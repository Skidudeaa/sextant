---
title: Session handoff — after the precision arc (012+013); next target is the classifier's conf-0.4 conversational firing
date: 2026-06-09
status: handoff
branch_state: main @ abf966c (everything merged + pushed; clean tree)
supersedes: docs/011-handoff.md
companion: docs/012-exported-symbol-gap.md, docs/013-path-match-pool.md, scripts/analyze-surfacings.js, todos.md
---

# Handoff — Next Session

> Read order: this file → `docs/012` + `docs/013` (method + what already shipped) →
> `CLAUDE.md` (the two new precision sections under Eval Harness). `todos.md` top
> section is the live tracker.

## TL;DR

The retrieval-precision arc is **mined out and shipped** (all pushed, main @ `abf966c`):
exported_symbol term-quality gate + no-test-floor (012, predicted 3.3%→~15%), path_match
match-location tiers + borderline loose-drop (013, predicted 4.7%→~5.4%). Both confirm
passively via `eval-trajectory` per-source as post-ship sessions accrue.

**The next lever is upstream and feeds every lane at once: the classifier fires
`retrieve:true` at confidence 0.4 on conversational prompts.** Verified live this session:
`"proceed the way you have laid out please"` → `retrieve:true`, conf 0.4, terms
`["proceed","laid","out"]`. Those terms then hit every retrieval layer. The mission:
instance-level diagnosis (012/013 style) → measured fix or measured no-ship.

## Evidence already in hand (do NOT re-derive)

From the per-instance replay over the 110-session corpus (instrument now committed:
`scripts/analyze-surfacings.js`, dumps `/tmp/exp-instances.json`; recompute confidence by
piping the stored prompts through `lib/classifier.shouldRetrieve` — see docs/012/013 for
the exact pattern):

- **exported_symbol**: 60% of its (pre-gate) volume came from conf-0.4 turns at 2.3% opens.
  The 012 gate already kills most of that downstream.
- **path_match by confidence** — the landmine that refutes the naive fix:
  | bucket | conf ≤0.4 | conf >0.4 |
  |--------|-----------|-----------|
  | aligned (stem/dir/token) | **6.2%** (28/453) | 4.9% |
  | near (affix ≤2) | **6.8%** | 4.8% |
  | loose (mid-word) | 1.4% (now dropped by 013) | 3.9% |
  **Borderline turns are NOT uniformly junk** — aligned path matches on conf-0.4 turns
  *outperform* the lane average. The agent often does navigate to a module the user named
  conversationally. So "skip retrieval at conf 0.4" is already refuted by data.
- Non-human boilerplate (`#`-prefixed autonomous-loop/system prompts) contributed 57
  path_match instances / 2 opens — a small pure-noise slice worth its own cut.

## What is NOT yet measured (the actual digging)

1. **text_only × confidence split** — the biggest unknown. If borderline text hits earn
   opens (like aligned path matches do), the right fix is term-level, not turn-level.
2. **Whole-block value at conf 0.4**: per-injection open rate (any surfaced file opened)
   by confidence tier, all sources — answers "are borderline blocks worth their context
   cost at all?"
3. **What conf-0.4 prompts look like by class**: human-conversational vs agent boilerplate
   vs genuinely-code-adjacent. The classifier's score components are in `lib/classifier.js`
   (signals are documented in CLAUDE.md §8); `retrieval.classified` telemetry events carry
   `{retrieve, confidence, termCount}` so fire-rate by tier is auditable from
   `.planning/intel/telemetry.jsonl` too.

## Candidate fix shapes (evaluate against the data; none pre-decided)

- **(a) Borderline requires ≥1 code-shaped term** (`utils.isCodeShapedTerm` exists since
  012): `proceed/laid/out` has none → falls back to static summary; checked that
  py-nl-001's NL-scatter terms (`escalation`, `acknowledged`) are ≥10 chars → still fire.
  Cheapest, term-grounded, probably the front-runner.
- **(b) Borderline → text-only block** (suppress graph lanes, keep zoekt): the 013
  `borderline` opt already threads into `graphRetrieve` — extending its meaning is a
  small change. But the aligned-path 6.2% data argues against suppressing path matches.
- **(c) Classifier score tweaks** (raise the bar for action-verb-only prompts).
- **(d) Skip/flag `#`-prefixed agent-boilerplate prompts** (autonomous-loop ticks).

## Landmines / constraints

- `test/classifier.test.js` regression-locks exact dogfooding phrasings (scope-003/004
  lineage) — any classifier change must keep those, and self-eval scope cases green.
- `py-nl-001` (python hook eval) has `minRecall` gates that NEED NL prompts to keep firing
  retrieval — a stricter classifier that kills NL-scatter queries regresses the A4 recall
  work. Check it explicitly.
- Classifier budget is <1ms, pure heuristics, no LLM calls (What NOT to add).
- **Known pre-existing eval failures** (do not burn time re-discovering): hook self-eval
  `multi-003`, python hook-eval `py-flag-001` — both reproduce at clean baseline (verified
  twice this session via stash A/B). CLI self-eval and Vapor diff are the hard gates.
- Telemetry rotation: telemetry.jsonl rotates at 1 MiB → use `--include-old` when reading
  rates (the holdback cron already does).

## Standing instruments (all passive, no action needed)

- `sextant eval-trajectory` per-source: watch exported_symbol drift toward ~15% and
  path_match toward ~5.4% as post-ship sessions accrue (historical injections are baked).
- Holdback arm at 20% on this repo; daily cron logs to `~/sextant-benefit.log`, announces
  when both arms reach 30 scored opens (as of 2026-06-09: armed 94, holdback 0 — the
  posttooluse TTL shipped this session may explain holdback-0; watch it move).
- `bash scripts/check-holdback-benefit.sh` to check manually.

## This session's ledger (all pushed)

`657efc9` flake root-cause (holdback env leak, NOT timing) · `3ff86b7` measurement
integrity (TTL / pct bound / suffix matching ×3 / sorted arms) · `fe1f0b3` coverage
refinements + `coverageDiagnostics` knob · `c1922b5` holdback-cron hardening + integration
test · `c0afc3a` benefit re-measured (**2.52×** new anchor, matcher A/B attribution) ·
`10d9562` docs/012 diagnosis · `a9c6be0` 012 fixes shipped · `e425e6f` docs/013 diagnosis ·
`abf966c` 013 moves shipped. Unit suite now 797/797; `npm test` exit 0 end-to-end.
