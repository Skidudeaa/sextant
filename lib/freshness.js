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
const { execSync, spawn, spawnSync } = require("child_process");

const { stateDir } = require("./utils");
const graph = require("./graph");

// WHY explicit constant rather than package.json version: the npm version
// changes for docs/test/ops bumps that don't invalidate graphs.  This
// constant moves only when extractor logic, resolver behaviour, or
// graph-content semantics change in a way that would produce a different
// graph from the same source.  Bump it when shipping such a change to
// force every existing graph.db to be considered stale on next read.
//
// History:
//   "1" — initial freshness gate
//   "2" — NodeNext resolver rewrite: TS import specifiers using .js/.mjs/.cjs
//          can resolve to .ts/.mts/.cts source files.
//   "3" — tree-sitter-swift grammar 0.7.1 -> 0.7.2: raw-string literals and
//          top-level / function-body #if directives now parse cleanly, so a
//          file's extracted Swift declarations can differ from the same source
//          under 0.7.1. Force existing graphs stale so they re-extract.
const SCANNER_VERSION = "3";

// WHY explicit constant: the schema_version meta key lets us detect when
// graph.db structure (tables, indexes, key names) has changed in a way
// that the cached file's contents are no longer trustworthy under the
// current code.  Bump when adding/removing/renaming tables or columns.
//
// History:
//   "1" — initial: files, imports, exports, reexports, meta
//   "2" — Swift v1: + swift_declarations, swift_relations
//   "3" — blast-radius lane (docs/016): + cochange_pairs, cochange_degree.
//          Bumping forces the freshness gate to rescan existing graphs so the
//          co-change tables get populated on first post-upgrade read.
const SCHEMA_VERSION = "3";

const META_HEAD = "scanned_head";
const META_STATUS_HASH = "scanned_status_hash";
const META_STATUS_FILES = "scanned_status_files";
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

// Filtered `git status --porcelain` lines — the shared substrate for the
// status fingerprint (hash) and the status path list (self-caused-drift
// check).  Returns null on git failure / non-git dir.
function getStatusLines(rootAbs) {
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
    return out.split("\n").filter((line) => {
      // git status --porcelain format: 2-char status + space + path.
      // Untracked-directory rollup uses "?? <name>/".  We match by path
      // suffix, not raw substring, to avoid false positives if a real
      // user file is literally named ".planning-something".
      const filePath = line.replace(/^.{0,3}/, ""); // drop status chars + space
      return !(
        filePath.startsWith(".planning/") ||
        filePath === ".planning/" ||
        filePath.startsWith(".claude/") ||
        filePath === ".claude/" ||
        filePath === ".mcp.json"
      );
    });
  } catch {
    return null;
  }
}

function getCurrentStatusHash(rootAbs) {
  const lines = getStatusLines(rootAbs);
  if (lines === null) return null;
  return shortHash(lines.join("\n"));
}

// The dirty PATHS behind the fingerprint (rename lines contribute both sides).
// Null on git failure.  Order-insensitive consumers only.
function getCurrentStatusPaths(rootAbs) {
  const lines = getStatusLines(rootAbs);
  if (lines === null) return null;
  const paths = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const p = line.replace(/^.{0,3}/, "");
    if (p.includes(" -> ")) {
      const [from, to] = p.split(" -> ");
      paths.push(from, to);
    } else {
      paths.push(p);
    }
  }
  return paths;
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

// Cap on the persisted dirty-path map.  A messier tree than this gets no
// map (meta "") and the self-caused-drift check degrades to strict
// suppression — bounded meta size beats a rarely-useful rescue on chaos trees.
const STATUS_FILES_MAX = 400;

// Content hash of one working-tree file.  "" for anything unreadable
// (deleted, dir, permission) — the comparison treats "" == "" as unchanged,
// which is why directory-rollup paths get special-cased in the drift check.
function hashWorkingFile(rootAbs, relPath) {
  try {
    return crypto
      .createHash("sha1")
      .update(fs.readFileSync(path.join(rootAbs, relPath)))
      .digest("hex")
      .slice(0, 16);
  } catch {
    return "";
  }
}

