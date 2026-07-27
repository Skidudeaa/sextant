#!/usr/bin/env bash
#
# check-holdback-benefit.sh — local daily check for the injection-OFF holdback
# arm's causal benefit number (009 #1 follow-up).
#
# WHY LOCAL (not a remote /schedule routine): the telemetry it reads lives in
# .planning/intel/telemetry.jsonl, which is GITIGNORED — it never leaves this
# machine. A cloud routine clones the repo and gets the code but none of the
# data, so it can't compute the delta. This runs where the data is.
#
# WHY POOLED (2026-07-27): the arms randomize per TURN, and a single repo
# accrues eligible turns far too slowly to ever clear the floor — 170 days on
# sextant alone. `sextant telemetry --roots-file` pools the fleet; pooling is
# valid at the turn level because that is the randomization unit. The roots file
# is the single source of truth, shared with the command the banner tells the
# user to run.
#
# WHY THE TURN FLOOR (docs/033 Tier 3 #4): gating on scored OPENS alone is not a
# volume gate at all. At ~28 opens per turn an opens-only floor of 30 clears
# after ONE randomized turn per arm, which is how the per-open delta previously
# graduated to an unqualified causal claim on n=1. Both floors must hold.
#
# Behavior: writes a one-line banner file that the statusline renders — the only
# surface the user actually sees (hook stdout goes to Claude, stderr goes
# nowhere, and a log file in $HOME is not a surface anybody reads). Two banners:
#   ready  — both arms cleared both floors and a turn delta exists. Written ONCE
#            (sentinel-guarded), so deleting the banner dismisses it for good.
#   stall  — the experiment has been enabled for STALL_DAYS and the pooled
#            holdback arm is STILL empty. That is not patience-shaped: it means
#            turns are not reaching decideArm (on churny repos, content-stale
#            turns are forced armed by design), so waiting will not fix it.
# The log keeps its per-run progress line for anyone who wants the history.
#
# Env knobs (all optional):
#   SEXTANT_ROOTS_FILE    roots to pool  (default: $HOME/.claude/sextant-fleet-roots)
#   SEXTANT_REPO          fallback single repo when no roots file exists
#   SEXTANT_BIN           sextant bin to run   (default: this checkout's)
#   SEXTANT_BENEFIT_LOG   log file    (default: $HOME/sextant-benefit.log)
#   SEXTANT_FLEET_AB_FILE banner file (default: $HOME/.claude/.sextant-fleet-ab)
#   SEXTANT_HOLDBACK_MIN  min scored opens per arm  (default: 30)
#   SEXTANT_HOLDBACK_MIN_TURNS  min scored turns per arm  (default: 30)
#   SEXTANT_STALL_DAYS    days before an empty holdback arm is a stall (default: 14)
set -euo pipefail

REPO="${SEXTANT_REPO:-/root/sextant}"
ROOTS_FILE="${SEXTANT_ROOTS_FILE:-${HOME:-/root}/.claude/sextant-fleet-roots}"
# The bin is resolved from THIS script's checkout, not from $REPO — the repo
# holding the telemetry data need not be the repo holding the sextant code
# (and cron's minimal PATH has no npm-global `sextant` either way).
BIN="${SEXTANT_BIN:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/bin/intel.js}"
LOG="${SEXTANT_BENEFIT_LOG:-${HOME:-/root}/sextant-benefit.log}"
BANNER="${SEXTANT_FLEET_AB_FILE:-${HOME:-/root}/.claude/.sextant-fleet-ab}"
MIN="${SEXTANT_HOLDBACK_MIN:-30}"
MIN_TURNS="${SEXTANT_HOLDBACK_MIN_TURNS:-30}"
STALL_DAYS="${SEXTANT_STALL_DAYS:-14}"
SENTINEL="$REPO/.planning/intel/.holdback_benefit_reported"
STALL_SENTINEL="$REPO/.planning/intel/.holdback_stall_reported"
SINCE="$REPO/.planning/intel/.fleet_ab_since"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# The log dir may not exist yet (fresh $HOME, custom SEXTANT_BENEFIT_LOG) —
# under `set -e` a failed `>>` would kill the script silently.
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
mkdir -p "$(dirname "$BANNER")" 2>/dev/null || true
mkdir -p "$(dirname "$SINCE")" 2>/dev/null || true

# Stamp the clock the stall check measures from, once.
[ -f "$SINCE" ] || date -u +%s > "$SINCE" 2>/dev/null || true

if [ -r "$ROOTS_FILE" ]; then
    ROOT_ARGS=(--roots-file "$ROOTS_FILE")
    SCOPE="$(grep -cvE '^\s*(#|$)' "$ROOTS_FILE" 2>/dev/null || echo 0) roots"
    SHOW_CMD="sextant telemetry --roots-file $ROOTS_FILE"
else
    ROOT_ARGS=(--root "$REPO")
    SCOPE="$REPO"
    SHOW_CMD="cd $REPO && sextant telemetry"
fi

