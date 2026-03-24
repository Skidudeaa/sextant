#!/usr/bin/env bash
set -euo pipefail

# ARCHITECTURE: Test script for corrupt state recovery
# WHY: Validates that sextant handles corrupt/missing state files gracefully
# TRADEOFF: Manual test script vs full test framework (matches existing pattern)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.."; pwd)"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Testing corrupt state recovery..."

# ---------------------------------------------------------------------------
# Test 1: Corrupt graph.db -> should rebuild cleanly
# ---------------------------------------------------------------------------
echo ""
echo "Test 1: Corrupt graph.db -> rebuild"

t1="$tmp/t1"
mkdir -p "$t1/.planning/intel"
# Write random binary garbage to graph.db
dd if=/dev/urandom of="$t1/.planning/intel/graph.db" bs=256 count=1 2>/dev/null

out1="$(node -e "
const graph = require('$ROOT/lib/graph');
(async () => {
  const db = await graph.loadDb('$t1');
  const stmt = db.prepare('SELECT COUNT(*) AS c FROM files');
  stmt.step();
  const count = stmt.getAsObject().c;
  stmt.free();
  console.log('count:' + count);
})().catch(e => { console.error(e); process.exit(1); });
" 2>/dev/null)"

echo "$out1" | grep -q "count:0" || fail "corrupt graph.db did not rebuild to 0 files (got: $out1)"
echo "  Corrupt graph.db rebuilt cleanly: OK"

# ---------------------------------------------------------------------------
# Test 2: Invalid JSON in index.json -> should reinitialize
# ---------------------------------------------------------------------------
echo ""
echo "Test 2: Invalid index.json -> reinitialize"

t2="$tmp/t2"
mkdir -p "$t2/.planning/intel"
# Write invalid JSON
echo '{invalid json!!!' > "$t2/.planning/intel/index.json"

out2="$(node -e "
const intel = require('$ROOT/lib/intel');
(async () => {
  await intel.init('$t2');
  const s = intel.readSummary('$t2');
  // readSummary returns string or null; after init, summary.md should exist (possibly empty)
  console.log(s !== null ? 'init_ok' : 'init_fail');
  // Verify index.json was rewritten as valid JSON
  const fs = require('fs');
  const path = require('path');
  const idx = JSON.parse(fs.readFileSync(path.join('$t2', '.planning', 'intel', 'index.json'), 'utf8'));
  console.log(idx && idx.files && typeof idx.files === 'object' ? 'index_valid' : 'index_invalid');
})().catch(e => { console.error(e); process.exit(1); });
" 2>/dev/null)"

echo "$out2" | grep -q "init_ok" || fail "init failed after invalid index.json (got: $out2)"
echo "$out2" | grep -q "index_valid" || fail "index.json not rewritten as valid JSON (got: $out2)"
echo "  Invalid index.json recovery: OK"

# ---------------------------------------------------------------------------
# Test 3: Empty/truncated summary.md -> should regenerate
# ---------------------------------------------------------------------------
echo ""
echo "Test 3: Empty summary.md -> regenerate"

t3="$tmp/t3"
mkdir -p "$t3/.planning/intel"
# Write empty string to summary.md
printf '' > "$t3/.planning/intel/summary.md"

out3="$(node -e "
const intel = require('$ROOT/lib/intel');
(async () => {
  await intel.init('$t3');
  await intel.writeSummary('$t3', { force: true });
  const s = intel.readSummary('$t3');
  if (s && s.trim().length > 0) {
    console.log('regenerated');
  } else {
    console.log('still_empty');
  }
})().catch(e => { console.error(e); process.exit(1); });
" 2>/dev/null)"

echo "$out3" | grep -q "regenerated" || fail "empty summary.md was not regenerated (got: $out3)"
echo "  Empty summary.md regeneration: OK"

# ---------------------------------------------------------------------------
# Test 4: Missing .planning/intel/ directory -> should create it
# ---------------------------------------------------------------------------
echo ""
echo "Test 4: Missing .planning/intel/ -> create"

t4="$tmp/t4"
# Deliberately do NOT create .planning/intel/
mkdir -p "$t4"

out4="$(node -e "
const intel = require('$ROOT/lib/intel');
const fs = require('fs');
const path = require('path');
(async () => {
  await intel.init('$t4');
  const dir = path.join('$t4', '.planning', 'intel');
  if (!fs.existsSync(dir)) {
    console.log('dir_missing');
    return;
  }
  // Check that default state files were created
  const hasIndex = fs.existsSync(path.join(dir, 'index.json'));
  const hasGraphDb = fs.existsSync(path.join(dir, 'graph.db'));
  const hasSummary = fs.existsSync(path.join(dir, 'summary.md'));
  console.log('dir_created');
  console.log('index:' + hasIndex);
  console.log('graph:' + hasGraphDb);
  console.log('summary:' + hasSummary);
})().catch(e => { console.error(e); process.exit(1); });
" 2>/dev/null)"

echo "$out4" | grep -q "dir_created" || fail ".planning/intel/ was not created (got: $out4)"
echo "$out4" | grep -q "index:true" || fail "index.json was not created (got: $out4)"
echo "$out4" | grep -q "summary:true" || fail "summary.md was not created (got: $out4)"
echo "  Missing directory creation: OK"

echo ""
echo "All corrupt state recovery tests passed!"
