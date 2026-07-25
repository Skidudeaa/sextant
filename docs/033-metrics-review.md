# 033 — Metrics review of the Phase A–F ships, and the refinement plan

**Date**: 2026-07-25
**Reads**: `.planning/intel/telemetry.jsonl` (+ `.old`), 1889 events over 85.9 days;
`sextant eval-trajectory` over `~/.claude/projects` (150 sessions / 9 repos).
**Occasion**: first metrics review after the context-coherence arc (Phases A–F, docs/025–032)
landed on `main` at `53ffcdf`.

The short version: **two of the three alarming numbers are measurement artifacts, and the
instruments that would have caught that are themselves partly broken.** Fix the instruments
before acting on anything they report.

---

## 1. The open-precision "collapse" is denominator inflation, not a regression

Weekly retrieval open-precision (`path_hit / (path_hit + path_miss)`):

| week | injection turns | scored opens | opens/turn | open-precision |
|------|----------------:|-------------:|-----------:|---------------:|
| 2026-06-01 | 18 | 61 | 3.4 | 34.4% |
| 2026-06-08 | 7 | 92 | 13.1 | 2.2% |
| 2026-06-22 | 4 | 28 | 7.0 | 32.1% |
| 2026-06-29 | 3 | 72 | 24.0 | 15.3% |
| 2026-07-06 | 8 | 227 | 28.4 | 2.6% |
| 2026-07-13 | 15 | 183 | 12.2 | 1.6% |

Open-precision scores **every file the agent touches after an injection** against a surfaced
set of ~5 files. So it is mechanically bounded by `surfacedSetSize / opensPerTurn`. At 28
opens/turn the ceiling is ~18% no matter how good retrieval is. `opens/turn` rose 3.4 → 28.4
as agent sessions became more tool-heavy; precision fell in near-lockstep. The metric now
mostly measures session length.

Two hypotheses were checked and **refuted**:

- *"Task Capsule narrowed the surfaced set."* Mean `retrieval.injected.fileCount` is flat
  across the capsule boundary: 4.8 (06-01) → 5.6 (07-13). Capsule mode did not narrow it.
- *"Retrieval quality regressed."* The denominator-independent instrument disagrees — see §2.

**Conclusion**: `openPrecision` is not comparable across weeks with different session shapes.
It was always documented as "precision-flavored", but the caveat understates it: the
denominator is unbounded and unrelated to retrieval.

## 2. What the denominator-independent instrument says

`sextant eval-trajectory` (permutation-null lift, unfiltered):

```
population:  150 sessions with injection across 9 repos (of 168 scanned)
query-retrieval   2.99%   null 1.64%   lift 1.82x   50/1674
static-summary   12.37%   null 11.13%  lift 1.11x   732/5917
first-touch hit-rate 6.60%   median rank when hit: 1   opened-first 3.40%
```

Retrieval still steers at **1.82× chance**; the static summary is still the correlation trap
at 1.11×. The prior anchor was 2.52× (110 sessions, 2026-07-09 corpus, suffix-matcher v2).
The corpus has since rotated to a different 150-session population across 9 repos, so this is
**not** a clean before/after — per docs/016 R3, `~/.claude/projects` is a rolling window and
lift must always be cited with its date and corpus size. Treat 1.82× as the current reading,
not as evidence of a 0.7× decline.

## 3. The benefit-proof harness is half-dark

`sextant eval-trajectory --repo sextant` reports:

```
population: 0 sessions with injection across 0 repos (of 0 scanned)
```

confidently, and exits 0. `repoOf()` (`lib/trajectory.js:525`) returns the mangled project
directory name (`-root-sextant`), and the filter at line 670 compares it to the user's
`sextant` with `===`. Nothing matches, and an empty analysis is indistinguishable from a real
"no data" finding.

This is the failure mode CLAUDE.md's guardrails already name: a lying metric sends you
hunting phantom gaps. It must fail loudly.

## 4. The holdback A/B cannot pay off as built

Two independent defects.

**Starvation.** 3 holdback turns exist in the entire telemetry history
(2026-06-09, 07-15, 07-16). Since `SEXTANT_HOLDBACK_PCT=30` was set on 07-12: 2 holdback vs
19 armed injection turns. At that rate the arm needs ~6 months to reach a citable n. (3/56
lifetime is low enough to warrant checking whether the env var reaches the hook at all, but n
is too small to call it a bug.)

**Analysis-unit mismatch.** Randomization is per *turn* (`decideArm` runs once per
injection); scoring is per *open* (636 armed / 17 holdback scored opens). Opens within one
turn are strongly correlated — they share a surfaced set, a prompt, and a task. Treating them
as independent samples inflates the effective n by ~10× and understates the CI. The existing
`HOLDBACK_MIN_SCORED = 30` gate protects against small n but not against the wrong unit, so
`benefitDelta` would become "citable" while remaining statistically wrong.

## 5. Sync rescan is one heavy day from switching itself off

Live gate decision on this repo:

```
{ sync: true, p95: 2203, samples: 147, timeoutMs: 6609 }   # cap is 2500ms
```

Clean measured scans now run **1.91 / 1.99 / 2.12 s** (lifetime p50 was 1.14s). The gate sits
297ms under its own cap.

