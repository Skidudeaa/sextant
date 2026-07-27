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
//   - `git status --porcelain` plus bounded dirty-file content hashes (covers
//     uncommitted modifications, repeated edits to already-dirty paths, and
//     newly untracked files that the watcher might have missed)
//
// We deliberately do NOT walk the whole tree or trust mtimes. Only paths Git
// already marks dirty are content-hashed, with a hard file-count bound; an
// over-bound state is unverifiable and therefore stale.
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
//   "4" — freshness status fingerprints now include dirty-file content, so an
//          edit to an already-dirty path cannot masquerade as scan-current.
const SCANNER_VERSION = "4";

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
const META_GRAPH_GENERATION = "graph_generation";

// Dirty-file hashing runs on prompt hooks, so both cardinality and bytes are
// hard-bounded. Exceeding either bound is not treated as equality: the status
// fingerprint becomes unverifiable and checkFreshness degrades to stale.
const STATUS_FILES_MAX = 400;
const STATUS_FILE_MAX_BYTES = 2 * 1024 * 1024;
const STATUS_TOTAL_MAX_BYTES = 8 * 1024 * 1024;

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

// Is there a git repository here AT ALL? getCurrentHead() returns null for two
// very different states — "no repo" and "repo present but HEAD unreadable"
// (unborn branch, transient failure, mid-rebase) — and collapsing them is what
// made a non-git root permanently stale. `--git-dir` succeeds on an unborn repo
// where `rev-parse HEAD` fails, so this separates "no anchor exists" from
// "the anchor moved or could not be read", which need opposite treatments:
// the first can never be resolved by rescanning, the second usually can.
function isGitRepo(rootAbs) {
  try {
    execSync("git rev-parse --git-dir", {
      cwd: rootAbs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

const STATUS_MAP_VERSION = 2;
const MANAGED_STATUS_EXACT = [".planning", ".planning/", ".claude", ".claude/", ".mcp.json"]
  .map((p) => Buffer.from(p));
const MANAGED_STATUS_PREFIXES = [".planning/", ".claude/"].map((p) => Buffer.from(p));

function bufferStartsWith(value, prefix) {
  return value.length >= prefix.length && value.subarray(0, prefix.length).equals(prefix);
}

function isManagedStatusPath(filePath) {
  return (
    MANAGED_STATUS_EXACT.some((candidate) => filePath.equals(candidate)) ||
    MANAGED_STATUS_PREFIXES.some((prefix) => bufferStartsWith(filePath, prefix))
  );
}

function splitNulBuffer(value) {
  const fields = [];
  let start = 0;
  for (;;) {
    const end = value.indexOf(0, start);
    if (end === -1) {
      if (start < value.length) fields.push(value.subarray(start));
      break;
    }
    fields.push(value.subarray(start, end));
    start = end + 1;
  }
  return fields;
}

// Parsed, filtered `git status --porcelain=v1 -z` entries — the shared
// substrate for the status fingerprint and self-caused-drift path list. NUL
// framing preserves spaces, quotes, newlines, and non-ASCII filenames. Rename
// and copy records carry a second NUL field; retain both paths. Returns null on
// git failure / non-git dir.
function getStatusEntries(rootAbs) {
  try {
    // --untracked-files=all prevents an untracked directory rollup from hiding
    // changes to files inside it from the content-bearing fingerprint.
    // No --no-renames: the default rename detection is fine for fingerprinting.
    const out = execSync("git status --porcelain=v1 -z --untracked-files=all", {
      cwd: rootAbs,
      encoding: null,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 4 * 1024 * 1024,
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
    const fields = splitNulBuffer(Buffer.isBuffer(out) ? out : Buffer.from(out));
    const entries = [];
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      if (!field.length) continue;
      // Porcelain v1 is exactly: XY SP path. A malformed record is an
      // unverifiable status snapshot, not something to silently omit.
      if (field.length < 4 || field[2] !== 0x20) return null;
      const status = Buffer.from(field.subarray(0, 2));
      const paths = [Buffer.from(field.subarray(3))];
      if (status.includes(0x52) || status.includes(0x43)) { // R / C
        const origin = fields[++i];
        if (!origin || !origin.length) return null;
        paths.push(Buffer.from(origin));
      }
      const visiblePaths = paths.filter((filePath) => !isManagedStatusPath(filePath));
      if (visiblePaths.length) entries.push({ status, paths: visiblePaths });
    }
    return entries;
  } catch {
    return null;
  }
}

function statusPathsFromEntries(entries) {
  return entries.flatMap((entry) => entry.paths);
}

function rawAbsolutePath(rootAbs, relPath) {
  const root = Buffer.from(path.resolve(rootAbs));
  const separator = Buffer.from(path.sep);
  if (root.length >= separator.length && root.subarray(-separator.length).equals(separator)) {
    return Buffer.concat([root, relPath]);
  }
  return Buffer.concat([root, separator, relPath]);
}

function sameFileStat(a, b) {
  return Boolean(
    a && b &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

function fileEvidence(kind, relPath, stat = null) {
  return { kind, relPath: Buffer.from(relPath), stat };
}

function verifyWorkingFileEvidence(rootAbs, evidence) {
  const file = rawAbsolutePath(rootAbs, evidence.relPath);
  try {
    const current = fs.lstatSync(file, { bigint: true });
    if (evidence.kind === "missing") return false;
    return sameFileStat(evidence.stat, current);
  } catch (error) {
    return evidence.kind === "missing" && error && error.code === "ENOENT";
  }
}

function hashWorkingFileBounded(rootAbs, relPath, remainingBytes) {
  let fd = null;
  try {
    const cap = Math.min(STATUS_FILE_MAX_BYTES, Math.max(0, remainingBytes));
    const file = rawAbsolutePath(rootAbs, relPath);
    const pathBefore = fs.lstatSync(file, { bigint: true });
    if (pathBefore.isSymbolicLink()) {
      const target = fs.readlinkSync(file, { encoding: "buffer" });
      if (target.length > STATUS_FILE_MAX_BYTES || target.length > remainingBytes) return null;
      const pathAfter = fs.lstatSync(file, { bigint: true });
      if (!sameFileStat(pathBefore, pathAfter)) return null;
      return {
        hash: shortHash(target),
        bytes: target.length,
        evidence: fileEvidence("symlink", relPath, pathAfter),
      };
    }
    if (!pathBefore.isFile()) return null;

    // Open the inode and read at most cap+1 bytes. A pre-read stat followed by
    // readFileSync is not a bound: another process can replace/grow the file in
    // between and make the hook allocate the entire replacement. O_NOFOLLOW
    // plus before/after inode+metadata checks also fail closed on replacement or
    // an in-place write while hashing.
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || !sameFileStat(pathBefore, before)) return null;
    if (before.size > BigInt(cap)) return null;

    // Allocate only the observed size plus one sentinel byte (still capped).
    // The sentinel detects growth without paying a 2 MiB allocation for every
    // tiny dirty file in a large worktree.
    const readLimit = Math.min(cap + 1, Number(before.size) + 1);
    const content = Buffer.allocUnsafe(readLimit);
    let total = 0;
    while (total < content.length) {
      const n = fs.readSync(fd, content, total, content.length - total, total);
      if (!n) break;
      total += n;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const pathAfter = fs.lstatSync(file, { bigint: true });
    if (
      total > cap ||
      BigInt(total) !== after.size ||
      !sameFileStat(before, after) ||
      !sameFileStat(after, pathAfter)
    ) return null;
    const exact = content.subarray(0, total);
    return {
      hash: shortHash(exact),
      bytes: total,
      evidence: fileEvidence("file", relPath, pathAfter),
    };
  } catch (error) {
    // A deleted/renamed-away path is already represented by its status and has
    // no bytes to hash. Other failures are unverifiable, not an empty file.
    if (error && error.code === "ENOENT") {
      return { hash: "", bytes: 0, evidence: fileEvidence("missing", relPath) };
    }
    return null;
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function entrySortKey(entry) {
  const parts = [entry.status];
  for (const relPath of entry.paths) parts.push(Buffer.from([0]), relPath);
  return Buffer.concat(parts);
}

function sameStatusEntries(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const left = a.map(entrySortKey).sort(Buffer.compare);
  const right = b.map(entrySortKey).sort(Buffer.compare);
  return left.every((value, index) => value.equals(right[index]));
}

function captureStatusState(rootAbs) {
  const entries = getStatusEntries(rootAbs);
  if (entries === null) return { statusHash: null, statusFiles: null, statusPaths: null };
  const paths = statusPathsFromEntries(entries);
  // A huge dirty tree would make every prompt hash unbounded data. Treat it as
  // unverifiable instead; checkFreshness converts null/empty scan anchors into
  // content-stale rather than claiming equality.
  if (paths.length > STATUS_FILES_MAX) {
    return { statusHash: null, statusFiles: null, statusPaths: null };
  }
  const h = crypto.createHash("sha1");
  const orderedEntries = entries
    .map((entry) => ({ entry, key: entrySortKey(entry) }))
    .sort((a, b) => Buffer.compare(a.key, b.key))
    .map(({ entry }) => entry);
  for (const entry of orderedEntries) {
    h.update(entry.status);
    for (const relPath of entry.paths) {
      h.update("\0");
      h.update(String(relPath.length));
      h.update(":");
      h.update(relPath);
    }
    h.update("\n");
  }
  let hashedBytes = 0;
  const evidence = [];
  const uniquePaths = [...new Map(paths.map((p) => [p.toString("hex"), p])).values()]
    .sort(Buffer.compare);
  const files = {};
  for (const relPath of uniquePaths) {
    const content = hashWorkingFileBounded(
      rootAbs,
      relPath,
      STATUS_TOTAL_MAX_BYTES - hashedBytes
    );
    if (!content) return { statusHash: null, statusFiles: null, statusPaths: null };
    hashedBytes += content.bytes;
    evidence.push(content.evidence);
    h.update("\0");
    h.update(relPath);
    h.update("\0");
    h.update(content.hash);
    files[relPath.toString("hex")] = content.hash;
  }
  // One file's descriptor checks only stabilize that individual read. Retain
  // bounded evidence (at most STATUS_FILES_MAX entries) and recheck the whole
  // pass after all hashes, then re-read porcelain membership/status. This
  // catches an early dirty file changing while later files are hashed and a
  // new dirty path appearing after the first porcelain snapshot.
  if (!evidence.every((item) => verifyWorkingFileEvidence(rootAbs, item))) {
    return { statusHash: null, statusFiles: null, statusPaths: null };
  }
  const finalEntries = getStatusEntries(rootAbs);
  if (!sameStatusEntries(entries, finalEntries)) {
    return { statusHash: null, statusFiles: null, statusPaths: null };
  }
  const decodedPaths = [];
  for (const raw of uniquePaths) {
    const text = raw.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(raw)) {
      // Git can represent arbitrary pathname bytes while chokidar/fast-glob
      // expose JS strings. The fingerprint remains byte-exact, but an
      // incremental indexer cannot safely address this path and must fail
      // closed instead of indexing a U+FFFD alias.
      return {
        statusHash: h.digest("hex").slice(0, 16),
        statusFiles: { version: STATUS_MAP_VERSION, files },
        statusPaths: null,
      };
    }
    decodedPaths.push(text);
  }
  return {
    statusHash: h.digest("hex").slice(0, 16),
    statusFiles: { version: STATUS_MAP_VERSION, files },
    statusPaths: decodedPaths,
  };
}

function getCurrentStatusHash(rootAbs) {
  return captureStatusState(rootAbs).statusHash;
}

// The dirty PATHS behind the fingerprint (rename lines contribute both sides).
// Null on git failure.  Order-insensitive consumers only.
function getCurrentStatusPaths(rootAbs) {
  const entries = getStatusEntries(rootAbs);
  if (entries === null) return null;
  const decoded = [];
  for (const raw of statusPathsFromEntries(entries)) {
    const text = raw.toString("utf8");
    // The public path-list API is string-shaped. Never return a lossy U+FFFD
    // surrogate for a raw Git pathname; internal hashing/map code stays Buffer-
    // exact, while string-only consumers safely fail closed.
    if (!Buffer.from(text, "utf8").equals(raw)) return null;
    decoded.push(text);
  }
  return decoded;
}

// Captures everything we want to compare against later.  Returned object
// has all-string values because the meta table is TEXT.  Null fields mean
// "unknown / not a git repo / git failed" -- the freshness check treats
// them as unverifiable, so a transient git failure fails closed instead of
// silently blessing graph facts.
function captureCurrentStateDetailed(rootAbs) {
  const headBefore = getCurrentHead(rootAbs);
  const status = captureStatusState(rootAbs);
  const headAfter = getCurrentHead(rootAbs);
  const stable = headBefore === headAfter;
  return {
    head: stable ? headAfter : null,
    statusHash: stable ? status.statusHash : null,
    statusFiles: stable ? status.statusFiles : null,
    statusPaths: stable ? status.statusPaths : null,
    scannerVersion: SCANNER_VERSION,
    schemaVersion: SCHEMA_VERSION,
  };
}

// Scanner-only view: the public captureCurrentState contract stays compact,
// while scan/watcher persistence also needs the exact dirty paths from the
// SAME status pass as statusHash. A second `git status` would reopen the mixed-
// baseline race this module is meant to close.
function captureCurrentStateForIndexing(rootAbs) {
  return captureCurrentStateDetailed(rootAbs);
}

function captureCurrentState(rootAbs) {
  const state = captureCurrentStateDetailed(rootAbs);
  return {
    head: state.head,
    statusHash: state.statusHash,
    scannerVersion: state.scannerVersion,
    schemaVersion: state.schemaVersion,
  };
}

function sameRepoState(a, b) {
  return Boolean(
    a && b &&
    typeof a.head === "string" && a.head &&
    typeof b.head === "string" && b.head &&
    typeof a.statusHash === "string" && a.statusHash &&
    typeof b.statusHash === "string" && b.statusHash &&
    a.head === b.head &&
    a.statusHash === b.statusHash
  );
}

function newGraphGeneration() {
  return crypto.randomBytes(16).toString("hex");
}

function invalidateScanState(db, state) {
  graph.setMetaValue(db, META_HEAD, state && state.head ? state.head : "");
  graph.setMetaValue(db, META_STATUS_HASH, "");
  graph.setMetaValue(db, META_STATUS_FILES, "");
  graph.setMetaValue(db, META_SCANNER_VERSION, SCANNER_VERSION);
  graph.setMetaValue(db, META_SCHEMA_VERSION, SCHEMA_VERSION);
  graph.setMetaValue(db, META_GRAPH_GENERATION, newGraphGeneration());
}

// Persist state to db meta.  Call inside the same critical section that
// bumps generated_at and writes graph.db, so on-disk state is atomic.
function recordScanState(db, rootAbs, { expectedRepoState = null } = {}) {
  const state = captureCurrentStateDetailed(rootAbs);
  // A status snapshot without a stable, non-empty HEAD is not a Git anchor.
  // This deliberately keeps non-git/unborn roots and transient rev-parse
  // failures structurally stale; the separate Zoekt non-git lane still works.
  if (!state.head || !state.statusHash || (expectedRepoState && !sameRepoState(expectedRepoState, state))) {
    invalidateScanState(db, state);
    return false;
  }
  graph.setMetaValue(db, META_HEAD, state.head ?? "");
  graph.setMetaValue(db, META_STATUS_HASH, state.statusHash ?? "");
  graph.setMetaValue(db, META_SCANNER_VERSION, state.scannerVersion);
  graph.setMetaValue(db, META_SCHEMA_VERSION, state.schemaVersion);
  // The dirty-path MAP behind the status hash (docs/016 blast-radius fix):
  // v2 stores { rawPathHex: contentHash } for every dirty file, letting a consumer
  // distinguish drift caused by the session's own edits from foreign drift —
  // including content re-drift on a file that was ALREADY dirty at scan time
  // (adversarial-review MEDIUM: presence-only comparison was blind to that).
  // The map and fingerprint come from the same stabilized file reads; a second
  // status pass here would reintroduce a mixed-baseline race.
  graph.setMetaValue(db, META_STATUS_FILES, JSON.stringify(state.statusFiles));
  graph.setMetaValue(db, META_GRAPH_GENERATION, newGraphGeneration());
  return true;
}

function parseStoredStatusFiles(raw) {
  try {
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      parsed.version === STATUS_MAP_VERSION &&
      parsed.files &&
      typeof parsed.files === "object" &&
      !Array.isArray(parsed.files) &&
      Object.entries(parsed.files).every(
        ([rawHex, hash]) => /^(?:[0-9a-f]{2})+$/.test(rawHex) && typeof hash === "string"
      )
    ) {
      return parsed.files;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      // Backward-compatible reader for v1 { utf8Path: hash } maps.
      const files = {};
      for (const [filePath, hash] of Object.entries(parsed)) {
        if (filePath.endsWith("/") || typeof hash !== "string") return null;
        files[Buffer.from(filePath, "utf8").toString("hex")] = hash;
      }
      return files;
    }
  } catch {
    // Fall through to the fail-closed null below.
  }
  return null;
}

function decodeStoredStatusPaths(files) {
  if (!files) return null;
  const paths = [];
  for (const rawHex of Object.keys(files)) {
    const raw = Buffer.from(rawHex, "hex");
    const text = raw.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(raw)) return null;
    paths.push(text);
  }
  return paths;
}

// Persistence-only baseline. The watcher may advance a graph from one dirty
// worktree state to another only when the prior graph had a complete valid
// anchor and every path whose dirty state could have changed is re-indexed.
function getRecordedRepoState(db) {
  const statusFiles = parseStoredStatusFiles(graph.getMetaValue(db, META_STATUS_FILES));
  return {
    head: graph.getMetaValue(db, META_HEAD) || "",
    statusHash: graph.getMetaValue(db, META_STATUS_HASH) || "",
    statusFiles,
    statusPaths: decodeStoredStatusPaths(statusFiles),
    scannerVersion: graph.getMetaValue(db, META_SCANNER_VERSION) || "",
    schemaVersion: graph.getMetaValue(db, META_SCHEMA_VERSION) || "",
    graphGeneration: graph.getMetaValue(db, META_GRAPH_GENERATION) || "",
  };
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
    if (!storedHead) return false;
    const storedRaw = graph.getMetaValue(db, META_STATUS_FILES);
    if (!storedRaw) return false;
    const stored = parseStoredStatusFiles(storedRaw);
    if (!stored) return false;

    const current = captureCurrentStateDetailed(rootAbs);
    if (!current.statusFiles || storedHead !== (current.head || "")) return false;
    const currentFiles = current.statusFiles.files;
    const touched = new Set(
      [...(touchedSet || [])]
        .filter((p) => typeof p === "string")
        .map((p) => Buffer.from(p, "utf8").toString("hex"))
    );
    for (const rawHex of new Set([...Object.keys(currentFiles), ...Object.keys(stored)])) {
      if (touched.has(rawHex)) continue;
      if (!(rawHex in currentFiles) || !(rawHex in stored)) return false;
      if (currentFiles[rawHex] !== stored[rawHex]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Returns { fresh: boolean, reason: string | null, contentChanged: boolean,
//   evidence: object, validatedRepo?: { head, statusHash } }.
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
// `validatedRepo` is the exact current HEAD/status pair observed by this check;
// hot-path consumers can compare it again immediately before publication and
// avoid stamping newer repo state onto facts read from the validated graph.
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
  const graphGeneration = graph.getMetaValue(db, META_GRAPH_GENERATION) || "";

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
      graphGeneration,
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
    !stored.head ||
    !current.head ||
    ((current.head ?? "") !== stored.head) ||
    !stored.statusHash ||
    current.statusHash == null ||
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
      validatedRepo: { head: current.head, statusHash: current.statusHash },
      graphGeneration,
    };
  }
  if (stored.schemaVersion !== current.schemaVersion) {
    return {
      fresh: false,
      reason: "schema_version_changed",
      contentChanged,
      evidence: { stored: stored.schemaVersion, current: current.schemaVersion },
      validatedRepo: { head: current.head, statusHash: current.statusHash },
      graphGeneration,
    };
  }
  // A root that has NEVER been a git repository has no anchor — it does not
  // have a MOVED one. Before this branch such a root reported `head_changed`
  // with `contentChanged: true` hardcoded, forever: `!stored.head` is true on
  // every call because nothing was ever stored, so the condition below could
  // not go false no matter what happened. Measured on a fresh non-git fixture:
  // 3/3 consecutive checkFreshness calls stale immediately after a successful
  // scan, and still stale after `rescan --force` — a permanent blackout, plus a
  // successful-but-futile `freshness_gate` rescan enqueued on every read.
  //
  // We still withhold structure: without git there is no cheap tree
  // fingerprint, so freshness is genuinely UNVERIFIABLE and silent absence is
  // the honest answer (degrade, don't guess). What changes is that we stop
  // LYING about why, and stop paying for a rescan that cannot alter the
  // verdict — `rescanUseless` tells the gate not to enqueue one.
  //
  // Deliberately requires stored.head to be empty too: a repo that HAD git at
  // scan time and lost it (deleted .git, or a bad cwd) is a real anomaly and
  // must keep the loud head_changed path rather than being quietly reclassified.
  if (!stored.head && !current.head && !isGitRepo(rootAbs)) {
    return {
      fresh: false,
      reason: "git_absent",
      contentChanged,
      rescanUseless: true,
      evidence: { note: "no git repository at this root; freshness cannot be verified" },
      validatedRepo: { head: current.head, statusHash: current.statusHash },
      graphGeneration,
    };
  }
  // Treat null current.head/statusHash (git unavailable) as a soft signal:
  // if we previously had a value and now don't, the repo state can't be
  // verified.  Mark stale rather than risk a false-fresh.
  if (!stored.head || !current.head || current.head !== stored.head) {
    return {
      fresh: false,
      reason: "head_changed",
      contentChanged: true,
      evidence: { stored: stored.head, current: current.head },
      validatedRepo: { head: current.head, statusHash: current.statusHash },
      graphGeneration,
    };
  }
  if (!stored.statusHash || current.statusHash == null || (current.statusHash ?? "") !== stored.statusHash) {
    return {
      fresh: false,
      reason: "status_changed",
      contentChanged: true,
      evidence: {}, // hashes are useless to a human; reason is enough
      validatedRepo: { head: current.head, statusHash: current.statusHash },
      graphGeneration,
    };
  }

  return {
    fresh: true,
    reason: null,
    contentChanged: false,
    evidence: {},
    validatedRepo: { head: current.head, statusHash: current.statusHash },
    graphGeneration,
  };
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

  // Spawn an `sextant rescan` in the background. We use the binary on PATH
  // (mirrors how SessionStart starts the watcher; survives npm link).
  //
  // --allow-concurrent: the scan command refuses to run while the watcher
  // is alive by default, but here we *want* concurrent execution -- the
  // freshness gate fires precisely when the watcher's incremental flushes
  // didn't keep graph.db in sync with reality, and a fresh full scan is
  // the recovery.  The cross-process write lock at lib/graph.js prevents
  // corruption; the full file-identity-gated cache at lib/graph.js loadDb() ensures
  // the watcher's RAM copy gets invalidated on scan's persist, so it
  // resumes from the scan's fresh state instead of clobbering it.
  //
  // --force: drop any "no changes since last scan" optimisation -- we're
  // here precisely because the prior scan's state is no longer valid.
  let child;
  try {
    // `rescan`, not `scan`: gate-triggered healing must prune graph rows for
    // missed deletions/renames. A force-only scan re-extracts matches but keeps
    // ghosts, then could stamp the stale row current.
    child = spawn("sextant", ["rescan", "--allow-concurrent", "--force"], {
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
// RECENCY WINDOW + OUTLIER TRIM (docs/033 Tier 2 #4).
//
// The pool used to be EVERY scan.completed ever recorded — no window, no
// robustness. Two failures follow from that:
//
//   1. No window: a repo that got faster (or slower) takes hundreds of scans to
//      move its own estimate. On this repo the all-time p95 sat at 2202ms while
//      recent scans ran ~1.9s, i.e. the gate was reading history, not reality.
//
//   2. No robustness: scans that ran while the machine was loaded (a full test
//      suite) land at 10-19s. They are load artifacts, not the cost of scanning
//      this repo. On the last 50 samples here, two such spikes take the raw p95
//      from ~2.2s to 3.6s — over the cap, lane disabled. Measured directly:
//      all-time p95 2202 / last-50 raw 3609 / last-50 trimmed 2182.
//
// So: window to the most recent scans, then drop the slowest tenth before
// taking p95. Trimming weakens the worst-case guarantee (trimmed p95 sits near
// the raw p85), which is acceptable ONLY because the in-hook child is hard-
// killed at timeoutMs — the tail risk is bounded by the kill, not by this
// estimate. Without that kill this trim would be unsafe.
const SYNC_RESCAN_WINDOW = 50;
const SYNC_RESCAN_TRIM_FRACTION = 0.1;
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
//
// opts.versionOnly (docs/033 Tier 2 #5): the ONLY stale signal is a scanner or
// schema version bump — HEAD and the status fingerprint are unchanged. See the
// bypass below for why that case skips the stats gate.
function shouldSyncRescan(rootAbs, opts = {}) {
  const env = process.env.SEXTANT_SYNC_RESCAN;
  if (env === "0" || env === "false") return { sync: false, reason: "env_disabled" };

  try {
    const { loadRepoConfig } = require("./config");
    if (loadRepoConfig(rootAbs).syncRescan === false) {
      return { sync: false, reason: "config_disabled" };
    }
  } catch {}

  if (env === "1" || env === "force") {
    // Carry a reason so telemetry can separate the arms: lib/cli.js records
    // `gate: decision.reason || "stats"`, so a forced sync used to be logged as
    // gate:"stats" despite consulting no statistics at all (docs/033 Tier 3).
    return {
      sync: true,
      reason: "env_forced",
      p95: null,
      samples: 0,
      timeoutMs: SYNC_RESCAN_TIMEOUT_MAX_MS,
    };
  }

  // Collect scan durations + the most recent sync attempt from telemetry.
  // Current file first; .old appended only when the current window is thin.
  const telemetry = require("./telemetry");
  const durations = [];
  let lastSyncAttempt = null; // { ts, ok }
  const ingest = (file, sink) => {
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
        sink.push(e.durationMs);
      } else if (e.name === "freshness.sync_rescan") {
        const ts = Number(e.ts); // recordEvent stamps epoch ms
        if (Number.isFinite(ts) && (!lastSyncAttempt || ts > lastSyncAttempt.ts)) {
          lastSyncAttempt = { ts, ok: !!e.ok };
        }
      }
    }
  };
  // ORDER MATTERS (docs/033 Tier 3): `.old` holds the OLDER generation, so it
  // must land BEFORE the current file for `durations` to be in true append
  // order — the window below takes the tail as "most recent". Ingesting
  // current-then-old put older samples after newer ones, so in the thin branch
  // the genuinely most recent scans could fall outside the window entirely
  // (demonstrated: four 90s scans recorded as the newest samples were excluded
  // and the gate still returned {sync:true, p95:1500}). Bounded to <=4
  // misplaced rows and masked by the trim today, but the recency claim in the
  // comment below was simply false. Mirrors commands/telemetry.js:readAllEvents.
  //
  // The thin-branch test stays on the CURRENT file's own count, so a repo with
  // plenty of recent history never pays to parse `.old`.
  const current = [];
  const older = [];
  ingest(telemetry.telemetryPath(rootAbs), current);
  if (current.length < SYNC_RESCAN_MIN_SAMPLES) {
    ingest(telemetry.telemetryOldPath(rootAbs), older);
  }
  durations.push(...older, ...current);

  if (lastSyncAttempt && !lastSyncAttempt.ok &&
      Date.now() - lastSyncAttempt.ts < SYNC_RESCAN_FAILURE_COOLDOWN_MS) {
    return { sync: false, reason: "failure_cooldown" };
  }
  // VERSION-ONLY BYPASS (docs/033 Tier 2 #5).
  //
  // scanner_version_changed became the DOMINANT blackout cause on a dogfooded
  // repo — 76.2% of stale reads over the last 12 days, against 19.0% for
  // head_changed. Every one of those blackouts is self-inflicted: we shipped a
  // new scanner, so our own version stamp invalidated a graph built from bytes
  // that have not moved.
  //
  // That makes it the SAFEST possible sync-rescan case, not a marginal one:
  // content is unchanged, so the rescan cannot lose a race against the working
  // tree, and the post-scan checkFreshness re-verify (which still runs) has
  // nothing to catch unless the tree moves DURING the scan. It is also bounded
  // — once per upgrade per repo, not once per prompt.
  //
  // So a version-only stale read skips the p95/sample gate and takes the
  // maximum timeout. It does NOT skip the explicit env/config disables or the
  // failure cooldown — both are checked above, so an install that turned the
  // lane off stays off, and a repo whose last sync attempt failed backs away.
  if (opts.versionOnly === true) {
    return {
      sync: true,
      reason: "version_only",
      p95: null,
      samples: durations.length,
      timeoutMs: SYNC_RESCAN_TIMEOUT_MAX_MS,
    };
  }

  if (durations.length < SYNC_RESCAN_MIN_SAMPLES) {
    return { sync: false, reason: "insufficient_samples" };
  }

  // Recency window FIRST (durations are in append order after the ingest
  // ordering above, so the tail is the most recent), then sort, then drop the
  // slowest tenth as load artifacts.
  const recent = durations.slice(-SYNC_RESCAN_WINDOW);
  recent.sort((a, b) => a - b);
  const drop = Math.floor(recent.length * SYNC_RESCAN_TRIM_FRACTION);
  // NOTE: this floor is unreachable by construction and kept only as a guard
  // against a future change to SYNC_RESCAN_TRIM_FRACTION — drop = floor(0.1n)
  // leaves keep >= 0.9n >= SYNC_RESCAN_MIN_SAMPLES for every n >= 5.
  const keep = Math.max(SYNC_RESCAN_MIN_SAMPLES, recent.length - drop);
  const trimmed = recent.slice(0, keep);

  const p95 = percentileOf(trimmed, 95);
  // OPERATIONAL TOLERANCE (docs/033 Tier 3). The comment above says trimming
  // lowers the estimate to "roughly the raw p85". True, but it understates what
  // the lane will tolerate: p95-of-45 absorbs two more spikes beyond the five
  // the trim discards, so the measured flip point is 8 spikes in 50 — i.e. up
  // to 7 of the 50 most recent scans (14%) may exceed the timeout with the lane
  // still enabled. In that regime a stale read takes the sync arm, hangs the
  // prompt until timeoutMs, is killed, and blacks out anyway — strictly worse
  // than having gone async. It stays bounded rather than unbounded only because
  // the killed attempt records ok:false, which arms
  // SYNC_RESCAN_FAILURE_COOLDOWN_MS, capping the damage at one timeout-length
  // hang per 10 minutes.
  if (p95 > SYNC_RESCAN_MAX_P95_MS) {
    return { sync: false, reason: "p95_too_slow", p95, samples: trimmed.length };
  }
  const timeoutMs = Math.min(
    SYNC_RESCAN_TIMEOUT_MAX_MS,
    Math.max(SYNC_RESCAN_TIMEOUT_MIN_MS, 3 * p95)
  );
  return {
    sync: true,
    p95,
    samples: trimmed.length,
    // Observability: how much history the decision actually read, and how many
    // slow rows it set aside. Surfaces in doctor/telemetry when the lane's
    // behaviour needs explaining.
    windowed: recent.length,
    trimmed: recent.length - trimmed.length,
    timeoutMs,
  };
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
    const res = spawnSync(cmd, [...pre, "rescan", "--allow-concurrent", "--force"], {
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
// full file-identity-gated loadDb, picks up the scan's result and applies its queued changes
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
  META_GRAPH_GENERATION,
  RESCAN_MARKER_NAME,
  RESCAN_MARKER_STALE_MS,
  captureCurrentState,
  captureCurrentStateForIndexing,
  sameRepoState,
  getRecordedRepoState,
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
  SYNC_RESCAN_WINDOW,
  SYNC_RESCAN_TRIM_FRACTION,
  rescanMarkerPath,
  SCAN_MARKER_NAME,
  SCAN_MARKER_STALE_MS,
  scanMarkerPath,
  markScanInProgress,
  clearScanMarker,
  isScanInProgress,
};
