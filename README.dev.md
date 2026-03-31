# Developer Notes

For maintaining and operating the system.

## The visibility model (read this first)

This is the single most confusing thing about the system. There are three output channels and they go to different places:

| Channel | Where it goes | What sees it |
|---------|--------------|-------------|
| Hook **stdout** | Injected as Claude context (`<system-reminder>`) | Claude only |
| Hook **stderr** | Nowhere visible | Nobody (don't use for UI) |
| **statusLine** config | Persistent line at bottom of Claude Code | User only |

**There is no channel that both the user and Claude see simultaneously.**

The SessionStart hook writes a banner to stderr. Nobody sees it. It exists for manual debugging only. The actual user-facing indicator is the `statusLine` in `~/.claude/settings.json`, which runs a shell script that reads state files from `.planning/intel/`.

If you're adding user-facing output, put it in the statusline script. If you're adding Claude-facing context, put it in hook stdout. If you write to stderr, you're writing to /dev/null with extra steps.

## Layout

```
bin/intel.js              CLI entrypoint + hooks + banner/statusline renderers
lib/
  intel.js                orchestration (init/scan/update/health/auto-migrate)
  retrieve.js             search + scoring + graph rerank + export-graph lookup
  scoring.js              symbol detection, noise penalty, enhanced signals
  resolver.js             import → file path resolution
  graph.js                SQLite graph (files, imports, exports, reexports)
  summary.js              bounded summary generation + health alerts
  rg.js                   ripgrep backend (source-first two-phase, searchInFiles)
  scope-finder.js         function/class scope context for hits
  zoekt.js                Zoekt backend (optional)
  utils.js                shared utilities (isEntryPoint, isIndexable, etc.)
  terminal-viz.js         ANSI colors, bars, sparklines, box drawing
  extractors/
    javascript.js         JS/TS extractor (regex imports, AST exports via babel)
    js_ast_exports.js     AST export extraction (@babel/parser)
    python_ast.py         Python AST extractor
    python.js             Node wrapper for python_ast.py
    index.js              extractor registry
watch.js                  chokidar file watcher + heartbeat + dashboard
scripts/
  eval-retrieve.js        retrieval evaluation harness (19 cases)
  eval-dataset.json       eval test cases
  setup.sh                one-command project deployment
  test-refresh.sh         refresh hook regression tests
~/.claude/
  statusline-command.sh   status line script (reads intel state files)
  commands/watch.md       /watch slash command definition
```

## State files and what reads them

```
.planning/intel/
  graph.db                  ← graph.js (SQLite: files, imports, exports, reexports)
  index.json                ← intel.js (file metadata, INDEX_VERSION 2)
  summary.md                ← summary.js writes, hooks read, statusline reads
  history.json              ← history.js (health trend snapshots)
  .watcher_heartbeat        ← watch.js writes every 30s, statusline reads mtime
  .watcher_last_file        ← watch.js writes on flush, statusline reads content
  .last_injected_hash.*     ← refresh hook writes SHA-256, statusline reads mtime
```

## Hooks

Wired into project `.claude/settings.json` by `init`:

- **SessionStart**: reads summary.md → stdout (Claude context). Also auto-starts watcher if heartbeat is missing/stale.
- **UserPromptSubmit**: reads summary.md → compares SHA-256 hash to last injection → stdout only if changed.

Both emit under `<codebase-intelligence>` XML tag on stdout. Both write to stderr too (banner/status line) but **nobody sees stderr** — it's there for `2>&1` debugging.

## Watcher lifecycle

1. **Auto-start**: SessionStart hook forks `sextant watch` if heartbeat missing
2. **Heartbeat**: writes `.watcher_heartbeat` every 30s (periodic) and on each flush (activity)
3. **Last file**: writes `.watcher_last_file` on each flush
4. **Status**: statusline script reads heartbeat mtime. `< 90s` = alive, `> 90s` = dead
5. **Shutdown**: clears heartbeat on SIGINT/SIGTERM
6. **Manual control**: `watch-start`, `watch-stop` CLI commands, `/watch` slash command in Claude Code

**Gotcha**: watcher only monitors files matching configured globs. Root-level files and `bin/` are NOT in default globs.

## Health semantics

- Resolution >= 90%: graph boosts enabled
- Resolution < 90%: graph boosts gated (degrade, don't guess)
- Large index age: watcher not running or globs don't cover changed files

## Index auto-migration

`INDEX_VERSION` tracks format changes. On load, `migrateIndexIfNeeded()`:
- Normalizes absolute-path keys to relative
- Clears stale string imports, zeroes mtime to force re-extraction
- `initUnlocked()` re-extracts affected files immediately
- No manual rescan needed

## Scoring signals

| Signal | Weight | Where |
|--------|--------|-------|
| `exact_symbol` | +40% | scoring.js |
| `def_site_priority` | +25% | retrieve.js |
| `export-graph lookup` | inject | retrieve.js — queries exports table, injects missing files |
| `re-export chain` | inject | retrieve.js — follows barrel files via reexports table |
| `hotspot` | +15% | retrieve.js |
| `symbol_contains_query` | +12% | scoring.js |
| `export_match` | +10% | scoring.js |
| `entrypoint` | +10% | retrieve.js (path-excluded: fixtures/tests/examples) |
| `doc` | -40% | retrieve.js |
| `test` | -25% | retrieve.js |
| `vendor` | -50% | retrieve.js |
| `fanin_suppressed` | -50% of graph boost | retrieve.js — when def match exists elsewhere |

## rg two-phase collection

Phase 1: source files only (`.js`, `.py`, `.go`, `.rs`, etc.) — prevents changelogs from eating the budget.
Phase 2: remaining capacity filled with docs/config.
Raw limit: 5x `maxHits`.

## Eval harness

```bash
node scripts/eval-retrieve.js             # terminal
node scripts/eval-retrieve.js --verbose   # hit details + signals
node scripts/eval-retrieve.js --json      # machine-readable
```

19 cases, 7 categories. Measures P@k, MRR, nDCG, usefulness, graph lift.

Current: MRR 0.963, nDCG 0.979, 19/19 pass.

## Debugging

```bash
sextant doctor                          # full diagnosis
sextant health                          # raw metrics JSON
sextant summary                         # what Claude receives
node scripts/eval-retrieve.js --verbose        # scoring debug per query
ls -la .planning/intel/.watcher_heartbeat      # watcher alive?
cat .planning/intel/.watcher_last_file         # last file processed
ls -la .planning/intel/.last_injected_hash.*   # when was context last sent?
```

## What not to add

- Embeddings or vector search
- LLM calls in the pipeline
- Semantic claims (LSP-like)
- Summaries > 2200 chars
- UI that writes to stderr in hooks (nobody sees it)

Use eval metrics to justify changes.
