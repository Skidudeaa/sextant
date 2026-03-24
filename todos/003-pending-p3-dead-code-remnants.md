---
status: pending
priority: p3
issue_id: "003"
tags: [code-review, quality]
dependencies: []
---

# Dead Code Remnants After Cleanup

## Problem Statement

The cleanup in commits `a487f07` and `a0e7ba3` removed dead exports from several modules but missed some function bodies and unused exports. ~49 lines of dead code remain across 4 files.

## Findings

### Finding 1: Function bodies left in extractors/index.js (simplicity, architecture, agent-native)

**Location**: `lib/extractors/index.js:39-64`

`forFile()`, `listExtensions()`, `isSupported()` — exports were removed from `module.exports` at lines 70-73, but the function definitions (26 lines) are still in the file. No callers exist.

### Finding 2: Exported functions with zero callers in graph.js (simplicity, architecture)

**Location**: `lib/graph.js:321-341`

`topExternalImports()` and `hotFilesByImportCount()` are exported but never called anywhere in the codebase. ~22 lines + 2 export entries.

### Finding 3: stripAnsi exported but only used internally (simplicity)

**Location**: `lib/terminal-viz.js:254`

`stripAnsi` is exported in `module.exports` but only used internally by the `box()` function. No external file imports it.

### Finding 4: scoring.js over-exports (architecture)

**Location**: `lib/scoring.js:271-277`

5 of 7 exports (`COMMON_NOISE_WORDS`, `isExactSymbolMatch`, `isExportStatement`, `isPythonPublicSymbol`, `noiseWordRatio`) are never imported externally. Only `extractSymbolDef` and `computeEnhancedSignals` are used by `lib/retrieve.js`.

## Proposed Solutions

### Option A: Remove all dead code (Recommended)

- Delete function bodies in `extractors/index.js:39-64`
- Delete `topExternalImports` and `hotFilesByImportCount` from `graph.js` + exports
- Remove `stripAnsi` from `terminal-viz.js` exports
- Remove unused exports from `scoring.js`

**Pros**: Clean, consistent with existing cleanup intent
**Cons**: None (all confirmed zero-caller)
**Effort**: Small (15 min)
**Risk**: None

## Acceptance Criteria

- [ ] No function exists that is both unexported and uncalled
- [ ] No export exists with zero external importers
- [ ] Eval harness passes (MRR 0.963, 19/19)

## Work Log

| Date | Action | Notes |
|------|--------|-------|
| 2026-03-24 | Created | Identified by code-simplicity-reviewer, architecture-strategist, agent-native-reviewer |
