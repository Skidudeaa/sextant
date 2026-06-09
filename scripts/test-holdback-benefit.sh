#!/usr/bin/env bash
set -euo pipefail

# WHY: Integration test for scripts/check-holdback-benefit.sh (the local cron
# that watches the holdback arm accrue and announces the causal benefit number
# once). Exercises the accrual gate (volume floor on BOTH arms), the READY
# once-only sentinel, rotation awareness (--include-old), log-dir auto-create,
# and the no-telemetry fallback — against a synthetic telemetry fixture, with
# the bin resolved from this checkout (SEXTANT_REPO is only the DATA repo).

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.."; pwd)"
CHECK="$ROOT/scripts/check-holdback-benefit.sh"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

REPO="$tmp/repo"
mkdir -p "$REPO/.planning/intel"

# Append N retrieval.path_hit + M retrieval.path_miss events for an arm.
emit_events() {
  local file="$1" arm="$2" hits="$3" misses="$4"
  local i
  for ((i = 0; i < hits; i++)); do
    echo "{\"ts\":1,\"name\":\"retrieval.path_hit\",\"source\":\"exported_symbol\",\"tool\":\"Read\",\"arm\":\"$arm\"}" >> "$file"
  done
  for ((i = 0; i < misses; i++)); do
    echo "{\"ts\":2,\"name\":\"retrieval.path_miss\",\"tool\":\"Read\",\"arm\":\"$arm\"}" >> "$file"
  done
}

# Run the check with the fixture wiring. LOG dir deliberately nested+missing
# to prove the script creates it (a fresh \$HOME must not kill the cron).
LOG="$tmp/logs/nested/benefit.log"
run_check() {
  SEXTANT_REPO="$REPO" SEXTANT_BENEFIT_LOG="$LOG" SEXTANT_HOLDBACK_MIN=5 \
    bash "$CHECK" || fail "check script must always exit 0 (got $?)"
}

TJ="$REPO/.planning/intel/telemetry.jsonl"

# ── Test 1: below the volume floor → accruing line, log dir auto-created ────
emit_events "$TJ" armed 3 1        # armed scored=4 (< MIN=5)
emit_events "$TJ" holdback 1 1     # holdback scored=2 (< MIN=5)
run_check
[ -f "$LOG" ] || fail "log file (and its missing parent dirs) must be created"
grep -q "accruing" "$LOG" || fail "below-floor run must log an accruing line"
grep -q "holdback_scored=2" "$LOG" || fail "accruing line must carry the holdback count"
[ ! -f "$REPO/.planning/intel/.holdback_benefit_reported" ] || fail "no sentinel below the floor"

# ── Test 2: holdback at floor but armed below → still accruing (A5) ─────────
# benefitDelta is computable here (both arms have a precision) — volume on
# BOTH arms must gate, not just holdback.
emit_events "$TJ" holdback 2 2     # holdback scored=6 (>= 5); armed still 4
run_check
[ "$(grep -c "accruing" "$LOG")" = "2" ] || fail "armed below floor must still accrue"
grep -q "SEXTANT HOLDBACK BENEFIT READY" "$LOG" && fail "must not announce READY with armed below floor"

# ── Test 3: rotation — armed volume only reachable via .old (A1) ────────────
# Move the current file to .old and put fresh armed events in a new current
# file: each file ALONE is below-floor for one arm; only --include-old sees
# both arms at volume.
mv "$TJ" "$REPO/.planning/intel/telemetry.jsonl.old"
emit_events "$TJ" armed 1 1        # armed total: 4 (.old) + 2 (current) = 6
run_check
grep -q "SEXTANT HOLDBACK BENEFIT READY" "$LOG" || fail "READY must fire once both arms reach the floor across .old + current"
[ -f "$REPO/.planning/intel/.holdback_benefit_reported" ] || fail "READY must create the sentinel"

# ── Test 4: sentinel makes READY once-only ───────────────────────────────────
lines_before="$(wc -l < "$LOG")"
run_check
lines_after="$(wc -l < "$LOG")"
[ "$lines_before" = "$lines_after" ] || fail "second READY-state run must append nothing (sentinel)"

# ── Test 5: bin failure → 'no telemetry json' note, exit 0 (A4 guard) ───────
# (A MISSING repo is handled upstream: the telemetry CLI emits a valid empty
# summary, which logs as a zero-count accruing line. The fallback branch is
# for node/bin failure — the silently-dead-cron case.)
SEXTANT_REPO="$REPO" SEXTANT_BIN="$tmp/no-such-bin.js" SEXTANT_BENEFIT_LOG="$LOG" \
  bash "$CHECK" || fail "a failing bin must not crash the cron"
grep -q "no telemetry json" "$LOG" || fail "bin failure must log the fallback note"

# ── Test 6: missing repo degrades to a zero-count accruing line ─────────────
SEXTANT_REPO="$tmp/does-not-exist" SEXTANT_BENEFIT_LOG="$LOG" SEXTANT_HOLDBACK_MIN=5 \
  bash "$CHECK" || fail "missing repo must not crash the cron"
grep -q "holdback_scored=0" "$LOG" || fail "missing repo must log zero counts"

echo "PASS: check-holdback-benefit integration (6 scenarios)"
