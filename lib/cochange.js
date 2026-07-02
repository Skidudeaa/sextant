"use strict";

// Co-change mining (blast-radius lane, docs/016 Sprint 1).
//
// Parses `git log --name-only` and computes file-pair co-change counts +
// confidence (count / min(occurrences)).  Recon grounding (docs/016-phase0-recon.md,
// R2): raw pairs are 40-86% junk (CHANGELOG/todos/docs), but filtering to
// indexed source files leaves ~0% junk and genuinely additive signal — 37% of
// sextant's own filtered pairs have NO import edge (hub-orchestrated siblings
// the import graph structurally cannot see).
//
// Two v1 requirements promoted from follow-ups by the R2 data:
//   1. source filter — callers pass `isIncluded` (graph membership: the file
//      is currently indexed).  Graph membership subsumes isIndexable() AND the
//      repo's ignore globs / .gitignore / vendored exclusions, so history-only
//      files (deleted, renamed away, out of scope) never produce pairs.
//   2. hub dampener — god files co-change with everything; each kept file gets
//      a degree (distinct-partner count) so query time can drop hub partners.
//
// READ-ONLY on the repo: only `git log` is invoked.

const { execFileSync } = require("child_process");

// Commits touching more than this many files are bulk renames/refactors —
// R2 measured them at 2-5% of commits everywhere, so exclusion loses little
// history while avoiding O(N^2) pair blowups and rename noise.
const MAX_FILES_PER_COMMIT = 20;
// Bound git-log parse cost on huge repos; recent history is also the relevant
// history for "what moves together NOW".
const MAX_COMMITS = 3000;
// R2's reporting floor: pairs seen together fewer than 3 times are noise.
const MIN_PAIR_COUNT = 3;
// Bound stored rows (graph.db size) on pathological repos.
const MAX_STORED_PAIRS = 5000;

// Parse `git log --name-only` into [{ hash, files: [...] }].  Returns [] for
// non-git repos / git failures — co-change is strictly best-effort.
function parseGitLog(rootAbs, { maxCommits = MAX_COMMITS } = {}) {
  let raw;
  try {
    raw = execFileSync(
      "git",
      [
        "log",
        `-n${maxCommits}`,
        "--name-only",
        "--no-merges",
        "--pretty=format:%x01COMMIT%x01%H",
      ],
      { cwd: rootAbs, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" }
    );
  } catch {
    return [];
  }
  const commits = [];
  let cur = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("\x01COMMIT\x01")) {
      if (cur) commits.push(cur);
      cur = { hash: line.slice("\x01COMMIT\x01".length), files: [] };
    } else if (line.trim() !== "" && cur) {
      cur.files.push(line.trim());
    }
  }
  if (cur) commits.push(cur);
  return commits;
}

// Pure pair computation over parsed commits.  `isIncluded(relPath)` gates
// which files participate at all — filtering BEFORE pairing, so an excluded
// file neither pairs nor inflates another file's occurrence count.
// Pair keys join with \x00 (filenames can contain spaces).
function computeCoChange(
  commits,
  {
    isIncluded = () => true,
    maxFilesPerCommit = MAX_FILES_PER_COMMIT,
    minCount = MIN_PAIR_COUNT,
    maxPairs = MAX_STORED_PAIRS,
  } = {}
) {
  const pairCounts = new Map(); // "a\x00b" (a<b) -> count
  const fileOccur = new Map(); // file -> commits touching it (post-filter)
  let excludedCommits = 0;
  let usedCommits = 0;

  for (const c of commits) {
    // Dedupe within commit, then apply the source filter.  The >maxFiles
    // exclusion uses the RAW touched-file count: a 200-file vendor drop that
    // happens to include 3 source files is still a bulk commit, not evidence
    // those 3 files belong together.
    const rawFiles = [...new Set(c.files)];
    if (rawFiles.length === 0) continue;
    if (rawFiles.length > maxFilesPerCommit) {
      excludedCommits++;
      continue;
    }
    const files = rawFiles.filter((f) => isIncluded(f));
    if (files.length === 0) continue;
    usedCommits++;
    for (const f of files) fileOccur.set(f, (fileOccur.get(f) || 0) + 1);
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const a = files[i] < files[j] ? files[i] : files[j];
        const b = files[i] < files[j] ? files[j] : files[i];
        const key = `${a}\x00${b}`;
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
    }
  }

  let pairs = [];
  for (const [key, count] of pairCounts.entries()) {
    if (count < minCount) continue;
    const idx = key.indexOf("\x00");
    const a = key.slice(0, idx);
    const b = key.slice(idx + 1);
    const confidence =
      count / Math.min(fileOccur.get(a) || 1, fileOccur.get(b) || 1);
    pairs.push({ a, b, count, confidence });
  }
  pairs.sort((x, y) => y.count - x.count || y.confidence - x.confidence);
  if (pairs.length > maxPairs) pairs = pairs.slice(0, maxPairs);

  // Degree = distinct partners among KEPT pairs.  Persisted alongside pairs so
  // query time can dampen hubs without recomputing (pairs are replaced
  // wholesale each bulk scan, so this can't go stale relative to the table).
  // KNOWN TRADEOFF: on a repo with >maxPairs qualifying pairs, a hub whose
  // partnerships are spread across many low-count pairs can have its degree
  // undercounted (its tail falls off the cap) and slip under hubMaxDegree —
  // the cap bounds db size at the cost of degree accuracy on such repos.
  const degree = new Map();
  for (const p of pairs) {
    degree.set(p.a, (degree.get(p.a) || 0) + 1);
    degree.set(p.b, (degree.get(p.b) || 0) + 1);
  }

  return {
    pairs,
    degree,
    usedCommits,
    excludedCommits,
    totalCommits: commits.length,
  };
}

// One-call convenience for the scan path.
function mineCoChange(rootAbs, opts = {}) {
  const commits = parseGitLog(rootAbs, opts);
  return computeCoChange(commits, opts);
}

module.exports = {
  parseGitLog,
  computeCoChange,
  mineCoChange,
  MAX_FILES_PER_COMMIT,
  MAX_COMMITS,
  MIN_PAIR_COUNT,
  MAX_STORED_PAIRS,
};
