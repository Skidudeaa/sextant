---
title: Dead code confidence scoring
status: idea
priority: medium
feasibility: medium
source: agent-reflection
---

# Dead Code Confidence Scoring

## The gap

An export with zero fan-in that isn't an entry point is *probably* dead code. But "probably" isn't good enough to delete with confidence. The missing signal is time — how long has it been unused?

## What it would look like

```
sextant dead

High confidence (0 fan-in, not entry point, unchanged 30+ days):
  lib/history.js:getSparkline      last touched 45d ago, 0 importers
  lib/scope-finder.js:readScope    last touched 38d ago, 0 importers

Medium confidence (0 fan-in, recently changed):
  lib/format-retrieval.js:formatCompact  last touched 3d ago, 0 importers

Low confidence (fan-in from test files only):
  lib/scoring.js:noiseWordRatio    imported only by test/scoring.test.js
```

## Implementation notes

- Combine graph fan-in (already have) with git log last-touched dates.
- Confidence tiers: zero fan-in + not entry point + old = high. Zero fan-in + recent = medium. Fan-in only from tests = low.
- Entry point detection already exists (`isEntryPoint()` in utils.js).
- Could run as `sextant dead` CLI command.
- Could inject a "dead exports" section into the summary when count > 0.
- Challenge: dynamic imports (`import()`, `require(variable)`) are invisible to static analysis. Should be documented as a known limitation, not a reason to avoid the feature.

## What it would change

Agent hesitates less when removing code. Instead of "I think this is unused but I'm not sure," it's "sextant confirms 0 importers for 45 days."
