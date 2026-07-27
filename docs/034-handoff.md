# 034 — Session handoff: docs/033 Tier 3 decided, instruments repaired

Date: 2026-07-26. Branch `feat/033-metric-instruments` @ `b7dd52f` — **committed,
NOT pushed, NOT merged.** Main is unchanged at `53ffcdf` (the Phase A–F arc).
Six commits ahead:

```
b7dd52f docs(changelog): record the docs/033 metrics-review arc (Tiers 1-3)
f7510bb fix(freshness)+chore(honesty): label what the instruments actually measure
0aa19f9 feat(telemetry)+test(claims): decide Tier 3, split the Phase F verdict
fb42694 fix(spawn)+fix(metrics): close two silent-failure paths
23e4cec perf(scan)+fix(freshness): cut blackouts at the source          [Tier 2, prior session]
c582298 fix(metrics): make the outcome instruments honest               [Tier 1, prior session]
```

Gates at `b7dd52f`: unit **1260/1260**, integration green, self-eval 21/21
byte-identical (MRR 0.904 / nDCG 0.909 / graph lift +0.015). No retrieval or
scoring path was touched in any of the four Tier 3 commits.

Canonical doc: `docs/033-metrics-review.md` — Tier 3 is now a **DECIDED** section
with verdicts, plus "Tier 3 defects found while verifying it" and "Still open".
Read it before continuing; this handoff is the map, that doc is the record.

## What this session did

Closed docs/033 Tier 3 (items 7, 8, 9). Method: four independent read-only
investigations against the live repo and telemetry, each finding put through an
adversarial verifier, then implementation in the main loop (sequential — the
agents were read-only so they could not race the tree).

**The method mattered more than any single fix.** Every defect below was found by
*driving* the instrument in a throwaway repo, not by reading it. Three of the four
were in code that had shipped 48 hours earlier and whose own tests were green.

## Verdicts

### Item 7 — holdback: VERIFIED FIRING; the item as written was the wrong question

Not suppressed anywhere between `settings.json` and telemetry. **119 holdbacks in
240 real `hook refresh` invocations at `pct=50`** (49.58%, exact two-sided binomial
p=0.949), including one run with the dogfood capsule+coherence config and one
driving the full refresh→PostToolUse loop; plus 63/200 at `pct=30` (p=0.71).

Field scarcity is throughput. Funnel over 87.1 days: 135 classified → 114
`retrieve:true` → 56 `empty_fallback` → 58 reach `decideArm` → 20 content-stale
(forced armed) → **38 eligible turns = 0.436/day**.

**It cannot pay off on one repo.** 170 days to the accrual floor, and
`HOLDBACK_MIN_TURNS=30` is an *accrual* floor, not power — MDE there is +33 to +35
points. Detecting a plausible +10pt lift needs ~290–390 turns/arm ≈ years. So the
turn delta now prints a 95% Newcombe interval and says `SPANS ZERO, directional
only` instead of "the causal lift" when the interval includes zero.

Raised to 50% on this repo (`.claude/settings.json`). `eval-trajectory`
permutation-null lift remains the **primary** benefit proof.

### Item 8 — Phase C: it fires; the FIELD RATE is parked

"Unfalsifiable in single-repo dogfooding" was **refuted** — falsified twice, ~90s
each. New `test/claims-hook-e2e.test.js` drives the real edit-then-reprompt loop
and locks all four delta forms plus a negative control, **capsule ON and coherence
OFF** (the only prior hook-level assertion lived under a Phase-F title behind
`SEXTANT_COHERENCE=1`, so a Phase-C regression was indistinguishable from the
permanent `contextdelta.emitted = 0`). Mutation-checked: neutering
`renderContextDelta` fails the three positives and leaves the control passing.

Zero field firings is a four-way precondition conjunction, now stated with numbers.
Do not chase it with more dogfooding.

### Item 9 — Phase F: split by verdict TYPE, not by threshold

- `lifecycleVerdict` (`CLEAN` | `DEFECT_OPEN`) prints **first and outside every
  volume gate**, itemised by (stage, outcome, reason) with an `explained` flag.
  Integrity is an event-level property; one unexplained join miss is actionable the
  day it happens.
