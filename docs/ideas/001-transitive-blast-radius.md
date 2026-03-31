---
title: Transitive blast radius
status: researched
priority: high
feasibility: medium
source: agent-reflection
researched: 2026-03-31
revised: 2026-03-31
---

# Transitive Blast Radius

## The Gap

Sextant's graph provides direct fan-in and one-hop neighbors. When editing a function, the real question is: what breaks? That requires knowing not just which files depend on a module, but which *symbols* they consume from it.

## The File-Level Trap

### Why file-level blast radius is insufficient

The initial design proposed BFS on file-level import edges: "A imports B, so A is affected by changes to B." This degenerates badly:

- `lib/utils.js` (fan-in 8): change one small helper → 8 files "affected," including files that don't use that helper
- `lib/graph.js` (fan-in 9): change `findReexportChain()` → flags `intel.js`, which only uses `loadDb()` and `persistDb()`
- Transitively, a utility file change cascades to 30-40 files in a 69-file repo — more than half the codebase

A blast radius that says "42 of 69 files are affected" provides zero useful signal. It's just fan-in with extra steps.

### Agents don't work at file granularity

The initial research claimed "LLM agents operate at file granularity." This is wrong. Agents work at:
- **Symbol level** — search for specific functions, classes, variables
- **Line level** — Edit tool targets specific strings, not whole files
- **Function level** — plan changes around "which functions need to change"
- **Cross-file symbol level** — trace function calls across modules

File-level is the *crudest* level an agent operates at, not the primary one. A blast radius tool must match the agent's actual working granularity.

## What Symbol-Level Blast Radius Requires

### Current state: symbols are extracted then discarded

The import regex in `javascript.js:36` matches:
```
import { loadDb, persistDb } from './graph'
```
But only captures `m[1]` = `./graph`. The destructured names `loadDb, persistDb` are consumed by a non-capturing group `[\s\S]{0,500}?` and thrown away.

Meanwhile, the `exports` table already stores which symbols each file exports (`name`, `kind`). So sextant knows what B offers but not what A consumes from B.

### The data that needs to be captured

| What | Currently captured | What's needed |
|------|-------------------|---------------|
| "A imports from B" | YES (`imports` table: `from_path → to_path`) | Still needed |
| "B exports X, Y, Z" | YES (`exports` table: `path, name, kind`) | Still needed |
| "A imports X, Y from B" | **NO** — symbol names discarded | **New: `import_symbols` table** |

### New schema

```sql
CREATE TABLE IF NOT EXISTS import_symbols (
  from_path TEXT NOT NULL,
  to_path TEXT NOT NULL,
  symbol_name TEXT NOT NULL,
  kind TEXT,              -- "named" | "default" | "namespace" | "require-destructure"
  updated_at_ms INTEGER,
  PRIMARY KEY (from_path, to_path, symbol_name)
);
CREATE INDEX idx_import_symbols_to ON import_symbols(to_path, symbol_name);
```

This enables the core query: "which files import symbol X from file Y?"

```sql
SELECT from_path FROM import_symbols
WHERE to_path = ? AND symbol_name = ?;
```

### Extraction changes

The import regex needs to capture both the path AND the imported names:

**ESM named imports**: `import { loadDb, persistDb } from './graph'`
- Capture group 1: `{ loadDb, persistDb }` → parse into `["loadDb", "persistDb"]`
- Capture group 2: `./graph` → resolve to `lib/graph.js`

**ESM default import**: `import graph from './graph'`
- Symbol: `default` (or the local binding name)

**ESM namespace import**: `import * as graph from './graph'`
- Symbol: `*` (namespace — means ALL exports are potentially used)

**CJS destructured require**: `const { loadDb } = require('./graph')`
- Capture the destructured names

**CJS non-destructured require**: `const graph = require('./graph')`
- Symbol: `*` (namespace — any export could be accessed via `graph.loadDb()`)