# --include-old: telemetry.jsonl rotates to .old at 8 MiB. Without it the
# visible counts REGRESS after every rotation and the accrual gate can starve.
JSON="$(node "$BIN" telemetry "${ROOT_ARGS[@]}" --json --include-old 2>/dev/null || true)"
if [ -z "$JSON" ]; then
  echo "$TS  no telemetry json (scope: $SCOPE)" >> "$LOG"
  exit 0
fi

# `|| echo` guard: under `set -e` a node crash here would exit the script
# before anything is logged — a silently dead cron.
SUMMARY="$(printf '%s' "$JSON" | MIN="$MIN" MIN_TURNS="$MIN_TURNS" node -e '
let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
  let j; try { j = JSON.parse(s); } catch { console.log("error parse-error"); return; }
  const r = j.retrieval || {};
  const min = parseInt(process.env.MIN || "30", 10);
  const minTurns = parseInt(process.env.MIN_TURNS || "30", 10);
  const tc = r.turnCountsByArm || {};
  const at = (tc.armed || {}).turns || 0;
  const ht = (tc.holdback || {}).turns || 0;
  const ac = (r.armCounts && r.armCounts.armed) || { scored: 0 };
  const hc = (r.armCounts && r.armCounts.holdback) || { scored: 0 };
  const td = r.turnBenefitDelta;
  const pct = v => v == null ? "n/a" : (v * 100).toFixed(1) + "%";
  const rates = r.turnHitRateByArm || {};
  // BOTH floors, per docs/033 Tier 3 #4. Turns are the randomization unit; the
  // opens floor alone clears after one turn per arm at ~28 opens/turn.
  const ready = (td != null && ht >= minTurns && at >= minTurns &&
                 hc.scored >= min && ac.scored >= min) ? "ready" : "accruing";
  const kind = (ready === "accruing" && ht === 0) ? "empty-holdback" : ready;
  console.log([
    kind,
    `armed=${at}t/${ac.scored}o`,
    `holdback=${ht}t/${hc.scored}o`,
    `turnHitRate armed=${pct(rates.armed)} holdback=${pct(rates.holdback)}`,
    `turnDelta=${td == null ? "n/a" : (td * 100).toFixed(1) + "pts"}`,
  ].join(" "));
});' || echo "error summarize-error")"

KIND="${SUMMARY%% *}"
DETAIL="${SUMMARY#* }"
# Compact form for the statusline, which has ~40 usable columns after the
# health/watcher segments — the full numbers live behind $SHOW_CMD.
COMPACT="$(printf '%s' "$SUMMARY" | awk '{print $2, $3}')"

case "$KIND" in
  ready)
    if [ ! -f "$SENTINEL" ]; then
      {
        echo "============================================================"
        echo "$TS  ✅ SEXTANT FLEET HOLDBACK A/B READY  (scope: $SCOPE)"
        echo "   $DETAIL"
        echo "   -> $SHOW_CMD"
        echo "============================================================"
      } >> "$LOG"
      printf 'ready ✅ fleet A/B ready (%s) — see: sextant telemetry --roots-file\n' "$COMPACT" > "$BANNER" 2>/dev/null || true
      # Without the mkdir the touch fails silently when .planning/intel is
      # missing — and the READY block would then re-append on EVERY run.
      mkdir -p "$(dirname "$SENTINEL")" 2>/dev/null || true
      touch "$SENTINEL" 2>/dev/null || true
    fi
    ;;
  empty-holdback)
    # An empty holdback arm after STALL_DAYS is not "keep waiting" — it means
    # eligible turns are not reaching decideArm at all. The dominant known cause
    # is content-staleness: a content-stale turn is FORCED ARMED by design, and
    # on a churny repo that is most turns.
    STARTED="$(cat "$SINCE" 2>/dev/null || echo 0)"
    NOW="$(date -u +%s)"
    AGE_DAYS=$(( (NOW - STARTED) / 86400 ))
    if [ "$STARTED" -gt 0 ] && [ "$AGE_DAYS" -ge "$STALL_DAYS" ] && [ ! -f "$STALL_SENTINEL" ]; then
      {
        echo "============================================================"
        echo "$TS  ⚠ SEXTANT FLEET HOLDBACK A/B STALLED  (scope: $SCOPE)"
        echo "   $AGE_DAYS days enabled, holdback arm still EMPTY."
        echo "   $DETAIL"
        echo "   Likely cause: content-stale turns are forced armed by design."
        echo "   Check the retrieval stale rate: $SHOW_CMD"
        echo "============================================================"
      } >> "$LOG"
      printf 'stall ⚠ fleet A/B stalled %sd — holdback arm empty\n' "$AGE_DAYS" > "$BANNER" 2>/dev/null || true
      touch "$STALL_SENTINEL" 2>/dev/null || true
    else
      echo "$TS  accruing… $DETAIL  (holdback arm empty, ${AGE_DAYS}d)" >> "$LOG"
    fi
    ;;
  error)
    echo "$TS  $DETAIL" >> "$LOG"
    ;;
  *)
    echo "$TS  accruing… $DETAIL  (need >=$MIN_TURNS turns AND >=$MIN opens per arm)" >> "$LOG"
    ;;
esac