// Persist state to db meta.  Call inside the same critical section that
// bumps generated_at and writes graph.db, so on-disk state is atomic.
function recordScanState(db, rootAbs) {
  const state = captureCurrentState(rootAbs);
  graph.setMetaValue(db, META_HEAD, state.head ?? "");
  graph.setMetaValue(db, META_STATUS_HASH, state.statusHash ?? "");
  graph.setMetaValue(db, META_SCANNER_VERSION, state.scannerVersion);
  graph.setMetaValue(db, META_SCHEMA_VERSION, state.schemaVersion);
  // The dirty-path MAP behind the status hash (docs/016 blast-radius fix):
  // { relPath: contentHash } for every dirty file, letting a consumer
  // distinguish drift caused by the session's own edits from foreign drift —
  // including content re-drift on a file that was ALREADY dirty at scan time
  // (adversarial-review MEDIUM: presence-only comparison was blind to that).
  // Same critical section → atomic with the status hash it explains.
  const statusPaths = getCurrentStatusPaths(rootAbs);
  let payload = "";
  if (statusPaths && statusPaths.length <= STATUS_FILES_MAX) {
    const map = {};
    for (const p of statusPaths) map[p] = hashWorkingFile(rootAbs, p);
    payload = JSON.stringify(map);
  }
  graph.setMetaValue(db, META_STATUS_FILES, payload);
}

