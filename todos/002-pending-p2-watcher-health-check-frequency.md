---
status: pending
priority: p2
issue_id: "002"
tags: [code-review, performance]
dependencies: []
---

# Watcher Health Check Computed Too Frequently

## Problem Statement

After every debounced flush (250ms), the watcher calls `intel.health(root)` which iterates ALL files and ALL imports in the index via `computeResolutionMetrics()`. The dashboard only renders once per second, so health data computed more frequently than 1Hz is wasted work. At 10,000 files with 5 imports each, `computeResolutionMetrics` takes ~6ms while holding the queue lock, blocking all other operations.

## Findings

### Finding 1: Health check per flush wastes CPU and blocks queue (performance-oracle)

**Location**: `watch.js:197-201`

During burst file changes (e.g., `git checkout` of a large branch), the watcher processes files every 250ms. Each flush triggers a health check that holds the queue for 6ms+. The dashboard render interval is 1s, so health computed more than once per second is never displayed.

**Benchmarked**: 10,000 files, 5 imports each: `computeResolutionMetrics` = ~6ms per call. Under burst conditions, this means ~24ms/s of unnecessary health computation.

## Proposed Solutions

### Option A: Move health check to dashboard render interval (Recommended)

Cache the last health result and only refresh when the dashboard tick fires (every 1s). The flush callback stops calling `intel.health()`.

**Pros**: Eliminates all redundant health computation, reduces queue contention
**Cons**: Health data may lag by up to 1s during bursts (acceptable)
**Effort**: Small
**Risk**: Low

### Option B: Throttle health calls to max 1/second

Keep health check in the flush callback but skip if less than 1s since last computation.

**Pros**: Simpler change, keeps health tied to data changes
**Cons**: Still acquires queue lock unnecessarily
**Effort**: Small
**Risk**: Low

## Recommended Action

(To be filled during triage)

## Technical Details

**Affected files**:
- `watch.js` (flush callback and dashboard render loop)
- `lib/intel.js` (`health()` function)

## Acceptance Criteria

- [ ] Health check runs at most once per second during burst file changes
- [ ] Dashboard still shows up-to-date health after changes settle
- [ ] Watcher queue is not blocked by health computation during flushes

## Work Log

| Date | Action | Notes |
|------|--------|-------|
| 2026-03-24 | Created | Identified by performance-oracle |

## Resources

- `watch.js:197-201` (flush callback)
- `lib/intel.js:health()` (queue-locking health function)
