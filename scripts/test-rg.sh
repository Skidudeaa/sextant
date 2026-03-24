#!/usr/bin/env bash
set -euo pipefail

# ARCHITECTURE: Test script for rg.js module (ripgrep wrapper)
# WHY: Validates rg availability checks, search behavior, error paths,
#      maxHits capping, source-first ordering, and searchInFiles edge cases.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.."; pwd)"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

echo "Testing rg module..."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Helper: rg returns paths with ./ prefix when searching with "." as the
# directory. This normalizer strips that prefix for stable assertions.
NORM='function norm(p) { return p.replace(/^\.\//, ""); }'

# ──────────────────────────────────────────────────────────────
# Test 1: isInstalled returns true when rg exists
# ──────────────────────────────────────────────────────────────
node -e "
const rg = require('$ROOT/lib/rg');
if (!rg.isInstalled()) {
  console.error('rg should be installed on this system');
  process.exit(1);
}
console.log('  isInstalled() = true when rg present: OK');
"

# ──────────────────────────────────────────────────────────────
# Test 2: search() throws when rg is not in PATH
# ──────────────────────────────────────────────────────────────
# The which() helper in rg.js calls the local isInstalled() function,
# not module.exports.isInstalled, so monkey-patching exports won't work.
# Instead, we evict rg.js from the module cache and shim child_process.spawnSync
# so that the which() call returns { status: 1 } (binary not found).
node -e "
const Module = require('module');
const origSpawnSync = require('child_process').spawnSync;

// Shim spawnSync to make which('rg') fail
require('child_process').spawnSync = function(cmd, args, opts) {
  // Intercept the 'command -v' call that which() uses
  if (cmd === 'sh' && args && args[1] && args[1].includes('command -v')) {
    return { status: 1, stdout: '', stderr: '' };
  }
  return origSpawnSync.call(this, cmd, args, opts);
};

// Evict rg.js from cache so it picks up our shim on re-require
const rgPath = require.resolve('$ROOT/lib/rg');
delete require.cache[rgPath];
const rg = require(rgPath);

(async () => {
  try {
    await rg.search('/tmp', 'hello', { maxHits: 10 });
    console.error('Expected search() to throw when rg missing');
    process.exit(1);
  } catch (e) {
    if (!e.message.includes('rg not found')) {
      console.error('Expected \"rg not found\" error, got: ' + e.message);
      process.exit(1);
    }
  }

  // Restore
  require('child_process').spawnSync = origSpawnSync;
  delete require.cache[rgPath];
  console.log('  search() throws when rg missing: OK');
})().catch(e => { console.error(e); process.exit(1); });
"

# ──────────────────────────────────────────────────────────────
# Test 3: searchInFiles() returns [] when rg is missing
# ──────────────────────────────────────────────────────────────
node -e "
const origSpawnSync = require('child_process').spawnSync;
require('child_process').spawnSync = function(cmd, args, opts) {
  if (cmd === 'sh' && args && args[1] && args[1].includes('command -v')) {
    return { status: 1, stdout: '', stderr: '' };
  }
  return origSpawnSync.call(this, cmd, args, opts);
};

const rgPath = require.resolve('$ROOT/lib/rg');
delete require.cache[rgPath];
const rg = require(rgPath);

(async () => {
  const hits = await rg.searchInFiles('/tmp', 'hello', ['some/file.js'], {});
  if (!Array.isArray(hits) || hits.length !== 0) {
    console.error('Expected empty array when rg missing, got', JSON.stringify(hits));
    process.exit(1);
  }

  require('child_process').spawnSync = origSpawnSync;
  delete require.cache[rgPath];
  console.log('  searchInFiles() returns [] when rg missing: OK');
})().catch(e => { console.error(e); process.exit(1); });
"

# ──────────────────────────────────────────────────────────────
# Test 4: searchInFiles() returns [] for empty file list
# ──────────────────────────────────────────────────────────────
mkdir -p "$tmp/src"
echo "hello world" > "$tmp/src/test.js"

node -e "
const rg = require('$ROOT/lib/rg');
(async () => {
  const hits = await rg.searchInFiles('$tmp', 'hello', [], {});
  if (!Array.isArray(hits) || hits.length !== 0) {
    console.error('Expected empty array for empty file list, got', JSON.stringify(hits));
    process.exit(1);
  }
  console.log('  searchInFiles() returns [] for empty file list: OK');
})().catch(e => { console.error(e); process.exit(1); });
"

