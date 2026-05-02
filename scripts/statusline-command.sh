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
# WHY: jq is not installed by default on Alpine/minimal Docker. Fall back to
# sed-based extraction so the statusline works without it. Cwd values in
# practice are simple paths (no escapes/unicode) so the sed pattern is safe.
if command -v jq >/dev/null 2>&1; then
    cwd=$(printf '%s' "$input" | jq -r '.cwd // empty')
else
    cwd=$(printf '%s' "$input" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
fi

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
# WHY we no longer extract res_frac (the 155/155): redundant with the
# percentage on the happy path, and the user found "100%(155/155) · 80 files"
# confusing because the relationship between the three numbers isn't
# obvious at a glance.  Resolution % alone is the at-a-glance health
# signal; the absolute fraction is available via `sextant doctor`.
#
# WHY we no longer query graph.db for `exports`/`reexports` counts: those
# are interesting to a sextant developer but not actionable for the user
# -- they were noise in the line that mattered.  `sextant telemetry` and
# `sextant doctor` carry the diagnostic detail; the statusline carries
# only what the user needs to decide whether to act.
res=$(grep -oE 'resolution [0-9]+' "$intel_summary" 2>/dev/null | grep -oE '[0-9]+' | head -1)
files=$(grep -oE 'Indexed files.*[0-9]+' "$intel_summary" 2>/dev/null | grep -oE '[0-9]+' | head -1)
# WHY: Swift parser ALERT is emitted by lib/summary.js when the WASM grammar
# fails to load AND the repo has Swift files. Surfaces in the action_hint
# slot below.  Pattern matches "ALERT: SWIFT PARSER INIT_FAILED" or
# "ALERT: SWIFT PARSER UNAVAILABLE".
swift_alert=$(grep -oE '^ALERT: SWIFT PARSER [A-Z_]+' "$intel_summary" 2>/dev/null | head -1)
[ -z "$files" ] && [ -z "$res" ] && exit 0

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
watcher_state="ok"   # ok | stale | off
if [ -f "$hb" ]; then
    hb_age=$(( now - $(get_mtime "$hb") ))
    if [ "$hb_age" -lt 90 ]; then
        watcher="\e[32m⟳ $(fmt_age $hb_age)\e[m"
    else
        watcher="\e[33m⏸ stale\e[m"
        watcher_state="stale"
    fi
else
    watcher="\e[33m⏸ off\e[m"
    watcher_state="off"
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

# ── Last query-aware retrieval ─────────────────────────
# WHY: Distinguishes the static-summary inject path from the actual graph+
# zoekt retrieval pipeline.  File: line 1 = file count, line 2 = unix ts.
# Only written by hook-refresh.js when retrieval fires with results.
retrieval_label=""
retrieval_path="$intel_dir/.last_retrieval"
if [ -f "$retrieval_path" ]; then
    r_count=$(sed -n '1p' "$retrieval_path" 2>/dev/null)
    r_ts=$(sed -n '2p' "$retrieval_path" 2>/dev/null)
    if [ -n "$r_count" ] && [ -n "$r_ts" ]; then
        r_age=$(( now - r_ts ))
        if [ "$r_age" -lt 60 ]; then
            retrieval_label="\e[36m🔍 ${r_count} \e[90m· $(fmt_age $r_age)\e[m"
        elif [ "$r_age" -lt 600 ]; then
            retrieval_label="\e[90m🔍 ${r_count} · $(fmt_age $r_age)\e[m"
        fi
    fi
fi

# ── Action hint (the only "you need to do X" surface for the user) ──
# WHY this exists: the freshness gate, watcher heartbeat, and resolution
# health all detect actionable conditions, but Claude sees them via the
# <codebase-intelligence> injection and the user only sees this status
# line.  Without an action slot here, the user has no signal that
# something is off until something visibly breaks -- and even then, no
# hint about *which* command fixes it.  This block computes a single
# highest-priority action and surfaces the literal command to copy.
#
# Priority (highest to lowest):
#   1. Watcher off / heartbeat stale     -> sextant watch-start
#   2. Resolution < 90% (extractor drift / unresolvable imports en masse)
#                                         -> sextant scan --force
#   3. Swift parser failed (WASM missing/incompatible)
#                                         -> sextant doctor (full diagnostic)
# Multiple-issue case: show the most severe; when it's resolved, the
# next-most severe surfaces.  We do NOT auto-execute -- the user copies.
action_hint=""
if [ "$watcher_state" = "off" ] || [ "$watcher_state" = "stale" ]; then
    action_hint="\e[33m⚠ run: sextant watch-start\e[m"
elif [ -n "$res" ] && [ "$res" -lt 90 ]; then
    action_hint="\e[33m⚠ run: sextant scan --force\e[m"
elif [ -n "$swift_alert" ]; then
    action_hint="\e[33m⚠ swift parser unavailable: sextant doctor\e[m"
fi

# ── Assemble status line ──────────────────────────────
printf " ${dot}"
[ -n "$res" ] && printf " %s%%" "$res"
[ -n "$files" ] && printf " %s files" "$files"
printf " \e[90m·\e[m %b" "$watcher"
[ -n "$inject_label" ] && printf " \e[90m·\e[m %b" "$inject_label"
[ -n "$retrieval_label" ] && printf " \e[90m·\e[m %b" "$retrieval_label"
[ -n "$last_file_label" ] && printf " %b" "$last_file_label"
[ -n "$action_hint" ] && printf "  %b" "$action_hint"
exit 0