// Self-caused-drift check (docs/016 Sprint 1, blast-radius lane).  The
// headless end-to-end gate exposed a structural trap: the agent's OWN edit
// makes the tree content-stale at the exact moment the post-edit note should
// fire, so without a running watcher the lane would never speak.  But drift
// confined to files the session itself touched does NOT invalidate
// structural claims about OTHER files (dependents / co-change of the edited
// file) — the graph's knowledge of those files hasn't moved.
//
// Returns true iff ALL of:
//   - HEAD is unchanged since the recorded scan (a commit shifts the porcelain
//     baseline, so comparison is meaningless across one — the enqueued rescan
//     heals that window instead), and
//   - the stored dirty-path map and the current dirty-path list are available, and
//   - every untouched path present on either side is present on BOTH sides
//     with an UNCHANGED content hash (an untouched already-dirty file whose
//     bytes moved again is FOREIGN drift even though porcelain shows the same
//     "M file" line), and no untouched path is a directory rollup ("?? dir/",
//     whose inner contents porcelain can't itemize).
// Anything unknowable returns false (degrade-don't-guess).
function isSelfCausedStatusDrift(db, rootAbs, touchedSet) {
  try {
    const storedHead = graph.getMetaValue(db, META_HEAD) || "";
    if (!storedHead || storedHead !== (getCurrentHead(rootAbs) || "")) return false;
    const storedRaw = graph.getMetaValue(db, META_STATUS_FILES);
    if (!storedRaw) return false;
    const stored = JSON.parse(storedRaw);
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return false;
    const current = getCurrentStatusPaths(rootAbs);
    if (current === null) return false;
    const currentSet = new Set(current);
    for (const p of new Set([...currentSet, ...Object.keys(stored)])) {
      if (touchedSet.has(p)) continue;
      // Untouched drift is tolerable ONLY as "identical dirty state on both
      // sides": same presence, same bytes, and verifiable (not a dir rollup).
      if (p.endsWith("/")) return false;
      if (!currentSet.has(p) || !(p in stored)) return false;
      if (hashWorkingFile(rootAbs, p) !== stored[p]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Returns { fresh: boolean, reason: string | null, contentChanged: boolean,
//   evidence: object }.
// `reason` is one of: head_changed, status_changed, scanner_version_changed,
//   schema_version_changed, no_scan_record, db_load_failed.
// `contentChanged` is REASON-INDEPENDENT: it is true iff the git HEAD or the
//   git-status fingerprint has moved since the stored scan-state, regardless of
//   which `reason` won the single-valued race.  This closes the version+content
//   coincidence: a scanner/schema version bump returns reason="*_version_changed"
//   FIRST (the ordering below is load-bearing for cli.js's telemetry signal), but
//   if a checkout/edit ALSO moved files that same turn, `reason` alone would mask
//   the content change.  Consumers that need to know "could files have moved?"
//   (hook-refresh's suppressive/phantom-drop path) read contentChanged, not reason.
//   For the can't-verify paths (no_scan_record, db_load_failed) we set it true:
//   we cannot confirm the stored structure is valid, so degrade-don't-guess.
// `evidence` carries the raw before/after fields used in the decision so
// callers (telemetry, debugging) can record exactly what triggered stale.
async function checkFreshness(rootAbs) {
  let db;
  try {
    db = await graph.loadDb(rootAbs);
  } catch (err) {
    // Can't even load the db → can't verify the stored structure is valid.
    // Conservative: assume content could have moved (degrade-don't-guess).
    return {
      fresh: false,
      reason: "db_load_failed",
      contentChanged: true,
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
    // No baseline to compare against → can't rule out a content change.
    // Conservative: treat as content-changed (degrade-don't-guess).
    return {
      fresh: false,
      reason: "no_scan_record",
      contentChanged: true,
      evidence: { stored },
    };
  }

  const current = captureCurrentState(rootAbs);

  // Compute contentChanged ONCE, here, before the reason race below decides a
  // single winner.  This is the whole point of the field: it must reflect the
  // real HEAD/status delta independent of which reason fired first, so a version
  // bump coinciding with a checkout can no longer mask the content move.  Treat
  // null current.head/statusHash (git unavailable) as "" so a previously-known
  // value going unknown counts as a change (mirrors the comparisons below).
  const contentChanged =
    ((current.head ?? "") !== stored.head) ||
    ((current.statusHash ?? "") !== stored.statusHash);

  // Order matters for `reason`: we report the first mismatch we find so
  // the telemetry signal is single-valued.  Version mismatches first --
  // they imply the code has moved on and the rest of the comparison is
  // meaningless under the new code.  (contentChanged above is unaffected by
  // this ordering — it always reflects the HEAD/status delta.)
  if (stored.scannerVersion !== current.scannerVersion) {
    return {
      fresh: false,
      reason: "scanner_version_changed",
      contentChanged,
      evidence: { stored: stored.scannerVersion, current: current.scannerVersion },
    };
  }
  if (stored.schemaVersion !== current.schemaVersion) {
    return {
      fresh: false,
      reason: "schema_version_changed",
      contentChanged,
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
      contentChanged: true,
      evidence: { stored: stored.head, current: current.head },
    };
  }
  if ((current.statusHash ?? "") !== stored.statusHash) {
    return {
      fresh: false,
      reason: "status_changed",
      contentChanged: true,
      evidence: {}, // hashes are useless to a human; reason is enough
    };
  }

  return { fresh: true, reason: null, contentChanged: false, evidence: {} };
}

// Atomic claim of the single-flight rescan marker.  Shared by the async
// enqueue path and the sync-rescan path so both respect the same
// one-rescan-at-a-time invariant.  Returns:
//   { claimed: true }
//   { claimed: false, state: "pending", since }   — recent rescan in flight
//   { claimed: false, state: "skipped", reason }  — marker io failed
//
// The marker file is created with `wx` (atomic create-if-not-exists).
// If a marker exists but is older than RESCAN_MARKER_STALE_MS, we treat
// the prior process as orphaned and replace it -- a crashed scanner
// shouldn't permanently block future rescans.
function claimRescanMarker(rootAbs) {
  const markerPath = rescanMarkerPath(rootAbs);
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  } catch {}

  try {
    fs.writeFileSync(
      markerPath,
      JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
      { flag: "wx" }
    );
    return { claimed: true };
  } catch (e) {
    if (e.code !== "EEXIST") {
      return { claimed: false, state: "skipped", reason: `marker_write_failed:${e.code || "unknown"}` };
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
        // WHY unlink before re-creating: plain writeFileSync overwrites
        // non-atomically, so two concurrent hooks seeing a stale marker both
        // overwrite and both claim the slot, breaking single-flight.
        // Unlink + wx (O_CREAT|O_EXCL) is atomic: whichever process wins
        // the wx succeeds; the other gets EEXIST and returns "skipped".
        try { fs.unlinkSync(markerPath); } catch {}
        fs.writeFileSync(
          markerPath,
          JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
          { flag: "wx" }
        );
        return { claimed: true };
      } catch {
        return { claimed: false, state: "skipped", reason: "marker_replace_failed" };
      }
    }
    return {
      claimed: false,
      state: "pending",
      since: payload?.startedAt ? Number(payload.startedAt) : null,
    };
  }
}

// Atomic single-flight rescan trigger (async arm).
// Returns one of:
//   { state: "requested", pid }    — we just enqueued a fresh rescan
//   { state: "pending", since }    — a recent rescan is already in flight
//   { state: "skipped", reason }   — couldn't enqueue (e.g. spawn failed)
function enqueueRescan(rootAbs) {
  const markerPath = rescanMarkerPath(rootAbs);
  const claim = claimRescanMarker(rootAbs);
  if (!claim.claimed) {
    return claim.state === "pending"
      ? { state: "pending", since: claim.since }
      : { state: "skipped", reason: claim.reason };
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

// ── Option-5 adaptive SYNC rescan ──
// WHY: 73 days of telemetry showed 30% of injection reads were blackout
// turns while scans ran p50 1.1s / p95 1.7s at 100% success. When the
// repo's own recorded scan history proves rescans are fast, running ONE
// synchronously inside the hook converts the blackout turn into a fresh
// injection for ~1-2s of prompt latency. When history says otherwise (or
// doesn't exist yet), the async blackout path is unchanged — degrade,
// don't guess.

// Sync only when the repo's recorded p95 is at or under this.
const SYNC_RESCAN_MAX_P95_MS = 2500;
// Need this many recorded scan durations before trusting the percentile.
const SYNC_RESCAN_MIN_SAMPLES = 5;
// Child kill-timeout bounds: 3x the observed p95, clamped. The clamp floor
// keeps tiny-p95 repos from getting killed on a one-off slow disk; the
// ceiling bounds worst-case prompt latency when the estimate was wrong.
const SYNC_RESCAN_TIMEOUT_MIN_MS = 3000;
const SYNC_RESCAN_TIMEOUT_MAX_MS = 8000;
// After a failed/timed-out sync attempt, don't re-attempt sync for this
// long (a killed child records no scan.completed, so the duration stats
// wouldn't learn the repo got slower — this cooldown is the guard).
const SYNC_RESCAN_FAILURE_COOLDOWN_MS = 10 * 60 * 1000;

function percentileOf(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

// Decide whether a sync rescan is safe for this repo, from its own recorded
// scan history (telemetry scan.completed durations, any trigger — full scans
// all take the same path).  Returns { sync: true, p95, samples, timeoutMs }
// or { sync: false, reason }.
//
// Overrides: SEXTANT_SYNC_RESCAN=0 kills the lane; =1 forces it past the
// stats gate (tests / early adoption on a repo with no history yet).
// `.codebase-intel.json` `syncRescan: false` disables per-repo.
function shouldSyncRescan(rootAbs) {
  const env = process.env.SEXTANT_SYNC_RESCAN;
  if (env === "0" || env === "false") return { sync: false, reason: "env_disabled" };

  try {
    const { loadRepoConfig } = require("./config");
    if (loadRepoConfig(rootAbs).syncRescan === false) {
      return { sync: false, reason: "config_disabled" };
    }
  } catch {}

  if (env === "1" || env === "force") {
    return { sync: true, p95: null, samples: 0, timeoutMs: SYNC_RESCAN_TIMEOUT_MAX_MS };
  }

  // Collect scan durations + the most recent sync attempt from telemetry.
  // Current file first; .old appended only when the current window is thin.
  const telemetry = require("./telemetry");
  const durations = [];
  let lastSyncAttempt = null; // { ts, ok }
  const ingest = (file) => {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return;
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.name === "scan.completed" && e.success && typeof e.durationMs === "number") {
        durations.push(e.durationMs);
      } else if (e.name === "freshness.sync_rescan") {
        const ts = Number(e.ts); // recordEvent stamps epoch ms
        if (Number.isFinite(ts) && (!lastSyncAttempt || ts > lastSyncAttempt.ts)) {
          lastSyncAttempt = { ts, ok: !!e.ok };
        }
      }
    }
  };
  ingest(telemetry.telemetryPath(rootAbs));
  if (durations.length < SYNC_RESCAN_MIN_SAMPLES) {
    ingest(telemetry.telemetryOldPath(rootAbs));
  }

  if (lastSyncAttempt && !lastSyncAttempt.ok &&
      Date.now() - lastSyncAttempt.ts < SYNC_RESCAN_FAILURE_COOLDOWN_MS) {
    return { sync: false, reason: "failure_cooldown" };
  }
  if (durations.length < SYNC_RESCAN_MIN_SAMPLES) {
    return { sync: false, reason: "insufficient_samples" };
  }

  durations.sort((a, b) => a - b);
  const p95 = percentileOf(durations, 95);
  if (p95 > SYNC_RESCAN_MAX_P95_MS) {
    return { sync: false, reason: "p95_too_slow", p95 };
  }
  const timeoutMs = Math.min(
    SYNC_RESCAN_TIMEOUT_MAX_MS,
    Math.max(SYNC_RESCAN_TIMEOUT_MIN_MS, 3 * p95)
  );
  return { sync: true, p95, samples: durations.length, timeoutMs };
}

// Run one rescan synchronously under the same single-flight marker the async
// arm uses.  Returns:
//   { state: "completed", durationMs }
//   { state: "failed", durationMs, timedOut }
//   { state: "pending", since }        — another rescan already in flight
//   { state: "skipped", reason }       — marker io failed / spawn failed
//
// Safety: graph.db persists are tmp+rename atomic, so killing the child on
// timeout can't corrupt the index. We claim the marker ourselves and clear
// it in finally — unlike the async arm we own the child's whole lifetime,
// so a killed child can't leave the slot stuck for the 5-min orphan TTL.
function syncRescan(rootAbs, timeoutMs) {
  const claim = claimRescanMarker(rootAbs);
  if (!claim.claimed) {
    return claim.state === "pending"
      ? { state: "pending", since: claim.since }
      : { state: "skipped", reason: claim.reason };
  }

  const t0 = Date.now();
  try {
    // SEXTANT_BIN: same override the holdback cron uses — lets tests (and
    // installs without a global link) point at a specific bin/intel.js.
    const [cmd, ...pre] = process.env.SEXTANT_BIN
      ? [process.execPath, process.env.SEXTANT_BIN]
      : ["sextant"];
    const res = spawnSync(cmd, [...pre, "scan", "--allow-concurrent", "--force"], {
      cwd: rootAbs,
      stdio: "ignore",
      timeout: Math.max(1000, timeoutMs || SYNC_RESCAN_TIMEOUT_MAX_MS),
      env: { ...process.env, SEXTANT_RESCAN_TRIGGER: "freshness_gate_sync" },
    });
    const durationMs = Date.now() - t0;
    const timedOut = res.error?.code === "ETIMEDOUT" || (res.signal != null && res.status == null);
    if (res.error && !timedOut) {
      return { state: "skipped", reason: `spawn_failed:${res.error.code || "unknown"}` };
    }
    if (!timedOut && res.status === 0) {
      return { state: "completed", durationMs };
    }
    return { state: "failed", durationMs, timedOut: !!timedOut };
  } finally {
    clearRescanMarker(rootAbs);
  }
}

// ── Scan-in-progress marker (cooperative watcher pause) ──
// WHY: a live watcher and a manual scan both write graph.db from independent
// sql.js in-memory copies, so a watcher flush landing mid-scan can clobber the
// scan with stale state. Rather than refusing the scan (forcing the user to
// stop the watcher), the scan drops this marker and the watcher DEFERS its
// flushes while it is fresh — then the watcher's next flush, via the
// mtime-gated loadDb, picks up the scan's result and applies its queued changes
// on top. The scan refreshes the marker as it progresses; if the scan crashes
// without clearing it, the marker goes stale after this window and the watcher
// resumes — a bounded freeze, not a permanent one. 90s matches the watcher's
// own heartbeat-liveness threshold (lib/cli.js:getWatcherStatus).
const SCAN_MARKER_NAME = ".scan_in_progress";
const SCAN_MARKER_STALE_MS = 90 * 1000;

function scanMarkerPath(rootAbs) {
  return path.join(stateDir(rootAbs), SCAN_MARKER_NAME);
}

// Write or refresh the marker (mtime is the freshness signal). Idempotent:
// called once at scan start and again on progress to keep it fresh through a
// long scan. Never throws — marker IO must not break a scan.
function markScanInProgress(rootAbs) {
  try {
    const p = scanMarkerPath(rootAbs);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + "\n");
  } catch {
    /* marker is best-effort */
  }
}

function clearScanMarker(rootAbs) {
  // WHY pid-aware: with two concurrent scans on one root (--allow-concurrent),
  // the first to finish must not unlink the marker out from under the other and
  // let the watcher resume mid-write. Clear only OUR claim (or an
  // unparseable/ownerless marker, best-effort); a different live owner keeps its
  // marker, which it refreshes on progress and clears in its own finally. The
  // 90s stale window stays the crash backstop either way.
  try {
    const p = scanMarkerPath(rootAbs);
    let owner = null;
    try { owner = JSON.parse(fs.readFileSync(p, "utf8")).pid; } catch { /* unparseable */ }
    if (owner == null || owner === process.pid) fs.unlinkSync(p);
  } catch {
    /* already gone / never written */
  }
}

// True iff a scan marker exists AND is fresh. A stale marker (a crashed scan
// that never cleared it) reads as not-in-progress, so the watcher resumes
// after at most SCAN_MARKER_STALE_MS rather than freezing forever.
function isScanInProgress(rootAbs) {
  try {
    const st = fs.statSync(scanMarkerPath(rootAbs));
    return Date.now() - st.mtimeMs < SCAN_MARKER_STALE_MS;
  } catch {
    return false;
  }
}

module.exports = {
  SCANNER_VERSION,
  SCHEMA_VERSION,
  META_HEAD,
  META_STATUS_HASH,
  META_STATUS_FILES,
  META_SCANNER_VERSION,
  META_SCHEMA_VERSION,
  RESCAN_MARKER_NAME,
  RESCAN_MARKER_STALE_MS,
  captureCurrentState,
  recordScanState,
  checkFreshness,
  getCurrentStatusPaths,
  isSelfCausedStatusDrift,
  enqueueRescan,
  clearRescanMarker,
  claimRescanMarker,
  shouldSyncRescan,
  syncRescan,
  SYNC_RESCAN_MAX_P95_MS,
  SYNC_RESCAN_MIN_SAMPLES,
  rescanMarkerPath,
  SCAN_MARKER_NAME,
  SCAN_MARKER_STALE_MS,
  scanMarkerPath,
  markScanInProgress,
  clearScanMarker,
  isScanInProgress,
};
