# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

`sextant` (formerly `codebase-intel`) is a health-aware codebase intelligence service that keeps LLM coding agents oriented by continuously mapping repository structure and injecting factual summaries into Claude Code sessions. It solves orientation failures (hallucinated structure, wrong starting files, missed blast radius) by providing a small, honest map before the first prompt and keeping it fresh mid-session.

It is **not** a semantic code understanding engine, LSP, vector database, or IDE replacement. See `DESIGN_PHILOSOPHY.md` for the guiding principles (orientation > intelligence, drift must be loud, degrade don't guess).

## Commands

```bash
npm install          # install dependencies (chokidar, fast-glob, sql.js)
npm link             # make `sextant` globally available (`codebase-intel` still works as alias)
npm test             # runs scripts/test-refresh.sh (refresh hook regression tests)
```

No build step. CommonJS throughout, no transpilation.

## Architecture

### Pipeline

1. **Extractors** (`lib/extractors/`) parse imports/exports from source files
   - JS/TS: regex-based (`javascript.js`)
   - Python: AST-based via `python_ast.py` (`python.js`)

2. **Resolver** (`lib/resolver.js`) maps import specifiers to file paths
   - JS/TS: relative paths, tsconfig `paths`/`baseUrl`, workspace packages
   - Python: relative imports (dot notation), local package imports
   - Returns `{ specifier, resolved, kind }` where kind is `relative|external|tsconfig|workspace|asset|unresolved`

3. **Graph** (`lib/graph.js`) stores the dependency graph in SQLite (via sql.js)
   - Tables: `files`, `imports`, `exports`, `meta`
   - Provides fan-in/fan-out queries, neighbor expansion, hotspot detection

4. **Intel** (`lib/intel.js`) orchestrates everything — the central module (highest fan-in)
   - Per-root state management via `stateByRoot` Map
   - Serialized operations via `withQueue()` promise chain
   - Debounced flushing for index, graph, and summary writes
   - Auto-migrates stale index formats on load (INDEX_VERSION gated)

5. **Summary** (`lib/summary.js`) generates bounded markdown summaries (~2200 chars max)
   - Health metrics, module types, dependency hotspots, entry points, recent git changes
   - Emits `ALERT:` lines when resolution < 90% or index is stale

6. **Retrieve** (`lib/retrieve.js`) provides ranked search combining text search with graph reranking
   - **Scoring** (`lib/scoring.js`): symbol-aware signals — exact match (+40%), definition-site priority (+25%), noise penalty, CommonJS/Python pattern recognition
   - **rg backend** (`lib/rg.js`): two-phase collection — source files first, then docs/config. Prevents changelog saturation for common terms
   - **Fan-in suppression**: halves graph boost on hub files when a definition match exists in the result set
   - **Health gating**: graph boosts disabled when resolution < 90%

### Injection into Claude Code

Two hooks (configured in `.claude/settings.json`):
- **SessionStart**: `sextant hook sessionstart` — injects summary on session start/resume
- **UserPromptSubmit**: `node tools/codebase_intel/refresh.js` — re-injects if summary changed (per-session SHA-256 dedupe)

### Per-Repo State

All state lives in `.planning/intel/` (never committed):
- `graph.db` — SQLite dependency graph
- `index.json` — file metadata and import/export records (INDEX_VERSION 2)
- `summary.md` — the injected summary
- `history.json` — health snapshots for sparkline trends
- `.last_injected_hash.*` — per-session dedupe hashes

## Key Design Decisions

- **Health-gated ranking**: graph reranking disabled when import resolution drops below 90%
- **Definition over hub**: scoring prioritizes files that define a symbol over files that merely import it — fan-in suppression + definition-site priority signals
- **Source-first search**: rg searches source files before docs/config to prevent changelog saturation on common terms
- **Auto-migration**: stale index entries (v1 format) are detected and re-extracted transparently on load
- **Debounced writes**: index, graph, and summary use independent debounce timers during watch mode
- **Queue serialization**: all operations on a root are serialized through a promise chain to prevent concurrent SQLite access
- **Summary is clamped**: hard-capped at ~2200 chars to stay within useful context budget
- **Per-repo config**: `.codebase-intel.json` at repo root overrides default globs, ignore patterns, and summary throttle interval
- **Periodic heartbeats**: background processes (watcher) must ping a heartbeat file periodically, not just on activity — idle processes that only write on flush look dead to status monitors
- **No redundant metrics**: don't display values that are always identical (e.g., indexed files vs graph nodes are always equal)