**The hard cases** (and why this isn't trivial):
- `const graph = require('./graph'); graph.loadDb()` — the consumed symbol (`loadDb`) is not at the import site but at the call site. Tracking this requires data-flow analysis, not just import parsing.
- Re-exports: `export { loadDb } from './graph'` — already captured by AST extractor in `reexports` table.
- Dynamic access: `graph[methodName]()` — unknowable at static analysis time.

### Practical scoping

Full call-site tracking is out of scope (that's an LSP). What IS tractable:
1. **ESM named imports** — exact symbols known at import site. This is the highest-value case.
2. **CJS destructured require** — exact symbols known at import site.
3. **Namespace/default imports** — mark as `*` (all symbols potentially used). These become file-level edges, same as today. Not worse than current behavior.
4. **Dynamic access** — unknowable, falls back to file-level. Same as today.

For JS/TS codebases using ESM or destructured CJS (most modern code), cases 1-2 cover the majority of imports with exact symbol information.

## Revised Algorithm

### Phase 1: Identify changed symbols

When a file is re-indexed (via watcher or scan), diff the old exports against the new exports:

```javascript
function diffExports(db, filePath, newExports) {
  const old = queryExports(db, filePath);
  const added = newExports.filter(e => !old.some(o => o.name === e.name));
  const removed = old.filter(o => !newExports.some(e => e.name === o.name));
  const modified = []; // signature changes need content hashing — future work
  return { added, removed, modified, unchanged: old.length - removed.length };
}
```

### Phase 2: Symbol-level BFS

```javascript
function blastRadius(db, filePath, changedSymbols, opts = {}) {
  const maxDepth = opts.maxDepth ?? 50;
  const maxFiles = opts.maxFiles ?? 500;

  // If changedSymbols is empty or unknown, fall back to file-level
  // (all importers are potentially affected)
  const useSymbolLevel = changedSymbols && changedSymbols.length > 0;

  const visited = new Set([filePath]);
  const queue = [{ path: filePath, depth: 0, symbols: changedSymbols }];
  const results = [];

  while (queue.length > 0 && results.length < maxFiles) {
    const { path, depth, symbols } = queue.shift();
    results.push({ path, depth, symbols });
    if (depth >= maxDepth) continue;

    let dependents;
    if (useSymbolLevel && symbols?.length) {
      // Only find files that import the specific changed symbols
      dependents = findImportersOfSymbols(db, path, symbols);
    } else {
      // Fall back to file-level (namespace imports, non-destructured require)
      dependents = queryDependents(db, path);
    }

    for (const dep of dependents) {
      if (visited.has(dep.fromPath)) continue;
      visited.add(dep.fromPath);

      // For the next hop: what symbols does this file RE-EXPORT from the changed file?
      // If it re-exports changedSymbol, its own importers are also affected.
      const reexported = findReexportedSymbols(db, dep.fromPath, symbols);
      const nextSymbols = reexported.length > 0 ? reexported : null;

      queue.push({ path: dep.fromPath, depth: depth + 1, symbols: nextSymbols });
    }
  }

  return { affected: results, stats: categorize(results) };
}
```

### Phase 3: Graceful degradation

The symbol-level path is an enhancement, not a requirement. When symbol data is unavailable (namespace imports, CJS without destructuring, Python), the algorithm falls back to file-level edges — identical to the original design. This means:

- ESM with named imports → precise, symbol-level blast radius
- CJS with destructured require → precise
- Namespace/default imports → file-level fallback (same as today's fan-in)
- Python → file-level fallback (Python extractor doesn't track imported names yet)

Health metric: "symbol-level coverage %" — what fraction of import edges have symbol-level data. Analogous to the existing resolution % for import paths.

## What You'd Actually See

### With symbol-level data (ESM codebase)

```
sextant blast lib/graph.js --symbols findReexportChain

lib/graph.js:findReexportChain → 3 affected

Direct (import findReexportChain):
  lib/graph-retrieve.js — uses in layer 2 search
  lib/retrieve.js — uses in re-export chain tracing

Transitive:
  commands/retrieve.js — via lib/retrieve.js

NOT affected (import graph.js but don't use findReexportChain):
  lib/intel.js, lib/summary.js, mcp/server.js, commands/doctor.js, ...
```

### Without symbol data (fallback)

```
sextant blast lib/graph.js

lib/graph.js → 14 affected (file-level, symbol data unavailable)
  ⚠ Namespace imports detected — results may include unaffected files
  ...
```

### In hook context injection

```markdown
Blast radius: you're editing findReexportChain in lib/graph.js.
3 files use this symbol: graph-retrieve.js, retrieve.js, commands/retrieve.js.
6 other files import graph.js but don't use findReexportChain.
```

## Existing Infrastructure

| Capability | Status | Location |
|-----------|--------|----------|
| File-level import edges | EXISTS | `imports` table |
| Export symbols per file | EXISTS | `exports` table |
| Re-export tracking | EXISTS | `reexports` table |
| BFS with visited + depth | EXISTS | `findReexportChain()` |
| Import regex (captures path only) | EXISTS | `javascript.js:36` |
| AST export extraction | EXISTS | `js_ast_exports.js` |
| Test path detection | EXISTS | `isTestPath()` in retrieve.js |
| Entry point detection | EXISTS | `isEntryPoint()` in utils.js |
| **Imported symbol names** | **MISSING** | **Regex captures then discards them** |
| **`import_symbols` table** | **MISSING** | **New schema needed** |
| **Symbol-level BFS** | **MISSING** | **New algorithm** |

## Implementation Plan

### Phase 1: Capture imported symbols (the prerequisite)

1. **Modify import regex** in `javascript.js` to capture destructured names alongside specifier path
2. **Add `import_symbols` table** to graph.js schema
3. **Populate during indexing** — `indexOneFileUnlocked` in intel.js already calls `extractImports()` and `graph.replaceImports()`. Add `graph.replaceImportSymbols()` call.
4. **AST path for Python** — `python_ast.py` already parses `from module import name1, name2`. Extract symbol names.
5. **Handle namespace imports** — store as `symbol_name = '*'` to indicate file-level fallback

### Phase 2: Export diffing

1. **Add `diffExports()`** to graph.js — compare old vs new exports when a file is re-indexed
2. **Emit changed symbols** from `indexOneFileUnlocked` — return `{ changedSymbols: ['findReexportChain'] }`
3. **Store in watcher state** — the watcher knows which files changed and can pass changed symbols to blast radius

### Phase 3: Blast radius algorithm

1. **Add `findImportersOfSymbols(db, filePath, symbolNames)`** to graph.js — query `import_symbols` table
2. **Add `blastRadius(db, filePath, changedSymbols, opts)`** to graph.js — symbol-level BFS with file-level fallback
3. **Add categorization** — reuse `isTestPath`, `isEntryPoint`, `fanInByPaths`

### Phase 4: CLI + MCP + Hooks

1. **`sextant blast <file> [--symbols name1,name2]`** CLI command
2. **`sextant_blast` MCP tool** — input: `{ file, symbols?, maxDepth? }`
3. **Hook injection** — when classifier detects file-editing prompts, extract file + function being edited, inject one-line blast summary

### Phase 5: Health metric

1. **Symbol coverage %** — what fraction of import edges have symbol-level data
2. **Surface in summary** — alongside resolution %, show "symbol coverage: 85%"
3. **Degrade gracefully** — below some threshold, warn that blast radius is file-level only

## Risks (revised)

| Risk | Severity | Mitigation |
|------|----------|------------|
| Namespace imports (`import * as X`) can't be tracked at symbol level | Medium | Fall back to file-level for these edges. Most modern code uses named imports. |
| CJS `const X = require(Y); X.foo()` — consumed symbol at call site, not import | Medium | Mark as `*` (file-level fallback). Destructured CJS IS trackable. |
| Regex complexity for capturing import names | Low | Well-established patterns. Can use AST fallback for complex cases. |
| Performance of symbol-level BFS | Low | More edges to traverse but still O(V+E) on a small graph. <50ms budget is achievable. |
| Python import tracking | Low | `from X import Y` is already parsed by AST. `import X` is namespace (file-level fallback). |
| Migration: existing graph.db has no symbol data | Low | Symbol data populates on next scan. Blast radius falls back to file-level until populated. |

## Feasibility: Medium (revised from High)

The algorithm itself is straightforward (BFS, same pattern as `findReexportChain`). The real work is in Phase 1: modifying the import extraction pipeline to capture and persist symbol names. This touches:
- `lib/extractors/javascript.js` — regex changes
- `lib/graph.js` — new table, new queries
- `lib/intel.js` — new `replaceImportSymbols()` call in indexing pipeline
- Potentially `lib/extractors/python.js` — symbol extraction from Python imports

Estimated effort: 2-3x the original "just add BFS" estimate. But the result is a tool that actually provides signal instead of noise.

## Sources

- Bazel Query Reference (rdeps, deps, allpaths)
- Nx Affected deep-dive (smartsdlc.dev)
- Jest findRelatedTests internals (thesametech.com)
- Martin Fowler: The Rise of Test Impact Analysis
- Google SWE Book ch23: Continuous Integration (TAP)
- Meta: Predictive Test Selection
- SQLite Forum: BFS performance on recursive CTEs
- JetBrains Research: Efficient Context Management for LLM Agents
