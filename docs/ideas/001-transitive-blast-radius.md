---
title: Transitive blast radius
status: idea
priority: high
feasibility: high
source: agent-reflection
---

# Transitive Blast Radius

## The gap

Sextant's graph provides direct fan-in (who imports this file) and neighbors (one hop). But when editing a function, the real question is: what breaks? That requires the transitive closure — dependents of dependents up to entry points and test files.

## What it would look like

```
sextant blast lib/resolver.js

lib/resolver.js
  <- lib/intel.js (direct)
     <- commands/scan.js
     <- commands/init.js
     <- watch.js
     <- commands/hook-refresh.js
  <- lib/retrieve.js (direct)
     <- mcp/server.js
     <- commands/retrieve.js
  <- test/resolver.test.js (test)

7 files in blast radius. 1 test file covers directly.
```

## Implementation notes

- The graph already stores all edges. This is a BFS/DFS from a starting node collecting all reachable ancestors.
- Cap depth to prevent explosion (5 hops? configurable?).
- Separate output into: direct dependents, transitive dependents, test files, entry points.
- Could power a `sextant blast <file>` CLI command and an MCP tool (`sextant_blast`).
- The hook could include blast radius for files mentioned in the user's prompt — "you're editing resolver.js, which affects 7 files including 3 commands."

## Existing infrastructure

- `graph.neighbors()` already does one-hop expansion.
- `graph.fanInByPaths()` provides the raw counts.
- `graph.queryDependents()` returns direct importers.
- Just need recursive expansion with cycle detection and depth cap.
