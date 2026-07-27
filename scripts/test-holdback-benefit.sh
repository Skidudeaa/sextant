#!/usr/bin/env bash
set -euo pipefail

# WHY: Integration test for scripts/check-holdback-benefit.sh (the local cron
# that watches the holdback arm accrue and announces the causal benefit number
# once). Exercises the accrual gate (volume floor on BOTH arms AND both units),
# the READY once-only sentinel, the statusline banner, the stall branch,
# rotation awareness (--include-old), log-dir auto-create, and the
# no-telemetry fallback — against a synthetic telemetry fixture, with the bin
# resolved from this checkout (SEXTANT_REPO is only the DATA repo).
#
# TEST ISOLATION (2026-07-27): HOME and SEXTANT_ROOTS_FILE are pinned INSIDE
# run_check. The script defaults its roots file to $HOME/.claude/sextant-fleet-roots,
# which on a dogfooding machine EXISTS and lists the real fleet — without the
# pin this test would silently measure production telemetry and pass or fail on
# whatever the user did that day. Same ambient-config trap as the holdback env
# flags; pin at invocation, not at load.

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

# One scored TURN for an arm: `hits` path_hit + `misses` path_miss events, all
# stamped with the same `turn` id. The turn stamp is what the turn-level floor
# counts (docs/033 Tier 1); events without it are turnUnscored and never fold in.
emit_turn() {
  local file="$1" arm="$2" turn="$3" hits="$4" misses="$5"
  local i
  for ((i = 0; i < hits; i++)); do
    echo "{\"ts\":1,\"name\":\"retrieval.path_hit\",\"source\":\"exported_symbol\",\"tool\":\"Read\",\"arm\":\"$arm\",\"turn\":$turn}" >> "$file"
  done
  for ((i = 0; i < misses; i++)); do
    echo "{\"ts\":2,\"name\":\"retrieval.path_miss\",\"tool\":\"Read\",\"arm\":\"$arm\",\"turn\":$turn}" >> "$file"
  done
}

LOG="$tmp/logs/nested/benefit.log"   # nested+missing on purpose: the cron must create it
BANNER="$tmp/banner"
FAKE_HOME="$tmp/home"
mkdir -p "$FAKE_HOME"

run_check() {
  local repo="${1:-$REPO}"
  HOME="$FAKE_HOME" \
  SEXTANT_ROOTS_FILE="$tmp/no-such-roots-file" \
  SEXTANT_REPO="$repo" \
  SEXTANT_BENEFIT_LOG="$LOG" \
  SEXTANT_FLEET_AB_FILE="$BANNER" \
  SEXTANT_HOLDBACK_MIN=5 \
  SEXTANT_HOLDBACK_MIN_TURNS=3 \
    bash "$CHECK" || fail "check script must always exit 0 (got $?)"
}

TJ="$REPO/.planning/intel/telemetry.jsonl"

# ── Test 1: below both floors → accruing line, log dir auto-created ─────────
emit_turn "$TJ" armed 101 1 1
emit_turn "$TJ" armed 102 1 1        # armed: 2 turns, 4 opens (< 3t, < 5o)
emit_turn "$TJ" holdback 201 1 1     # holdback: 1 turn, 2 opens
run_check
[ -f "$LOG" ] || fail "log file (and its missing parent dirs) must be created"
grep -q "accruing" "$LOG" || fail "below-floor run must log an accruing line"
grep -q "holdback=1t/2o" "$LOG" || fail "accruing line must carry the holdback turn+open counts"
[ ! -f "$REPO/.planning/intel/.holdback_benefit_reported" ] || fail "no sentinel below the floor"
[ ! -f "$BANNER" ] || fail "no statusline banner below the floor"

# ── Test 2: holdback at both floors but armed below → still accruing ────────
# The delta is computable here (both arms have a rate) — volume on BOTH arms
# must gate, not just holdback.
emit_turn "$TJ" holdback 202 1 1
emit_turn "$TJ" holdback 203 1 1     # holdback: 3 turns, 6 opens (at floor)
run_check
[ "$(grep -c "accruing" "$LOG")" = "2" ] || fail "armed below floor must still accrue"
grep -q "FLEET HOLDBACK A/B READY" "$LOG" && fail "must not announce READY with armed below floor"

