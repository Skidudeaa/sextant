---
title: Transitive blast radius
status: researched
priority: high
feasibility: high
source: agent-reflection
researched: 2026-03-31
---

# Transitive Blast Radius

## The Gap

Sextant's graph provides direct fan-in and one-hop neighbors. When editing a function, the real question is: what breaks? That requires the transitive closure — dependents of dependents up to entry points and test files.

## Research Findings

### Algorithm: BFS is the universal choice

Every production tool (Bazel `rdeps()`, Nx affected, Jest `findRelatedTests`, Google TAP, Webpack HMR) uses BFS with a visited set. BFS provides depth information naturally, which is essential for categorization and priority ordering.

Sextant already implements this pattern in `findReexportChain()` (graph.js:272-346) — BFS with visited set, depth counter, max depth cap. The blast radius implementation is structurally identical, just traversing import edges instead of re-export edges.

### Depth limiting: don't limit, just categorize

Most tools (Nx, Jest, Google TAP) use unlimited depth. Bazel exposes depth as an optional parameter. Google TAP runs full transitive closure on a monorepo with billions of lines. For sextant's target (5,000 files, avg fan-in 3), full closure touches ~50-300 files in <20ms.

Depth is more useful as a **categorization signal** than a truncation mechanism. Direct (depth 1) vs transitive (depth 2+) is the key distinction for the agent.

### Performance: application-level BFS, not recursive CTE

Two approaches evaluated:

- **App-level BFS** (recommended): Call `queryDependents()` iteratively from JS, visited set in a `Set`. ~200 SQL queries for a 200-file result, each <0.1ms with sql.js in-memory. Total: **<20ms**.
- **SQLite recursive CTE**: Elegant but without a global visited set, revisits nodes reached via multiple paths. SQLite forum confirms exponential degradation on dense graphs. sql.js doesn't ship the closure extension.

App-level BFS is faster, simpler, and consistent with sextant's existing patterns.

### Categorization: what production tools use

| Category | Description |
|----------|-------------|
| Direct | Depth 1 — files that directly import the changed file |
| Transitive | Depth 2+ — reachable through chains |
| Tests | Matches test patterns (any depth) |
| Entry points | Fan-in 0 or recognized entry patterns (any depth) |

Files can appear in multiple categories. Nx additionally distinguishes "why" (FileChanged vs DependencyChanged) — worth adopting.

### File-level vs function-level: file-level wins

Function-level reduces false positives 4-7x (academic research) but adds massive complexity (AST parsing every file, 10-100x larger graph, constant invalidation on every edit). The decisive argument: **LLM agents operate at file granularity** — Claude reads and edits whole files. Telling it "function X in file Y is affected" vs "file Y is affected" doesn't change its behavior.

### Presentation for LLM context

JetBrains research (Dec 2025): how information is presented matters more than whether it's present. Recommended format:

```markdown
## Blast radius: lib/graph.js (changed)
**12 affected** | 3 direct | 7 transitive | 2 tests | 1 entry

### Direct (depth 1)
- `lib/intel.js` — imports graph, fan-in: 8
- `lib/graph-retrieve.js` — imports graph, fan-in: 1
- `lib/retrieve.js` — imports graph, fan-in: 2

### Tests
- `test/graph.test.js` — imports graph directly
- `test/retrieve.test.js` — transitively via lib/retrieve.js

### Entry points reached
- `bin/intel.js` — via lib/intel.js (depth 3)
```

Lead with summary counts, list by category, depth as priority signal, direct dependents first.

## Existing Infrastructure in Sextant

Everything needed exists or is one function away:

