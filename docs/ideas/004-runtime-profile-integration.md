---
title: Runtime profile integration
status: idea
priority: medium
feasibility: low
source: agent-reflection
---

# Runtime Profile Integration

## The gap

Sextant's graph is purely static — it knows `intel.js` has the highest fan-in, but not whether it's the hottest code path at runtime. Static structure and runtime behavior diverge in important ways:

- A file imported everywhere may have fast, rarely-called functions.
- A file with low fan-in may contain the critical hot loop.
- Error branches that "never fire" vs. ones that fire constantly look identical in static analysis.

## What it would look like

A lightweight runtime snapshot injected alongside the static summary:

```
## Runtime profile (last 24h)
- Hot paths: hook-refresh.js:run (1,247 calls), graph-retrieve.js:graphRetrieve (1,247 calls)
- Slow calls: retrieve.js:retrieve avg 340ms (p99: 890ms)
- Error rate: zoekt.js:searchFast 2.3% timeout rate
- Unused at runtime: lib/scope-finder.js (0 calls in 24h)
```

## Implementation notes

- This requires instrumentation — sextant would need to wrap or observe function calls.
- For Node.js: could use `--require` with a lightweight profiler, or async_hooks.
- For the hook use case: the hooks already measure their own duration. Could accumulate stats in a `.planning/intel/profile.json`.
- Simpler version: just track hook execution stats (call count, duration, error rate) without instrumenting user code. This is feasible today.
- Full function-level profiling is invasive and likely out of scope for sextant's philosophy ("orientation > intelligence").

## Simpler alternative

Track only sextant's own performance:
- Hook execution count and duration per session
- Zoekt/rg hit rates and latencies
- Classifier decisions (how many prompts triggered retrieval vs. static)
- Watcher flush frequency and file counts

This is achievable without any user-code instrumentation and would still answer "is sextant healthy and performing well?"
