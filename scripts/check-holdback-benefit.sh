#!/usr/bin/env bash
#
# check-holdback-benefit.sh — local daily check for the injection-OFF holdback
# arm's causal benefit number (009 #1 follow-up).
#
# WHY LOCAL (not a remote /schedule routine): the telemetry it reads lives in
# .planning/intel/telemetry.jsonl, which is GITIGNORED — it never leaves this
# machine. A cloud routine clones the repo and gets the code but none of the
# data, so it can't compute benefitDelta. This runs where the data is.
#
# Behavior: reads `sextant telemetry --json`; when the holdback arm has at least
# SEXTANT_HOLDBACK_MIN scored opens AND benefitDelta is computed, appends a loud
# READY block to the log ONCE (guarded by a sentinel) and stops nagging. Until
# then it appends a one-line "accruing" progress note each run.
#
# Env knobs (all optional):
#   SEXTANT_REPO         repo path           (default: /root/sextant)
#   SEXTANT_BENEFIT_LOG  log file            (default: $HOME/sextant-benefit.log)
#   SEXTANT_HOLDBACK_MIN min holdback scored (default: 30)
set -euo pipefail

REPO="${SEXTANT_REPO:-/root/sextant}"
LOG="${SEXTANT_BENEFIT_LOG:-${HOME:-/root}/sextant-benefit.log}"
MIN="${SEXTANT_HOLDBACK_MIN:-30}"
SENTINEL="$REPO/.planning/intel/.holdback_benefit_reported"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Call the repo's bin directly so cron's minimal PATH (no npm global) still works.
JSON="$(node "$REPO/bin/intel.js" telemetry --root "$REPO" --json 2>/dev/null || true)"
if [ -z "$JSON" ]; then
  echo "$TS  no telemetry json (is $REPO present?)" >> "$LOG"
  exit 0
fi

SUMMARY="$(printf '%s' "$JSON" | MIN="$MIN" node -e '
let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
  let j; try { j = JSON.parse(s); } catch { console.log("0 parse-error"); return; }
  const r = j.retrieval || {};
  const min = parseInt(process.env.MIN || "30", 10);
  const hb = (r.armCounts && r.armCounts.holdback) || { scored: 0 };
  const ar = (r.armCounts && r.armCounts.armed) || { scored: 0 };
  const op = r.openPrecisionByArm || {};
  const d = r.benefitDelta;
  const pct = v => v == null ? "n/a" : (v * 100).toFixed(1) + "%";
  const ready = (d != null && hb.scored >= min) ? 1 : 0;
  console.log(`${ready} holdback_scored=${hb.scored} armed_scored=${ar.scored} ` +
    `armed=${pct(op.armed)} holdback=${pct(op.holdback)} ` +
    `benefitDelta=${d == null ? "n/a" : (d * 100).toFixed(1) + "pts"}`);
});')"

READY="${SUMMARY%% *}"
DETAIL="${SUMMARY#* }"

if [ "$READY" = "1" ]; then
  if [ ! -f "$SENTINEL" ]; then
    {
      echo "============================================================"
      echo "$TS  ✅ SEXTANT HOLDBACK BENEFIT READY"
      echo "   $DETAIL"
      echo "   -> cd $REPO && sextant telemetry   (see 'by arm' + BENEFIT DELTA)"
      echo "============================================================"
    } >> "$LOG"
    touch "$SENTINEL" 2>/dev/null || true
  fi
else
  echo "$TS  accruing… $DETAIL  (need holdback_scored>=$MIN + benefitDelta)" >> "$LOG"
fi
