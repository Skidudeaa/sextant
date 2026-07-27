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

### Tier 3 — earn a verdict on the dark phases — **DECIDED**

Investigated 2026-07-26 by four independent read-only investigations, each finding put
through adversarial verification. Every verdict below is backed by a probe actually run.

7. **Holdback — VERIFIED FIRING; the item as written was the wrong question.**
   The arm is not suppressed anywhere between `settings.json` and telemetry. Two
   independent end-to-end probes in throwaway repos: **119 holdbacks in 240 real `hook
   refresh` invocations at `pct=50`** (49.58%, exact two-sided binomial p=0.949) — one run
   carrying the dogfood capsule+coherence config, one driving the full refresh→PostToolUse
   loop and confirming holdback turns get turn-stamped and scored with `arm:"holdback"` —
   plus 63/200 at `pct=30` (p=0.71).

   The field number is throughput, not a bug. The true funnel over 87.1 days: 135
   classified → 114 `retrieve:true` → 56 `empty_fallback` → 58 reach `decideArm` → 20
   content-stale (forced armed) → **38 holdback-eligible turns = 0.436/day**. Replace §4's
   "3/56 lifetime is low enough to warrant checking whether the env var reaches the hook at
   all" with that funnel. The existing hedge — *n is too small to call it a bug* — remains
   the correct statement: pooled across the three env-var repos the deficit sits at
   p = 0.027–0.063 depending on a two-turn bookkeeping choice, so neither "it's a bug" nor
   "it's noise" is supportable. The `retrieval.deduped` event added in Tier 3 makes that
   choice observable going forward; do not resolve it retroactively.

   **The viability question is the real content of item 7, and on one repo the answer is
   negative.** Reaching 30 scored turns/arm with 90% probability needs 74 eligible turns at
   p=0.5 → **170 days solo**. And `HOLDBACK_MIN_TURNS = 30` is an *accrual* floor, not
   statistical power: at n=30/arm the minimum detectable effect is **+33 to +35 points**, a
   near-doubling of the turn hit-rate. Detecting a plausible +10pt lift needs ~290–390
   turns/arm ≈ years. The delta therefore now prints with a **95% Newcombe interval** and
   refuses the word "causal" whenever that interval spans zero.

   Raised to 50% on this repo. `eval-trajectory` permutation-null lift remains the
   **primary** benefit proof — it already has three orders of magnitude more data than the
   A/B will have this year. Pooling the fleet (13 repos, 314 eligible turns, 5.63/day =
   12.9× sextant) would reach the accrual floor in ~13 days and is the only change that
   makes the arm reachable at all; it needs multi-root aggregation in
   `commands/telemetry.js` (`ctx.roots[0]` today) and is **not** done here.

8. **Phase C — DECIDED: it fires. The FIELD RATE is parked.**
   "Unfalsifiable in single-repo dogfooding" is **refuted** — it was falsified twice, in
   ~90 seconds each. Driving a real edit-then-reprompt sequence in a throwaway repo emits
   literal `<sextant-context-delta>` blocks for all four forms (span move on a fresh turn,
   span move on a content-stale turn, symbol removed, file removed), each with a matching
   `contextdelta.emitted` event. Re-running `diffClaims` read-only against sextant's **own**
   persisted `.capsule.266cb3b0…` renders a real 2-line CHANGED delta today. Now locked by
   `test/claims-hook-e2e.test.js` under its own name and with coherence OFF — the only
   prior hook-level assertion lived under a Phase-F title behind `SEXTANT_COHERENCE=1`, so
   a Phase-C regression was indistinguishable from the permanent `contextdelta.emitted = 0`.

   It has never fired in the field because four preconditions must hold at once: capsule
   mode on, an armed non-content-stale minting turn (8 in 87 days), a later prompt in the
   same session, and a claimed file mutated in between (9.0% of mutations land on a
   surfaced file; 3 such mutations in the whole capsule era). Park the field rate with
   those numbers stated; do not chase it with more dogfooding.

   Two corrections to §6: `claim.served = 36` overstates by 3 — those were minted on a
   holdback turn before `edf40e3` fixed it, so the honest served count is **33**. And
   `telemetry.jsonl.old` does not exist on disk; this review read only the current file.

   *Not adopted*: the claim that "0 of 69 persisted rows carry a `symbol`, so the symbol
   half has never had an eligible field input". Retrieval-side symbol thinness is real, but
   52 of 59 surviving rows predate `7ecfea1` (the commit that first writes `symbol`) by
   construction, and `retrieval.path_hit` carries `exported_symbol` four times, three of
   them after `7ecfea1` landed. The stronger claim does not survive.

