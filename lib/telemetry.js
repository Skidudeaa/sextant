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
const fileMutex = require("./file-mutex");

const TELEMETRY_FILE = "telemetry.jsonl";
const TELEMETRY_OLD_FILE = "telemetry.jsonl.old";
const TELEMETRY_ROTATE_LOCK_FILE = "telemetry.rotate.lock";
// 8 MiB cap -- sized so the pre-registered 7-day / 300-task Phase-F cohort can
// survive alongside ordinary telemetry after per-touch rows were removed,
// while current + one rotated generation remains hard-bounded at ~16 MiB.
// When this is reached,
// we rotate the current file to .old (overwriting the previous .old) and
// start fresh.
const TELEMETRY_MAX_BYTES = 8 * 1024 * 1024;

function telemetryPath(rootAbs) {
  return path.join(stateDir(rootAbs), TELEMETRY_FILE);
}

function telemetryOldPath(rootAbs) {
  return path.join(stateDir(rootAbs), TELEMETRY_OLD_FILE);
}

function telemetryRotateLockPath(rootAbs) {
  return path.join(stateDir(rootAbs), TELEMETRY_ROTATE_LOCK_FILE);
}

const ROTATE_LOCK_STALE_MS = 60 * 1000;

function acquireRotateLock(file) {
  return fileMutex.acquireFileMutex(file, {
    attempts: 25,
    waitMs: 2,
    staleMs: ROTATE_LOCK_STALE_MS,
  });
}

function releaseRotateLock(lock) {
  fileMutex.releaseFileMutex(lock);
}

function rotateIfTooLarge(filePath, oldPath, lockPath) {
  const lock = acquireRotateLock(lockPath);
  // Another hook owns rotation. Appending to the current path is still safe:
  // the write lands either in the file it renames or in the fresh generation.
  if (!lock) return;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= TELEMETRY_MAX_BYTES) return;
    // Rename is atomic. The token-owned lock prevents two hook processes from
    // rotating different generations onto the same `.old` path.
    fs.renameSync(filePath, oldPath);
    try { fs.chmodSync(oldPath, 0o600); } catch {}
  } catch (e) {
    // ENOENT: file doesn't exist yet, nothing to rotate.  Anything else:
    // we don't want telemetry I/O to ever break the hook, so swallow.
  } finally {
    releaseRotateLock(lock);
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
    const lockPath = telemetryRotateLockPath(rootAbs);
    rotateIfTooLarge(filePath, oldPath, lockPath);

    const event = { ts: Date.now(), name, ...payload };
    const line = JSON.stringify(event) + "\n";
    fs.appendFileSync(filePath, line, { mode: 0o600 });
    // Existing installs may have created the stream under a permissive umask.
    // Schema-v1 rows contain bounded repository facts, so repair permissions on
    // every successful append (best-effort, like the append itself).
    try { fs.chmodSync(filePath, 0o600); } catch {}
    try { fs.chmodSync(oldPath, 0o600); } catch {}
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
  TELEMETRY_ROTATE_LOCK_FILE,
  TELEMETRY_MAX_BYTES,
  telemetryPath,
  telemetryOldPath,
  telemetryRotateLockPath,
  recordEvent,
  readEvents,
};
