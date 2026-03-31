#!/bin/bash

# WHY: Status line script for Claude Code. Shows sextant health, watcher status,
# and injection timing at the bottom of the terminal. This is the ONLY way the
# user sees sextant state — hook stdout goes to Claude, hook stderr goes nowhere.
#
# Install: cp scripts/statusline-command.sh ~/.claude/statusline-command.sh
# Then add to ~/.claude/settings.json:
#   "statusLine": { "command": "~/.claude/statusline-command.sh" }
#
# Cross-platform: works on both Linux (stat -c) and macOS (stat -f).

input=$(cat)
cwd=$(echo "$input" | jq -r '.cwd')

user=$(whoami)
host=$(hostname -s)

git_branch=""
if git -c core.useBuiltinFSMonitor=false rev-parse --git-dir > /dev/null 2>&1; then
    git_branch=$(git -c core.useBuiltinFSMonitor=false branch 2>/dev/null | sed -e '/^[^*]/d' -e 's/* \(.*\)/(\1)/')
fi

printf '\e[32m%s@%s\e[m \e[34m%s\e[m' "$user" "$host" "$cwd"
[ -n "$git_branch" ] && printf ' \e[31m%s\e[m' "$git_branch"

# ── codebase-intel ─────────────────────────────────────
intel_dir="$cwd/.planning/intel"
intel_summary="$intel_dir/summary.md"
[ ! -f "$intel_summary" ] && exit 0

now=$(date +%s)
fmt_age() {
    local s=$1
    if [ "$s" -lt 60 ]; then echo "${s}s"
    elif [ "$s" -lt 3600 ]; then echo "$(( s / 60 ))m"
    elif [ "$s" -lt 86400 ]; then echo "$(( s / 3600 ))h"
    else echo "$(( s / 86400 ))d"; fi
}

# WHY: macOS uses `stat -f %m`, Linux uses `stat -c %Y`. Detect once.
if stat -f %m / >/dev/null 2>&1; then
    get_mtime() { stat -f %m "$1" 2>/dev/null || echo 0; }
else
    get_mtime() { stat -c %Y "$1" 2>/dev/null || echo 0; }
fi

# ── Parse summary for display data ────────────────────
res=$(grep -oE 'resolution [0-9]+' "$intel_summary" 2>/dev/null | grep -oE '[0-9]+' | head -1)
res_frac=$(grep -oE 'resolution [0-9]+% \([0-9/]+' "$intel_summary" 2>/dev/null | grep -oE '[0-9]+/[0-9]+' | head -1)
files=$(grep -oE 'Indexed files.*[0-9]+' "$intel_summary" 2>/dev/null | grep -oE '[0-9]+' | head -1)
[ -z "$files" ] && [ -z "$res" ] && exit 0

# ── Graph stats from graph.db ─────────────────────────
graph_db="$intel_dir/graph.db"
exports=""
reexports=""
if command -v sqlite3 &>/dev/null && [ -f "$graph_db" ]; then
    exports=$(sqlite3 "$graph_db" "SELECT COUNT(*) FROM exports;" 2>/dev/null)
    reexports=$(sqlite3 "$graph_db" "SELECT COUNT(*) FROM reexports;" 2>/dev/null || echo "0")
fi

# ── Health dot ────────────────────────────────────────
if [ -n "$res" ]; then
    if [ "$res" -ge 90 ]; then dot="\e[32m◆\e[m"
    elif [ "$res" -ge 70 ]; then dot="\e[33m◆\e[m"
    else dot="\e[31m◆\e[m"; fi
else
    dot="\e[36m◆\e[m"
fi

# ── Watcher status ────────────────────────────────────
hb="$intel_dir/.watcher_heartbeat"
if [ -f "$hb" ]; then
    hb_age=$(( now - $(get_mtime "$hb") ))
    if [ "$hb_age" -lt 90 ]; then
        watcher="\e[32m⟳ $(fmt_age $hb_age)\e[m"
    else
        watcher="\e[33m⏸ stale\e[m"
    fi
else
    watcher="\e[33m⏸ off\e[m"
fi

# ── Last injection to Claude ──────────────────────────
newest_hash=$(ls -t "$intel_dir"/.last_injected_hash.* 2>/dev/null | head -1)
inject_label=""
if [ -n "$newest_hash" ]; then
    inject_age=$(( now - $(get_mtime "$newest_hash") ))
    if [ "$inject_age" -lt 60 ]; then inject_label="\e[36m→ $(fmt_age $inject_age)\e[m"
    elif [ "$inject_age" -lt 300 ]; then inject_label="\e[90m→ $(fmt_age $inject_age)\e[m"
    else inject_label="\e[33m→ $(fmt_age $inject_age)\e[m"; fi
fi

# ── Watcher: last file processed ───────────────────────
last_file_label=""
last_file_path="$intel_dir/.watcher_last_file"
if [ -f "$last_file_path" ]; then
    lf=$(cat "$last_file_path" 2>/dev/null | tr -d '\n')
    [ -n "$lf" ] && last_file_label="\e[90m← $(basename "$lf")\e[m"
fi

# ── Assemble status line ──────────────────────────────
printf " ${dot}"
[ -n "$res" ] && printf " %s%%" "$res"
[ -n "$res_frac" ] && printf "\e[90m(%s)\e[m" "$res_frac"
[ -n "$files" ] && printf " %s files" "$files"
[ -n "$exports" ] && [ "$exports" != "0" ] && printf " \e[90m·\e[m %sexp" "$exports"
[ -n "$reexports" ] && [ "$reexports" != "0" ] && printf " \e[90m·\e[m %srx" "$reexports"
printf " \e[90m·\e[m %b" "$watcher"
[ -n "$inject_label" ] && printf " \e[90m·\e[m %b" "$inject_label"
[ -n "$last_file_label" ] && printf " %b" "$last_file_label"
exit 0
