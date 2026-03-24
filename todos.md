# Sextant TODOs

Items identified by full codebase review (2026-03-24).

## Correctness

- [x] **deleteFile removes inbound imports** — Fixed: changed `DELETE FROM imports WHERE to_path = ?` to `UPDATE imports SET to_path = NULL` so other files' import records are preserved as unresolved. Validated with eval harness (19/19 pass).
- [x] **Hotspot cutoff inflated for <5 results** — Fixed: skip hotspot detection when <5 files, minimum threshold of 2. Validated with eval harness (19/19 pass).
- [x] **Re-export chain BFS is effectively flat** — Fixed: BFS follow step now uses basename matching on `to_specifier` to trace chains directionally (e.g., `./ReactHooks` matches files whose path contains `ReactHooks`). Falls back to global gather when basename is empty. Added WHY comment documenting the resolver-unavailability limitation. Validated with eval harness (19/19 pass).
- [x] **Resolver caches never invalidated** — Fixed: added mtime-based invalidation to `loadTsConfig()` and `loadWorkspacePackages()`. Checks file mtime before returning cached data; reloads on change. Added `clearCaches()` export for testing. Validated with eval harness (19/19 pass).

## Performance

- [ ] **index.json O(N) serialization per flush** — `lib/intel.js:161-172` serializes entire index on every debounced flush (~5MB at 10k files). Consider storing index in SQLite alongside graph, or incremental format.
- [x] **Python extractor spawns 1 subprocess per file** — Fixed: added `batch_extract` mode to `python_ast.py` and `extractBatch()` to `python.js`. Single subprocess handles N files. Existing per-file API unchanged; callers opt in to batch. Falls back to per-file on failure. Validated with eval harness (19/19 pass).

## Patterns / Refactoring

- [x] **Code duplication: loadRepoConfig** — Extracted to `lib/config.js`. Also fixed: watch.js copy was missing `.claude/**` ignore pattern.
- [x] **Code duplication: stateDir()** — Extracted to `lib/utils.js`.
- [x] **Code duplication: session key derivation** — Fixed: extracted `deriveSessionKey()` to `lib/session.js`. `bin/intel.js` uses the shared module; `refresh.js` retains inline copy (deployed standalone) with documentation linking to source of truth.
- [x] **Code duplication: scope context** — Unified into `addScopeContext()` in `lib/scope-finder.js`.
- [x] **Code duplication: git info** — Extracted to `lib/git.js`.
- [ ] **bin/intel.js is a 961-line God object** — 15+ subcommands in a single switch. Extract command handlers into `commands/` directory.

## Testing

- [ ] **Minimal test coverage** — `npm test` only runs `test-refresh.sh` (4 bash assertions). No tests for extractors, resolver, graph, scoring, summary, or watcher.
- [x] **Wire eval harness into CI** — Added to `npm test` alongside `test-scoring.sh`.
- [x] **Corrupt state recovery tests** — Added `scripts/test-corrupt-recovery.sh` with 4 tests: corrupt graph.db rebuild, invalid index.json reinit, empty summary.md regeneration, missing state dir creation. Also fixed real bug: `ensureSchema` was outside try/catch in `loadDb`.
- [x] **Watcher tests** — Added `scripts/test-watcher.sh` with 10 tests covering heartbeat creation, clearing, stale detection, last-file tracking. Exported `writeHeartbeat`/`clearHeartbeat` from `watch.js`.
- [x] **rg unavailability / timeout tests** — Added `scripts/test-rg.sh` with 15 tests: availability check, missing-rg error handling, search/searchInFiles, maxHits cap, source-first ordering, context lines, excluded directories.
