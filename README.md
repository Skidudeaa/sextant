# sextant

Health-aware codebase intelligence that keeps LLM coding agents oriented.

## The Problem

LLMs confidently hallucinate file structure in unfamiliar codebases. They pick
the wrong starting files, miss blast radius, and invent modules that don't exist.
More retrieval makes this faster, not rarer. Sextant solves it differently: it
builds a small, honest map of your repository and injects it into Claude Code
sessions before the first prompt -- so the model starts oriented, not guessing.

## How It Works

```
Source files
    |
    v
Extract imports/exports (regex + AST)
    |
    v
Resolve paths (relative, tsconfig, workspace, Python dot-notation)
    |
    v
Build dependency graph (SQLite via sql.js)
    |
    v
Generate summary (<2200 chars: health, hotspots, entry points, recent changes)
    |
    v
Inject into Claude Code (SessionStart hook + query-aware UserPromptSubmit hook)
```

On each user prompt, sextant classifies the input (<1ms), runs graph retrieval
and text search in parallel if code-relevant (~50ms), and injects ranked results
as context. Non-code prompts get the static summary instead.

## Quick Start

```bash
# Install globally
cd /path/to/sextant && npm install && npm link

# Set up a project
cd your-project
sextant init              # creates .planning/intel/, wires hooks, registers MCP server
sextant scan --force      # indexes files, builds dependency graph
```

### Status line (optional but recommended)

To see sextant status at the bottom of Claude Code, install the status line script:

```bash
cp /path/to/sextant/scripts/statusline-command.sh ~/.claude/statusline-command.sh
```

Then add to your global `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "command": "~/.claude/statusline-command.sh"
  }
}
```

Works on both macOS and Linux. Requires `jq` and optionally `sqlite3` for export counts.

That's it. On the next Claude Code session:

1. The **SessionStart hook** injects the codebase summary and starts the file watcher
2. The **UserPromptSubmit hook** classifies each prompt and injects code-relevant context
3. The **watcher** keeps the index fresh as you edit files

## What You'll See

The status line at the bottom of Claude Code is your only visual indicator:

```
root@host ~/project (main) ◆ 97% · 64 files · ⟳ 3s · → 8s ← resolver.js
```

When something needs action, an action slot appears with the literal command to run:

```
root@host ~/project (main) ◆ 60% · 12 files · ⏸ off  ⚠ run: sextant watch-start
```

| Part | Meaning |
|------|---------|
| `◆` | Health indicator (green/yellow/red) |
| `97%` | Import resolution rate |
| `64 files` | Indexed file count |
| `⟳ 3s` / `⏸ off` | Watcher status + heartbeat age |
| `→ 8s` | When context was last sent to Claude |
| `← resolver.js` | Last file the watcher processed |
| `⚠ run: <cmd>` | Action hint (only when something needs attention) |

### Operational ergonomics — telling you what to type

Sextant runs in the background, so when something goes wrong you might not remember whether to scan, rescan, init, or restart the watcher. Two surfaces solve this without taking any action on your behalf:

- **Status line action slot** — appears only when an actionable condition is detected (watcher off/stale, resolution below 90%) and carries the literal command to copy. Highest-priority action shown alone; fix it, the next one appears next render.
- **`sextant doctor` Actions block** — top-of-output checklist that exhaustively lists every applicable item (state-dir missing, graph.db missing/empty, watcher dead or stale, resolution degraded, settings.json missing) with a `→ sextant <cmd>` line under each.

Detection and recommendation live in code; execution stays in your hands. Sextant never auto-runs a scan or restarts a watcher.

### Visibility model

There are three output channels and they go to different places:

| Channel | Destination | Audience |
|---------|-------------|----------|
| Hook stdout | Injected as `<system-reminder>` context | Claude only |
| Hook stderr | Nowhere | Nobody |
| `statusLine` in settings.json | Bottom of Claude Code terminal | User only |

There is no channel that both the user and Claude see simultaneously.

## Features

- **Health-gated scoring** -- graph boosts disabled when import resolution drops below 90%
- **Three-layer retrieval** -- rg text search + export-graph symbol lookup + re-export chain tracing
- **Swift declarations + relations** -- tree-sitter walker produces top-level types, members one level deep, and conformance/inheritance edges with `confidence={direct|heuristic}`
- **Query-aware hooks** -- classifies each prompt, retrieves code-relevant context in <200ms
- **AST export extraction** -- JS/TS via @babel/parser with regex fallback on parse failure
- **MCP server** -- 4 tools (search, related, explain, health) registered per-project via `.mcp.json`
- **Definition over hub** -- definition-site scoring beats high fan-in hub files
- **Source-first search** -- source files searched before docs/config to prevent changelog saturation
- **Re-export chain tracing** -- follows barrel-file re-exports up to 5 hops to find original definitions
- **Cross-project validated** -- Express (142 files), Flask (83 files), React (4,337 files)

