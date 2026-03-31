---
title: Test-to-code mapping
status: idea
priority: high
feasibility: medium
source: agent-reflection
---

# Test-to-Code Mapping

## The gap

When editing `lib/resolver.js`, which specific tests cover the behavior being modified? Currently the answer is "run the full suite and hope." A map from source functions to test cases would enable targeted validation and surface coverage gaps for the exact code being touched.

## What it would look like

```
sextant coverage lib/resolver.js

lib/resolver.js (8 exports, 6 covered by tests)
  resolveImport        <- test/resolver.test.js (12 assertions)
  resolveAll           <- test/resolver.test.js (3 assertions)
  resolveTsconfig      <- test/resolver.test.js (4 assertions)
  resolveWorkspace     <- test/resolver.test.js (2 assertions)
  resolvePythonImport  <- test/resolver.test.js (5 assertions)
  resolveAsset         <- test/resolver.test.js (1 assertion)
  loadTsConfig         NOT COVERED
  clearCache           NOT COVERED
```

Injected into hook context when editing a file:
"You're editing resolver.js. 6/8 exports have test coverage. loadTsConfig and clearCache are untested."

## Implementation notes

- **Static approach** (feasible now): scan test files for import statements that reference the target module. Map test file → source file via the existing import graph. This gives file-level coverage, not function-level.
- **Import-graph approach**: test files already appear in the graph as importers. Filter `queryDependents(file)` to only return paths matching test patterns (`*.test.js`, `*.spec.js`, `__tests__/`). This is trivial with existing infrastructure.
- **Function-level approach** (harder): parse test files for function calls matching the source file's exports. Regex or AST-based. Would need to handle destructured imports (`const { resolveImport } = require(...)`) and track which `it()` blocks call which functions.
- **Runtime approach** (most accurate): Node.js `--experimental-vm-modules` or c8/istanbul coverage data mapped back to export names. Heavy but precise.

## Recommended path

Start with the import-graph approach — it's free:
1. `graph.queryDependents(db, "lib/resolver.js")` already returns all importers
2. Filter to test paths using `isTestPath()` from retrieve.js
3. Surface as "N test files cover this module" in the blast radius output

Function-level mapping is a separate, harder problem. File-level is immediately useful and requires zero new infrastructure.

## What it would change

- Agent runs targeted tests instead of full suite after edits
- Agent warns when editing untested code: "this function has no test coverage, consider adding tests"
- Agent can suggest which test file to add assertions to when implementing a new export
