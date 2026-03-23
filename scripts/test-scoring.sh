#!/usr/bin/env bash
set -euo pipefail

# ARCHITECTURE: Test script for scoring module integration
# WHY: Validates enhanced scoring signals work end-to-end
# TRADEOFF: Manual test script vs full test framework

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.."; pwd)"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

echo "Testing scoring module..."

# Test 1: Python symbol extraction
node -e "
const s = require('$ROOT/lib/scoring');
const sym = s.extractSymbolDef('def authenticate(self):');
if (sym !== 'authenticate') {
  console.error('Expected authenticate, got: ' + sym);
  process.exit(1);
}
console.log('  Python symbol extraction: OK');
"

# Test 2: Python class extraction
node -e "
const s = require('$ROOT/lib/scoring');
const sym = s.extractSymbolDef('class AuthHandler(BaseHandler):');
if (sym !== 'AuthHandler') {
  console.error('Expected AuthHandler, got: ' + sym);
  process.exit(1);
}
console.log('  Python class extraction: OK');
"

# Test 3: Noise word ratio
node -e "
const s = require('$ROOT/lib/scoring');
const noisy = s.noiseWordRatio('return self if True else None');
const clean = s.noiseWordRatio('authenticate_user_credentials');
if (noisy <= clean) {
  console.error('Expected noisy > clean ratio');
  process.exit(1);
}
console.log('  Noise word ratio: OK');
"

# Test 4: isPythonPublicSymbol
node -e "
const s = require('$ROOT/lib/scoring');
if (!s.isPythonPublicSymbol('def authenticate():')) {
  process.exit(1);
}
if (s.isPythonPublicSymbol('def _private():')) {
  process.exit(1);
}
console.log('  Python public symbol detection: OK');
"

# Test 5: Enhanced signals boost exact match
node -e "
const s = require('$ROOT/lib/scoring');
const hit = { path: 'auth.py', line: 'def authenticate():', score: 1 };
const r = s.computeEnhancedSignals(hit, ['authenticate'], { explainHits: true });
if (r.adjustment <= 0) {
  console.error('Expected positive adjustment for exact match');
  process.exit(1);
}
if (!r.signals.some(s => s.includes('exact_symbol'))) {
  console.error('Expected exact_symbol signal');
  process.exit(1);
}
console.log('  Enhanced signals (exact match boost): OK');
"

# Test 6: Module loads cleanly
node -e "
const retrieve = require('$ROOT/lib/retrieve');
console.log('  retrieve module loads: OK');
"

echo ""
echo "All scoring tests passed!"
