"use strict";

// WHY THIS EXISTS (2026-07-10 incident): sextant handed zoekt-index the RAW
// root with default flags. zoekt's only default exclusions are .git/.hg/.svn —
// no .gitignore, no node_modules, none of sextant's own ignore/vendored
// filters — and every file up to 2 MiB is read and indexed. Pointed at a big
// directory (the incident: a user's home dir, mis-adopted as a root), that
// grew a 101 GB index, rebuilt in full every ~3 minutes by the watcher.
//
// This module is the zoekt lane's scope + hygiene layer, shared by
// lib/zoekt.js (buildIndex, sync) and lib/zoekt-reindex.js (triggerReindex,
// spawned):
//   - ZOEKT_IGNORE_DIRS   — dir basenames passed as -ignore_dirs (non-git path)
//   - estimateCorpusBytes — early-exit pre-check so a huge corpus is refused
//                           BEFORE a single shard is written
//   - index-size circuit breaker — an index dir past the cap is deleted and
//                           the lane disabled via a persisted marker
//   - cleanupTmpShards    — interrupted zoekt runs leak *.tmp shards that
//                           nothing else ever deletes
//
// Disabling is loud, not silent: the marker carries the reason, `sextant
// doctor` surfaces it with the re-enable command, and search degrades to rg
// (retrieve() already falls back when zoekt errors).

const fs = require("fs");
const path = require("path");

const { stateDir } = require("./utils");

// Dir BASENAMES (zoekt-index -ignore_dirs matches names, not globs) that must
// never be walked. Mirrors zoekt's defaults + sextant's graph ignore floor
// (lib/config.js) + the vendored-dir conventions (lib/project-scope.js) + the
// user-machine dirs that only appear when a broad directory is indexed.
// Same caveat as the graph floor: a repo whose real source lives in a dir with
// one of these names needs a config override.
const ZOEKT_IGNORE_DIRS = [
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".planning", // sextant's own state — the index must never index itself
  ".claude",
  // vendored conventions
  "vendor",
  "Pods",
  "Carthage",
  "third_party",
  "bower_components",
  "external",
  "deps",
  // build / generated output
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".cache",
  ".turbo",
  ".svelte-kit",
  ".nuxt",
  ".output",
  ".vercel",
  // Python
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  "site-packages",
  // user-machine dirs (matter only when a broad root slips past the guard)
  "Library",
  "DerivedData",
  ".Trash",
  ".npm",
  ".gradle",
  ".m2",
  ".cargo",
];

// zoekt-index skips files over its -file_limit (2 MiB default) — the corpus
// estimate must count the same population or it overestimates.
const ZOEKT_FILE_LIMIT_BYTES = 2 * 1024 * 1024;

const DEFAULT_MAX_CORPUS_BYTES = 512 * 1024 * 1024; // 512 MiB of indexable text
const DEFAULT_MAX_INDEX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB of shards
// Walk backstop: a tree of millions of tiny files can stay under the byte cap
// while making the pre-check walk itself pathological. Past this many entries
// the corpus is treated as too large.
const MAX_WALK_ENTRIES = 200000;

const TMP_SHARD_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

function zoektDirOf(root) {
  return path.join(stateDir(root), "zoekt");
}

function zoektIndexDirOf(root) {
  return path.join(zoektDirOf(root), "index");
}

function disabledMarkerPath(root) {
  return path.join(zoektDirOf(root), ".disabled.json");
}

// Caps are read straight from .codebase-intel.json (not loadRepoConfig — the
// full config load runs vendored detection + .gitignore parsing, which the
// reindex trigger doesn't need).
function readZoektCaps(root) {
  let cfg = null;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(root, ".codebase-intel.json"), "utf8"));
  } catch {}
  const num = (v, dflt) => (Number.isFinite(v) && v > 0 ? v : dflt);
  return {
    maxCorpusBytes: num(cfg?.zoektMaxCorpusBytes, DEFAULT_MAX_CORPUS_BYTES),
    maxIndexBytes: num(cfg?.zoektMaxIndexBytes, DEFAULT_MAX_INDEX_BYTES),
  };
}

