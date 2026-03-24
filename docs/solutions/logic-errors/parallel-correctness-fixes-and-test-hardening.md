---
title: "Batch TODO resolution: graph deletion safety, resolver cache invalidation, session extraction, Python batch mode, and 29 new tests"
category: logic-errors
date: 2026-03-24
tags: [graph-integrity, cache-invalidation, deduplication, batch-processing, corrupt-recovery, watcher-lifecycle, rg-search, test-coverage, bug-discovery]
severity: medium
components: [lib/graph.js, lib/resolver.js, lib/session.js, lib/extractors/python.js, lib/extractors/python_ast.py, bin/intel.js, tools/codebase_intel/refresh.js, watch.js]
problem_type: batch-todo-resolution
---

# Parallel Correctness Fixes and Test Hardening

## Problem Overview

Eight TODO items in the sextant codebase were resolved in parallel, spanning correctness fixes (3), code quality improvements (2), and test coverage additions (3). The fixes targeted core infrastructure: the dependency graph (graph.js), import resolver (resolver.js), Python extractor pipeline, and session key derivation. The test additions covered corrupt state recovery, watcher lifecycle, and ripgrep availability -- all previously untested failure paths.

The dominant theme was silent correctness failures: code that ran without crashing but produced wrong results. `deleteFile` destroyed records it didn't own. BFS claimed to trace chains but gathered globally. Resolver caches served stale data indefinitely in the long-running watcher.

## Root Causes & Fixes

### 1. deleteFile destroys other files' import records (graph.js)

**Problem:** `DELETE FROM imports WHERE to_path = ?` in `deleteFile()` removed import records owned by OTHER files when the target was deleted. When file A imports file B and file B is deleted, A's import record was destroyed.

**Root cause:** Using DELETE instead of nullifying -- destructive cleanup of records that belong to the importing file, not the deleted file.

**Fix:** Changed to `UPDATE imports SET to_path = NULL WHERE to_path = ?`. Preserves records as unresolved, which is semantically correct -- the import still exists in A's source code, it just points to a missing file.

### 2. Re-export chain BFS was effectively flat (graph.js)

**Problem:** `findReexportChain()` BFS follow step queried all reexporters globally by symbol name (`WHERE LOWER(name) = LOWER(?) AND from_path != ?`), producing a flat fan-out rather than a directed chain walk.

**Root cause:** The follow query just excludes the current node -- it doesn't feed the current hop's output into the next hop's input.

**Fix:** Added basename extraction from `to_specifier` and LIKE matching to follow chains directionally (e.g., `./ReactHooks` matches files whose path contains `ReactHooks`). Falls back to global gather when basename is empty. Documented the limitation that the resolver is not available at this layer.

### 3. Resolver caches never invalidated (resolver.js)

**Problem:** tsconfig and workspace package caches used boolean flags (`tsconfigLoaded`/`workspaceLoaded`) set once and never cleared. The long-running watcher would never pick up `tsconfig.json` or `package.json` changes.

**Root cause:** Cache had no invalidation mechanism -- process-lifetime persistence by default.

**Fix:** Added mtime tracking fields. Checks file mtime before returning cached data; resets and reloads on change. Exposed `clearCaches()` for explicit invalidation and testing.

### 4. Session key derivation duplication

**Problem:** Identical 13-line session key derivation logic in `bin/intel.js` and `refresh.js`.

**Fix:** Extracted to `lib/session.js`. The bin entry point imports the module; `refresh.js` retains inline copy (deployed standalone to target projects) with documentation linking to the source of truth.

### 5. Python extractor 1-subprocess-per-file overhead

**Problem:** `spawnSync` per Python file incurred ~20-50ms overhead each.

**Fix:** Added `batch_extract` mode to `python_ast.py` accepting JSON array of `{path, content}`. JS side gained `extractBatch()` with cache integration and per-file fallback on failure. Existing per-file API unchanged; callers opt in.

### 6. Bonus bug: corrupt DB crash (found during test writing)

**Problem:** `ensureSchema()` was called outside the try/catch in `loadDb()`. Corrupt databases that pass the sql.js constructor but fail on first SQL execution would crash instead of rebuilding.

**Fix:** Moved `ensureSchema` inside the try/catch recovery branches.

## Test Coverage Added (29 new tests)

**Corrupt state recovery (4 tests):** Corrupt `graph.db` rebuild, invalid `index.json` reinitialization, empty `summary.md` regeneration, missing state directory creation.

**Watcher lifecycle (10 tests):** Heartbeat creation, clearing, stale detection (>120s threshold), last-file tracking, safe no-op on missing files. Required exporting `writeHeartbeat`/`clearHeartbeat` from `watch.js`.

**rg unavailability (15 tests):** Availability detection, search/searchInFiles behavior, maxHits enforcement, source-first ordering, context lines, excluded directories. Uses `spawnSync` shimming + module cache eviction to simulate missing ripgrep.

## Key Techniques

- **NULL-ification over deletion** for foreign-key-like relationships in SQLite -- preserves record ownership while marking the target as gone.
- **Basename extraction from specifier paths** to make BFS directional without requiring the full resolver.
- **Mtime-based cache invalidation** for long-lived processes -- cheaper than file hashing, sufficient for config files that change infrequently.
- **Batch subprocess invocation** -- single `spawnSync` with JSON array input/output replaces N individual spawns.
- **Module cache eviction** (`delete require.cache[...]`) combined with `spawnSync` shimming to test behavior when external tools are unavailable.
- **Intentional duplication with documentation** when a module is deployed standalone.

## Prevention Strategies

### Five Review Questions

When reviewing changes to sextant (or similar graph/codebase-intelligence tooling):

1. **Does this DELETE distinguish which side of the relationship it is removing?** On any table that stores edges, a DELETE must specify which end of the edge it is removing.

2. **Does this traversal feed each hop's output into the next hop's query?** A traversal that does not feed each hop's output into the next hop's input is a global search wearing a BFS costume. Test with a "diamond + tail" graph to verify directed behavior.

3. **Does this cached value have an invalidation path in the long-running process?** Every cache in a long-running process needs an answer to "when does this become wrong?" Search for `Map` caches in module scope of watch.js and daemon files.

4. **Does this recovery code handle its own failure?** If your recovery code can throw, and you have not tested what happens when it does, you do not have recovery code. Test three SQLite corruption modes: zero-byte file, random bytes, valid DB with missing tables.

5. **Does this duplicated logic have a comment pointing to its other copy, or should it be extracted?** When reviewing a bug fix in lib/, search for the same pattern in scripts/ and tools/.

## Cross-References

- `DESIGN_PHILOSOPHY.md` Principle 2 ("Drift must be loud") and Principle 4 ("Degrade, don't guess") -- directly relevant to graph correctness and cache invalidation
- `EVAL_FINDINGS.md` -- 3 of 4 eval bugs are graph correctness issues
- `docs/solutions/security-issues/xml-injection-hook-context-escaping.md` -- related data integrity concern (different domain)

## Validation

All 19/19 eval cases pass. MRR 0.958, nDCG 0.964. 29 new tests across three scripts. Full `npm test` suite green.
