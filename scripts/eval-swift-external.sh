#!/usr/bin/env bash
# External Swift benchmark — clone Vapor at a pinned tag, scan with sextant,
# run the eval-retrieve.js harness against fixtures/vapor-eval-queries.json,
# diff against fixtures/vapor-baseline.json.
#
# Usage:
#   bash scripts/eval-swift-external.sh                  # diff mode (default)
#   bash scripts/eval-swift-external.sh regen-baseline   # regenerate the baseline
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
CURRENT="$(mktemp -t vapor-current.XXXXXX.json)"
trap 'rm -f "$CURRENT"' EXIT

if [[ "$MODE" != "diff" && "$MODE" != "regen-baseline" ]]; then
  echo "usage: $0 [diff|regen-baseline]" >&2
  exit 2
fi

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

# 3. Run eval-retrieve.js with --json into the temp file.
echo "==> eval-retrieve.js --root $VAPOR_DIR --dataset $QUERIES"
node "$REPO_ROOT/scripts/eval-retrieve.js" \
  --root "$VAPOR_DIR" \
  --dataset "$QUERIES" \
  --json > "$CURRENT"

# 4a. Regen-baseline mode: write current → baseline, print summary.
if [[ "$MODE" == "regen-baseline" ]]; then
  cp "$CURRENT" "$BASELINE"
  echo ""
  echo "==> Wrote new baseline to $BASELINE"
  node -e "
    const j = JSON.parse(require('fs').readFileSync('$BASELINE','utf8'));
    const a = j.aggregates;
    console.log('  cases:', a.totalCases, '(passed', a.passed, '/ failed', a.failed, ')');
    console.log('  meanMRR:', a.meanMRR.toFixed(4), 'meanNDCG:', a.meanNDCG.toFixed(4));
    console.log('  graphLiftNDCG:', a.graphLiftNDCG.toFixed(4), '(' + a.graphLiftDirection + ')');
  "
  exit 0
fi

# 4b. Diff mode: run the comparator. Exit code propagates.
echo ""
echo "==> compare-vapor-eval.js"
node "$REPO_ROOT/scripts/compare-vapor-eval.js" "$BASELINE" "$CURRENT"
