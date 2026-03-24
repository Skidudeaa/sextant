---
status: pending
priority: p3
issue_id: "005"
tags: [code-review, reliability, security]
dependencies: []
---

# Timeout and Compatibility Consistency Issues

## Problem Statement

Three minor consistency issues with the timeout/subprocess changes: (1) the `doctor` command uses the `which` binary instead of the fixed POSIX `command -v` approach, (2) the Python extractor timeout is 30s but documented as 15s, (3) the rg timeout is not `.unref()`'d.

## Findings

### Finding 1: Doctor command uses `which` binary (security-sentinel)

**Location**: `bin/intel.js:689-690`

```js
const rgInstalled = require("child_process").spawnSync("which", ["rg"]).status === 0;
const zoektInstalled = require("child_process").spawnSync("which", ["zoekt-webserver"]).status === 0;
```

The `which()` function was fixed in `lib/rg.js` and `lib/zoekt.js` to use POSIX `command -v` (works on Alpine). The `doctor` command still uses the `which` binary directly. Not a security risk (hardcoded args), but breaks on systems without `which`.

### Finding 2: Python timeout 30s, documented as 15s (security-sentinel)

**Location**: `lib/extractors/python.js:63`

The code has `timeout: 30000` but the review description and scope-finder.js:89 use 15s. This is a documentation/consistency mismatch.

### Finding 3: rg timeout not .unref()'d (performance-oracle)

**Location**: `lib/rg.js:177`

The 30s setTimeout for rg child processes is not `.unref()`'d. In the watcher context, if the child process somehow never emits exit/error, the timer keeps the event loop alive. Other timers in `intel.js` all use `.unref()`.

## Proposed Solutions

### Fix all three (Recommended)

1. Replace `spawnSync("which", ...)` in doctor with `command -v` approach from `lib/rg.js`
2. Align Python timeout to 15s (matching scope-finder.js) or update documentation
3. Add `.unref()` to the rg timeout

**Effort**: Small (10 min total)
**Risk**: None

## Acceptance Criteria

- [ ] `sextant doctor` works on Alpine Linux (no `which` binary)
- [ ] Python extractor timeout matches documentation
- [ ] rg timeout is `.unref()`'d

## Work Log

| Date | Action | Notes |
|------|--------|-------|
| 2026-03-24 | Created | Identified by security-sentinel, performance-oracle |
