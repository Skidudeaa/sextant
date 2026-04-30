"use strict";

// ARCHITECTURE: Real-state freshness gate for the <codebase-intelligence>
// injection layer.  The previous design fired a time-based "INDEX STALE"
// alert based on hours-since-generated_at and shipped the structural body
// anyway -- which (a) cried wolf on unchanged repos that happened to be
// idle and (b) still leaked stale numeric fields when the repo HAD changed.
// Both failures trained the LLM to ignore the alert.
//
// This module replaces that with a freshness check keyed to actual repo
// state -- not elapsed time.  When stale, the injection layer is expected
// to sanitize by construction (no hotspots, no fan-in, no entry points,
// no numeric graph fields) and to enqueue an atomic single-flight rescan.
//
// The check has four signals; any mismatch means stale:
//   - Scanner code version (bumped manually when extractor logic changes)
//   - Graph schema version (bumped when graph.db tables/keys change)
//   - Git HEAD (covers commits, checkouts, rebases that bypassed the watcher)
//   - `git status --porcelain` hash (covers uncommitted modifications and
//     newly untracked files that the watcher might have missed)
//
// We deliberately do NOT walk file mtimes: chokidar already covers FS
// changes when alive, and `git status` covers FS changes that produced a
// git-visible delta.  The remaining gap (untracked file content edits with
// no git delta) is rare, low-stakes, and the watcher catches it within
// debounce anyway.
//
// Scan-state is recorded in graph.db's `meta` table and updated:
//   - On every persistGraphUnlocked (watcher flush) -- piggybacks on the
//     same write that bumps generated_at, so it's atomic with the data.
//   - On the bulk scan command's final flush.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync, spawn } = require("child_process");

const { stateDir } = require("./utils");
const graph = require("./graph");

// WHY explicit constant rather than package.json version: the npm version
// changes for docs/test/ops bumps that don't invalidate graphs.  This
// constant moves only when extractor logic, resolver behaviour, or
// graph-content semantics change in a way that would produce a different
// graph from the same source.  Bump it when shipping such a change to
// force every existing graph.db to be considered stale on next read.
const SCANNER_VERSION = "1";

// WHY explicit constant: the schema_version meta key lets us detect when
// graph.db structure (tables, indexes, key names) has changed in a way
// that the cached file's contents are no longer trustworthy under the
// current code.  Bump when adding/removing/renaming tables or columns.
const SCHEMA_VERSION = "1";

const META_HEAD = "scanned_head";
const META_STATUS_HASH = "scanned_status_hash";
const META_SCANNER_VERSION = "scanner_version";
const META_SCHEMA_VERSION = "schema_version";

const RESCAN_MARKER_NAME = ".rescan_pending";
// WHY: a marker older than this is treated as orphaned (process crashed
// before clearing it) and may be replaced.  Conservative: longer than any
// realistic scan duration on machines we target.  Tune via telemetry.
const RESCAN_MARKER_STALE_MS = 5 * 60 * 1000;

function rescanMarkerPath(rootAbs) {
  return path.join(stateDir(rootAbs), RESCAN_MARKER_NAME);
}

function shortHash(s) {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
}

