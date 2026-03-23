#!/usr/bin/env bash
#
# sextant setup script
# Run this in any project directory to enable codebase intelligence.
#
# Usage:
#   ./setup.sh           # Setup only
#   ./setup.sh --watch   # Setup + enable systemd watcher service
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENABLE_WATCH=false

# Parse flags
for arg in "$@"; do
  case $arg in
    --watch) ENABLE_WATCH=true ;;
  esac
done

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info() { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; exit 1; }

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  sextant setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check if sextant is installed (also accepts codebase-intel alias)
if ! command -v sextant &> /dev/null; then
  fail "sextant not found on PATH

Install it first:
  cd /path/to/sextant
  npm install && npm link
"
fi

info "sextant found: $(which sextant)"

# Check we're in a project directory (has some code files)
if [ ! -d ".git" ] && [ ! -f "package.json" ] && [ ! -f "pyproject.toml" ] && [ ! -f "setup.py" ]; then
  warn "No .git, package.json, or Python project files found"
  read -p "Continue anyway? [y/N] " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

# Initialize
echo ""
echo "Initializing..."
sextant init
info "State directory created: .planning/intel/"
info "Claude hooks wired: .claude/settings.json"

# Scan
echo ""
echo "Scanning codebase..."
sextant scan
info "Index built"

# Show health
echo ""
echo "Health check:"
sextant doctor

# Add to gitignore if not present
if [ -f ".gitignore" ]; then
  if ! grep -q "^\.planning/" .gitignore 2>/dev/null; then
    echo ".planning/" >> .gitignore
    info "Added .planning/ to .gitignore"
  fi
else
  echo ".planning/" > .gitignore
  info "Created .gitignore with .planning/"
fi

# Optionally enable systemd watcher service
if [ "$ENABLE_WATCH" = true ]; then
  echo ""
  echo "Enabling systemd watcher service..."
  "$SCRIPT_DIR/watcher-service.sh" enable "$(pwd)"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Setup complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ "$ENABLE_WATCH" = true ]; then
  echo "Watcher service is running. Manage with:"
  echo "  $SCRIPT_DIR/watcher-service.sh status"
  echo "  $SCRIPT_DIR/watcher-service.sh logs"
  echo "  $SCRIPT_DIR/watcher-service.sh disable"
else
  echo "Next steps (optional):"
  echo "  Enable persistent watcher service:"
  echo "    $SCRIPT_DIR/watcher-service.sh enable"
  echo ""
  echo "  Or run manually:"
  echo "    sextant watch --summary-every 5"
fi
echo ""
echo "Claude Code will now receive codebase intelligence automatically."