function readDisabled(root) {
  try {
    const d = JSON.parse(fs.readFileSync(disabledMarkerPath(root), "utf8"));
    return d && typeof d === "object" ? d : null;
  } catch {
    return null;
  }
}

function isDisabled(root) {
  return readDisabled(root) != null;
}

function writeDisabled(root, { reason, detail }) {
  try {
    fs.mkdirSync(zoektDirOf(root), { recursive: true });
    fs.writeFileSync(
      disabledMarkerPath(root),
      JSON.stringify({ reason, detail, at: new Date().toISOString() }, null, 2) + "\n"
    );
  } catch {}
  // Loud in the audit stream too — this is a health event, not routine churn.
  try {
    const { recordEvent } = require("./telemetry");
    recordEvent(path.resolve(root), "zoekt.disabled", { reason });
  } catch {}
}

function clearDisabled(root) {
  try {
    fs.unlinkSync(disabledMarkerPath(root));
  } catch {}
}

// Early-exit corpus estimate over the same population zoekt-index would walk:
// prune ZOEKT_IGNORE_DIRS, skip symlinks, count regular files ≤ file_limit.
// Returns as soon as the cap is exceeded, so the pre-check on a huge tree
// costs one partial stat-only walk, never a full one.
function estimateCorpusBytes(root, { capBytes, maxFileBytes = ZOEKT_FILE_LIMIT_BYTES, maxEntries = MAX_WALK_ENTRIES } = {}) {
  const ignore = new Set(ZOEKT_IGNORE_DIRS);
  let bytes = 0;
  let entries = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let dirents;
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — zoekt would skip it too
    }
    for (const de of dirents) {
      entries++;
      if (entries > maxEntries) return { bytes, exceeded: true, reason: "entry-count" };
      if (de.isSymbolicLink()) continue;
      if (de.isDirectory()) {
        if (ignore.has(de.name)) continue;
        stack.push(path.join(dir, de.name));
        continue;
      }
      if (!de.isFile()) continue;
      let size = 0;
      try {
        size = fs.statSync(path.join(dir, de.name)).size;
      } catch {
        continue;
      }
      if (size > maxFileBytes) continue; // zoekt records these as skipped, ~0 cost
      bytes += size;
      if (capBytes != null && bytes > capBytes) {
        return { bytes, exceeded: true, reason: "byte-cap" };
      }
    }
  }
  return { bytes, exceeded: false };
}

function dirSizeBytes(dir) {
  let bytes = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop();
    let dirents;
    try {
      dirents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const de of dirents) {
      if (de.isSymbolicLink()) continue;
      const p = path.join(d, de.name);
      if (de.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!de.isFile()) continue;
      try {
        bytes += fs.statSync(p).size;
      } catch {}
    }
  }
  return bytes;
}

// Interrupted zoekt runs (reboot, kill, sleep-then-die) leave *.tmp shard
// files that zoekt only cleans up in-process — on a watcher cadence they
// accumulate without bound. Age-gated so a LIVE indexer's in-flight tmp files
// are never yanked out from under it.
function cleanupTmpShards(indexDir, { maxAgeMs = TMP_SHARD_MAX_AGE_MS, nowMs = Date.now() } = {}) {
  let removed = 0;
  let names;
  try {
    names = fs.readdirSync(indexDir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.includes(".tmp")) continue;
    const p = path.join(indexDir, name);
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      if (nowMs - st.mtimeMs > maxAgeMs) {
        fs.unlinkSync(p);
        removed++;
      }
    } catch {}
  }
  return removed;
}

