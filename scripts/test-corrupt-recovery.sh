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
# Test 2: Legacy index.json -> should migrate to graph.db
# ---------------------------------------------------------------------------
echo ""
echo "Test 2: Legacy index.json -> migrate"

t2="$tmp/t2"
mkdir -p "$t2/.planning/intel"
# Write a valid legacy index.json
cat > "$t2/.planning/intel/index.json" <<'INDEXEOF'
{
  "version": 2,
  "generatedAt": "2026-03-24T00:00:00.000Z",
  "files": {
    "app.js": {
      "type": "js",
      "sizeBytes": 100,
      "mtimeMs": 12345,
      "imports": [{ "specifier": "./util", "resolved": "util.js", "kind": "relative" }],
      "exports": [{ "name": "main", "kind": "named" }]
    },
    "util.js": {
      "type": "js",
      "sizeBytes": 50,
      "mtimeMs": 12346,
      "imports": [],
      "exports": [{ "name": "helper", "kind": "named" }]
    }
  }
}
INDEXEOF

out2="$(node -e "
const intel = require('$ROOT/lib/intel');
const fs = require('fs');
const path = require('path');
const graph = require('$ROOT/lib/graph');
(async () => {
  await intel.init('$t2');
  const s = intel.readSummary('$t2');
  console.log(s !== null ? 'init_ok' : 'init_fail');
  // Verify index.json was renamed to .migrated
  const indexExists = fs.existsSync(path.join('$t2', '.planning', 'intel', 'index.json'));
  const migratedExists = fs.existsSync(path.join('$t2', '.planning', 'intel', 'index.json.migrated'));
  console.log('index_gone:' + !indexExists);
  console.log('migrated_exists:' + migratedExists);
  // Verify data is in graph.db
  const db = await graph.loadDb('$t2');
  const count = graph.countFiles(db);
  console.log('graph_files:' + count);
  const meta = graph.getFileMeta(db, 'app.js');
  console.log('app_type:' + (meta ? meta.type : 'missing'));
})().catch(e => { console.error(e); process.exit(1); });
" 2>/dev/null)"

echo "$out2" | grep -q "init_ok" || fail "init failed after index.json migration (got: $out2)"
echo "$out2" | grep -q "index_gone:true" || fail "index.json still exists after migration (got: $out2)"
echo "$out2" | grep -q "migrated_exists:true" || fail "index.json.migrated not created (got: $out2)"
echo "$out2" | grep -q "graph_files:2" || fail "graph.db doesn't have migrated files (got: $out2)"
echo "$out2" | grep -q "app_type:js" || fail "migrated file metadata incorrect (got: $out2)"
echo "  Legacy index.json migration: OK"

# ---------------------------------------------------------------------------
# Test 2b: Invalid JSON in index.json -> should rename to .migrated
# ---------------------------------------------------------------------------
echo ""
echo "Test 2b: Invalid index.json -> rename to .migrated"

t2b="$tmp/t2b"
mkdir -p "$t2b/.planning/intel"
# Write invalid JSON
echo '{invalid json!!!' > "$t2b/.planning/intel/index.json"

out2b="$(node -e "
const intel = require('$ROOT/lib/intel');
const fs = require('fs');
const path = require('path');
(async () => {
  await intel.init('$t2b');
  const s = intel.readSummary('$t2b');
  console.log(s !== null ? 'init_ok' : 'init_fail');
  const indexExists = fs.existsSync(path.join('$t2b', '.planning', 'intel', 'index.json'));
  const migratedExists = fs.existsSync(path.join('$t2b', '.planning', 'intel', 'index.json.migrated'));
  console.log('index_gone:' + !indexExists);
  console.log('migrated_exists:' + migratedExists);
})().catch(e => { console.error(e); process.exit(1); });
" 2>/dev/null)"

echo "$out2b" | grep -q "init_ok" || fail "init failed after invalid index.json (got: $out2b)"
echo "$out2b" | grep -q "index_gone:true" || fail "invalid index.json still exists (got: $out2b)"
echo "$out2b" | grep -q "migrated_exists:true" || fail "invalid index.json not renamed to .migrated (got: $out2b)"
echo "  Invalid index.json rename: OK"

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
  // Check that default state files were created (no more index.json)
  const hasGraphDb = fs.existsSync(path.join(dir, 'graph.db'));
  const hasSummary = fs.existsSync(path.join(dir, 'summary.md'));
  console.log('dir_created');
  console.log('graph:' + hasGraphDb);
  console.log('summary:' + hasSummary);
})().catch(e => { console.error(e); process.exit(1); });
" 2>/dev/null)"

echo "$out4" | grep -q "dir_created" || fail ".planning/intel/ was not created (got: $out4)"
echo "$out4" | grep -q "summary:true" || fail "summary.md was not created (got: $out4)"
echo "  Missing directory creation: OK"

echo ""
echo "All corrupt state recovery tests passed!"