| Capability | Status | Location |
|-----------|--------|----------|
| One-hop dependents | EXISTS | `graph.queryDependents(db, path)` |
| One-hop neighbors | EXISTS | `graph.neighbors(db, path, opts)` |
| Batch fan-in | EXISTS | `graph.fanInByPaths(db, paths)` |
| Batch metadata | EXISTS | `graph.fileMetaByPaths(db, paths)` |
| BFS with visited + depth | EXISTS (reexports) | `graph.findReexportChain()` |
| Test path detection | EXISTS | `isTestPath()` in retrieve.js |
| Entry point detection | EXISTS | `isEntryPoint()` in utils.js |
| **Transitive BFS on imports** | **MISSING** | **The gap** |

### SQL Schema supports it

The `imports` table has `idx_imports_to` index on `to_path`, enabling fast reverse lookups. `queryDependents()` already uses this: `SELECT from_path, specifier, kind FROM imports WHERE to_path = ? AND is_external = 0`.

## Implementation Plan

### New function in `lib/graph.js`

```javascript
function blastRadius(db, seedPaths, opts = {}) {
  const maxDepth = opts.maxDepth ?? 50;
  const maxFiles = opts.maxFiles ?? 500;
  const seeds = Array.isArray(seedPaths) ? seedPaths : [seedPaths];

  const visited = new Set(seeds);
  const queue = seeds.map(p => ({ path: p, depth: 0 }));
  const results = [];

  while (queue.length > 0 && results.length < maxFiles) {
    const { path, depth } = queue.shift();
    results.push({ path, depth });
    if (depth >= maxDepth) continue;

    const deps = queryDependents(db, path);
    for (const dep of deps) {
      if (!dep.fromPath || visited.has(dep.fromPath)) continue;
      visited.add(dep.fromPath);
      queue.push({ path: dep.fromPath, depth: depth + 1 });
    }
  }

  return { affected: results, stats: categorize(results) };
}
```

### CLI command: `sextant blast <file>`

New command in `commands/blast.js`. Output:

```
lib/graph.js → 12 affected (3 direct, 7 transitive, 2 tests, 1 entry)

Direct:
  lib/intel.js (fan-in: 8)
  lib/graph-retrieve.js (fan-in: 1)
  lib/retrieve.js (fan-in: 2)

Tests:
  test/graph.test.js
  test/retrieve.test.js (via lib/retrieve.js)

Entry points:
  bin/intel.js (via lib/intel.js, depth 3)
```

### MCP tool: `sextant_blast`

Add to `mcp/server.js` TOOLS array. Input: `{ files: string[], maxDepth?: number }`. Returns categorized affected files.

### Hook integration

In `hook-refresh.js`, when the classifier detects file-editing prompts, extract file paths and inject a one-line blast radius summary alongside retrieval results:

```
Blast radius: lib/graph.js affects 12 files (3 direct, 2 tests, 1 entry point).
```

### Build sequence

1. Add `blastRadius()` to `graph.js` (core algorithm)
2. Add categorization helpers (reuse `isTestPath`, `isEntryPoint`, `fanInByPaths`)
3. Add `commands/blast.js` CLI command
4. Add `sextant_blast` MCP tool
5. Add blast radius injection to `hook-refresh.js`
6. Tests: graph-level BFS tests, CLI integration test
7. Update eval harness if blast radius affects retrieval rankings

### Risks

- **Utility files with extreme fan-in**: `lib/utils.js` (fan-in 8) would touch nearly every file. The `maxFiles=500` cap prevents runaway, and the categorized output keeps it useful.
- **Circular dependencies**: Handled by visited set (same pattern as `findReexportChain`).
- **Hook latency**: BFS takes <20ms, well within the 200ms budget. No risk.

## Sources

- Bazel Query Reference (rdeps, deps, allpaths)
- Nx Affected deep-dive (smartsdlc.dev)
- Jest findRelatedTests internals (thesametech.com)
- Martin Fowler: The Rise of Test Impact Analysis
- Google SWE Book ch23: Continuous Integration (TAP)
- Meta: Predictive Test Selection
- SQLite Forum: BFS performance on recursive CTEs
- JetBrains Research: Efficient Context Management for LLM Agents