9. **Phase F — SPLIT, by verdict TYPE rather than by threshold.**
   The lifecycle half carries an actionable, volume-free signal that sat buried under a
   volume-gated headline for a week. It is now reported first and unconditionally as
   `lifecycleVerdict: CLEAN | DEFECT_OPEN`, itemised by (stage, outcome, reason), with an
   `explained` flag marking a return-side miss whose spawn side already recorded a
   non-success outcome for the same identity. Today it reads `DEFECT_OPEN` — one
   UNEXPLAINED `tool_return missing [no_spawn_snapshot]`, whose root cause is fixed in
   `fb42694`.

   `ACCRUING` was dishonest for both halves. Measured ETAs at the observed rate: 30
   multi-agent tasks = 293d, 100 spawn attempts = 1001d, 100 return attempts = 495d, 50
   eligible incidents = **never** (rate 0). The word asserts that elapsed time closes the
   gap; for four of five floors that was false by one to two orders of magnitude. Each floor
   now carries its own ETA, the heading is **Unmet floors**, and the status is
   `UNREACHABLE_AT_OBSERVED_RATE` unless every unmet floor closes within
   `COHERENCE_ACCRUAL_HORIZON_DAYS` (180).

   **Gate attribution corrected**: this document previously called the 30-task gate the
   randomized trial's. `minMultiAgentTasks: 30` is a top-level/shared gate applied only in
   `coherenceScorecard`'s `baseGaps`; it appears nowhere in `coherenceExperimentScorecard`,
   whose own floors are 40/arm (pilot) and 150/arm (credible read). Parking the trial does
   **not** remove the 30-task gate.

   **The trial is parked**: `coherenceHoldbackPct` is now `0` on this repo. It had been
   switched ON and structurally starved, not awaiting traffic — enrollment requires two
   concurrently live agent snapshots on one taskId with an overlapping workset, and across
   all 13 analysis rows in 10.1 days there were **0** with `overlapPairs > 0` and **0** with
   `sharedPaths > 0` (max concurrent snapshots: 2). Sequential single-repo subagent use
   cannot produce the precondition. **Unpark condition**: a second enrolled repo, or ≥1
   eligible overlap pair per week sustained for four weeks. The code stays — dormant cost is
   one `fs.existsSync` per file-tool PostToolUse, and deleting ~1,471 production lines plus
   1,275 lines of test whose only missing input is a second repo would convert a config flip
   into a rewrite of a subtle locking/attrition/GC design.

### Tier 3 defects found while verifying it

Driving the instruments rather than reading them turned up four defects, three of them in
code that had shipped 48 hours earlier. All are fixed in `fb42694`, each locked by a test
verified to fail pre-change; see that commit message for the mechanisms.

- The PreToolUse double-inject guard was a bare substring test that could not distinguish a
  prompt CARRYING an injected block from one MENTIONING the tag — it silently de-oriented a
  child on 2026-07-16 and broke the downstream join. **1/1 of all observed guard firings
  were false positives; the guard has never fired a true positive.**
- `already_injected` was the only post-validation exit that skipped the spawn lifecycle row,
  so the instrument kept the consequence and erased the cause. Adding that row naively
  introduces a worse bug — `withheld` is TERMINAL and overrides an earlier `written` for the
  same identity, which is exactly the re-fired-hook case the tightened regex now isolates —
  so it is recorded only when nothing was ever prepared for that identity.
- The dedupe path skipped `persistInjectedSet`, collapsing k real turns into one turn id.
  The bias is arm-asymmetric (holdback always mints), landing on `turnBenefitDelta` itself.
- The per-OPEN benefit delta still graduated to an unqualified causal claim on ONE
  randomized turn per arm, printed two lines under the turn-level DORMANT.

### Still open

