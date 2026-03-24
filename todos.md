# Sextant TODOs

Items identified by full codebase review (2026-03-24).

## Correctness

- [ ] **deleteFile removes inbound imports** — `lib/graph.js:124` `DELETE FROM imports WHERE to_path = ?` silently removes import records owned by other files. Consider setting `to_path = NULL` to preserve as unresolved, or document as intentional cleanup.
- [x] **Hotspot cutoff inflated for <5 results** — Fixed: skip hotspot detection when <5 files, minimum threshold of 2. Validated with eval harness (19/19 pass).
- [ ] **Re-export chain BFS is effectively flat** — `lib/graph.js:287-301` follow query re-finds seeds instead of tracing chains. True multi-hop traversal needs to resolve `to_specifier` to a file path. Works by coincidence in React.
- [ ] **Resolver caches never invalidated** — `lib/resolver.js:10-21` tsconfig and workspace caches persist for process lifetime. Watcher won't pick up tsconfig.json changes. Add mtime-based invalidation or periodic cache clear.

## Performance

- [ ] **index.json O(N) serialization per flush** — `lib/intel.js:161-172` serializes entire index on every debounced flush (~5MB at 10k files). Consider storing index in SQLite alongside graph, or incremental format.
- [ ] **Python extractor spawns 1 subprocess per file** — `lib/extractors/python.js:41-86` ~20-50ms overhead per spawn. Batch multiple files into a single python3 invocation by extending `python_ast.py` to accept arrays.

## Patterns / Refactoring

- [x] **Code duplication: loadRepoConfig** — Extracted to `lib/config.js`. Also fixed: watch.js copy was missing `.claude/**` ignore pattern.
- [x] **Code duplication: stateDir()** — Extracted to `lib/utils.js`.
- [ ] **Code duplication: session key derivation** — Identical logic in `bin/intel.js:314-326`, `tools/codebase_intel/refresh.js:35-47`, and deployed copies. Extract to shared module.
- [x] **Code duplication: scope context** — Unified into `addScopeContext()` in `lib/scope-finder.js`.
- [x] **Code duplication: git info** — Extracted to `lib/git.js`.
- [ ] **bin/intel.js is a 961-line God object** — 15+ subcommands in a single switch. Extract command handlers into `commands/` directory.

## Testing

- [ ] **Minimal test coverage** — `npm test` only runs `test-refresh.sh` (4 bash assertions). No tests for extractors, resolver, graph, scoring, summary, or watcher.
- [x] **Wire eval harness into CI** — Added to `npm test` alongside `test-scoring.sh`.
- [ ] **Corrupt state recovery tests** — No tests for corrupt `graph.db`, invalid `index.json`, or partial `summary.md`.
- [ ] **Watcher tests** — No tests for multi-root, heartbeat, concurrent instance detection.
- [ ] **rg unavailability / timeout tests** — No tests for missing rg, non-zero exit codes, or hang behavior.
