---
title: Rejected approaches log
status: idea
priority: high
feasibility: low
source: agent-reflection
---

# Rejected Approaches Log

## The gap

The single biggest time sink in agent-assisted development: proposing an approach the user already tried and abandoned. Git history shows what was committed, not what was reverted or never merged. A conversation in a previous session where the user said "we tried X, it failed because Y" is lost when that session ends.

## What it would look like

A lightweight per-file or per-function annotation:

```
# .planning/intel/rejected.json
{
  "lib/retrieve.js": [
    {
      "what": "vector embeddings for scoring",
      "why": "added 2s latency per query, marginal relevance improvement over fan-in reranking",
      "when": "2026-03-22",
      "related_commit": "a1b2c3d"
    }
  ],
  "lib/graph.js": [
    {
      "what": "in-memory graph instead of SQLite",
      "why": "JSON.stringify on every flush was O(N) and caused 200ms stalls at 500 files",
      "when": "2026-03-20"
    }
  ]
}
```

The hook could inject relevant rejections when the user's prompt touches those files: "Note: vector embeddings were previously tried for scoring in retrieve.js and rejected due to 2s latency."

## Implementation notes

- This is fundamentally a human-authored knowledge store, not something sextant can auto-generate.
- Could be populated via a `sextant reject <file> "what" "why"` CLI command.
- Could also be populated by the agent itself when the user rejects an approach mid-conversation (via memory or a hook).
- The hard part isn't storage — it's capture. Most rejected approaches are discussed verbally and never written down.
- Feasibility is low because it requires workflow change (someone has to write the rejection).

## Why it matters

An agent that knows what was rejected is dramatically more useful than one that doesn't. It's the difference between "let me suggest embeddings" and "I see embeddings were tried here and rejected for latency — let me suggest something lighter."
