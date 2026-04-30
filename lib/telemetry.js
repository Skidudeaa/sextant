"use strict";

// ARCHITECTURE: Append-only JSONL telemetry for the freshness gate.
//
// Goal: collect just enough signal to drive the future Option-5 adaptive
// sync-vs-async decision (per-repo p95 scan duration, timeout rate,
// async-rescan success rate, blackout-turn frequency).  Without this
// data, "Option 5 later" becomes hand-waving -- so we eat the small
// I/O cost now to make sure the dataset exists when we need it.
//
// Format: one JSON object per line at .planning/intel/telemetry.jsonl
// Fields: { ts, name, ...payload }.  Schema is intentionally flat -- no
// nested objects -- so jq / awk / a future analyzer can slice it without
// a parser.  Names are namespaced (freshness.stale_hit, scan.completed)
// so the file can host events from other subsystems later.
//
// Bounded growth: when the file exceeds TELEMETRY_MAX_BYTES, we rotate
// it once to .old (overwriting any prior .old).  We do NOT keep rolling
// archives; this is signal for the next analysis pass, not an audit log.
// Overwriting .old is acceptable because losing a generation of stale
// telemetry doesn't undermine future decisions -- the most recent window
// is what matters.

const fs = require("fs");
const path = require("path");

const { stateDir } = require("./utils");

const TELEMETRY_FILE = "telemetry.jsonl";
const TELEMETRY_OLD_FILE = "telemetry.jsonl.old";
// 1 MiB cap -- generous enough for tens of thousands of events but small
// enough that a runaway logger can't fill the disk.  When this is reached,
// we rotate the current file to .old (overwriting the previous .old) and
// start fresh.  Tune via experience; 1 MiB is conservative.
const TELEMETRY_MAX_BYTES = 1 * 1024 * 1024;

function telemetryPath(rootAbs) {
  return path.join(stateDir(rootAbs), TELEMETRY_FILE);
}

function telemetryOldPath(rootAbs) {
  return path.join(stateDir(rootAbs), TELEMETRY_OLD_FILE);
}

function rotateIfTooLarge(filePath, oldPath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= TELEMETRY_MAX_BYTES) return;
    // Rename is atomic and cheap; overwriting any existing .old is fine
    // (see ARCHITECTURE comment -- we keep one generation, not a log).
    fs.renameSync(filePath, oldPath);
  } catch (e) {
    // ENOENT: file doesn't exist yet, nothing to rotate.  Anything else:
    // we don't want telemetry I/O to ever break the hook, so swallow.
  }
}

// Best-effort recording.  Never throws -- callers should be able to wrap
// recordEvent in their hot path without try/catch.  Failures are silent
// because telemetry is observational; a missing event is strictly less
// bad than a hook crash.
function recordEvent(rootAbs, name, payload = {}) {
  try {
    const dir = stateDir(rootAbs);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = telemetryPath(rootAbs);
    const oldPath = telemetryOldPath(rootAbs);
    rotateIfTooLarge(filePath, oldPath);

    const event = { ts: Date.now(), name, ...payload };
    const line = JSON.stringify(event) + "\n";
    fs.appendFileSync(filePath, line);
  } catch {
    // Silent: see ARCHITECTURE.  If we couldn't record, a downstream
    // analyzer will see a gap; that's better than the hook erroring.
  }
}

// Read events back -- only used by tests and (eventually) the analysis
// tooling that drives Option 5.  Returns an array of parsed objects;
// malformed lines are skipped silently.
function readEvents(rootAbs) {
  const filePath = telemetryPath(rootAbs);
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Skip malformed lines (e.g. partial write from a crash).
    }
  }
  return out;
}

module.exports = {
  TELEMETRY_FILE,
  TELEMETRY_OLD_FILE,
  TELEMETRY_MAX_BYTES,
  telemetryPath,
  telemetryOldPath,
  recordEvent,
  readEvents,
};