`shouldSyncRescan` (`lib/freshness.js:908`) ingests **every** `scan.completed` in the
telemetry file — no recency window, no trigger filter, 147 all-time samples. That pool
includes two 18.8s scans recorded on 2026-07-18 while the full test suite was running. One
heavy day raises the all-time p95 above the cap and blacks out the rescue lane; because old
fast samples never expire preferentially, recovery is slow and arbitrary.

Meanwhile the blackout rate went **up**: 38.1% of reads in the last 12 days vs 31.2%
lifetime. And the dominant stale reason inverted — `scanner_version_changed` is now 76.2% of
stale reads (vs `head_changed` 62.4% lifetime). Most blackouts are now caused by our own
shipping, which is the most predictable stale reason there is.

Scan duration itself roughly doubled (p50 1.14s → ~2.0s). Co-change mining is not the cause
(`git log -n3000 --name-only` measures 37ms); the regression is elsewhere in the Phase C–E
additions.

## 6. Phases C and F shipped dark

- **Phase C (Claim Ledger)**: 36 claims served, **0** context-deltas ever emitted, 0 facts
  re-derived, 0 invalidated. The lane has never fired in the field. That may be correct
  behavior (claimed files usually don't change between prompts in one session), but there is
  zero evidence it *can* fire.
- **Phase F (Multi-agent coherence)**: 1 multi-agent task in 8.9 days against a 30-task
  accrual gate (~9 months at this rate). 1 of 2 tool-return joins failed
  (`no_spawn_snapshot`). The randomized overlap trial is DORMANT with 0 opportunities, 0
  exposed, 0 closed windows. Scorecard status: ACCRUING on every gate.

The lifecycle-reliability half of Phase F *is* producing signal — the `no_spawn_snapshot`
join failure is a real, actionable observation. The causal-trial half is not reachable on a
single dogfood repo.

## 7. What is working

- **Blast radius**: open-precision 17.4% over the last 12 days, up from 13.7% lifetime.
  Dependents continue to outperform co-change partners (72.5% vs 17.5% of hits) — the same
  ordering found on 2026-07-12, now on more data.
- **Retrieval fire path**: `empty_fallback` fell 48.6% → 25.0% of retrieve-classified prompts;
  fire-rate 90.3%; 94.7% of injections are `graph_merged` rather than text-only.
- **Scans**: 143 scans, 100% success rate, 0 failures across the whole window.
- **Sync rescan** when it does fire: 5 rescues of 9 attempts, converting stale reads to fresh
  injections in-hook.

---

## Refinement plan

### Tier 1 — fix the instruments (blocking: everything downstream is suspect)

1. **Per-turn outcome metric.** The injected-set file's `ts` is already a unique per-injection
   identifier (the file is overwritten each injection). Stamp it as `turn` on every
   `retrieval.path_hit` / `path_miss`, then aggregate:
   - `turnHitRate` = turns with ≥1 surfaced-file open / turns scored — bounded, session-shape
     independent, and directly comparable week over week.
   - `medianFirstTouchRank` = position of the first hit among that turn's scored opens,
     reconstructed from append order (no extra hook state).
   Keep per-open precision as a secondary, explicitly labelled session-shape-sensitive.
   Legacy events carry no `turn` and are excluded from the turn metric, reported honestly as
   an unscored count rather than silently folded in.

2. **`--repo` filter: match and fail loudly.** Normalize the mangled project directory
   (`-root-sextant` → `root/sextant`) and accept an exact name, a path suffix, or the raw
   directory. When a filter matches zero sessions, print the available repo names and exit
   non-zero instead of rendering an empty report.

3. **Turn-level `benefitDelta`.** Recompute armed − holdback at the turn level (turn hit-rate
   per arm) and gate on turns per arm, not opens per arm. This is the unit the randomization
   actually happened at.

### Tier 2 — stop the blackouts

4. **Bound the sync-rescan gate's sample pool** to a recency window (last ~50 scans or 14
   days) and exclude scans recorded under test-suite load, so one heavy day cannot disable
   the rescue lane for months.
5. **Handle `scanner_version_changed` without a blackout.** It is 76% of stale reads and is
   entirely self-inflicted: a version bump on an otherwise-unchanged tree invalidates no
   structural fact that a rescan cannot immediately restore. This is the highest-yield
   blackout reduction available.
6. **Investigate the p50 1.14s → 2.0s scan regression** introduced somewhere in Phases C–E.
   Co-change mining is ruled out (37ms).

### Tier 3 — earn a verdict on the dark phases

7. **Raise holdback to 50% on this repo** and verify the arm fires at the configured rate.
8. **Decide Phase C**: build a test that proves `diffClaims` fires on a real
   edit-then-reprompt sequence, or accept it is unfalsifiable in single-repo dogfooding and
   park it with that stated.
9. **Split the Phase F decision**: keep the lifecycle-reliability half (accruing, already
   surfaced a real join failure); park the randomized overlap trial, whose 30-task gate is
   unreachable on one repo.

### Explicitly not planned

- No action on the open-precision "decline" as if it were a quality regression (§1).
- No citation of 1.82× vs 2.52× as a measured decline — different corpora (§2).