function getCurrentHead(rootAbs) {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: rootAbs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

function getCurrentStatusHash(rootAbs) {
  try {
    // --untracked-files=normal so a newly added file flips the hash.
    // No --no-renames: the default rename detection is fine for fingerprinting.
    const out = execSync("git status --porcelain --untracked-files=normal", {
      cwd: rootAbs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    // WHY filter sextant-managed paths: several directories are infrastructure,
    // not user code, and their churn must not flip the freshness fingerprint:
    //   - .planning/  : sextant's own state (graph.db, summary.md, telemetry,
    //                   rescan marker) -- written every flush.
    //   - .claude/    : Claude Code config (settings.json hooks) -- sextant
    //                   init writes this; later hook runs may touch it.
    //   - .mcp.json   : MCP server registration -- sextant init writes this.
    // If a host project hasn't gitignored these, their first appearance would
    // flip the status hash between recordScanState (called BEFORE persistDb's
    // on-disk write) and the next checkFreshness, forcing permanent stale on
    // an otherwise fresh graph.  Filtering scopes the fingerprint to user
    // changes only, which is what staleness is supposed to track.
    const filtered = out
      .split("\n")
      .filter((line) => {
        // git status --porcelain format: 2-char status + space + path.
        // Untracked-directory rollup uses "?? <name>/".  We match by path
        // suffix, not raw substring, to avoid false positives if a real
        // user file is literally named ".planning-something".
        const path = line.replace(/^.{0,3}/, ""); // drop status chars + space
        return !(
          path.startsWith(".planning/") ||
          path === ".planning/" ||
          path.startsWith(".claude/") ||
          path === ".claude/" ||
          path === ".mcp.json"
        );
      })
      .join("\n");
    return shortHash(filtered);
  } catch {
    return null;
  }
}

// Captures everything we want to compare against later.  Returned object
// has all-string values because the meta table is TEXT.  Null fields mean
// "unknown / not a git repo / git failed" -- the freshness check treats
// them as fingerprint inputs verbatim, so a transient git failure doesn't
// silently flip the gate.
function captureCurrentState(rootAbs) {
  return {
    head: getCurrentHead(rootAbs),
    statusHash: getCurrentStatusHash(rootAbs),
    scannerVersion: SCANNER_VERSION,
    schemaVersion: SCHEMA_VERSION,
  };
}

// Persist state to db meta.  Call inside the same critical section that
// bumps generated_at and writes graph.db, so on-disk state is atomic.
function recordScanState(db, rootAbs) {
  const state = captureCurrentState(rootAbs);
  graph.setMetaValue(db, META_HEAD, state.head ?? "");
  graph.setMetaValue(db, META_STATUS_HASH, state.statusHash ?? "");
  graph.setMetaValue(db, META_SCANNER_VERSION, state.scannerVersion);
  graph.setMetaValue(db, META_SCHEMA_VERSION, state.schemaVersion);
}

// Returns { fresh: boolean, reason: string | null, evidence: object }.
// `reason` is one of: head_changed, status_changed, scanner_version_changed,
//   schema_version_changed, no_scan_record, db_load_failed.
// `evidence` carries the raw before/after fields used in the decision so
// callers (telemetry, debugging) can record exactly what triggered stale.
async function checkFreshness(rootAbs) {
  let db;
  try {
    db = await graph.loadDb(rootAbs);
  } catch (err) {
    return {
      fresh: false,
      reason: "db_load_failed",
      evidence: { error: err?.message || String(err) },
    };
  }

  const stored = {
    head: graph.getMetaValue(db, META_HEAD) || "",
    statusHash: graph.getMetaValue(db, META_STATUS_HASH) || "",
    scannerVersion: graph.getMetaValue(db, META_SCANNER_VERSION) || "",
    schemaVersion: graph.getMetaValue(db, META_SCHEMA_VERSION) || "",
  };

  // No scan_state at all means an old graph.db from before this code
  // landed (or a freshly-created empty one).  Treat as stale so the
  // first read records state and subsequent reads benefit from the gate.
  const hasAnyRecord =
    stored.head || stored.statusHash || stored.scannerVersion || stored.schemaVersion;
  if (!hasAnyRecord) {
    return {
      fresh: false,
      reason: "no_scan_record",
      evidence: { stored },
    };
  }

  const current = captureCurrentState(rootAbs);

  // Order matters for `reason`: we report the first mismatch we find so
  // the telemetry signal is single-valued.  Version mismatches first --
  // they imply the code has moved on and the rest of the comparison is
  // meaningless under the new code.
  if (stored.scannerVersion !== current.scannerVersion) {
    return {
      fresh: false,
      reason: "scanner_version_changed",
      evidence: { stored: stored.scannerVersion, current: current.scannerVersion },
    };
  }
  if (stored.schemaVersion !== current.schemaVersion) {
    return {
      fresh: false,
      reason: "schema_version_changed",
      evidence: { stored: stored.schemaVersion, current: current.schemaVersion },
    };
  }
  // Treat null current.head/statusHash (git unavailable) as a soft signal:
  // if we previously had a value and now don't, the repo state can't be
  // verified.  Mark stale rather than risk a false-fresh.
  if ((current.head ?? "") !== stored.head) {
    return {
      fresh: false,
      reason: "head_changed",
      evidence: { stored: stored.head, current: current.head },
    };
  }
  if ((current.statusHash ?? "") !== stored.statusHash) {
    return {
      fresh: false,
      reason: "status_changed",
      evidence: {}, // hashes are useless to a human; reason is enough
    };
  }

  return { fresh: true, reason: null, evidence: {} };
}

// Atomic single-flight rescan trigger.
// Returns one of:
//   { state: "requested", pid }    — we just enqueued a fresh rescan
//   { state: "pending", since }    — a recent rescan is already in flight
//   { state: "skipped", reason }   — couldn't enqueue (e.g. spawn failed)
//
// The marker file is created with `wx` (atomic create-if-not-exists).
// If a marker exists but is older than RESCAN_MARKER_STALE_MS, we treat
// the prior process as orphaned and replace it -- a crashed scanner
// shouldn't permanently block future rescans.
function enqueueRescan(rootAbs) {
  const markerPath = rescanMarkerPath(rootAbs);
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  } catch {}

  let canSpawn = false;
  let existingSince = null;
  try {
    fs.writeFileSync(
      markerPath,
      JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
      { flag: "wx" }
    );
    canSpawn = true;
  } catch (e) {
    if (e.code !== "EEXIST") {
      return { state: "skipped", reason: `marker_write_failed:${e.code || "unknown"}` };
    }
    // Marker exists -- check whether the prior rescan is stale.
    let payload = null;
    try {
      payload = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    } catch {}
    const ageMs = payload?.startedAt
      ? Date.now() - Number(payload.startedAt)
      : RESCAN_MARKER_STALE_MS + 1; // unparseable = treat as orphaned
    if (ageMs > RESCAN_MARKER_STALE_MS) {
      try {
        fs.writeFileSync(
          markerPath,
          JSON.stringify({ pid: process.pid, startedAt: Date.now() })
        );
        canSpawn = true;
      } catch {
        return { state: "skipped", reason: "marker_replace_failed" };
      }
    } else {
      existingSince = payload?.startedAt ? Number(payload.startedAt) : null;
    }
  }

  if (!canSpawn) {
    return { state: "pending", since: existingSince };
  }

  // Spawn an `sextant scan` in the background.  We use the binary on PATH
  // (mirrors how SessionStart starts the watcher; survives npm link).
  //
  // --allow-concurrent: the scan command refuses to run while the watcher
  // is alive by default, but here we *want* concurrent execution -- the
  // freshness gate fires precisely when the watcher's incremental flushes
  // didn't keep graph.db in sync with reality, and a fresh full scan is
  // the recovery.  The cross-process write lock at lib/graph.js prevents
  // corruption; the mtime-gated cache at lib/graph.js loadDb() ensures
  // the watcher's RAM copy gets invalidated on scan's persist, so it
  // resumes from the scan's fresh state instead of clobbering it.
  //
  // --force: drop any "no changes since last scan" optimisation -- we're
  // here precisely because the prior scan's state is no longer valid.
  let child;
  try {
    child = spawn("sextant", ["scan", "--allow-concurrent", "--force"], {
      cwd: rootAbs,
      stdio: "ignore",
      detached: true,
      env: { ...process.env, SEXTANT_RESCAN_TRIGGER: "freshness_gate" },
    });
    child.unref();
  } catch (e) {
    // Marker is now orphaned; clean it so a later call can retry.
    try { fs.unlinkSync(markerPath); } catch {}
    return { state: "skipped", reason: `spawn_failed:${e.code || "unknown"}` };
  }

  return { state: "requested", pid: child.pid };
}

// Best-effort marker cleanup.  Called by the scan command in its finally
// block so a successful rescan releases the single-flight slot promptly,
// without waiting for the staleness threshold.
function clearRescanMarker(rootAbs) {
  try {
    fs.unlinkSync(rescanMarkerPath(rootAbs));
  } catch {
    // Marker may not exist (e.g. user ran `sextant scan` directly without
    // a freshness-gate trigger).  Silent.
  }
}

module.exports = {
  SCANNER_VERSION,
  SCHEMA_VERSION,
  META_HEAD,
  META_STATUS_HASH,
  META_SCANNER_VERSION,
  META_SCHEMA_VERSION,
  RESCAN_MARKER_NAME,
  RESCAN_MARKER_STALE_MS,
  captureCurrentState,
  recordScanState,
  checkFreshness,
  enqueueRescan,
  clearRescanMarker,
  rescanMarkerPath,
};