- Each unmet floor carries its own **ETA at the observed rate**, the heading is
  **Unmet floors**, and the status is `UNREACHABLE_AT_OBSERVED_RATE` unless every
  floor closes inside `COHERENCE_ACCRUAL_HORIZON_DAYS` (180). `ACCRUING` had been
  asserting that waiting closes gaps measured at 293d / 495d / 1001d / **never**.
- Overlap trial **parked**: `.codebase-intel.json` `coherenceHoldbackPct: 50 → 0`.
  It was switched ON and structurally starved — 0 of 13 analyses ever recorded an
  overlap pair. **Unpark condition**: a second enrolled repo, or ≥1 eligible overlap
  pair/week sustained four weeks. Code left dormant (one `fs.existsSync` per
  file-tool PostToolUse); do not delete it.
- **Gate attribution corrected**: docs/033 called `minMultiAgentTasks: 30` the
  trial's gate. It is top-level/shared and appears nowhere in
  `coherenceExperimentScorecard`, whose floors are 40/arm and 150/arm.

## The four defects (all locked by a test verified to fail pre-change)

1. **`commands/hook-pretask.js` silently de-oriented subagents.** The double-inject
   guard was `prompt.includes("</codebase-intelligence>")`, which cannot distinguish
   a prompt that CARRIES an injected block from one that MENTIONS the tag. A real
   Task prompt on 2026-07-16 — recovered verbatim from the transcript — was skipped;
   the child spawned with **no orientation** and its return had no snapshot to join
   (the window's lone `no_spawn_snapshot`). Now `/^<\/codebase-intelligence>$/m`:
   `lib/orient.js` always emits the close tag alone on its own line, a quotation
   never does. **Deliberately not tail-anchored** — the coherence block appends
   after it, so a `$`-anchored test on the whole prompt would re-inject every time.
2. **`already_injected` skipped its spawn lifecycle row** — the only post-validation
   exit in that file to do so, against the invariant stated at its top. **LANDMINE:
   adding the row naively introduces a worse bug.** `withheld` is TERMINAL in
   `lifecycleAttemptUnits`, which collapses `child_spawn` rows by `taskKey\0agentKey`
   and lets a terminal outcome override an earlier `written`. Tightening the regex
   makes the guard fire *only* on prompts that genuinely carry a block — i.e. the
   re-fired-hook / retried-Task case, same `tool_use_id`, same `childKey`, where a
   success row already exists. So the row is recorded **only when no snapshot exists
   for that identity**. Do not remove that check.
3. **The dedupe path skipped `persistInjectedSet`**, collapsing k real turns into one
   turn id. Tier 1 assumed "the injected-set ts identifies the turn"; that holds per
   EMITTED BLOCK, not per turn. Bias is arm-asymmetric (holdback always mints), so it
   landed on `turnBenefitDelta` itself. Deduped turns now mint their own id and emit
   `retrieval.deduped {arm}`.
4. **The per-OPEN benefit delta graduated to an unqualified causal claim on ONE
   randomized turn per arm** — at ~28 opens/turn an opens-only floor of 30 clears
   immediately. `deltaAtVolume` now requires both floors.

## Gotchas for whoever picks this up

- **The bash tool's cwd persists across calls.** A `cd` into the memory dir made a
  later `git status` report on `~/.claude` instead of `/root/sextant`. Re-anchor with
  an explicit `cd /root/sextant &&` when it matters.
- **`test/hook-holdback.test.js:134` encoded the OLD opens-only contract** and failed
  the moment `deltaAtVolume` gained the turn floor. It is updated, plus a mirrored
  case (30 opens concentrated in 1 turn/arm must stay DORMANT). Expect similar
  contract-encoding tests if you change a gate.
- **`telemetry.jsonl.old` does not exist on this repo.** docs/033 originally said the
  review read both; it read only the current file. `--include-old` is a no-op here.
- **The `.old`-ordering fix in `shouldSyncRescan` has no behavioural test, on purpose.**
  The `.old` branch only runs when the current file holds < `SYNC_RESCAN_MIN_SAMPLES`
  (5) rows, so at most 4 rows can ever be misordered and the trim discards 5 — the
  fix is structurally unobservable through the decision. The test file says so. Do not
  "fix" that by adding an assertion the constants cannot produce.
- **Restart the watcher after upgrading** (standing repo landmine): an old-code
  watcher flush can clobber a new-shape persist.

## Next steps, ranked

1. **Push / open the PR.** Six commits, all gates green, tree clean.
2. ~~**Multi-root telemetry aggregation**~~ — **DONE 2026-07-27.** See docs/033 "Still open"
   for the shipped behaviour AND for the two corrections the measurement forced: the floor
   counts *scored* turns, not the *eligible* turns estimated below, and pooling alone
   changes nothing while only sextant has a holdback arm (pooled: armed 26, holdback 1).
   Original note kept for the record: (`commands/telemetry.js:2322` is
   `ctx.roots[0]`). Accept `--roots a,b,c` and pool turns for
   `turnCountsByArm`/`turnHitRateByArm` — pooling is valid because randomization is
   per turn. This is the **only** change that makes the holdback A/B reachable:
   13 repos carry 314 eligible turns at 5.63/day (12.9× sextant) → accrual floor in
   ~13 days instead of 170.
3. **Gate (2) on a precondition check first.** The only two turn-stamped retrieval
   turns in existence are both zero-hit, and `eval-trajectory --repo sextant` reads
   **0.68× — at or below chance — on 38 surfaced rows** (vs somaNotes 2.61× on 1446).
   Both samples are far too thin to conclude anything, but if the armed turn hit-rate
   really is near zero, no delta is detectable at any n. Re-read past ~150 surfaced
   rows before scaling the experiment.
4. **Sync rescan does not reach the retrieval lane** — `hook-refresh.js:690` calls
   bare `checkFreshness` and only ever takes the async arm (`:738`); the Option-5 sync
   arm lives in `lib/cli.js:applyFreshnessGate`. So a content-stale *code* prompt with
   results still gets the degraded text-only block. Ship it as a **product** fix
   (blackouts on code turns), **never** as an eligibility lever — on `/root/somaNotes`,
   where 97% of turns are content-stale, `shouldSyncRescan` returns
   `{sync:false, p95:99452}` and would never fire. Requires re-running graph retrieval
   after a successful rescan, since `graphPromise` ran against the stale graph.
5. **Enabling holdback on other repos** (`jan25`, `glasshud`, `defGen2`) is a user
   decision — it edits other projects' `.claude/settings.json`. Not done.

## Refuted — do NOT re-chase

- **"The holdback arm is suppressed/broken."** Refuted by two end-to-end probes. Keep
  docs/033's existing hedge (*n is too small to call it a bug*); pooled p sits at
  0.027–0.063 across defensible counting rules, so neither "bug" nor "noise" is
  supportable. The new `retrieval.deduped` event dissolves the ambiguity
  prospectively — do not resolve it retroactively.
- **"Phase C is unfalsifiable in single-repo dogfooding."** Refuted; falsified twice.
- **"The double-inject false-positive is routine."** Refuted as a rate — it fired
  ONCE in 87 days. The defensible framing is *1/1 of all observed guard firings were
  false positives; the guard has never fired a true positive.*
- **"0 of 69 persisted rows carry a `symbol`, so the ledger's symbol half never had
  an eligible field input."** Refuted as stated (this was my own claim). 52 of 59
  surviving rows predate `7ecfea1` (which first writes `symbol`) by construction, and
  `retrieval.path_hit` carries `exported_symbol` four times, three of them after that
  commit. Retrieval-side symbol thinness is real; the stronger claim is not. Do not
  enshrine it in CLAUDE.md.
- **"Sync rescan is the biggest holdback-eligibility unlock."** Core defect real (see
  next-step 4), unlock claim false.

## Process lesson worth keeping

An adversarial verifier returned `refuted: true` on the `hook-pretask.js` finding —
but its reasoning **confirmed** the file:line, the mechanism, and the block format
verbatim, and refuted only the word "routine" in the frequency claim. The workflow's
synthesis filter dropped it as refuted. It was a real silent-de-orientation bug.
**Never filter findings on the boolean; read `correctedClaim` for every non-confirmed
finding.** Prefer a graded field (`refuted | overstated | confirmed`) in future
verification schemas. Recorded in memory as `feedback-adversarial-verdict-boolean`.
