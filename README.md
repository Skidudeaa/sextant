# sextant

Health-aware codebase intelligence for LLM coding agents.

Maps repository structure, tracks import health, and injects a factual summary into Claude Code sessions — so the model starts oriented, not guessing.

> **Note:** The `codebase-intel` command still works as an alias for `sextant`.

## Install

```bash
npm install && npm link
sextant --help
```

## Use

```bash
cd /path/to/project
sextant init          # wire hooks + create state dir
sextant scan --force  # index files, build graph
```

Claude Code receives codebase intelligence automatically via hooks.

## What you'll actually see

This is the part that's confusing, so read carefully.

**There are two audiences**: you (the human) and Claude (the LLM). They see different things through different channels. Nothing about this is obvious.

### What Claude sees

Claude receives a `<codebase-intelligence>` block as context on every session start and whenever the summary changes mid-session. You'll see it as `<system-reminder>` tags in the conversation. This is the summary from `.planning/intel/summary.md` — hotspots, health metrics, entry points, recent changes. Claude reads it. You don't control when it fires. It just works.

### What you see

**The status line** at the bottom of Claude Code. This is the ONLY persistent visual indicator. It comes from `~/.claude/statusline-command.sh` and shows:

```
root@host ~/project (main) ◆ 100%(35/35) · 27 files · 130exp · ⟳ 3s · → 12s ← config.py
```

| Part | What it means | Where the data comes from |
|------|---------------|--------------------------|
| `◆` | Health dot (green/yellow/red) | Resolution % from summary.md |
| `100%(35/35)` | Import resolution rate | summary.md |
| `27 files` | Indexed file count | summary.md |
| `130exp` | Exports tracked by AST extraction | graph.db `exports` table |
| `1004rx` | Re-exports tracked (barrel files) | graph.db `reexports` table |
| `⟳ 3s` / `⏸ off` | Watcher status + heartbeat age | `.watcher_heartbeat` file mtime |
| `→ 12s` | When context was last sent to Claude | `.last_injected_hash.*` file mtime |
| `← config.py` | Last file the watcher processed | `.watcher_last_file` |

If you don't see the status line, sextant has no way to talk to you. Check that your `statusLine` config in `~/.claude/settings.json` points to a script that reads the intel state files.

### What you DON'T see

- **Hook output** — stdout from hooks goes to Claude as context, not to your terminal
- **stderr from hooks** — goes nowhere visible. Don't write UI to stderr in hooks.
- **The banner** — there's a banner written to stderr on session start. You can't see it. It exists for debugging only (`echo '{"source":"startup"}' | sextant hook sessionstart 2>&1 1>/dev/null`)

### How to verify it's working

1. **Status line shows `◆`** — sextant is active for this project
2. **`⟳`** is green — watcher is running and heartbeating
3. **`→ Xs`** is cyan or dim — context was recently sent to Claude
4. **`← filename`** — watcher last processed this file
5. **Run `sextant summary`** — see exactly what Claude receives
6. **Run `sextant health`** — see raw metrics as JSON

If the status line shows nothing after `(branch)`, either `.planning/intel/summary.md` doesn't exist (run `init` + `scan`) or the statusline script doesn't have the sextant section.

## Watcher

The watcher keeps the index fresh as you edit files.

```bash
sextant watch         # foreground with dashboard
sextant watch-start   # background (detached)
sextant watch-stop    # kill background watcher
```

In Claude Code, type `/watch` to toggle it on/off.

The watcher auto-starts when a Claude Code session begins (via the SessionStart hook). If it dies or goes stale, the status line shows `⏸`.

**What the watcher actually monitors**: files matching the configured globs (`lib/**/*.js`, `src/**/*.ts`, `**/*.py` by default). If you're editing files outside those patterns (e.g., `bin/`, root-level scripts), the watcher won't see them. Add broader globs to `.codebase-intel.json` if needed.

**Heartbeat**: the watcher writes `.planning/intel/.watcher_heartbeat` every 30 seconds and on each file-change flush. Status line reads this file's mtime. If it's > 90s old (3x the write interval), watcher is considered dead.

## Commands

| Command | What it does |
|---------|-------------|
| `init` | Create `.planning/intel/`, wire Claude hooks |
| `scan [--force]` | Index imports/exports, build dependency graph |
| `rescan [--force]` | Scan + prune deleted files |
| `watch` | Live file watching with terminal dashboard |
| `watch-start` | Start watcher in background |
| `watch-stop` | Stop background watcher |
| `health` | Resolution %, index age, top unresolved |
| `doctor` | Visual diagnostic with trends and hints |
| `summary` | Print what Claude sees |
| `retrieve <query>` | Ranked search with graph context |

## How it works

1. **Extract** — parse imports/exports from JS/TS (regex + AST for exports) and Python (AST)
2. **Resolve** — map import specifiers to file paths (relative, tsconfig, workspace, Python dot-notation)
3. **Graph** — store dependency edges + exports + re-exports in SQLite
4. **Summarize** — generate bounded markdown (<2200 chars): health, hotspots, entry points, recent changes
5. **Inject** — push summary to Claude at session start and when it changes (dedupe per session via SHA-256)
6. **Retrieve** — two-phase rg (source first), score with definition-site + export-graph + re-export chain, rerank with graph

## Scoring pipeline

| Signal | Weight | What it does |
|--------|--------|-------------|
| `exact_symbol` | +40% | Definition line's symbol name matches query |
| `def_site_priority` | +25% | Function/class definition matching query |
| `export-graph lookup` | inject | Finds files that export the queried symbol, even if rg missed them |
| `re-export chain` | inject | Follows barrel files to the original definition |
| `hotspot` | +15% | File in top-5 fan-in |
| `fan-in suppression` | -50% of graph boost | Halves graph boost on hub files when definition match exists |
| `doc penalty` | -40% | Markdown, rst, changelog files |
| `test penalty` | -25% | Test directories/files |
| `vendor penalty` | -50% | node_modules, dist, build |
| `health gating` | disable | Graph boosts disabled below 90% resolution |

## Languages

- JavaScript / TypeScript (regex imports, AST exports via `@babel/parser`)
- Python (AST extraction via stdlib `ast`)

## Config

Optional `.codebase-intel.json` at repo root:

```json
{
  "globs": ["**/*.{js,ts,py}"],
  "ignore": ["legacy/**"],
  "summaryThrottleMs": 5000
}
```

## State

All state in `.planning/intel/` (add `.planning/` to `.gitignore`):

```
graph.db                SQLite dependency graph (files, imports, exports, reexports)
index.json              file metadata + import/export records
summary.md              the summary Claude receives
history.json            health trend snapshots
.watcher_heartbeat      watcher alive signal (mtime checked every 30s)
.watcher_last_file      last file the watcher processed
.last_injected_hash.*   per-session context dedupe (SHA-256)
```

## Updating in existing projects

The tool is installed globally via `npm link`. The binary is a symlink — any code changes are immediately available everywhere. To rebuild the index with new features:

```bash
cd /path/to/project
sextant scan --force
```

No reinstall or re-init needed.
