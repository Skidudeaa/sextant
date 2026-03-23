#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.."; pwd)"
SCRIPT="$ROOT/tools/codebase_intel/refresh.js"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

run_refresh() {
  local dir="$1"
  local payload="$2"
  (cd "$dir" && printf '%s' "$payload" | node "$SCRIPT")
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/.planning/intel"
echo "alpha" > "$tmp/.planning/intel/summary.md"

# Test 1: emits only when changed for same session
out1="$(run_refresh "$tmp" '{"session_id":"s1"}')"
printf '%s' "$out1" | grep -q "<codebase-intelligence>" || fail "expected initial emit"

out2="$(run_refresh "$tmp" '{"session_id":"s1"}')"
[[ -z "$out2" ]] || fail "expected no emit on unchanged summary"

echo "beta" > "$tmp/.planning/intel/summary.md"
out3="$(run_refresh "$tmp" '{"session_id":"s1"}')"
printf '%s' "$out3" | grep -q "beta" || fail "expected emit after summary change"

# Test 2: per-session dedupe (same summary, different session)
echo "alpha" > "$tmp/.planning/intel/summary.md"
out4="$(run_refresh "$tmp" '{"session_id":"s2"}')"
printf '%s' "$out4" | grep -q "alpha" || fail "expected emit for different session"

echo "ok"