- ~~**Multi-root telemetry aggregation** (`--roots a,b,c`)~~ — **SHIPPED 2026-07-27.**
  `sextant telemetry` read `ctx.roots[0]` and dropped the rest; `rootsFromArgs` had parsed
  `--roots`/`--roots-file` all along. Pooled reads namespace the turn key by source repo
  (two repos can stamp the same millisecond; a merged turn lets one arm absorb the other's
  opens — the Tier 3 #3 bias class again), apply the coherence gate per repo, refuse
  `--coherence-scorecard`/`--review`, and print a contribution row for every requested root
  including zero-event ones. Single-root output verified byte-identical, text and JSON.
  Locked by `test/telemetry-multiroot.test.js` (16 cases, mutation-checked: dropping the
  namespace fails 3, including the CLI-level one).

  **But the measurement it enabled refutes the projection that motivated it.** Pooled over
  13 fleet repos: **armed 26 turns, holdback 1** — because only sextant has
  `SEXTANT_HOLDBACK_PCT` set. Pooling armed turns does nothing; the binding constraint is
  holdback turns, and that is a per-repo settings change (next-step 5 in docs/034, a user
  decision). Two corrections to the docs/034 estimate: (a) it cited *eligible* turns
  (`decideArm` invocations, 5.63/day) but the floor counts **scored** turns — turns with ≥1
  scored open — a strictly smaller denominator; (b) the fleet's post-stamp scored-turn rate
  measured **12.5/day pooled** (25 turns over the two days in which every event carries the
  Tier 1 turn stamp). At 50% assignment fleet-wide that is ~6 holdback scored turns/day →
  the 30-turn floor in **~5 days**, versus 170 solo. Caveat: a two-day base rate inflated by
  heavy dogfooding, including the session that shipped this.

  **Known limitation, printed in the report rather than absorbed**: the pooled contrast is
  **unstratified**. Randomization is within-repo, but repos differ in baseline hit-rate and
  may differ in `SEXTANT_HOLDBACK_PCT`, so cross-repo arm imbalance confounds the pooled
  delta (Simpson's-paradox shape). The per-root arm counts are printed so the imbalance is
  visible. A Mantel-Haenszel stratified estimator is the correct fix; it was deliberately
  NOT implemented here rather than shipped half-verified.
- **Enabling holdback on the fleet repos** is now the whole remaining unlock — and it is
  still gated on the `turnHitRate` precondition below.
- **Establish the armed `turnHitRate` baseline first.** The only two turn-stamped retrieval
  turns in existence are both zero-hit, and `eval-trajectory --repo sextant` reads 0.68× —
  at or below chance — on 38 surfaced rows (vs somaNotes 2.61× on 1446). Both samples are
  far too thin to conclude anything, but if the armed turn hit-rate really is near zero, no
  delta is detectable at any n. Re-read past ~150 surfaced rows before scaling the A/B.
- ~~**Sync rescan does not reach the retrieval lane.**~~ — **SHIPPED 2026-07-27.**
  `hook-refresh.js` now runs the same Option-5 decision the static path does: same
  `shouldSyncRescan`, same version-only bypass, same clamped timeout, same post-scan
  re-verify, same `freshness.sync_rescan` event (tagged `lane:"retrieval"`). A rescue
  additionally **re-runs graph retrieval** — the graph was queried before the rescan
  rebuilt it, and serving those results under a fresh verdict would assert pre-rescan
  structure with post-rescan confidence, strictly worse than the blackout it replaced.
  Zoekt is deliberately not re-run (it searches the working tree, not the graph).

  **The fixture showed the bug was worse than filed.** With the lane off, a content-stale
  code prompt naming a real symbol does not merely degrade to a stale retrieval block: the
  stale graph has never seen the new file, so the merged set is EMPTY, the hook takes
  `empty_fallback` to the static summary, and the static gate serves the minimal body. The
  turn blacks out completely. Both states are locked by `test/sync-rescan.test.js`, and the
  rescue's load-bearing assertion is the new file's `exported_symbol` provenance — text
  search finds the file too, so only a graph signal proves the exports table was rebuilt
  and re-read. Mutation-checked.

  Telemetry deliberately does **not** emit `freshness.stale_hit`/`fresh_hit` from this
  lane: those are the static path's read denominators, this lane never emits a matching
  `fresh_hit`, and a one-sided `stale_hit` would bias the reported freshness stale rate
  upward by exactly the rescued turns. The lane's own `retrieval.stale_hit` carries
  `rescanState:"sync"` instead — recorded BEFORE the flags clear, so rescuing a turn never
  shrinks the denominator it was counted in.

  **Still not an eligibility lever.** A rescued turn is genuinely fresh and therefore does
  become holdback-eligible — correct, not a side effect to suppress. But it will not move
  the A/B: on the churny repos where content-staleness actually suppresses eligibility,
  `shouldSyncRescan` returns `{sync:false}` (somaNotes p95 99452ms). Ship counted as
  blackout reduction; do not count it as accrual.

### Explicitly not planned

- No action on the open-precision "decline" as if it were a quality regression (§1).
- No citation of 1.82× vs 2.52× as a measured decline — different corpora (§2).
