#!/usr/bin/env bash
# External Swift benchmark — clone Vapor at a pinned tag, scan with sextant,
# run the eval-retrieve.js (CLI/MCP path) and eval-hook.js (hook fast path)
# harnesses against fixtures/vapor-eval-queries.json, diff against
# fixtures/vapor-baseline.json and fixtures/vapor-hook-baseline.json.
#
# Usage:
#   bash scripts/eval-swift-external.sh                       # diff (CLI + hook)
#   bash scripts/eval-swift-external.sh diff                  # same as above
#   bash scripts/eval-swift-external.sh regen-baseline        # regen CLI baseline
#   bash scripts/eval-swift-external.sh regen-hook-baseline   # regen hook baseline
#   bash scripts/eval-swift-external.sh hook-diff             # diff hook only
#
# WHY two baselines: the CLI path (lib/retrieve.js) and the hook path
# (graph-retrieve + zoekt + merge-results) are different code paths with
# different rerank pipelines.  The hook is what every UserPromptSubmit hits;
# without its own gate, hook-side regressions silently pass `diff` mode.
#
# Env overrides:
#   VAPOR_SHA=<tag-or-sha>   default: 4.121.4
#   VAPOR_DIR=<dir>          default: /tmp/vapor-eval
#
# Manual-trigger only. NOT part of npm test. Runtime ~1–3 minutes depending on
# network speed and how cold sextant's tree-sitter init is.

set -euo pipefail

VAPOR_SHA="${VAPOR_SHA:-4.121.4}"
VAPOR_DIR="${VAPOR_DIR:-/tmp/vapor-eval}"
MODE="${1:-diff}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
QUERIES="$REPO_ROOT/fixtures/vapor-eval-queries.json"
BASELINE="$REPO_ROOT/fixtures/vapor-baseline.json"
HOOK_BASELINE="$REPO_ROOT/fixtures/vapor-hook-baseline.json"
CURRENT="$(mktemp -t vapor-current.XXXXXX.json)"
HOOK_CURRENT="$(mktemp -t vapor-hook-current.XXXXXX.json)"
trap 'rm -f "$CURRENT" "$HOOK_CURRENT"' EXIT

case "$MODE" in
  diff|regen-baseline|regen-hook-baseline|hook-diff) ;;
  *)
    echo "usage: $0 [diff|regen-baseline|regen-hook-baseline|hook-diff]" >&2
    exit 2
    ;;
esac

# 1. Clone or fast-forward to pinned tag.
if [[ ! -d "$VAPOR_DIR/.git" ]]; then
  echo "==> Cloning vapor/vapor at $VAPOR_SHA into $VAPOR_DIR"
  git clone --depth 1 --branch "$VAPOR_SHA" https://github.com/vapor/vapor "$VAPOR_DIR"
else
  echo "==> Existing checkout at $VAPOR_DIR — fetching $VAPOR_SHA"
  git -C "$VAPOR_DIR" fetch --depth 1 origin "refs/tags/$VAPOR_SHA:refs/tags/$VAPOR_SHA" 2>/dev/null || true
  git -C "$VAPOR_DIR" checkout --quiet "$VAPOR_SHA"
fi

# 2. Scan with sextant. Force re-index so the corpus reflects the pinned SHA.
echo "==> sextant scan --root $VAPOR_DIR --force"
node "$REPO_ROOT/bin/intel.js" scan --root "$VAPOR_DIR" --force

# 3a. Run CLI path eval (always, unless we're hook-only).
# WHY `|| true`: eval-{retrieve,hook}.js exit non-zero when any case fails
# its per-case gate, but for diff/regen we want the JSON regardless.  The
# regression gate is the comparator output (compare-vapor-eval.js), not the
# per-case pass/fail of the eval harness itself.
if [[ "$MODE" != "hook-diff" && "$MODE" != "regen-hook-baseline" ]]; then
  echo "==> eval-retrieve.js --root $VAPOR_DIR --dataset $QUERIES"
  node "$REPO_ROOT/scripts/eval-retrieve.js" \
    --root "$VAPOR_DIR" \
    --dataset "$QUERIES" \
    --json > "$CURRENT" || true
fi

# 3b. Run hook path eval (always, unless we're CLI-only regen).
if [[ "$MODE" != "regen-baseline" ]]; then
  echo "==> eval-hook.js --root $VAPOR_DIR --dataset $QUERIES"
  node "$REPO_ROOT/scripts/eval-hook.js" \
    --root "$VAPOR_DIR" \
    --dataset "$QUERIES" \
    --json > "$HOOK_CURRENT" || true
fi

# 4. Branch by mode.
case "$MODE" in
  regen-baseline)
    cp "$CURRENT" "$BASELINE"
    echo ""
    echo "==> Wrote new CLI baseline to $BASELINE"
    node -e "
      const j = JSON.parse(require('fs').readFileSync('$BASELINE','utf8'));
      const a = j.aggregates;
      console.log('  cases:', a.totalCases, '(passed', a.passed, '/ failed', a.failed, ')');
      console.log('  meanMRR:', a.meanMRR.toFixed(4), 'meanNDCG:', a.meanNDCG.toFixed(4));
      console.log('  graphLiftNDCG:', a.graphLiftNDCG.toFixed(4), '(' + a.graphLiftDirection + ')');
    "
    exit 0
    ;;

  regen-hook-baseline)
    cp "$HOOK_CURRENT" "$HOOK_BASELINE"
    echo ""
    echo "==> Wrote new hook baseline to $HOOK_BASELINE"
    node -e "
      const j = JSON.parse(require('fs').readFileSync('$HOOK_BASELINE','utf8'));
      const a = j.aggregates;
      console.log('  cases:', a.totalCases, '(passed', a.passed, '/ failed', a.failed, ')');
      console.log('  meanMRR:', a.meanMRR.toFixed(4), 'meanNDCG:', a.meanNDCG.toFixed(4));
    "
    exit 0
    ;;

  hook-diff)
    echo ""
    echo "==> compare-vapor-eval.js (hook)"
    node "$REPO_ROOT/scripts/compare-vapor-eval.js" "$HOOK_BASELINE" "$HOOK_CURRENT"
    exit $?
    ;;

  diff)
    # WHY both gates run sequentially: a regression on either path must fail
    # the whole script.  We disable -e for the gates so we collect both exits
    # before deciding overall pass/fail.
    set +e
    echo ""
    echo "==> compare-vapor-eval.js (CLI)"
    node "$REPO_ROOT/scripts/compare-vapor-eval.js" "$BASELINE" "$CURRENT"
    CLI_EXIT=$?
    echo ""
    echo "==> compare-vapor-eval.js (hook)"
    if [[ -f "$HOOK_BASELINE" ]]; then
      node "$REPO_ROOT/scripts/compare-vapor-eval.js" "$HOOK_BASELINE" "$HOOK_CURRENT"
      HOOK_EXIT=$?
    else
      echo "  <skipped: $HOOK_BASELINE missing — run regen-hook-baseline first>"
      HOOK_EXIT=0
    fi
    set -e
    if [[ $CLI_EXIT -ne 0 || $HOOK_EXIT -ne 0 ]]; then
      echo ""
      echo "FAIL: CLI exit=$CLI_EXIT, hook exit=$HOOK_EXIT"
      exit 1
    fi
    echo ""
    echo "PASS: both CLI and hook gates clean."
    ;;
esac
