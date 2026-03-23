#!/usr/bin/env bash
#
# Manage systemd watcher service for sextant
#
# Usage:
#   watcher-service.sh enable [path]   - Enable and start watcher for project
#   watcher-service.sh disable [path]  - Stop and disable watcher
#   watcher-service.sh status [path]   - Show watcher status
#   watcher-service.sh logs [path]     - Show watcher logs
#   watcher-service.sh list            - List all active watchers
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$SCRIPT_DIR/../systemd"
SERVICE_FILE="sextant-watcher@.service"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info() { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; exit 1; }

# Get project path (default to current directory)
get_project_path() {
  local p="${1:-$(pwd)}"
  echo "$(cd "$p" && pwd)"
}

# Escape path for systemd instance name
# Note: Don't use --path flag as it strips leading /
escape_path() {
  systemd-escape "$1"
}

# Ensure systemd user service directory exists and service is installed
ensure_service_installed() {
  local user_service_dir="$HOME/.config/systemd/user"
  mkdir -p "$user_service_dir"
  
  if [ ! -f "$user_service_dir/$SERVICE_FILE" ]; then
    cp "$SERVICE_DIR/$SERVICE_FILE" "$user_service_dir/"
    systemctl --user daemon-reload
    info "Installed systemd service template"
  fi
}

cmd_enable() {
  local project_path="$(get_project_path "${1:-}")"
  local escaped="$(escape_path "$project_path")"
  local service_name="sextant-watcher@${escaped}.service"

  ensure_service_installed

  echo -e "${CYAN}Enabling watcher for:${NC} $project_path"
  echo ""

  # Initialize if needed
  if [ ! -d "$project_path/.planning/intel" ]; then
    echo "Initializing sextant..."
    (cd "$project_path" && sextant init && sextant scan)
  fi
  
  # Enable and start
  systemctl --user enable "$service_name"
  systemctl --user start "$service_name"
  
  echo ""
  info "Watcher enabled and started"
  echo ""
  echo "Commands:"
  echo "  Status: $0 status $project_path"
  echo "  Logs:   $0 logs $project_path"
  echo "  Stop:   $0 disable $project_path"
}

cmd_disable() {
  local project_path="$(get_project_path "${1:-}")"
  local escaped="$(escape_path "$project_path")"
  local service_name="sextant-watcher@${escaped}.service"
  
  echo -e "${CYAN}Disabling watcher for:${NC} $project_path"
  
  systemctl --user stop "$service_name" 2>/dev/null || true
  systemctl --user disable "$service_name" 2>/dev/null || true
  
  info "Watcher stopped and disabled"
}

cmd_status() {
  local project_path="$(get_project_path "${1:-}")"
  local escaped="$(escape_path "$project_path")"
  local service_name="sextant-watcher@${escaped}.service"
  
  echo -e "${CYAN}Watcher status for:${NC} $project_path"
  echo ""
  systemctl --user status "$service_name" --no-pager || true
}

cmd_logs() {
  local project_path="$(get_project_path "${1:-}")"
  local escaped="$(escape_path "$project_path")"
  local service_name="sextant-watcher@${escaped}.service"
  
  echo -e "${CYAN}Watcher logs for:${NC} $project_path"
  echo ""
  journalctl --user -u "$service_name" -f --no-pager
}

cmd_list() {
  echo -e "${CYAN}Active sextant watchers:${NC}"
  echo ""
  systemctl --user list-units 'sextant-watcher@*' --no-pager || echo "  (none)"
}

cmd_help() {
  echo "Usage: $0 <command> [project_path]"
  echo ""
  echo "Commands:"
  echo "  enable [path]   Enable and start watcher (default: current dir)"
  echo "  disable [path]  Stop and disable watcher"
  echo "  status [path]   Show watcher status"
  echo "  logs [path]     Follow watcher logs"
  echo "  list            List all active watchers"
  echo ""
  echo "Examples:"
  echo "  $0 enable                    # Enable for current directory"
  echo "  $0 enable ~/projects/myapp   # Enable for specific project"
  echo "  $0 list                      # Show all running watchers"
}

# Main
case "${1:-help}" in
  enable)  cmd_enable "${2:-}" ;;
  disable) cmd_disable "${2:-}" ;;
  status)  cmd_status "${2:-}" ;;
  logs)    cmd_logs "${2:-}" ;;
  list)    cmd_list ;;
  help|--help|-h) cmd_help ;;
  *) fail "Unknown command: $1. Use '$0 help' for usage." ;;
esac
