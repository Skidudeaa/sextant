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

## 5. Sync rescan is reading history instead of reality

Live gate decision on this repo:

```
{ sync: true, p95: 2203, samples: 147, timeoutMs: 6609 }   # cap is 2500ms
```

Clean measured scans now run **1.91 / 1.99 / 2.12 s** (lifetime p50 was 1.14s). The gate sits
297ms under its own cap.

`shouldSyncRescan` (`lib/freshness.js:908`) ingests **every** `scan.completed` in the
telemetry file — no recency window, no robustness, 147 all-time samples.

A first reading of this said "one heavy day trips the gate". Measuring it refuted that, and
the real shape is worse in a more interesting way:

| pool | p50 | p95 | verdict at the 2500ms cap |
|------|----:|----:|---------------------------|
| all-time (n=152) | 1154 | 2202 | passes, barely |
| last 80 | 1568 | 2569 | **fails** |
| last 50 | 1769 | 3609 | **fails** |
| last 30 | 1863 | 7524 | **fails** |
| last 20 | 1958 | 10816 | **fails** |

The two 18.8s / 10.4s scans recorded on 2026-07-18 under full-suite load sit *above* the
all-time p95, so they barely move it — the all-time pool is accidentally protected by
dilution. Shorten the window and those same spikes become 4–10% of the sample and dominate
the percentile. So a recency window **alone would have disabled the lane**, and the gate
currently passes only because it is reading months of history rather than the present.

Both halves need fixing together: window for recency, trim for robustness.

Meanwhile the blackout rate went **up**: 38.1% of reads in the last 12 days vs 31.2%
lifetime. And the dominant stale reason inverted — `scanner_version_changed` is now 76.2% of
stale reads (vs `head_changed` 62.4% lifetime). Most blackouts are now caused by our own
shipping, which is the most predictable stale reason there is.

Scan duration itself roughly doubled (p50 1.14s → ~2.0s). Co-change mining is not the cause
(`git log -n3000 --name-only` measures 37ms). A CPU profile of a forced scan located it:

```
33.2%  node_modules/@babel/parser      <- every JS/TS file parsed TWICE
14.9%  node:internal/child_process     <- git subprocesses (4x captureCurrentStateDetailed
11.2%  node_modules/sql.js                + cochange + getGitInfo + getRecentGitFiles)
 7.2%  wasm (sql.js)
```

`extractImports()` and `extractExports()` run back-to-back on the same source at
`intel.js:1067-1068`, and `js_ast_imports.js` / `js_ast_exports.js` each called
`parser.parse(code, PARSE_OPTS)` with *byte-identical* options. Roughly half of the 33% was
redundant.

The `spawnSync` share is real but is NOT safe to memoize: `captureCurrentStateDetailed` is
deliberately re-invoked at distinct points (indexing, `persistGraphUnlocked`, summary
binding), and caching its result across a scan would record a pre-scan status as if it were
post-scan — breaking the atomicity invariant the freshness gate depends on. Left alone.

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

### Tier 2 — stop the blackouts — **SHIPPED**

4. **Windowed + outlier-trimmed sync-rescan gate.** Pool is now the most recent 50 successful
   scans with the slowest tenth dropped (`SYNC_RESCAN_WINDOW` / `SYNC_RESCAN_TRIM_FRACTION`).
   On this repo that reads p95 2201ms over 45 kept samples, where the raw last-50 p95 of
   3609ms would have disabled the lane. Trimming weakens the worst-case guarantee to roughly
   the raw p85, which is only acceptable because the in-hook child is already hard-killed at
   `timeoutMs` — the tail risk is bounded by the kill, not by this estimate. The decision now
   reports `windowed` and `trimmed` counts for observability.

5. **Version-only staleness bypasses the stats gate.** When the sole stale signal is
   `scanner_version_changed` / `schema_version_changed` *and* `contentChanged === false`,
   `shouldSyncRescan(root, {versionOnly: true})` authorises a synchronous rescan regardless of
   recorded history, at the maximum timeout. Content is unchanged, so the rescan cannot lose a
   race against the working tree and the post-scan re-verify has nothing to catch; the cost is
   once per upgrade per repo. The env kill switch, the per-repo config opt-out and the failure
   cooldown all still apply. A version bump that *coincides* with a checkout is excluded —
   `contentChanged` is computed independently of the single-valued reason race. Telemetry
   carries `gate: "version_only" | "stats"` so the two arms stay separable.

6. **Scan regression fixed: single-parse front-end.** `lib/extractors/js_ast_cache.js` gives
   both AST lanes one shared, single-entry, source-keyed parse cache (failures cached too).
   Measured scans went **1.91 / 1.99 / 2.12 s → 1.60 / 1.64 / 1.77 s** (~17%), matching the
   predicted saving from halving babel. Self-eval byte-identical.

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
