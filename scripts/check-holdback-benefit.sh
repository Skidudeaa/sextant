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
# Behavior: reads `sextant telemetry --json --include-old`; when BOTH arms have
# at least SEXTANT_HOLDBACK_MIN scored opens AND benefitDelta is computed,
# appends a loud READY block to the log ONCE (guarded by a sentinel) and stops
# nagging. Until then it appends a one-line "accruing" progress note each run.
#
# Env knobs (all optional):
#   SEXTANT_REPO         repo whose telemetry to read (default: /root/sextant)
#   SEXTANT_BIN          sextant bin to run            (default: this checkout's)
#   SEXTANT_BENEFIT_LOG  log file            (default: $HOME/sextant-benefit.log)
#   SEXTANT_HOLDBACK_MIN min scored per arm  (default: 30)
set -euo pipefail

REPO="${SEXTANT_REPO:-/root/sextant}"
# The bin is resolved from THIS script's checkout, not from $REPO — the repo
# holding the telemetry data need not be the repo holding the sextant code
# (and cron's minimal PATH has no npm-global `sextant` either way).
BIN="${SEXTANT_BIN:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/bin/intel.js}"
LOG="${SEXTANT_BENEFIT_LOG:-${HOME:-/root}/sextant-benefit.log}"
MIN="${SEXTANT_HOLDBACK_MIN:-30}"
SENTINEL="$REPO/.planning/intel/.holdback_benefit_reported"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# The log dir may not exist yet (fresh $HOME, custom SEXTANT_BENEFIT_LOG) —
# under `set -e` a failed `>>` would kill the script silently.
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

# --include-old: telemetry.jsonl rotates to .old at 1 MiB. Without it the
# visible counts REGRESS after every rotation and the accrual gate can starve.
JSON="$(node "$BIN" telemetry --root "$REPO" --json --include-old 2>/dev/null || true)"
if [ -z "$JSON" ]; then
  echo "$TS  no telemetry json (is $REPO present?)" >> "$LOG"
  exit 0
fi

# `|| echo` guard: under `set -e` a node crash here would exit the script
# before anything is logged — a silently dead cron.
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
  // Volume gate on BOTH arms: benefitDelta exists from the first scored open
  // per arm, but an armed precision computed at n=1 is noise, not a baseline.
  const ready = (d != null && hb.scored >= min && ar.scored >= min) ? 1 : 0;
  console.log(`${ready} holdback_scored=${hb.scored} armed_scored=${ar.scored} ` +
    `armed=${pct(op.armed)} holdback=${pct(op.holdback)} ` +
    `benefitDelta=${d == null ? "n/a" : (d * 100).toFixed(1) + "pts"}`);
});' || echo "0 summarize-error")"

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
    # Without the mkdir the touch fails silently when .planning/intel is
    # missing — and the READY block would then re-append on EVERY run.
    mkdir -p "$(dirname "$SENTINEL")" 2>/dev/null || true
    touch "$SENTINEL" 2>/dev/null || true
  fi
else
  echo "$TS  accruing… $DETAIL  (need >=$MIN scored per arm + benefitDelta)" >> "$LOG"
fi
