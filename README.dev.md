# Developer Guide

For contributors and anyone working on sextant internals.
See `README.md` for user docs, `CLAUDE.md` for the AI agent guide.

## Development Setup

```bash
git clone https://github.com/Skidudeaa/sextant.git && cd sextant
npm install && npm link && npm test
```

No build step. CommonJS throughout, no transpilation.

## Testing

| Command | What it runs |
|---------|-------------|
| `npm run test:unit` | 356 unit tests via `node:test` (~900ms) |
| `npm run test:eval` | 19-query eval harness (MRR, nDCG, usefulness) |
| `npm test` | Full suite: unit + 5 bash integration scripts + eval |

Async test bodies must use `async` directly on `it()` -- wrapping in inner async IIFEs silently swallows failures.

## Project Layout

```
bin/intel.js              CLI dispatcher (~108 lines)
commands/                 one file per command, exports { run }
lib/
  intel.js                orchestrator (highest fan-in)
  graph.js                SQLite dependency graph (sql.js)
  retrieve.js             three-layer ranked search (rg + exports + reexports)
  scoring.js              hit-level scoring signals
  scoring-constants.js    shared numeric weights (both retrieval paths)
  graph-retrieve.js       fast hook-path retrieval (<50ms, no subprocesses)
  classifier.js           heuristic prompt classification (<1ms)
  merge-results.js        graph + zoekt result fusion
  format-retrieval.js     compact markdown formatter
  summary.js              bounded summary generation (~2200 chars)
  resolver.js             import specifier -> file path resolution
  rg.js                   ripgrep backend (source-first two-phase)
  zoekt.js                Zoekt HTTP backend (optional)
  cli.js                  shared CLI utilities
  extractors/             JS/TS (regex imports, AST exports), Python (AST)
mcp/server.js             JSON-RPC 2.0 MCP server (4 tools)
watch.js                  chokidar file watcher + heartbeat + dashboard
test/                     node:test unit tests
scripts/
  eval-retrieve.js        retrieval eval harness (19 cases)
  eval-dataset.json       eval test cases
  setup.sh                one-command project deployment
```

## Visibility Model (CRITICAL)

| Channel | Destination | Audience |
|---------|------------|----------|
| Hook **stdout** | `<system-reminder>` context | Claude only |
| Hook **stderr** | Nowhere | Nobody |
| **statusLine** in settings.json | Bottom of Claude Code | User only |

**No channel reaches both the user and Claude simultaneously.**
User-facing output goes in the statusline script. Claude-facing context goes on hook stdout. stderr is `/dev/null` with extra steps.

## Hook Lifecycle

Two hooks wired into project `.claude/settings.json` by `sextant init`:

**SessionStart** (`hook-sessionstart.js`): emits `summary.md` as `<codebase-intelligence>`. Auto-starts watcher if heartbeat missing/stale (>90s).

**UserPromptSubmit** (`hook-refresh.js`): classifies prompt (<1ms) then either runs graph+Zoekt retrieval in parallel (35-70ms, 180ms shared deadline) and emits `<codebase-retrieval>`, or falls back to static summary. Results deduped via SHA-256.

## Watcher Lifecycle

1. **Auto-start**: SessionStart hook forks `sextant watch` when heartbeat missing/stale
2. **Heartbeat**: writes `.watcher_heartbeat` every 30s (periodic) + on each flush
3. **Flush**: re-extracts changed files, updates graph.db, writes `.watcher_last_file`
4. **Stale detection**: heartbeat mtime > 90s = watcher considered dead
5. **Shutdown**: clears heartbeat on SIGINT/SIGTERM

## Scoring Pipeline

All weights live in `lib/scoring-constants.js`. Both `retrieve.js` and `graph-retrieve.js` import from there.

