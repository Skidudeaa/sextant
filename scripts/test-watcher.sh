#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.."; pwd)"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

echo "Testing watcher heartbeat functions..."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/.planning/intel"

# Test 1: writeHeartbeat creates heartbeat file and last_file
node -e "
const w = require('$ROOT/watch');
w.writeHeartbeat('$tmp', 'test.js');
"
[ -f "$tmp/.planning/intel/.watcher_heartbeat" ] || fail "heartbeat not created"
grep -q "test.js" "$tmp/.planning/intel/.watcher_last_file" || fail "last file not written"
echo "  writeHeartbeat creates files: OK"

# Test 2: clearHeartbeat removes heartbeat file
node -e "
const w = require('$ROOT/watch');
w.clearHeartbeat('$tmp');
"
[ ! -f "$tmp/.planning/intel/.watcher_heartbeat" ] || fail "heartbeat not cleared"
echo "  clearHeartbeat removes heartbeat: OK"

# Test 3: writeHeartbeat without lastFile only writes heartbeat, not last_file
rm -f "$tmp/.planning/intel/.watcher_last_file"
node -e "
const w = require('$ROOT/watch');
w.writeHeartbeat('$tmp');
"
[ -f "$tmp/.planning/intel/.watcher_heartbeat" ] || fail "heartbeat not created (no lastFile)"
[ ! -f "$tmp/.planning/intel/.watcher_last_file" ] || fail "last_file should not be written when no file provided"
echo "  writeHeartbeat without lastFile skips last_file: OK"

# Test 4: Heartbeat content has valid ISO timestamp on first line + JSON payload
# (Format changed: line 1 is ISO for liveness, line 2+ is JSON activity payload.)
node -e "
const w = require('$ROOT/watch');
w.writeHeartbeat('$tmp', 'x.js', { lastEventMs: Date.now(), lastFlushMs: Date.now(), totalUpdates: 1 });
"
node -e "
const fs = require('fs');
const path = require('path');
const hbPath = path.join('$tmp', '.planning', 'intel', '.watcher_heartbeat');
const body = fs.readFileSync(hbPath, 'utf8');
const lines = body.split('\n');
const d = new Date(lines[0]);
if (isNaN(d.getTime())) { console.error('first line not ISO:', lines[0]); process.exit(1); }
const jsonLine = lines.find(l => l.trim().startsWith('{'));
if (!jsonLine) { console.error('no JSON payload line'); process.exit(1); }
const payload = JSON.parse(jsonLine);
if (!payload.heartbeat || typeof payload.pid !== 'number') {
  console.error('payload missing heartbeat/pid:', payload);
  process.exit(1);
}
" || fail "heartbeat not valid (first line ISO + JSON payload)"
echo "  heartbeat content is valid ISO date + JSON payload: OK"

# Test 5: Heartbeat mtime is recent (within last 5 seconds)
node -e "
const fs = require('fs');
const path = require('path');
const hbPath = path.join('$tmp', '.planning', 'intel', '.watcher_heartbeat');
const stat = fs.statSync(hbPath);
const ageSec = Math.floor((Date.now() - stat.mtimeMs) / 1000);
if (ageSec > 5) {
  console.error('Heartbeat age ' + ageSec + 's, expected < 5s');
  process.exit(1);
}
"
echo "  heartbeat mtime is recent: OK"

# Test 6: Stale heartbeat detection (simulates getWatcherStatus logic)
# Write heartbeat, then backdate its mtime by 200 seconds
node -e "
const w = require('$ROOT/watch');
w.writeHeartbeat('$tmp', 'stale.js');
"
HEARTBEAT_PATH="$tmp/.planning/intel/.watcher_heartbeat" node -e "
const fs = require('fs');
const hbPath = process.env.HEARTBEAT_PATH;
const stale = new Date(Date.now() - 200_000);
fs.utimesSync(hbPath, stale, stale);
"
node -e "
const fs = require('fs');
const path = require('path');
const hbPath = path.join('$tmp', '.planning', 'intel', '.watcher_heartbeat');
const stat = fs.statSync(hbPath);
const ageSec = Math.floor((Date.now() - stat.mtimeMs) / 1000);
// getWatcherStatus considers > 90s as not running (3x the 30s write interval)
if (ageSec < 90) {
  console.error('Expected stale heartbeat (age ' + ageSec + 's), need >= 90s');
  process.exit(1);
}
"
echo "  stale heartbeat detection (>90s = not running): OK"

# Test 7: Fresh heartbeat detected as running
node -e "
const w = require('$ROOT/watch');
w.writeHeartbeat('$tmp', 'fresh.js');
"
node -e "
const fs = require('fs');
const path = require('path');
const hbPath = path.join('$tmp', '.planning', 'intel', '.watcher_heartbeat');
const stat = fs.statSync(hbPath);
const ageSec = Math.floor((Date.now() - stat.mtimeMs) / 1000);
if (ageSec >= 90) {
  console.error('Expected fresh heartbeat (age ' + ageSec + 's), need < 90s');
  process.exit(1);
}
"
echo "  fresh heartbeat detection (<90s = running): OK"

# Test 8: Missing heartbeat detected as not running
rm -f "$tmp/.planning/intel/.watcher_heartbeat"
node -e "
const fs = require('fs');
const path = require('path');
const hbPath = path.join('$tmp', '.planning', 'intel', '.watcher_heartbeat');
if (fs.existsSync(hbPath)) {
  console.error('Heartbeat should not exist');
  process.exit(1);
}
// This mirrors getWatcherStatus returning { running: false }
"
echo "  missing heartbeat = not running: OK"

# Test 9: writeHeartbeat overwrites previous last_file
node -e "
const w = require('$ROOT/watch');
w.writeHeartbeat('$tmp', 'first.js');
"
grep -q "first.js" "$tmp/.planning/intel/.watcher_last_file" || fail "first last_file not written"
node -e "
const w = require('$ROOT/watch');
w.writeHeartbeat('$tmp', 'second.js');
"
grep -q "second.js" "$tmp/.planning/intel/.watcher_last_file" || fail "second last_file not written"
# Ensure old value is gone
if grep -q "first.js" "$tmp/.planning/intel/.watcher_last_file" 2>/dev/null; then
  fail "old last_file value still present"
fi
echo "  writeHeartbeat overwrites previous last_file: OK"

# Test 10: clearHeartbeat is safe when no heartbeat exists
rm -f "$tmp/.planning/intel/.watcher_heartbeat"
node -e "
const w = require('$ROOT/watch');
w.clearHeartbeat('$tmp');
// Should not throw
"
echo "  clearHeartbeat safe on missing file: OK"

echo ""
echo "All watcher tests passed!"