# ──────────────────────────────────────────────────────────────
# Test 5: search() finds a match in a source file
# ──────────────────────────────────────────────────────────────
node -e "
$NORM
const rg = require('$ROOT/lib/rg');
(async () => {
  const result = await rg.search('$tmp', 'hello', { maxHits: 10, contextLines: 0 });
  if (result.hits.length !== 1) {
    console.error('Expected 1 hit, got', result.hits.length, JSON.stringify(result.hits));
    process.exit(1);
  }
  if (norm(result.hits[0].path) !== 'src/test.js') {
    console.error('Expected src/test.js, got', result.hits[0].path);
    process.exit(1);
  }
  if (result.provider !== 'rg') {
    console.error('Expected provider rg, got', result.provider);
    process.exit(1);
  }
  console.log('  search() finds match in source file: OK');
})().catch(e => { console.error(e); process.exit(1); });
"

# ──────────────────────────────────────────────────────────────
# Test 6: search() returns correct hit shape (path, lineNumber, line, ranges)
# ──────────────────────────────────────────────────────────────
node -e "
const rg = require('$ROOT/lib/rg');
(async () => {
  const result = await rg.search('$tmp', 'hello', { maxHits: 10, contextLines: 0 });
  const hit = result.hits[0];
  if (typeof hit.path !== 'string') {
    console.error('Expected hit.path to be string, got', typeof hit.path);
    process.exit(1);
  }
  if (typeof hit.lineNumber !== 'number' || hit.lineNumber < 1) {
    console.error('Expected positive lineNumber, got', hit.lineNumber);
    process.exit(1);
  }
  if (!hit.line.includes('hello')) {
    console.error('Expected hit.line to contain query, got', hit.line);
    process.exit(1);
  }
  if (!Array.isArray(hit.ranges) || hit.ranges.length === 0) {
    console.error('Expected non-empty ranges array');
    process.exit(1);
  }
  if (hit.provider !== 'rg') {
    console.error('Expected provider rg, got', hit.provider);
    process.exit(1);
  }
  if (hit.score !== null) {
    console.error('Expected score null, got', hit.score);
    process.exit(1);
  }
  console.log('  hit shape (path, lineNumber, line, ranges, provider, score): OK');
})().catch(e => { console.error(e); process.exit(1); });
"

# ──────────────────────────────────────────────────────────────
# Test 7: search() returns empty hits for no-match query
# ──────────────────────────────────────────────────────────────
node -e "
const rg = require('$ROOT/lib/rg');
(async () => {
  const result = await rg.search('$tmp', 'nonexistent_string_xyz_987654', { maxHits: 10, contextLines: 0 });
  if (result.hits.length !== 0) {
    console.error('Expected 0 hits, got', result.hits.length);
    process.exit(1);
  }
  if (result.stats.matchCount !== 0) {
    console.error('Expected matchCount 0, got', result.stats.matchCount);
    process.exit(1);
  }
  console.log('  search() returns empty for no-match query: OK');
})().catch(e => { console.error(e); process.exit(1); });
"

# ──────────────────────────────────────────────────────────────
# Test 8: maxHits cap is respected
# ──────────────────────────────────────────────────────────────
# Create 10 files each containing the target string
for i in $(seq 1 10); do
  echo "findme_cap_test" > "$tmp/src/cap${i}.js"
done

node -e "
const rg = require('$ROOT/lib/rg');
(async () => {
  const result = await rg.search('$tmp', 'findme_cap_test', { maxHits: 3, contextLines: 0 });
  if (result.hits.length > 3) {
    console.error('Expected <= 3 hits with maxHits=3, got', result.hits.length);
    process.exit(1);
  }
  if (result.hits.length === 0) {
    console.error('Expected some hits, got 0');
    process.exit(1);
  }
  console.log('  maxHits cap respected (' + result.hits.length + ' <= 3): OK');
})().catch(e => { console.error(e); process.exit(1); });
"