# ── Test 3: rotation — armed volume only reachable via .old ─────────────────
# Move the current file to .old and put fresh armed events in a new current
# file: each file ALONE is below-floor for one arm; only --include-old sees both.
mv "$TJ" "$REPO/.planning/intel/telemetry.jsonl.old"
emit_turn "$TJ" armed 103 1 1        # armed total: 2 (.old) + 1 (current) = 3 turns, 6 opens
run_check
grep -q "FLEET HOLDBACK A/B READY" "$LOG" || fail "READY must fire once both arms clear both floors across .old + current"
[ -f "$REPO/.planning/intel/.holdback_benefit_reported" ] || fail "READY must create the sentinel"
[ -f "$BANNER" ] || fail "READY must write the statusline banner"
grep -q "^ready " "$BANNER" || fail "banner must carry the 'ready' kind token the statusline colours on"

# ── Test 4: sentinel makes READY once-only ─────────────────────────────────
lines_before="$(wc -l < "$LOG")"
run_check
lines_after="$(wc -l < "$LOG")"
[ "$lines_before" = "$lines_after" ] || fail "second READY-state run must append nothing (sentinel)"

# ── Test 5: OPENS-ONLY TRAP must not announce (docs/033 Tier 3 #4) ──────────
# The pre-Tier-3 failure mode: gating on scored OPENS alone is not a volume
# gate. At ~28 opens/turn an opens floor of 30 clears after ONE randomized turn
# per arm, so the delta graduated to a causal claim on n=1. Both floors hold now.
REPO2="$tmp/repo-trap"
mkdir -p "$REPO2/.planning/intel"
TJ2="$REPO2/.planning/intel/telemetry.jsonl"
emit_turn "$TJ2" armed 301 10 10     # 1 turn, 20 opens — opens floor cleared
emit_turn "$TJ2" holdback 401 10 10  # 1 turn, 20 opens
rm -f "$BANNER"
run_check "$REPO2"
grep -q "armed=1t/20o" "$LOG" || fail "trap fixture must register 1 turn / 20 opens"
[ ! -f "$REPO2/.planning/intel/.holdback_benefit_reported" ] || fail "opens-only volume must NOT announce READY"
[ ! -f "$BANNER" ] || fail "opens-only volume must NOT write a banner"

# ── Test 6: stall — holdback arm still empty after the stall window ─────────
# Not a "keep waiting" state: an empty holdback arm means eligible turns are not
# reaching decideArm at all (content-stale turns are forced armed by design), so
# elapsed time does not fix it.
REPO3="$tmp/repo-stall"
mkdir -p "$REPO3/.planning/intel"
TJ3="$REPO3/.planning/intel/telemetry.jsonl"
emit_turn "$TJ3" armed 501 1 1
emit_turn "$TJ3" armed 502 1 1
emit_turn "$TJ3" armed 503 1 1       # armed only; holdback arm empty
echo $(( $(date -u +%s) - 20 * 86400 )) > "$REPO3/.planning/intel/.fleet_ab_since"
run_check "$REPO3"
[ -f "$BANNER" ] || fail "a 20-day-old empty holdback arm must raise the stall banner"
grep -q "^stall " "$BANNER" || fail "stall banner must carry the 'stall' kind token"

# ── Test 7: a YOUNG empty holdback arm stays silent ────────────────────────
REPO4="$tmp/repo-young"
mkdir -p "$REPO4/.planning/intel"
emit_turn "$REPO4/.planning/intel/telemetry.jsonl" armed 601 1 1
echo $(( $(date -u +%s) - 3 * 86400 )) > "$REPO4/.planning/intel/.fleet_ab_since"
rm -f "$BANNER"
run_check "$REPO4"
[ ! -f "$BANNER" ] || fail "3 days in, an empty holdback arm is still just accruing"

# ── Test 8: bin failure → 'no telemetry json' note, exit 0 ─────────────────
# (A MISSING repo is handled upstream: the telemetry CLI emits a valid empty
# summary, which logs as a zero-count accruing line. The fallback branch is
# for node/bin failure — the silently-dead-cron case.)
HOME="$FAKE_HOME" SEXTANT_ROOTS_FILE="$tmp/no-such-roots-file" \
  SEXTANT_REPO="$REPO" SEXTANT_BIN="$tmp/no-such-bin.js" SEXTANT_BENEFIT_LOG="$LOG" \
  bash "$CHECK" || fail "a failing bin must not crash the cron"
grep -q "no telemetry json" "$LOG" || fail "bin failure must log the fallback note"

# ── Test 9: missing repo degrades to a zero-count line ─────────────────────
rm -f "$BANNER"
run_check "$tmp/does-not-exist"
grep -q "holdback=0t/0o" "$LOG" || fail "missing repo must log zero counts"
[ ! -f "$BANNER" ] || fail "missing repo must not raise a banner"

echo "PASS: check-holdback-benefit integration (9 scenarios)"
