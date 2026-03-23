# Design Philosophy

This project exists to solve a **specific failure mode**.

Everything else is a distraction.

---

## The Core Problem

LLMs do not reason well in unfamiliar environments.
They confidently hallucinate structure when context is missing.

Most tools try to:
- search harder
- retrieve more
- embed everything

This makes hallucination *faster*, not rarer.

---

## Principle 1: Orientation beats intelligence

A small, factual map is more valuable than a large, speculative one.

- Entry points
- Hotspots
- Health
- Recent change

That's enough to orient reasoning.

---

## Principle 2: Drift must be loud

Silent rot is worse than no data.

- Resolution % is surfaced
- Index age is visible
- Ranking degrades when health degrades

If the system is wrong, it should say so.

---

## Principle 3: Evidence ≠ structure

Search returns **evidence**.
Graphs represent **structure**.

They must be combined, not conflated.

- rg / Zoekt → evidence
- dependency graph → structure
- reranking → bias toward impact

---

## Principle 4: Degrade, don't guess

When something can't be resolved:
- record it
- surface it
- don't fabricate a target

This applies especially to Python imports.

---

## Principle 5: Session boundaries matter

The most important moment is **before the first prompt**.

Second most important: **when reality changes mid-session**.

Everything else is secondary.

---

## Principle 6: Reusability over cleverness

One global tool.
Per-repo state.
Explicit commands.
No hidden daemons.

If you can't explain what it's doing in 30 seconds,
it's probably wrong.

---

## Anti-goals

This project is intentionally **not**:

- a semantic code understanding engine
- a full language server
- a vector database
- an IDE replacement

Those problems are real.
They are not *this* problem.

---

## The test of success

If an LLM:
- starts in the right files
- understands blast radius
- notices when the map is stale
- and doesn't hallucinate structure

Then this project has succeeded.
