# Sextant TODOs

Items identified by full codebase review (2026-03-24).

## Correctness

- [ ] **deleteFile removes inbound imports** — `lib/graph.js:124` `DELETE FROM imports WHERE to_path = ?` silently removes import records owned by other files. Consider setting `to_path = NULL` to preserve as unresolved, or document as intentional cleanup.
- [ ] **Hotspot cutoff inflated for <5 results** — `lib/retrieve.js:463-467` cutoff equals lowest fan-in when result set is small, making every file a "hotspot". Use absolute threshold or skip when <5 files. Validate with eval harness.
- [ ] **Re-export chain BFS is effectively flat** — `lib/graph.js:287-301` follow query re-finds seeds instead of tracing chains. True multi-hop traversal needs to resolve `to_specifier` to a file path. Works by coincidence in React.
- [ ] **Resolver caches never invalidated** — `lib/resolver.js:10-21` tsconfig and workspace caches persist for process lifetime. Watcher won't pick up tsconfig.json changes. Add mtime-based invalidation or periodic cache clear.

## Performance

- [ ] **index.json O(N) serialization per flush** — `lib/intel.js:161-172` serializes entire index on every debounced flush (~5MB at 10k files). Consider storing index in SQLite alongside graph, or incremental format.
- [ ] **Python extractor spawns 1 subprocess per file** — `lib/extractors/python.js:41-86` ~20-50ms overhead per spawn. Batch multiple files into a single python3 invocation by extending `python_ast.py` to accept arrays.

## Patterns / Refactoring

- [ ] **Code duplication: loadRepoConfig** — `bin/intel.js:159` and `watch.js:310` have identical copies of default globs and ignore patterns. Extract to `lib/config.js`.
- [ ] **Code duplication: stateDir()** — Defined independently in `lib/intel.js:55`, `lib/graph.js:16`, `lib/zoekt.js:5`. Extract to `lib/utils.js`.
- [ ] **Code duplication: session key derivation** — Identical logic in `bin/intel.js:314-326`, `tools/codebase_intel/refresh.js:35-47`, and deployed copies. Extract to shared module.
- [ ] **Code duplication: scope context** — `lib/rg.js:86-142` and `lib/retrieve.js:72-118` implement identical hit-grouping + scope-finder pattern. Unify into shared function.
- [ ] **Code duplication: git info** — Three implementations in `lib/summary.js:63`, `bin/intel.js:27`, `lib/retrieve.js:653`. Extract to `lib/git.js`.
- [ ] **bin/intel.js is a 961-line God object** — 15+ subcommands in a single switch. Extract command handlers into `commands/` directory.

## Testing

- [ ] **Minimal test coverage** — `npm test` only runs `test-refresh.sh` (4 bash assertions). No tests for extractors, resolver, graph, scoring, summary, or watcher.
- [ ] **Wire eval harness into CI** — `scripts/eval-retrieve.js` (19 queries, MRR 0.963) runs manually. Add to `npm test`.
- [ ] **Corrupt state recovery tests** — No tests for corrupt `graph.db`, invalid `index.json`, or partial `summary.md`.
- [ ] **Watcher tests** — No tests for multi-root, heartbeat, concurrent instance detection.
- [ ] **rg unavailability / timeout tests** — No tests for missing rg, non-zero exit codes, or hang behavior.