## Commands

| Command | Description |
|---------|-------------|
| `sextant init` | Create `.planning/intel/`, wire Claude Code hooks, register MCP server |
| `sextant scan [--force]` | Index imports/exports, build dependency graph |
| `sextant rescan [--force]` | Scan + prune deleted files |
| `sextant watch` | Live file watching with terminal dashboard |
| `sextant watch-start` | Start watcher in background (detached) |
| `sextant watch-stop` | Stop background watcher |
| `sextant health [--pretty]` | Resolution %, index age, top unresolved |
| `sextant doctor` | Visual diagnostic with trends and hints |
| `sextant summary` | Print what Claude sees |
| `sextant retrieve <query>` | Ranked search with graph context |
| `sextant query <imports\|dependents\|exports> --file <path>` | Query the dependency graph directly |
| `sextant zoekt <index\|serve\|search>` | Manage Zoekt code search (optional) |
| `sextant mcp` | Start the MCP server (stdio, used by Claude Code) |
| `sextant hook sessionstart` | SessionStart hook entry point |
| `sextant hook refresh` | UserPromptSubmit hook entry point |

## Configuration

Optional `.codebase-intel.json` at project root:

```json
{
  "globs": ["**/*.{js,ts,py}"],
  "ignore": ["legacy/**", "vendor/**"],
  "summaryThrottleMs": 5000
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `globs` | `["**/*.{js,ts,py}"]` | File patterns to index |
| `ignore` | `[]` | Patterns to exclude |
| `summaryThrottleMs` | `5000` | Minimum interval between summary regenerations |

## Language Support

| Language | Import extraction | Export extraction |
|----------|------------------|-------------------|
| JavaScript / TypeScript | Regex (96-100% accurate) | AST via `@babel/parser`, regex fallback |
| Python | AST via stdlib `ast` (subprocess) | AST via stdlib `ast` (subprocess) |
| Swift | tree-sitter (declarations + relations only — `import` statements not yet resolved as graph edges) | n/a — Swift has no `export` semantics |

> Swift v1 is **repo-local source orientation**, not SDK / framework
> introspection. See [docs/swift-v1-scope.md](docs/swift-v1-scope.md) for what
> works, what doesn't, and how to recover from parser failure.

## Architecture

The central orchestrator is `lib/intel.js` (highest fan-in in the project). Key modules:

- **`lib/graph.js`** -- SQLite dependency graph (files, imports, exports, re-exports)
- **`lib/retrieve.js`** -- three-layer ranked search (rg + export-graph + re-export chains)
- **`lib/scoring.js`** + **`lib/scoring-constants.js`** -- definition-site priority, fan-in suppression, health gating
- **`lib/classifier.js`** -- heuristic prompt classification (<1ms, no LLM calls)
- **`lib/graph-retrieve.js`** -- fast graph-only search for hooks (<50ms, no subprocesses)
- **`lib/summary.js`** -- bounded markdown generation (<2200 chars)
- **`mcp/server.js`** -- JSON-RPC 2.0 MCP server over stdio

See [DESIGN_PHILOSOPHY.md](DESIGN_PHILOSOPHY.md) for the guiding principles (orientation over intelligence, drift must be loud, degrade don't guess).

## Eval Results

19/19 queries pass. MRR 0.954, nDCG 0.925. Cross-project validated on Express (142 files), Flask (83 files), React (4,337 files).

See [EVAL_FINDINGS.md](EVAL_FINDINGS.md) for methodology, scoring evolution, and bugs found by eval.

## State Directory

All state lives in `.planning/intel/` (add `.planning/` to `.gitignore`):

| File | Purpose |
|------|---------|
| `graph.db` | SQLite dependency graph -- single source of truth |
| `summary.md` | The summary injected into Claude Code |
| `history.json` | Health trend snapshots for sparkline display |
| `.watcher_heartbeat` | Watcher alive signal (mtime checked by status line) |
| `.watcher_last_file` | Last file the watcher processed |
| `.last_injected_hash.*` | Per-session context deduplication (SHA-256) |

## Requirements

- Node.js 18+
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) for text search layer
- Optional: [Zoekt](https://github.com/sourcegraph/zoekt) for large-repo text search
- Optional: Python 3 for Python project indexing

## License

MIT