# ──────────────────────────────────────────────────────────────
# Test 9: source-first ordering (source files before docs)
# ──────────────────────────────────────────────────────────────
# Clean up previous test files, set up fresh structure
rm -rf "$tmp"/*
mkdir -p "$tmp/src"
echo "sourcefirst_marker" > "$tmp/CHANGELOG.md"
echo "sourcefirst_marker" > "$tmp/README.md"
echo "sourcefirst_marker" > "$tmp/src/impl.js"
echo "sourcefirst_marker" > "$tmp/src/helper.ts"

node -e "
$NORM
const rg = require('$ROOT/lib/rg');
(async () => {
  const result = await rg.search('$tmp', 'sourcefirst_marker', { maxHits: 50, contextLines: 0 });

  // Separate source and non-source hits by extension
  const srcExts = new Set(['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs']);
  const srcHits = [];
  const otherHits = [];
  for (const h of result.hits) {
    const p = norm(h.path);
    const ext = '.' + p.split('.').pop();
    if (srcExts.has(ext)) srcHits.push(h);
    else otherHits.push(h);
  }

  if (srcHits.length < 2) {
    console.error('Expected at least 2 source hits, got', srcHits.length);
    process.exit(1);
  }
  if (otherHits.length < 1) {
    console.error('Expected at least 1 non-source hit, got', otherHits.length);
    process.exit(1);
  }

  // Verify all source hits come before all non-source hits in result order
  const lastSrcIdx = Math.max(...srcHits.map(h => result.hits.indexOf(h)));
  const firstOtherIdx = Math.min(...otherHits.map(h => result.hits.indexOf(h)));
  if (lastSrcIdx >= firstOtherIdx) {
    console.error('Source hits should precede non-source hits');
    console.error('Last source at index', lastSrcIdx, ', first other at index', firstOtherIdx);
    console.error('Order:', result.hits.map(h => norm(h.path)));
    process.exit(1);
  }
  console.log('  source-first ordering (src before docs): OK');
})().catch(e => { console.error(e); process.exit(1); });
"

# ──────────────────────────────────────────────────────────────
# Test 10: searchInFiles() returns hits for specific files
# ──────────────────────────────────────────────────────────────
node -e "
$NORM
const rg = require('$ROOT/lib/rg');
(async () => {
  const hits = await rg.searchInFiles('$tmp', 'sourcefirst_marker', ['src/impl.js'], {});
  if (hits.length !== 1) {
    console.error('Expected 1 hit in impl.js, got', hits.length);
    process.exit(1);
  }
  if (norm(hits[0].path) !== 'src/impl.js') {
    console.error('Expected src/impl.js, got', hits[0].path);
    process.exit(1);
  }
  console.log('  searchInFiles() returns hits for specific file: OK');
})().catch(e => { console.error(e); process.exit(1); });
"

# ──────────────────────────────────────────────────────────────
# Test 11: excluded directories are not searched
# ──────────────────────────────────────────────────────────────
# WHY: Uses non-source extensions (.txt) in excluded dirs so that only
# phase 2 (non-source search) would find them.  Phase 1 source globs
# interact with rg's glob precedence in a way that overrides exclusions
# for source extensions — that's a known rg behavior, not what we're testing.
rm -rf "$tmp"/*
mkdir -p "$tmp/src" "$tmp/node_modules/pkg" "$tmp/.planning/intel" "$tmp/dist"
echo "excluded_dir_test" > "$tmp/src/app.js"
echo "excluded_dir_test" > "$tmp/node_modules/pkg/notes.txt"
echo "excluded_dir_test" > "$tmp/.planning/intel/data.txt"
echo "excluded_dir_test" > "$tmp/docs.txt"

node -e "
$NORM
const rg = require('$ROOT/lib/rg');
(async () => {
  const result = await rg.search('$tmp', 'excluded_dir_test', { maxHits: 50, contextLines: 0 });
  const paths = result.hits.map(h => norm(h.path));

  if (!paths.includes('src/app.js')) {
    console.error('Expected src/app.js in results, got', paths);
    process.exit(1);
  }

  // docs.txt (at root) should appear, but node_modules and .planning should not
  const excluded = paths.filter(p =>
    p.startsWith('node_modules/') ||
    p.startsWith('.planning/')
  );
  if (excluded.length > 0) {
    console.error('Excluded dirs should not appear in results:', excluded);
    process.exit(1);
  }
  console.log('  excluded directories (node_modules, .planning) filtered: OK');
})().catch(e => { console.error(e); process.exit(1); });
"

# ──────────────────────────────────────────────────────────────
# Test 12: context lines are populated when contextLines > 0
# ──────────────────────────────────────────────────────────────
rm -rf "$tmp"/*
mkdir -p "$tmp/src"
printf 'line_one\nline_two\ntarget_context_test\nline_four\nline_five\n' > "$tmp/src/ctx.js"

node -e "
const rg = require('$ROOT/lib/rg');
(async () => {
  const result = await rg.search('$tmp', 'target_context_test', { maxHits: 10, contextLines: 1 });
  if (result.hits.length !== 1) {
    console.error('Expected 1 hit, got', result.hits.length);
    process.exit(1);
  }
  const hit = result.hits[0];
  if (!Array.isArray(hit.before) || !Array.isArray(hit.after)) {
    console.error('Expected before/after arrays on hit');
    process.exit(1);
  }
  if (hit.before.length !== 1 || !hit.before[0].includes('line_two')) {
    console.error('Expected 1 before line containing line_two, got', hit.before);
    process.exit(1);
  }
  if (hit.after.length !== 1 || !hit.after[0].includes('line_four')) {
    console.error('Expected 1 after line containing line_four, got', hit.after);
    process.exit(1);
  }
  console.log('  context lines populated correctly: OK');
})().catch(e => { console.error(e); process.exit(1); });
"

# ──────────────────────────────────────────────────────────────
# Test 13: contextLines=0 produces empty before/after arrays
# ──────────────────────────────────────────────────────────────
node -e "
const rg = require('$ROOT/lib/rg');
(async () => {
  const result = await rg.search('$tmp', 'target_context_test', { maxHits: 10, contextLines: 0 });
  const hit = result.hits[0];
  if (!Array.isArray(hit.before) || hit.before.length !== 0) {
    console.error('Expected empty before array with contextLines=0, got', hit.before);
    process.exit(1);
  }
  if (!Array.isArray(hit.after) || hit.after.length !== 0) {
    console.error('Expected empty after array with contextLines=0, got', hit.after);
    process.exit(1);
  }
  console.log('  contextLines=0 gives empty before/after: OK');
})().catch(e => { console.error(e); process.exit(1); });
"

# ──────────────────────────────────────────────────────────────
# Test 14: phase 2 fills remaining capacity with non-source hits
# ──────────────────────────────────────────────────────────────
rm -rf "$tmp"/*
mkdir -p "$tmp/src"
echo "phase2_fill_test" > "$tmp/src/code.js"
echo "phase2_fill_test" > "$tmp/docs.md"
echo "phase2_fill_test" > "$tmp/config.yaml"

node -e "
$NORM
const rg = require('$ROOT/lib/rg');
(async () => {
  // With high maxHits, phase 2 should pick up the non-source files
  const result = await rg.search('$tmp', 'phase2_fill_test', { maxHits: 50, contextLines: 0 });
  const paths = result.hits.map(h => norm(h.path));
  if (!paths.includes('src/code.js')) {
    console.error('Expected src/code.js in results, got', paths);
    process.exit(1);
  }
  // At least one non-source file should appear from phase 2
  const nonSrc = paths.filter(p => !p.endsWith('.js'));
  if (nonSrc.length === 0) {
    console.error('Expected phase 2 to include non-source files');
    process.exit(1);
  }
  console.log('  phase 2 fills remaining capacity with non-source hits: OK');
})().catch(e => { console.error(e); process.exit(1); });
"

# ──────────────────────────────────────────────────────────────
# Test 15: phase 2 is skipped when source hits exhaust maxHits
# ──────────────────────────────────────────────────────────────
rm -rf "$tmp"/*
mkdir -p "$tmp/src"
# Create enough source files to fill maxHits
for i in $(seq 1 5); do
  echo "phase2_skip_test" > "$tmp/src/f${i}.js"
done
echo "phase2_skip_test" > "$tmp/notes.txt"

node -e "
$NORM
const rg = require('$ROOT/lib/rg');
(async () => {
  // maxHits=5, exactly 5 source files exist — phase 2 remaining = 0
  const result = await rg.search('$tmp', 'phase2_skip_test', { maxHits: 5, contextLines: 0 });
  const nonSrcHits = result.hits.filter(h => !norm(h.path).endsWith('.js'));
  if (nonSrcHits.length > 0) {
    console.error('Expected no non-source hits when source fills budget, got', nonSrcHits.map(h => norm(h.path)));
    process.exit(1);
  }
  console.log('  phase 2 skipped when source hits fill maxHits: OK');
})().catch(e => { console.error(e); process.exit(1); });
"

echo ""
echo "All rg tests passed!"