| Signal | Weight | Module |
|--------|--------|--------|
| `exact_symbol` | +40% | scoring.js |
| `def_site_priority` | +25% | retrieve.js |
| `hotspot` | +15% | retrieve.js |
| `symbol_contains_query` | +12% | scoring.js |
| `export_match` | +10% | scoring.js |
| `entry_point` | +10% | retrieve.js |
| `python_public` | +8% | scoring.js |
| `export_line` | +5% | scoring.js |
| `docstring_match` | +5% | scoring.js |
| `def_line` | +3% | scoring.js |
| `fan_in` | up to +15% | retrieve.js (log1p scaled, capped) |
| `test` | -25% | retrieve.js |
| `doc` | -40% | retrieve.js |
| `vendor` | -50% | retrieve.js |
| `noise_mid` | -8% | scoring.js (noise ratio > 0.5) |
| `noise_high` | -15% | scoring.js (noise ratio > 0.7) |
| `fan_in_suppression` | halves fan-in boost | retrieve.js (when def match exists elsewhere) |

Graph-retrieve base scores (absolute points before fan-in): exported_symbol=100, reexport_chain=80, path_match=60.

Merge layer: graph hits get 1.4x authority boost, files in both graph+zoekt get 1.2x fusion bonus.

## State Files

| File | Writer | Reader | Purpose |
|------|--------|--------|---------|
| `graph.db` | intel.js, watch.js | graph.js, graph-retrieve.js | SQLite dependency graph (single source of truth) |
| `summary.md` | summary.js | hook-sessionstart.js, hook-refresh.js | Static summary injected to Claude |
| `history.json` | history.js | summary.js | Health trend snapshots for sparklines |
| `.watcher_heartbeat` | watch.js (every 30s) | statusline, hook-sessionstart.js | Watcher alive signal (mtime-based) |
| `.watcher_last_file` | watch.js (on flush) | statusline | Last file the watcher processed |
| `.last_injected_hash.summary.*` | hook-sessionstart.js, hook-refresh.js | same | Per-session SHA-256 dedupe for static summary |
| `.last_injected_hash.retrieval.*` | hook-refresh.js | same | Per-session SHA-256 dedupe for retrieval results |

All state lives in `.planning/intel/` per repo (never committed).

## Health Semantics

- **Resolution >= 90%**: graph boosts enabled | **< 90%**: graph boosts gated off
- **Index age > 300s**: `ALERT:` emitted in summary
- **Heartbeat > 90s**: watcher considered dead, auto-restarted by SessionStart

## Debugging

```bash
sextant doctor                            # full diagnosis
sextant health --pretty                   # formatted metrics
sextant summary                           # what Claude receives
node scripts/eval-retrieve.js --verbose   # scoring debug per query
ls -la .planning/intel/.watcher_heartbeat # watcher alive?
```

## Adding a New Command

1. Create `commands/foo.js` exporting `async function run(ctx)` as `{ run }`
2. `ctx` has `{ argv, roots, root }` -- import `flag`/`hasFlag` from `lib/cli.js`
3. Add `foo: "../commands/foo"` to `commandMap` in `bin/intel.js`
4. Commands that skip roots parsing (hooks, etc.) get an early-exit block instead

## Design Principles

See `DESIGN_PHILOSOPHY.md`. In brief:

1. **Orientation > intelligence** -- small factual map over large speculative one
2. **Drift must be loud** -- resolution %, index age, ranking all degrade visibly
3. **Evidence != structure** -- rg/Zoekt = evidence, graph = structure, reranking combines them
4. **Degrade, don't guess** -- unresolved imports recorded and surfaced, never fabricated
5. **Session boundaries matter** -- before the first prompt is the critical moment
6. **Reusability > cleverness** -- one global tool, per-repo state, explicit commands

## Anti-Goals

Do not add: embeddings/vector search, LLM calls in the pipeline, semantic claims (LSP-like), summaries > 2200 chars, UI that writes to stderr in hooks. Use eval metrics (MRR, nDCG, usefulness) to justify scoring or retrieval changes.