// The circuit breaker: an index dir past the cap is evidence the scope
// controls failed (or the caps are misconfigured for this repo) — delete the
// shards, persist the disabled marker, and stop the lane until a human looks.
// Returns { disabled: boolean, bytes }.
function checkIndexSizeCap(root, caps = readZoektCaps(root)) {
  const indexDir = zoektIndexDirOf(root);
  const bytes = dirSizeBytes(indexDir);
  if (bytes <= caps.maxIndexBytes) return { disabled: false, bytes };
  try {
    fs.rmSync(indexDir, { recursive: true, force: true });
  } catch {}
  writeDisabled(root, {
    reason: "index-size-cap",
    detail: `index dir reached ${Math.round(bytes / (1024 * 1024))} MiB (cap ${Math.round(caps.maxIndexBytes / (1024 * 1024))} MiB); shards deleted`,
  });
  return { disabled: true, bytes };
}

// SECRET-BEARING PATHS (docs/035 #2).
//
// `zoekt-index` has NO file-level exclusion — only `-ignore_dirs` — so on the
// non-git path (which walks the LIVE tree, not committed content) the shard
// contains whatever secrets sit in the working directory, gitignored or not.
// Verified on a fixture: a fake `sk_live_…` token in a gitignored `.env` was
// found inside the built shard, and `zoekt.search` returned the full line —
// value included — at score 501, with the DB password in the `after` context.
// `format-retrieval.js:133` slices 60 raw characters of a matched line into the
// prompt, and that excerpt is explicitly designed to survive the content-stale
// strip. A `grep -niE "redact|secret|sanitiz"` across the injection path
// returned zero hits: there was no redaction anywhere.
//
// Enforcement therefore lives where hits are PRODUCED, not where the index is
// built. That placement is deliberate and buys three things a build-time filter
// could not: it protects shards built by an older sextant, it survives an index
// this code did not create, and it covers git roots too — a committed `.env` is
// a common accident and `zoekt-git-index` indexes committed content faithfully.
//
// `.env.example` / `.env.sample` / `.env.template` / `.env.dist` are
// deliberately NOT matched: they are the declared-manifest signal (required env
// KEYS) that sextant wants to surface, and by convention they carry names
// without values.
const SENSITIVE_BASENAMES = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  "_netrc",
  ".git-credentials",
  ".htpasswd",
  "credentials",
  "credentials.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);
const SENSITIVE_EXTENSIONS = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  ".ppk",
  ".asc",
]);
const ENV_EXAMPLE_SUFFIXES = ["example", "sample", "template", "dist", "defaults"];

function isSensitivePath(relPath) {
  if (typeof relPath !== "string" || !relPath) return false;
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const segments = normalized.split("/");
  const base = segments[segments.length - 1];
  if (!base) return false;
  const lower = base.toLowerCase();

  // Anything under an .ssh/ or .gnupg/ directory, at any depth.
  if (segments.some((s) => s === ".ssh" || s === ".gnupg")) return true;

  if (SENSITIVE_BASENAMES.has(lower)) return true;

  const dot = lower.lastIndexOf(".");
  if (dot > 0 && SENSITIVE_EXTENSIONS.has(lower.slice(dot))) return true;

  // .env, .env.local, .env.production — but not the *.example family. Compare
  // on the FINAL dot-segment so `.env.production.local` is still matched and
  // `.env.example` is still exempt.
  if (lower === ".env") return true;
  if (lower.startsWith(".env.")) {
    const tail = lower.slice(lower.lastIndexOf(".") + 1);
    return !ENV_EXAMPLE_SUFFIXES.includes(tail);
  }
  // `env.example`-style without the leading dot is a template too; a bare
  // `env` file is too generic to claim as a secret, so it is left alone.

  return false;
}

module.exports = {
  ZOEKT_IGNORE_DIRS,
  ZOEKT_FILE_LIMIT_BYTES,
  isSensitivePath,
  DEFAULT_MAX_CORPUS_BYTES,
  DEFAULT_MAX_INDEX_BYTES,
  TMP_SHARD_MAX_AGE_MS,
  zoektIndexDirOf,
  disabledMarkerPath,
  readZoektCaps,
  readDisabled,
  isDisabled,
  writeDisabled,
  clearDisabled,
  estimateCorpusBytes,
  dirSizeBytes,
  cleanupTmpShards,
  checkIndexSizeCap,
};
