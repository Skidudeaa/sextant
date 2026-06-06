---
name: Sextant
last_updated: 2026-06-06
---

# Sextant Strategy

## Target problem

LLM coding agents working in unfamiliar or frequently-changing codebases confidently hallucinate file structure — wrong starting files, missed blast radius, invented modules — because they get no factual map before the first prompt and no signal when their structural beliefs go stale mid-session.

## Our approach

We win by injecting a small, honest, health-gated map at the two moments that matter — session start and each code-relevant prompt — and by degrading *loudly* rather than silently leaking stale structure. That means trading comprehensiveness for honesty: deliberately forgoing embeddings, LLM calls in the pipeline, and compiler-backed semantics in favor of facts that can be produced without inference.

## Who it's for

**Primary:** Developer supervising an LLM coding agent — they're hiring Sextant to open a Claude Code session on an unfamiliar or large repo and trust the agent starts in the right files, without burning turns correcting hallucinated structure.

**Secondary:** The LLM coding agent itself — it consumes a freshness-gated map at first prompt and ranked code-relevant context on each subsequent prompt, so its reasoning stays grounded when reality changes mid-session.

## Key metrics

- **Real-session open-rate lift** — on replayed Claude Code session history, how much more often the agent opens a file sextant surfaced for a query vs a permutation-null baseline of plausible same-repo files. This is the only metric measured on *real agent behavior* rather than an offline fixture; everything else proves no-regression, this proves benefit. _Current:_ **1.98×** (6.8% vs 3.4%, 74 sessions). _Measured:_ `sextant eval-trajectory`; the per-turn injection-OFF holdback arm (`SEXTANT_HOLDBACK_PCT` → `benefitDelta` in `sextant telemetry`) upgrades it from correlation to causation. (lagging, north-star)
- **Hook-path retrieval MRR** — Mean Reciprocal Rank of the canonical definition file on the UserPromptSubmit hook path across the committed Vapor fixture; regresses if scoring, merge logic, or def-over-barrel ranking degrades. _Measured:_ `scripts/eval-hook.js` vs `fixtures/vapor-hook-baseline.json`. (leading)
- **graphLiftNDCG** — mean nDCG with the graph lane ON minus OFF (`noGraph` total-off) on the Vapor fixture; positive means graph injection is rescuing definitions that rg/zoekt text frequency buries; regresses toward zero if injection breaks. _Measured:_ `scripts/eval-retrieve.js --json` vs `fixtures/vapor-baseline.json`. (leading)
- **Import resolution rate** — percentage of import specifiers the resolver maps to a real file; below 90% the graph-boost lane disables entirely, so this gates whether orientation activates at all. _Measured:_ `sextant health` / statusline / `graph.db` meta, per-repo. (leading)
- **Freshness stale-hit rate** — fraction of hook injections where the gate detects stale state and emits a minimal body; regresses if the watcher dies, rescan latency grows, or the fingerprint over-fires. _Measured:_ `sextant telemetry` (`stale_rate`). (lagging)
- **NL-recall pass rate (multi-token queries)** — fraction of natural-language multi-token queries where the canonical source file lands in top-5; regresses if the zoekt AND/OR fallback path breaks or the classifier suppresses legitimate retrieval. _Measured:_ eval-harness NL/multiword cases + `eval-hook.js` recall gates. (leading)

## Tracks

### Honest orientation layer

Maintain the freshness gate, silent-absence model, health surfacing (statusline, `doctor`, ALERT lines), and the bounded summary — everything that keeps the injected map factual or withheld rather than stale.

_Why it serves the approach:_ It's what makes "honest" operationally true — drift stays loud instead of silent, so the tool never amplifies the hallucination it exists to prevent.

### Retrieval fidelity

Keep the three-layer pipeline (rg text search, export-graph lookup, re-export chain tracing) and scoring signals (definition-site priority, fan-in suppression, test/doc/vendor penalties, NL-recall tiers) calibrated so the canonical definition outranks hub files, test files, and barrel re-exports.

_Why it serves the approach:_ Orientation beats intelligence only if retrieval reliably surfaces where a symbol is defined; a buried definition is indistinguishable from hallucination.

### Language and resolver coverage

Extend and harden import/export extraction and path resolution across JS/TS (ESM, tsconfig paths, workspaces), Python (dot notation, packages), and Swift (tree-sitter declarations), so resolution stays above the 90% health threshold without adding semantic inference.

_Why it serves the approach:_ Degrade-don't-guess requires recording and surfacing resolution failures, not fabricating them; coverage raises the floor of what the map can honestly assert, and graph boosts only activate above 90% resolution.

### Session integration ergonomics

Lower the friction of installing, running, and diagnosing Sextant across projects — `sextant init`, cooperative watcher/scan coexistence, the statusline action slot, `doctor` hints — so injection actually fires at the session boundary where it matters most.

_Why it serves the approach:_ The approach wins at session boundaries; a tool that isn't running when the session starts provides no orientation at all, no matter how good the retrieval.

### Benefit measurement

Keep the outcome substrate honest and load-bearing: the offline trajectory harness (`sextant eval-trajectory`, permutation-null open-rate lift) and the per-turn injection-OFF holdback arm (`benefitDelta`). Every eval-invisible orientation signal (schema anchors, Makefile commands, public-API outline, co-change, blast-radius) must be measurable here before it ships on faith.

_Why it serves the approach:_ For most of its life sextant could prove no-regression but never benefit — the structural hollow-verification trap. This track converts kill-on-no-fixture from a brake into an accelerator: a signal that moves no offline scoreboard can still earn its place by lifting real open-rate.

## Not working on

- Embeddings or vector search
- LLM calls in the retrieval pipeline
- Semantic code understanding or LSP-like behavior
- Compiler-backed Swift semantics (USRs, cross-module refs, `.swiftinterface` ingestion)
- Summaries exceeding ~2200 chars
- IDE-replacement features
