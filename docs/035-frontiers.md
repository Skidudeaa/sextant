---
title: Frontiers — stop adding facts; prove, un-dark, and prune the ones we already have
status: synthesized
priority: high
feasibility: mixed (two XS honesty defects with a 30-second FAIL-pre; four candidates inert until a fixture exists or accrual arrives)
source: dynamic workflow (4 grounding lenses — telemetry-forensics · code-seams · backlog-ledger · external-landscape → 8 ranked candidates → 8 independent adversarial verifiers, each reproducing the candidate's OWN kill-gate against live code and 20 real repos → 1 completeness critic on the unexamined surfaces)
researched: 2026-07-27
method: fleet-wide telemetry + code-seam census + backlog ledger + external landscape → candidate generation → per-candidate skeptic reproduction (not reinterpretation) → completeness critic → composite ranking with post-verification adjustment
companion: docs/033-metrics-review.md, docs/034-handoff.md, docs/ideas/009-yield-synthesis.md
---

# Frontiers — the next campaign

> Successor to `docs/ideas/009-yield-synthesis.md` (2026-06-05). Same discipline: every candidate
> was handed to an independent skeptic that **reproduced** the candidate's own kill-gate against
> live code and the live 20-repo fleet. **All eight verdicts came back `overstated`** — not one
> candidate survived unaltered. In this repo the corrections are the most valuable output, so they
> are preserved inline with their numbers rather than laundered into the pitch.
>
> Everything below was measured on the fleet at HEAD `9e44cab` on 2026-07-27, read-only. Where two
> lenses disagree on a number, both are printed and the disagreement is named.
>
> Load-bearing claims were re-verified independently in the main loop after synthesis — see
> **Main-loop verification** at the end. Ten of ten confirmed; one caveat in the Bottom line is
> corrected there, in the direction that strengthens the argument.

## Where we're headed (the through-line)

009's campaign was **"every injected byte must be a fact, or be visibly absent."** That campaign
succeeded: the freshness gate reaches four injection surfaces, the honesty instruments exist, and
docs/033 repaired the instruments themselves. It is done, and continuing it yields nothing.

The next campaign is the inverse:

> **Stop adding facts. Make the instruments answerable, un-dark the surfaces that already have
> facts to deliver, and delete the lanes that have never fired.**

The frontier moved because three things became measurable at once. (1) Sextant's realized retrieval
product is **fuzzy filename matching** — path_match is 87.8% of the 1,172 rows currently persisted
across 13 repos, and the entire dependency-graph half surfaced **13 rows** in the current 16.8-day
transcript window, one of which was opened. (2) **17.4% of production code** (5,158 of 29,232 lines
in lib+commands+bin+mcp) serves Phases B–F, enabled on **1 of 20 repos**, whose central instruments
have emitted **zero rows** fleet-wide in 88 days. (3) Every question the project asks of its own
telemetry is **unanswerable from the events it records** — `retrieval.path_miss` carries no
`source`, so no per-source open *rate* exists anywhere; `retrieval.empty_fallback` is literally
`recordEvent(root, "retrieval.empty_fallback", {})` at `commands/hook-refresh.js:859` while being
**51.3% of retrieve-classified turns** (819/1,598 fleet-wide).

Adding a ninth signal to a block that is 88% filename matching, injected into a context that is
79% content-stale, measured by an instrument that cannot compute a rate, is not yield. Proving,
un-darkening, and pruning is.

## Bottom line

009's load-bearing fact was *"nothing in sextant observes whether an injected path is ever opened."*
That is fixed. The new load-bearing fact is worse, because it is about allocation:

> **The lane sextant has invested most in produces 6.4% of its credited file opens. The lane one
> candidate proposes to shrink produces 93.6%. The project's two headline metrics rank the two
> lanes oppositely, and only the metric that favours retrieval has ever been cited.**

From one `eval-trajectory --json` run today (151 sessions with injection): **retrieval** 409
injections / 1,676 surfaced / **52 opened** / coverage 3.1% / medianFirstTouchRank **1**;
**static summary** 690 injections / 6,237 surfaced / **757 opened** / coverage 12.1% /
medianFirstTouchRank 3. Permutation-null lift ranks them the other way: retrieval **1.77×**,
static **1.13×**. Five of the eight ranked candidates operate on the retrieval lane; the only one
touching the static body proposes evicting from it.

Two honest caveats on that framing, both load-bearing: the two surfaced sets are **not disjoint**,
so 93.6% is share-of-credited-opens, not causal attribution; and retrieval's few hits arrive
**first** (rank 1 vs 3), which is the orientation-latency argument the coverage number cannot see.

Three consequences follow, and they are the shape of the next six weeks:
1. **Adjudicate the allocation question before spending on either lane.** The cheapest test already
   exists and needs no new collection (§Gaps, "the load-bearing shared assumption").
2. **Fix the instruments so the adjudication is possible at all** — no per-source rate, no session
   id on any of 89 `recordEvent` sites, no injected-byte cost recorded, and a pooled A/B whose
   holdback arm is **100% one repo**.
3. **Prune.** Phases D–F, three MCP tools that have never been called, `swift_relations`
   (92 rows fleet-wide, zero production row-level readers), and the `reexports` lane (19 rows,
   one repo) are all carrying cost against zero field output.

The external landscape agrees from the outside: Gloaguen et al. (arXiv:2602.11988, 438 tasks,
4 agents) found repository-level context files "do not provide effective overviews" and did not
reduce steps-to-modified-file, at +20–23% cost; Claude Code 2.1.206 shipped a `/doctor` check that
proposes cutting CLAUDE.md content "Claude could derive from the codebase." Meanwhile the honest
effect size for *adding a retrieval layer to a coding agent* is Cursor's production A/B:
**+0.3% code retention overall, +2.6% on repos ≥1,000 files** — against sextant's holdback MDE of
**+33 to +35 points**. The A/B as designed cannot see the effect it is looking for, on any fleet,
on any timeline.

---

## The ranking

Composite = benefit×3 + leverage×2 + feasibility×2 + evidence×2 + philosophy×2 (max 55).
`48 → 42` means the workflow composite was adjusted **after** the verifier reproduced the kill-gate.
`novelty`: **new** = not in 006/007/009 · **gap** = surfaced by the completeness critic, scored
post-hoc on the same rubric by one lens only (weaker evidence than the verified eight) ·
**open-in-backlog** = already in the ledger.

| # | Composite | Move | Effort | Novelty | Class |
|---|-----------|------|--------|---------|-------|
| 1 | **48** | Make the funnel legible — source on `path_miss`, a real `empty_fallback` payload, a session id, a dominance guard on pooling | M | new | measurement-proof |
| 2 | **45** | Non-git root: permanent blackout **and** `.env` in the zoekt corpus (two defects, one root cause) | XS–S | gap | honesty-defect |
| 3 | **43** | MCP pull channel: 1 invocation in 576 transcripts — `defer_loading`, `recordEvent`, then cut | S | gap | scope-discipline |
| 4 | 46 → **42** | NL→export-graph lexical bridge (with the docs/012 guards the candidate omitted) | M | new | retrieval-quality |
| 5 | 35 → **40** | Zoekt daemon **identity** guard + doctor action + provider counter | S | new | honesty-defect |
| 6 | 41 → **37** | Un-dark subagent orientation (status-budget fix first, coherence flip second, degrade arm contested) | M | new | orientation-surface |
| 7 | 39 → **36** | `clampBlock` — stop injecting a mid-token path inside an unclosed backtick (+ section-tag the static replay) | S | new | honesty-defect |
| 8 | 35 → **30** | Context-coherence disposition: flip the flag today, decide deletion on surface area | M | new | scope-discipline |
| 9 | 36 → **26** | Wire `extractBatch` — as a **CPU-cost** move only; the staleness thesis is refuted | M | new | robustness-perf |
| 10 | 45 → **22** | `benefitDelta` JSON gate (**shell half shipped at `9e44cab`**; residual is the JSON contract) | XS | open-in-backlog | measurement-proof |
| 11 | 35 → **18** | rg fallback inside `searchFast` — **deferred**, see Killed | M | new | retrieval-quality |

---

## Tier 1 — the three that make everything else decidable

### 1. Make the funnel legible · composite 48 · **the unlock**

**Grounding (verified verbatim).** `retrieval.path_hit` carries `{source,tool,arm,turn}`;
`retrieval.path_miss` carries `{tool,arm,turn}` and **no source** — so
`commands/telemetry.js:2527`'s `path_hit by source` is a share-of-*hits* composition rendered with
no denominator, and **no per-source open rate is computable from telemetry at all**.
`recordEvent` appears at **89 sites, 0 carrying a session id**;
`commands/hook-refresh.js:102` is `Math.random() * 100 < pct` with no persisted assignment, so
armed→holdback carryover inside one session is undetectable. **95.1% of files touched after an
injection were never surfaced** (459 hit / 8,828 miss fleet-wide) and nothing records the byte cost
of what was injected (`grep -c blockBytes` = 0, exit 1).

**Mechanism.** Five additive changes on existing seams: (1) `retrieval.turn_outcome
{turn, arm, status, blockBytes, surfacedCount, confidence, termCount, contentStale}` at the
delivered/deduped/empty exits; (2) `source` on `path_miss` (`source:null` for unsurfaced files);
(3) fill the `empty_fallback` payload — all four fields are already in scope at `:859`;
(4) a hashed 12-hex `sid` at the ~12 sites already holding a `sessionKey`, with any session
containing both arms flagged CONTAMINATED and excluded; (5) a **pooling dominance refusal**.

**Verified corrections (two of them make the candidate stronger, not weaker):**
- **The two `source` vocabularies collide on one token.** `retrieval.injected.source` is drawn from
  `{graph_merged, text_only}`; `retrieval.path_hit.source` from
  `{path_match, exported_symbol, text_only, reexport_chain, swift_decl_*}`. A naive join of the two
  existing fields would emit a **silently wrong** per-source rate. The fix must add a distinct
  surfaced-count field, not reuse `injectedBySource`.
- **Pooling shipped at `548e7eb` — before the guard, and the arms are pathological.** The holdback
  arm is **100% sextant** (41 opens); armed is 92% non-sextant (8,947 opens across 10 roots). A live
  pooled run prints `armed open-precision 5.0% (n=7474)` beside `holdback 48.8% (n=41)`, and
  `armed turn hit-rate 12.0% (3/25)` beside `holdback 100.0% (1/1)` — inviting the read that
  retrieval **hurts**, which is pure root composition. The `≥30/arm` DORMANT gate suppresses the
  headline delta but **not the per-arm rows**. Mechanism (5) is therefore urgent and needs no
  synthetic fixture.
- **Numbers corrected.** somaNotes is **36.6% of 19,389** all-time fleet events (not 76.4% of
  26,143) — and **69.0% of the last 14 days**; the real dominance is arm-specific. Blast-radius vs
  retrieval precision is **2.52×** (12.47% = 109/874 vs 4.94% = 459/9,287), not 2.7×. The
  "exported_symbol is 7.7% of hits on ~5% of rows" inversion figure is **not reproducible** —
  historical surfaced composition is unrecoverable because the injected-set file is overwritten per
  turn. That unrecoverability is the candidate's own thesis; state the inversion as
  **"direction unknown until the denominator exists,"** not as a measured magnitude.

**Kill-gate.** FAIL-pre needs no accrual and is confirmed today: `grep -c blockBytes` = 0, and no
key in `telemetry --json .retrieval` supports a per-source open rate or a bytes-per-hit ratio.
PASS-post: a driven three-prompt fixture (the `test/claims-hook-e2e.test.js` throwaway-repo pattern
— it exists) asserts three `turn_outcome` rows with correct statuses and non-zero `blockBytes`;
`pathMissesBySource` exists and a rate prints; a mixed-arm session yields `contaminatedSessions 1`
and is excluded; the dominance guard suppresses the pooled headline against the **real** fleet, no
synthetic two-root fixture required.

**⚠ ACCRUAL-DEPENDENT (part).** Gate (e) — rescoring blast radius on a matched most-recent-set
denominator — is **not** feasible on existing data: `.blastradius.*` sets have a 24h TTL and the 109
historical hits cannot be re-attributed. That half needs forward accrual or a driven replay.
Separately, the turn-level half is **inert for weeks**: `retrieval.deduped` = **0 rows fleet-wide**
and only **29 distinct scored turns** exist fleet-wide (sextant 4–5). Gate any printed turn rate on
`turnsScored ≥ 30`, and expect it to print nothing.

**Effort** M. **Risk.** The wasted-injection rate (95.1%) will be misread as "sextant is 95%
useless" unless labelled **EXPOSURE, not damage** — the same misreading that already forced the
open-precision→turn-rate correction in docs/033 Tier 1. The dominance guard's first visible effect
is to withhold the pooled number `548e7eb` was written to enable, and with the holdback arm at 100%
one root it will suppress **indefinitely**, not briefly. That is honest and it will read as a
regression. One extra `fs.appendFileSync` per prompt is sub-ms against the 200ms budget but
accelerates the 8 MiB rotation cadence.

### 2. Non-git root — permanent blackout **and** secrets in the corpus · composite 45 · **gap**

Two independent defects with one precondition: a project that has never been `git init`ed. No lens
tested this; all 20 fleet repos are git.

**Grounding (driven live in a fixture).** `sextant scan` succeeds on a non-git root ("done (2
indexed)", 100% resolution) — and then `checkFreshness` returns
`{fresh:false, reason:"head_changed", contentChanged:true, evidence:{stored:"", current:null}}`
on **3/3 consecutive calls**, and still after `rescan --force`. Cause: `lib/freshness.js:649`
coerces stored head to `|| ""` and the guard at `:715` is
`if (!stored.head || !current.head || current.head !== stored.head)` — in a repo that never had git,
`!stored.head` is true **forever** — while `:720` hardcodes `contentChanged: true` instead of using
the value computed at `:681`. There is no git-absent branch. Field effect in the fixture:
3 `scan.completed {trigger:"freshness_gate", success:true}` — successful, futile rescans on every
read — plus `.rescan_pending`, plus 3/3 `retrieval.stale_hit`, plus every SessionStart emitting
"Structural claims unavailable this turn."

Second defect, same precondition: `lib/zoekt.js:222` selects
`isGit ? "zoekt-git-index" : "zoekt-index"`, and the `-ignore_dirs` list at `:238` is
**38 directories** — `.env` is a file and cannot be excluded by it. Verified: a non-git fixture with
a gitignored `.env` containing `STRIPE_WEBHOOK_TOKEN=sk_live_FAKE_deadbeef…` built cleanly and
`grep -a` on the shard **found the token**. The injection path is
`lib/format-retrieval.js`'s `f.zoektHit.line.trim().slice(0, 60)`, and that excerpt is explicitly
designed to **survive the `textOnly` content-stale gate**.
`grep -niE "redact|secret|api[_-]?key|sanitiz"` across format-retrieval / merge-results / zoekt /
hook-refresh returns **zero hits**. Git roots are safe (`zoekt-git-index` indexes committed content;
rg honors `.gitignore`).

**Mechanism.** (a) A `gitAvailable` branch in `checkFreshness` returning a distinct reason,
suppressing the rescan enqueue, and using the computed `contentChanged`; (b) apply the repo's
already-built `cfg.gitignoreFilter` to the non-git zoekt corpus, plus a filename denylist checked
before any line excerpt is emitted.

**Kill-gate.** Manufacturable in 30 seconds and currently failing: a `package.json`-marked non-git
dir with two JS files reproduces the permanent blackout on the first `checkFreshness`; the secrets
half reproduces with one `.env` and a `grep -a` on the built shard. PASS-post: blackout clears with
a distinct reason and zero `freshness_gate` scans enqueued; the shard contains no `.env` content.

**Effort** XS (freshness branch) + S (corpus filter). **Risk.** Deciding *what a non-git root's
freshness anchor is* is a real design question — content hash only, presumably — and getting it
wrong replaces a loud permanent blackout with a silent wrong "fresh". The two halves compound into
the worst configuration in the codebase: **no structural facts ever, while raw file content keeps
being injected**. This is the only finding in the whole set with a confidentiality consequence
rather than a measurement one.

### 3. MCP pull channel — 1 invocation in 576 transcripts · composite 43 · **gap**

**Grounding.** Parsing every `tool_use` record in `~/.claude/projects` (576 transcripts, 159
sessions with tool_use, window 2026-07-10 → 07-27): `mcp__sextant__sextant_search` = **1 call**, in
1 session. Every other sextant tool = **0**. Compare Read 2,808 · Edit 3,531 · Bash 9,745 · Grep 448;
all `mcp__*` calls together = 172, of which **171 are playwright**. Not a naming artifact — a raw
grep for the tool-name strings finds them **592–876 times each**, which are *definition loads*, not
calls. The `TOOLS` literal is **6,142 chars ≈ 1,536 tokens**, loaded into every session on 9 wired
repos. `grep -c recordEvent mcp/server.js` = **0** — there is no telemetry import at all, which is
why nobody noticed.

**Mechanism.** `recordEvent` on every handler (so the channel stops being unmeasured), then
`defer_loading` on all but the one or two tools with recorded use, then cut. Anthropic's Tool Search
Tool reduces tool-definition context 85% and *raises* tool-use accuracy (49%→74% Opus 4;
79.5%→88.1% Opus 4.5); Claude Code's MCP Tool Search auto-engages past 10% of context, at which
point sextant's pull tools become invisible **unless the model searches for them** — silently
breaking the "MCP availability as fact" line in `lib/orient.js` and the whole
`sextant_focus`/`sextant_orient` pull story.

**Verified correction to candidate #8.** `phases-bf-disposition` proposed cutting
focus/task_status/closure to save ~485 tokens (those three serialize to 1,942 chars). The right
scope is **the whole surface** — 1,536 tokens × ~600 loads — and the right first move is
instrumentation, not deletion.

**Kill-gate.** FAIL-pre is the transcript census above (reproducible today, no fixture). PASS-post:
every handler emits `mcp.invoked {tool}`; after 30 days, any tool with **zero** recorded invocations
is deleted rather than deferred. Deletion has no natural FAIL-pre, so the inertness proof is a
golden-file assertion that injected bytes are byte-identical on a repo without `.codebase-intel.json`.

**Effort** S. **Risk.** Six of the nine tools are the *deliberate high-trust surface* the honesty
work was built for; measuring zero use is not the same as measuring zero value, because the agent
may never have been told they exist in a form it acts on. The instrumentation must land before any
cut, or the deletion is taste-driven.

---

## Tier 2 — the retrieval lane, conditional on the allocation question

### 4. NL→export-graph lexical bridge · composite 46 → 42

**Grounding.** `lib/graph.js:651-659` `findExportsBySymbol` is `WHERE LOWER(name) = LOWER(?)` —
pure exact match. On **1,185 real prompts / 980 classifier fires across 11 repos**, the export lane
is reached on **6.0%** (sextant's own repo: **0 of 35**); path-only 59.4%; graph-empty 31.6%.
Persisted rows across 13 repos: **1,172 total — path_match 1,029 (87.8%)**, text_only 68,
exported_symbol 59, reexport_chain 12, swift_decl 4. Yet driving `graphRetrieve` with a repo's own
exported symbols hits **95–100%**: the lane works, users never type symbols.

**Mechanism.** A scan-time `export_tokens(token, path, name, df)` table (query-time build measured
**93ms** on somaNotes's 12,376 exports — over the <50ms budget; persisted lookups are 0.09ms),
`findExportsByToken`, and a **Layer 5** in `graph-retrieve.js` that fires **only when Layers 1–3
return nothing**. Score strictly between `GR_PATH_MATCH_STRONG` (70) and `GR_EXPORTED_SYMBOL` (100);
**never** add it to `DEF_SIGNAL_TYPES`, so it never receives `DEF_SCORE_FLOOR` (600). It is a
candidate, not a definition claim.

**Verified corrections (the shippable form is materially different from the pitch):**
- **The docs/012 guards are missing and they are the whole precision story.** As specified, Layer 5
  feeds generic non-code-shaped terms into the export lane with **neither** guard docs/012 shipped.
  Measured over 5,876 candidate rows on 624 recovered turns: **53.9% are test paths** and
  **87.6% sit below `EXPORT_INJECT_MIN_FANIN` = 5** (61.4% at fan-in 0). At 85×1.4 = 119 a test row
  survives `TEST_PENALTY` at ~89 and still beats path_match's 84 — docs/012's pathology verbatim.
  Adding the existing test-path exclusion + fan-in floor moves recovery **70.0% → 60.0% → 42.2%**
  and median candidates **8 → 5 → 1**. Ship the guarded form; it still clears the candidate's own
  ≥40% / median≤10 gate at far better precision.
- **The three named regression gates are structurally incapable of moving.** `scripts/eval-retrieve.js`
  runs `lib/retrieve.js`, which **never requires** graph-retrieve — so self-eval 21/21 and Vapor-CLI
  0.811 cannot register this change at all; and against the real Vapor graph.db Layer 5's firing
  condition is met on **0 of 15** hook cases (every query hits Layer 2 swift decls). They are
  **leak-detectors, not quality gates**, and must be re-labelled.
- **Two silent wiring gaps.** `lib/format-retrieval.js:112-126` has no `export_token` branch → the
  row renders **labelless**, the exact "strongest signal arrived unexplained" bug the `swiftDeclLabel`
  comment exists to fix. And `lib/trajectory.js:classifyDetailSource` would bucket it as `text_only`,
  so the **offline half of the field kill-gate measures nothing**. Also: `graphRetrieve` has **four**
  live consumers (hook-refresh, `lib/orient.js`, `mcp/server.js`, `lib/anti-sprawl.js`), not one —
  anti-sprawl already feeds filename stem tokens, so Layer 5 makes it fuzzy-on-fuzzy.
- **Barrel regression.** The read-only prototype puts the gold file at **rank 2 behind
  `app/__init__.py`** — re-creating the B3 def-over-barrel pathology `py-penalty-001` exists to
  catch. Route `kind === "explicit"` to `HIT_REEXPORT_CHAIN` as Layer 1 already does at
  `graph-retrieve.js:120`.
- **Window and baseline corrected.** "12 rows in 88 days" conflates the 88-day *telemetry* window
  with the **16.8-day** rolling transcript window: the true rate is ~0.8 structural rows/day, not
  0.14 — scarcity survives, magnitude was overstated ~5×. And the bar to beat is path_match at
  **3.8–4.7%** (docs/013 headline 4.7%; current corpus 12/315 = 3.8%), not the unsourced "~2.4%".
- **The `df > 12` constant encodes two different strictnesses**: p85 on somaNotes (13.8% of tokens
  over it) and p99+ on sextant (0.9%). Use a per-repo percentile.

**Kill-gate.** FAIL-pre is **real and reproducible today** on the committed `fixtures/python-eval`
through the production ladder: "where do we normalize the flag registry" → terms
`["normalize","flag","registry"]` → graph returns only `app/test_flag_rollout.py`; `searchFast`
returns **0 hits even after its Tier-2 AND fallback** (NL function words break whitespace-AND);
merged top-8 = one test file, gold `app/feature_gate.py` **absent**. Non-redundant with the shipped
NL-recall fix (which recovers `py-nl-001` but not this class). PASS-post must assert **def-over-barrel**,
not merely top-8 presence. Field kill: `path_hit{source:"export_token"}` must clear n≥30 and beat
3.8–4.7% — but note that beating a 3.8% baseline at n=30 needs ~2 opens with an interval spanning
zero. That is an **accrual floor mistaken for power**, the error docs/034 already flagged on the
holdback arm.

**Effort** M. **Risk.** SCHEMA_VERSION bump → one forced rescan per repo, which is a blackout on
the 10 repos at p95 4.8–105s. Sequence it after any scan-cost work and batch it with every other
schema change. Median-1 candidates (guarded) against `DEFAULT_MAX_FILES = 8` is safe; median-8
(unguarded) can fill the block by itself.

### 5. Zoekt daemon **identity** guard · composite 35 → 40

The original candidate was "restore the text lane." Its state half is confirmed and worse than
written; its recall half is refuted; and a third defect nobody proposed is the strongest item in it.

**Grounding.** `ensureWebserver` (`lib/zoekt.js:253`) has exactly two callers — `:548` inside
`search()` (CLI/MCP) and `commands/zoekt.js:28`. `searchFast` states at `:414` that it "Does NOT
call ensureWebserver()". Nothing on the hook path ever starts a daemon. Live fleet: **2 of 12** repos
have a correct live text lane (sextant :6070, somaNotes :6076); **7** have no `daemon.json`;
**2** have dead pids (jan25 3019390, glasshud 1153012) and HTTP 000. That is **9 dark, not 8**.

**The new finding — cross-repo index poisoning.** The 12th repo, `manus-api-mcp`, has a dead pid but
**HTTP 200** on port 6075, because that port is now owned by a different `zoekt-webserver` serving a
*different repo's* index. `searchFast`'s PID check is a deliberate soft pre-filter
(`lib/zoekt.js:433`), so it probes, gets 200, and searches a **foreign index**. Driven live:
`searchFast('/root/manus-api-mcp','manus')` returned **6 hits, every one a sextant file**
(`docs/015-handoff.md`, `test/watch.test.js`, …). `ensureWebserver` is strictly safer — it requires
the pid alive before reuse. **The fleet is dark / live / cross-wired**, and the cross-wired case
injects another repository's paths as facts. That is a direct breach of "silent absence over false
confidence," and it is cheaper to fix than anything else here.

**Verified corrections.**
- **The recall thesis is refuted by the within-repo test.** The candidate's split is between-repo and
  confounded. Splitting each repo's own empty-rate around its own `daemon.json` `startedAt`:
  sextant **50.0% → 50.6%** (starting a live daemon changed nothing), jan25 **49.0% → 68.4%**
  (worse), only glasshud improved (71.1% → 61.0%). And somaNotes — the entire "live daemon" bucket
  at 39.7% — has **1 text_only row out of 733 surfaced**, so its low empty rate does not come from
  the text lane.
- **Doctor claim half right.** `commands/doctor.js:361` prints "webserver ⚠ not running (will start
  on next search)" — true for `search()`, false for the hook — CONFIRMED. But defGen2's doctor does
  **not** currently print "no actions needed"; it has an unrelated action. The substantive claim
  survives: all 16 `actions.push` sites concern roots/state/graph/watcher/resolution/settings, none
  concern webserver liveness, and no test covers it.

**Mechanism (reshaped).** (0) Verify daemon **identity** before trusting a probe in `searchFast` —
compare the recorded pid's actual `-index` argument, or have the daemon echo its index path;
(1) call `ensureWebserver` fire-and-forget from SessionStart or the watcher, routed through the root
guard, corpus pre-check and index-size circuit breaker, never around them; (3) promote
"webserver dead/absent/foreign" to a doctor Action and emit
`retrieval.text_lane {provider:"zoekt"|"none"}`. **Drop piece (2), the rg fallback** — see Killed.

**Kill-gate.** FAIL-pre for the identity guard is deterministic and reproducible today (point a
`daemon.json` at a port owned by another repo's indexer; assert `searchFast` returns foreign paths).
FAIL-pre for the dark-lane half is real: a copy of `fixtures/python-eval` with `daemon.json` deleted
makes `eval-hook.js` self-label "graph-only" and `py-flag-001` fail. **⚠ Do not use `py-nl-001`** —
see Killed.

**Effort** S. **Risk.** Auto-starting a daemon has history here (the 101 GB home-dir incident), so
the start path must go through the existing guards. Restoring the lane on 9 repos is justified as
**correctness and observability**, not as recall — the recall payoff is unestablished and the
candidate's own field gate is likely to refute it within 30 days.

### 6. Un-dark subagent orientation · composite 41 → 37

**Grounding.** Fleet-wide `subagentstart.injected` **6** vs `subagentstart.skipped` **234** —
2.5% of 240 spawns, and all 6 injections came from **one repo** (jan25) inside a single 10-minute
window. Skip reasons: `orientation_unavailable` **202 (86.3%)**, `coherence_enabled` **34 (13.7%)**.
Both code cites are byte-exact: `commands/hook-subagentstart.js:41-47` returns unconditionally when
coherence is on; `lib/orient.js:52` is
`if (fresh.fresh === false && fresh.contentChanged === true) return null;`.
Headroom is ample: a live block measures **353 of 1,100 bytes**.

**Verified corrections (these reshape the candidate substantially):**
- **The 202 skips are not generic "active dev repo" staleness — they are one bounded-hash failure.**
  somaNotes has **316 dirty paths totalling 20.4 MiB** and open-interpreter-fork **309 paths /
  168.6 MiB**, both over `STATUS_TOTAL_MAX_BYTES` (8 MiB, `lib/freshness.js:84`). `captureStatusState`
  therefore returns `statusHash: null` (`:353`), and `checkFreshness` converts a null anchor into
  `contentChanged:true / status_changed` (`:685-687`, `:727`). **Both repos are permanently
  content-stale in a way no rescan can clear.** Contributing bug: the managed-path filter
  (`:113-115`) is root-anchored, so a **nested** sextant state dir
  (`.design-handoff/.planning/intel/zoekt/index/*.zoekt`, 4.7 MiB) is hashed into the fingerprint.
  A cheaper, philosophically uncontested upstream fix exists for the same 202 events.
- **The degrade arm as written does not un-dark the majority stale reason.** `hook-subagentstart.js:77`
  applies a second fence (`sameValidatedRepo`). For the null-status repos both sides coerce to `""`
  and it passes — but under `head_changed` the fence fails and the degraded block is dropped as
  `fingerprint_moved`. Observed live: sextant went fresh (353 B) → `head_changed` in ~20 minutes on
  a **clean tree**. head_changed is **62.8%** of sextant's stale reasons. Shipping the degrade arm
  and passing the dirty-tree kill-gate would certify a fix that is still dark for the majority case —
  the hollow-verification pattern this repo has been burned by.
- **Deleting the coherence gate is not a "straight bug fix."** `test/hook-subagentstart.test.js:120`
  asserts the silence as **intended behavior**; `hook-pretask.js` appends the same
  `buildOrientationBlock` output via `updatedInput`, so deletion risks **double** delivery
  (pretask's never-double-inject guard is anchored on the prompt and cannot see `additionalContext`);
  and `coherenceHoldbackPct: 0` parks only the overlap A/B — `coherenceEnabled` reads
  `SEXTANT_COHERENCE`/`config.coherence`, so the pretask lane is **not** dormant.
- **But the field data strengthens the coherence half beyond the original claim.** Across sextant's
  window, **34 of 34** `subagentstart.skipped` events carry `coherence_enabled`, all
  `agentType: "workflow-subagent"`, and **zero `pretask.*` events fired** — every one of the 12
  recent `coherence.report` rows is `surface:"parent_prompt"`. For workflow-spawned agents the gate
  silences the **only** lane that reaches them, with no substitute at all, and workflow-subagent is
  the dominant agentType fleet-wide (149 of 240 spawns). docs/018 pre-registered exactly this as
  deferred debt.
- **The working-set line is neither free nor precedent-covered.** `getStatusEntries`
  (`freshness.js:148`) is not exported; the exported `getCurrentStatusPaths` (`:403`) re-runs
  `git status`. And `lib/cli.js:324 buildStaleBody` — the cited main-session precedent — emits
  root/git/marker/signals/recent-commits but **not** the uncommitted working set.

**Mechanism (reshaped, in order).** (a) Fix the status-fingerprint budget and the root-anchored
managed-path filter — uncontested, upstream, and it alone converts 202 events; (b) yield the
coherence gate for spawn paths pretask demonstrably never reaches (workflow-subagent), rather than
deleting it wholesale; (c) the git-only degrade arm **last**, and only with its own fence semantics
for `head_changed`.

**Kill-gate.** **⚠ Both FAIL-pre fixtures already exist as PASSING tests**
(`test/hook-subagentstart.test.js:120` and `:186`) — this is a deliberate design reversal with
test-encoded intent, not a bug deletion, and landing it means rewriting two tests written to enforce
the current behavior. The reusable blackout-purity assertions are at `test/sync-rescan.test.js:341,418`
and `test/freshness-gate.test.js:106,145` (not in `hook-refresh-freshness.test.js`, as the candidate
cited). A **third fixture is required** — clean tree, moved HEAD — or the gate certifies a fix that
is still dark for 62.8% of stale reasons. The field gate (somaNotes 0% → >70%) is measurable but
**unattributable**: fixing the 8 MiB budget flips the same number without touching silent absence.

**Effort** M. **Risk.** The degrade arm relaxes the strictest reading of silent absence at the
surface with the **least correction channel** — a subagent sees no statusline. docs/018:108
pre-registers the injection-point gate as a SHIP BLOCKER, with the wording "no stale **structural
claims** to subagents"; the degrade arm emits none, so it arguably satisfies the letter. Contestable,
and correctly flagged rather than laundered. If a reviewer prefers strict silence at the child
surface, reject the degrade arm outright — (a) and (b) stand alone.

### 7. `clampBlock` + section-tag the static replay · composite 39 → 36

**Grounding.** `lib/summary.js:325-336` `clampChars` is a raw `s.slice(0, maxChars)` whose only
guard is a split-XML-entity backup; single call site at `:740`. On the two highest-volume fleet
repos it truncates **mid-token inside an unterminated backtick**: somaNotes ends `` - `api/__i ``
and jan25 ends ``- 2026-07-26 `todos``, both at exactly 2200 chars with an **odd backtick count
(79)**, and somaNotes loses `### Recent changes (git)` entirely. Exactly **2 of 20** fleet repos are
clamped. Meanwhile `lib/orient.js:17` already documents "sections are dropped whole (never mid-line
truncated)" — sextant ships the correct pattern on one surface and the defective one on its
highest-volume surface.

**Mechanism (S1).** Replace the tail of `clampChars` with `clampBlock`: accumulate complete lines
while under budget, stop at the last complete line, drop any now-bodyless trailing `### ` heading,
keep the entity guard for the within-line case.
**Mechanism (S4).** `lib/trajectory.js:108 parseStaticBlock` is section-blind — track the last
`^### ` header and emit `static:public_api|hotspots|entry_points|recent|structure`. Pure
instrumentation, **feasible on today's corpus** (6,237 static surfaced rows over 690 injections, so
even the smallest section clears n≥30).

**Verified corrections.**
- **The regression bound is far better than the candidate's own kill threshold (~60 chars):** the
  whole-line rule costs **10 chars** on somaNotes and **19** on jan25, **0** on the other 18 — fleet
  median 0. And the risk note is wrong in the safe direction: somaNotes **keeps** its first complete
  entry-point row.
- **"sextant is 2098/2200" is wrong** — its summary is **2030 chars (92.3%)**; 2098 is the telemetry
  *event count* from the grounding, conflated with a char count.
- **A tripwire the candidate missed:** `test/summary.test.js:301-308` clamps a single 3,000-char line
  with no newline and asserts non-empty output, so the within-line fallback is **mandatory**, not
  optional.
- **Public API sizing confirmed and it is the largest section everywhere it renders** — somaNotes 584
  (26.5% of 2200), jan25 646, sextant 585, defGen2 517, sinter 519 — at
  `MAX_API_FILES=4 × MAX_API_SYMS=6` (`lib/summary.js:642-643`).

**S2 and S3 are sent back — see Killed.**

**Kill-gate.** S1 fails **pre** on live data: fixtures already exist on disk (two clamped summaries),
and a synthetic 3,000-char section list reproduces it hermetically in the existing
`test/summary.test.js` harness. Of the three asserted properties, (a) final line byte-identical to a
source line and (b) balanced backticks both fail today; (c) no heading without a body needs a
synthetic fixture where the cut lands immediately after a heading. S4 has no gate — it is
instrumentation, and its output is the input to the allocation decision.

**Effort** S. **Risk.** S1 drops **more** bytes than truncating — correct under silent absence, but
it makes displacement pressure from Public API visible rather than hidden. That visibility is the
point; it is also the input S4 exists to adjudicate. **No eviction from the static body should ship
before S4's numbers land**, and CLAUDE.md already logs this displacement as an "accepted v1 trade,
on the post-ship metrics watchlist" — S4 is that watchlist item coming due, with numbers.

---

## Tier 3 — subtraction and cost

### 8. Context-coherence disposition · composite 35 → 30

**Grounding (all reproduced).** `/root/sextant/.codebase-intel.json` is the **only** one in all 20
fleet repos. `contextdelta.emitted`, `retrieval.region_hit`, `retrieval.region_miss` and
`retrieval.deduped` are **0 in all 20 telemetry files**, despite 36 minted claims. Phase F: **24**
`coherence.report` events, every one `snapshots:0 / agents:0 / overlapPairs:0 / outcome:"none"`;
`pretask.injected` 5, with `taskFiles: 0` on 4 of 5. Surface: **5,158 prod lines** (17.6% of 29,232)
plus ~4,800 test lines. `grep -c recordEvent mcp/server.js` = 0.

**Verified corrections — the Phase-A repair half is refuted, and the harm half is a config flip:**
- **The Phase-A FAIL-pre is a corpus artifact.** The breadcrumb shipped 2026-07-15 (`7ecfea1`) and
  **893 of 1,172 fleet rows (76%) predate it**. Splitting at that date, **post-ship structural rows
  carry a breadcrumb at 100%**: exported_symbol 6/6 symbol, reexport_chain 5/5, swift_decl 2/2,
  text_only 18/18 line. "0/64 carry symbol" is only true of rows written before the code existed.
- **The repair is near-inert for its stated purpose.** `lib/regions.js:160-171 scoreEditedRegion`
  treats line and symbol as **alternatives**; every exported_symbol row already carries a symbol, so
  adding `start_line` to the exports table cannot increase the count of scoreable rows — it only
  upgrades attribution from name-match to line-containment, bought with a SCHEMA_VERSION bump and a
  fleet-wide rescan.
- **The Python half is mispriced.** `python_ast.py` emits `start_line` only in `find_scopes` mode; the
  exports payload is flat string arrays. Not "already emits it."
- **The real blockers are elsewhere.** Post-Phase-A there were 15 region-eligible mutating path_hits,
  **7 of them breadcrumb-scoreable, and 0 region events fired**. Driving `lib/regions.js` directly
  shows it works — but `editedRegions` on a **module-scope line returns `[]`** and
  `scoreEditedRegion` returns null on empty regions, so top-level edits (very common in this CommonJS
  repo) are structurally unscoreable. And **path_match is 248/279 = 89%** of the post-ship live mix
  and can never carry a symbol by design.
- **The harm is real and bigger than claimed, and free to fix.** 34 of 34 suppressed spawns
  (§Tier 2 #6) — but `lib/coherence.js:40-54` reads the config key, so **`"coherence": false`
  restores all 34 spawns with a one-line change and zero deletion.** The candidate's best evidence
  argues for a flag flip, not a `git rm`.

**Mechanism (reshaped).** (1) Flip `coherence: false` on sextant **today** — one line, reclaims 34
spawns. (2) Decide deletion of D–F on **surface-area** grounds (5,158 prod + ~4,800 test lines, zero
field output in 88 days, zero MCP call instrumentation), not on the harm argument, and engage
docs/034's explicit "code left dormant… do not delete it" head-on — the 34/34 suppression evidence
is genuinely new information that decision did not price. (3) **Drop the `start_line` repair.**
(4) Keep Phase C on its existing e2e lock (`test/claims-hook-e2e.test.js`), not on a field rate
docs/034 already parked.

**Kill-gate.** The deletion inertness proof is manufacturable today: any of the 19 fleet repos
without a `.codebase-intel.json` takes the flags-off path, so a byte-identical stdout diff pre/post
proves the removal is inert for all of them. **⚠ The Phase-A gate as written is vacuous**: "≥70% line
coverage on structural rows" is true by construction the moment you add the field, and any
`region_hit` that appears would be evidence of arrived volume, not of the repair. The honest FAIL-pre
(7 valid breadcrumbs → 0 region rows; module-scope edits → `[]`) has **no existing fixture**.

**Effort** M. **Risk.** Shipping the repair, observing zero region events for reasons it never
touched, and then firing the candidate's own retirement trigger — foreclosing Phase G on a
**mis-attributed null**. Secondary: `lib/scope-finder.js` (707 lines, zero direct tests) sits under
both Phase A and Phase C; if A–C survive, a silent regression there degrades claims to
false-INVALIDATED with **no instrument firing**.

### 9. Wire `extractBatch` — as a CPU-cost move only · composite 36 → 26

**Grounding.** `extractBatch` (`lib/extractors/python.js:143`) has existed since `918fde8`
(2026-03-24), shipped explicitly as "callers opt in," and **no caller ever opted in**. Measured
**8.8–14.2×** across seven real repos, byte-identical output (`deepStrictEqual` PASS on
`fixtures/python-eval` and 60 real files). Python extraction is **42–94% of scan p50** — the
candidate **understated** it at 51–80% (defGen2 94%, jan25 93%, dictum 85%, somaNotes 84%). Fleet
saving ≈ **10.1 of 20.93 measured hours (~48%)**.

**Verified correction — the staleness thesis is refuted by the candidate's own gate.** Simulating
`shouldSyncRescan`'s trimmed p95 over each repo's real last-50 durations with the measured saving,
**only glasshud flips** (4,818 → 1,618–2,258). defGen2 — the candidate's named co-requirement —
lands **4,363–5,500**, still ~2× over the 2,500ms cap; dictum 5,441+, dark-roast 4,311+, jan25
12,875+, oif 30,165+, somaNotes 42,708+. That is **1 of 10** Python repos. And the completeness
critic closed it: **glasshud has been idle 12 days** (0 events in 7d, 7 in 14d), so the realized
staleness benefit on the *active* fleet is **zero**. Also: staleness is caused by HEAD moves
(head_changed 62.8% on sextant), not scan cost — scan cost only gates the *rescue* lane. And a
flipped gate may buy nothing anyway: `manus-api-mcp` already passes (`p95:680, sync:true`) yet
recorded 8 blackouts and **0 sync_rescan attempts**, consistent with the docs/034 wiring gap at
`commands/hook-refresh.js:690`.

**⚠ INERT UNTIL A FIXTURE EXISTS.** The perf gate is not expressible on any committed corpus —
`fixtures/python-eval` is 9 files ≈0.45s, and the gate names `/root/jan25`, an uncommitted external
repo, colliding with CLAUDE.md's own rule that a win claim needs a committed fixture. The correctness
gate **is** feasible and already passes.

**Effort** M (not S): `AST_CACHE_MAX = 100` blocks the cheap "pre-pass warms the cache"
implementation on any repo >100 py files, so this needs a real phase split of
`indexOneFileUnlocked`, plus the **first-ever test** of the batch-failure fallback
(`python.js:182-186`, currently untested — `python_ast.py:300-306` loops with no per-item try, so a
`RecursionError` aborts the whole chunk). **Risk.** Sell it as **~48% of fleet scan CPU and a 5–10×
faster local scan on Python repos**. Delete the staleness framing entirely.

### 10. `benefitDelta` JSON gate · composite 45 → 22 · **half shipped**

**✅ The shell half landed at `9e44cab`.** `scripts/check-holdback-benefit.sh:106` now gates on
`turnBenefitDelta` with **both** turn floors AND both open floors
(`ready = td != null && ht >= minTurns && at >= minTurns && …`), plus a stall branch and a fleet
banner, and `scripts/test-holdback-benefit.sh` locks the trap as scenario 5. The acute risk — the
16:00 cron publishing a sentinel-guarded, one-time **"BENEFIT READY … benefitDelta = −41.5pts"** off
**one** randomized holdback turn — is defused. No sentinel was ever written
(`.planning/intel/.holdback_benefit_reported` absent, confirmed).

**Residual, verified live at HEAD today:** `telemetry --json` still emits bare
`benefitDelta: -0.4141`, `turnBenefitDelta: -0.75`, `regionBenefitDelta: null`, with
**zero sibling gate keys** (`Object.keys` matching `/deltaAtVolume|spansZero|atVolume|dormant|Gate/`
= `[]`), while the human surface on the identical bytes prints DORMANT twice. The gate now exists in
**three independent re-implementations** and has already diverged once; the only thing binding a
consumer to it is prose.

**Verified corrections.** The candidate **missed `regionBenefitDelta`**, a third ungated causal
field with the identical defect. The provenance was also wrong: no cron run ever met the floor —
all 20 holdback hits landed in a **90-minute window** generated by the review session's own file
reads, flipping +7.3 → −41.5 in that window. That is a **stronger** indictment of the opens-only
gate than "six days of instability."

**Mechanism.** Additive, not replacing: keep the numeric field (four assertions in
`test/hook-holdback.test.js` and the cron's own `td * 100` depend on it) and add
`benefitDeltaGate: {deltaAtVolume, armedTurns, holdbackTurns, ci, spansZero}`. Then
`test/telemetry-json-contract.test.js` asserts every key matching `/[Bb]enefitDelta/` carries a
sibling gate flag — the generalizable guard, covering `regionBenefitDelta`.

**✅ SHIPPED 2026-07-27 (step 0 of the sequencing below).** All three deltas now carry a sibling
`*BenefitDeltaGate` `{atVolume, status, armed/holdback counts, minScored, minTurns, ci, spansZero}`.
The gate is computed **once** in `summarize()` (`openDeltaGate` / `turnDeltaGate`) and BOTH human
renderers now read it instead of re-deriving — without that half the fix would merely have added a
*fourth* re-implementation. `status` is `NO_ARM | DORMANT | SPANS_ZERO | AT_VOLUME`. The per-OPEN
gate deliberately carries `ci: null`: within-turn opens are correlated at ~28/turn, so a binomial
interval over opens would understate its own width — the analysis-unit error the gate exists to
prevent — and the interval lives on the turn gate, where the observation unit is the randomization
unit. `test/telemetry-json-contract.test.js` (5 cases) is reflective and mutation-checked: dropping
the region gate fails 2 of 5, and relaxing the gate to opens-only — the exact cron defect — fails 1.

**Kill-gate.** FAIL-pre needs no fixture: the JSON above. **Effort** XS. **Risk.** Nothing here is
evidence that injection hurts; the honest statement is that the holdback arm has **1 scored turn
fleet-wide**.

---

## What no lens looked at (completeness critic)

Every lens examined the same surface — the Claude Code **push** channel. The two surfaces outside it
are both broken.

**The load-bearing shared assumption, and its cheapest test.** All eight candidates assume
*"retrieval is the lane worth improving, and permutation-null lift is the metric that says so."*
The cheapest test **already ran, free, on existing data**: one `eval-trajectory --json` invocation
returns both lanes, and they rank oppositely (coverage 12.1% vs 3.1% favours static by 3.9×;
lift 1.13 vs 1.77 favours retrieval by 1.6×; absolute credited opens 757 vs 52). **Name the
assumption in any plan that spends on either lane, and adjudicate it with S4's section tagging
before evicting anything from the static body.** If absolute opens matter, the plan is misallocated;
if incremental lift matters, say so and stop citing static's 1.13× as a weakness while ignoring that
it produces 14.6× more opens.

- **Non-git roots** — promoted to ranked #2 above (permanent blackout + `.env` in the corpus).
- **The MCP pull channel** — promoted to ranked #3 above.
- **Cross-editor parity was examined by nobody.** 7 fleet repos carry `.codex/hooks.json` + AGENTS.md;
  `~/.codex/config.toml` holds trust entries for **only 4** (glasshud, jan25,
  open-interpreter-fork, somaNotes) — so amoSportsCenter, manus-api-mcp and sinter are **silently
  dark** for the untrusted-hook reason CLAUDE.md itself documents. `[mcp_servers.sextant]`
  pre-approves **5 of 9** tools. There is **no doctor check** for any of it: no trust check, no
  hooks.json presence check, no AGENTS.md drift check. Cheap fix: a doctor Action comparing
  `hooks.state` against the repo's `.codex/hooks.json` and emitting `⚠ run: codex …` — the same
  loud-drift contract the statusline already owes the Claude path (009 #5).
- **There is no distribution or upgrade mechanism.** `which sextant` resolves through the npm global
  symlink to **`/root/sextant/bin/intel.js` — the live working tree**, so all 20 repos execute
  uncommitted code. `package.json` is `1.0.0, private` with no publish config; `commands/update.js`
  re-indexes a single file and is not an updater; there is no `--version`. Two consequences: a
  half-saved edit is instantly live on 20 repos (the generalized form of the cron finding), and any
  SCHEMA_VERSION/SCANNER_VERSION bump invalidates all 20 the instant the file is saved, not on a
  deliberate release. **A minimal `sextant --version` + a packaged install path is a prerequisite for
  treating the fleet as a controlled experiment population.**
- **Hook wiring is lazily deployed.** SubagentStart is wired on **11 of 20** repos, PostToolUse on
  **16 of 20**; pointclick has no SessionStart at all. Self-deploy works — every repo with July
  activity has SubagentStart, and all 9 without it last logged telemetry in May/June — but strictly
  on next session. So "sextant init installs it in every repo" is false as a statement about the
  fleet, and any new telemetry field's pooled denominator is really the 16 PostToolUse repos,
  accruing from zero per repo on a rolling basis.
- **The active fleet is 9 repos, not 12–20, and one is 69% of it.** Repos with ≥1 event in the last
  7 days: 9. Last 14 days: 11 repos / 10,280 events, of which **somaNotes is 7,092 = 69.0%**.
  Dormant: glasshud 12.0d, infograph 7.6d, tradingDesk 47.2d, manus-api-mcp 77.4d, cairn 86.0d.
  **Divide every named horizon by this**: the "12 days to the holdback accrual floor," the "60 days
  to n≥30 export_token rows," the "295 days pooled."
- **Blast-radius delivery VERIFIED, and each note is re-transmitted ~2.4×.** Every lens took the
  `additionalContext` channel on faith from docs/016 R1. Checked directly: **27 transcript files,
  221 occurrences** of real note content. Against 91 `blastradius.injected` events that is **~2.4×
  re-appearance** as the note persists across turns — the concrete price of the external lens's
  prompt-cache concern, and the number any "blast radius is cheap" argument must carry
  (arXiv:2607.12161: cache creation+reads ≈ **87% of reconstructed cost** across 2,848 runs).
- **Git worktrees work but fragment every per-repo artifact.** A linked worktree passes
  `root-guard.checkRoot(strict)` and `checkFreshness` cleanly, but gets its **own** `.planning/intel`
  — separate graph.db, zoekt shards, telemetry, injected-set, and **arm draws**. The environment
  ships `EnterWorktree`/`ExitWorktree` tooling, so this is an active workflow. **The dominance guard
  in #1 must key on repository identity (git common-dir), not root path.**
- **State hygiene does not match the docs.** `/root/open-interpreter-fork` **tracks**
  `.planning/intel/graph.db` and `.planning/intel/summary.md` in git (a 1.1 MB binary rewritten on
  every scan, plus a stale structural claim living in the repo), and `git check-ignore` fails there.
  `sextant init` writes no `.gitignore` entry. Separately, **8 of 18** fleet telemetry files are
  mode **644** despite `lib/telemetry.js:102` appending with `{mode: 0o600}` — the mode is applied at
  create/rotate but never repaired on pre-existing files.
- **Scale is unobserved above ~1,800 files, and both known cliffs fail toward permanent staleness.**
  `lib/graph.js:498` is `db.export()` — sql.js has no incremental write, so every flush rewrites the
  whole file. somaNotes is 6.37 MB at 1,757 files (≈3.6 KB/file); a 10k-file monorepo extrapolates to
  a **~36 MB whole-file rewrite per debounced flush**, held in memory. The second cliff is the 8 MiB
  status-fingerprint budget that already permanently disables two repos (§Tier 2 #6). Any candidate
  premised on "fix scan cost and staleness improves" must carry this.
- **Multi-language coverage is a closed non-gap.** 95–100% of tracked code in every fleet repo is
  already supported (`{js,jsx,ts,tsx,mjs,cjs,py,swift}`); the measured ceiling for new-extractor work
  is **~2% of fleet code**. Zero Rust/Ruby/C#/PHP/Elixir anywhere. **Do not re-propose a Go or Rust
  extractor.** The flip side is a caveat on this entire document: **every number here is drawn from a
  JS/TS/Python-only population**, and the one repo with real polyglot content (glasshud, 17.7% Java)
  is also the dormant one.

---

## Killed / downgraded (the kills are as useful as the picks)

- **python-batch's staleness thesis — KILLED.** The candidate's own refutation condition fired:
  only glasshud crosses the 2,500ms gate after the saving, defGen2 lands 4,363–5,500, and glasshud
  has been idle 12 days. Keep the CPU-cost claim (~48% of fleet scan CPU); delete the staleness
  framing.
- **rg fallback inside `searchFast` — DEFERRED, three independent blockers.** (a) `lib/rg.js`
  `collectHits` sets `score: null` and `merge-results.js:238` does `zh.score || 1`, so every rg hit
  lands at **1** against zoekt's ~500 base and the 600 def floor — injected but sorted to the bottom.
  (b) `rg.js:205` pushes `"--", q, "."` so paths carry a `./` prefix, and the hook path lacks the
  normalizer `lib/retrieve.js:18` documents for exactly this — those paths get persisted into
  `.last_injected_paths.retrieval.*`, where the PostToolUse scorer normalizes to repo-relative, so
  **every rg-surfaced row would score `path_miss`**, silently corrupting open-precision. That is the
  lying-instrument class docs/033 spent an arc repairing. (c) rg defaults to literal `-F` with no
  AND/OR tiers: `rg.search('/root/somaNotes','handleSubmit onChange')` returned **0 hits in 122ms**,
  the exact NL-scatter pathology zoekt Tier-2 exists to fix.
- **`py-nl-001` as an rg PASS-post gate — KILLED, the fixture is self-contaminated.**
  `fixtures/python-eval/app/notifications.py:7` contains the literal query string
  *"clinician reminder escalation acknowledged"* inside the docstring that asserts the tokens
  "appear SCATTERED… never as an adjacent phrase" (both added in `be8eefe`). Verified against the
  fixture's own index: the plain **phrase** query already matches it, so the AND-fallback the guard
  claims to protect is not exercised, and rg-literal also finds it. **⚠ INERT UNTIL THE FIXTURE IS
  REPAIRED.** Use `py-flag-001` instead.
- **The Phase-A `start_line` repair — KILLED as diagnosed.** Post-`7ecfea1` structural breadcrumbs
  are at **100%**; the "0/64 carry symbol" FAIL-pre only exists if you pool 893 rows written before
  the code shipped. `scoreEditedRegion` treats line and symbol as alternatives, so the repair cannot
  increase the scoreable set. The real gaps are path_match's 89% share and module-scope edits
  resolving to `[]`.
- **The blackout-body diet (S3) — SENT BACK, its derivability rationale fails on its own largest
  target.** `### Recent changes (git)` is **46.5% of all blackout bytes** and renders changed **file
  paths** from `git log --name-only`, whereas the host env block's "Recent commits" gives hash +
  subject only. Those are different facts, and the file paths are the openable ones — the candidate's
  own risk note ("the section most correlated with what the agent opens next") contradicts its
  premise. It would also reverse four positive assertions in a describe block literally named
  **"buildStaleBody invariants"** (`test/freshness-gate.test.js:174-210`), and delete `### Signals`,
  the only stale-turn surface for Commands/Required-env provenance. **⚠ Its behavioural half is
  INERT on the existing corpus** (transcripts are historical; ~4 weeks of new sessions needed).
- **"The one fact the host cannot derive" (S2) — DOWNGRADED.** The Claude Code env block carries a
  `gitStatus` section that renders `git status` output. The defensible residual is **freshness, not
  existence** — the host block is explicitly "a snapshot in time [that] will not update during the
  conversation," while a blackout is by definition a mid-session tree move. But it renders **nothing**
  on the 47.8% plurality of blackouts that are `head_changed` on a clean tree. The mechanical premise
  is correct and cheap (`captureCurrentStateDetailed` already computes `statusPaths` and drops the
  field at the return), so keep it as a small follow-on, not a headline.
- **Blanket `git rm` of D–F on harm grounds — DOWNGRADED.** The harm (34 silenced spawns) is fixed
  completely by a one-line `"coherence": false`. Deletion needs its own surface-area argument and
  must engage docs/034's explicit "code left dormant… do not delete it" head-on.
- **Self-eval / Vapor as regression gates for the NL bridge — RECLASSIFIED.** `lib/retrieve.js` never
  requires graph-retrieve, and Layer 5 fires on **0 of 15** Vapor hook cases. They are leak-detectors,
  not quality gates, and must not be presented as the hard gate.
- **Multi-root pooling as "the holdback unlock" — REFUTED again.** Pooling shipped at `548e7eb`; the
  arms are pathological (holdback **100% sextant**, 41 opens). Detecting a 2× lift at the observed
  14.8% fleet turn hit-rate needs **712 turns/arm ≈ 295 days pooled**; 1.5× needs 1,762/arm. Pool for
  **visibility**, never sell it as making the A/B reachable. Keep `eval-trajectory` as the primary
  benefit proof, as docs/034 concluded.
- **New-language extractors — CLOSED as a non-gap** (see §Gaps; ceiling ~2% of fleet code).
- **The co-change half of the blast-radius note — the docs/024 kill-gate RESOLVES AS KEEP.** docs/024
  queued "at ~50 notes consider dropping the co-change half" on 0/24 opened. Today:
  43 notes, 52 co-change surfaced, **10 hits** (`pathHitsBySource: {dependent 40, cochange 10,
  sprawl_match 8}`). Do not re-propose dropping it.

---

## Ledger corrections (cheap, and they mislead a downstream agent today)

- **CLAUDE.md:309/350 and README:381/389 publish stale eval numbers.** Harness on HEAD:
  `meanMRR 0.9042 / meanNDCG 0.9092 / graphLiftNDCG 0.01518`, 21/21. The docs say
  `0.900 / 0.920 / +0.012` — a downstream agent comparing a change against 0.920 reads a **phantom
  regression of −0.011**. docs/033 and docs/034 already carry the correct values.
- **CLAUDE.md overclaims the sync rescan's reach.** ~~`:124` says the gate runs "At every injection
  point (SessionStart, **UserPromptSubmit**, summary, inject)" and `:127` describes the sync arm as
  part of it — but `commands/hook-refresh.js:690` calls bare `checkFreshness` and `:738` takes only
  the async arm; `syncRescan` exists solely at `lib/cli.js:161-167`.~~ The same bullet then says at
  `:149` that the dataset feeds the "**future** Option-5 decision" 22 lines after saying it shipped;
  and `:148` re-asserts `benefitDelta` "= the causal lift" nine lines after `:139` demotes it to
  "SPANS ZERO, directional only." ~~Three~~ **Two** overclaims in the honesty area the project is
  strictest about.

  **✅ RESOLVED IN PART, 2026-07-27 (concurrent with this research).** `9a55d8f` shipped
  `commands/hook-refresh.js:trySyncRescue`, routing the sync arm into the retrieval lane and
  re-running graph retrieval on a rescue (the pre-rescan graph would otherwise assert stale
  structure under a fresh verdict), and rewrote `:127` to document both lanes. So `:124` is now
  **true as written** and the reach overclaim is gone. The two remaining overclaims — `:149`
  "future" and `:148` "the causal lift" — were fixed in this session's step-0 pass; `:148`'s fix is
  the prose half of #10's JSON gate. This entry is preserved rather than deleted because the
  *pattern* is the finding: the honesty area accumulates overclaims fastest, because a lane ships
  and its prose does not move with it.
- **`todos.md` is ~6 weeks stale** — it lists the shipped co-change lane as open, states a 20%
  holdback against the actual 50, and names `docs/015-handoff.md` as current (19 handoffs later).
  Either refresh it against this doc or demote it explicitly in favour of docs/034 + this one.
- **`docs/ideas/002` (dead-code confidence), `003` (rejected-approaches log) and `004`
  (runtime-profile) were dropped from the 2026-06 rankings with no kill verdict and no
  cross-reference** — a downstream agent will re-propose them as fresh. Suggested verdicts to write
  into the ledger: 001 → subsumed by 009 #11 (open); 005 → superseded by co-change (shipped,
  validated); 004 → ~60% shipped as self-telemetry, remainder (hook latency, zoekt latency,
  watcher-flush frequency — no `recordEvent` for any) is a cheap real gap; 002 and 003 → never
  adjudicated, and 003 needs a fresh kill-gate pass.

---

## Recommended sequencing

0. ~~**Free, today.** Flip `"coherence": false` on sextant (one line, reclaims 34 workflow-subagent
   spawns). Land the `benefitDeltaGate` JSON contract + the contract test covering
   `regionBenefitDelta` (#10 residual). Fix the CLAUDE.md/README eval numbers and the three
   sync-rescan overclaims.~~ **✅ DONE 2026-07-27.** Coherence flipped; the gate ships next to all
   three deltas with the renderers reading it; eval numbers corrected at **four** sites (a fourth,
   `CLAUDE.md:352`, was missed by the research pass); two of the three sync-rescan overclaims fixed
   and the third resolved independently by `9a55d8f`.
1. ~~**Honesty defects with a 30-second FAIL-pre.** Non-git root: `gitAvailable` branch + gitignore
   filter on the non-git zoekt corpus (#2). Zoekt daemon **identity** guard + doctor action (#5).
   `clampBlock` (#7 S1). None of these need accrual, a fixture, or a schema bump.~~
   **✅ DONE 2026-07-27.** All four FAIL-pres were reproduced by DRIVING them first, and all four
   are locked by `test/honesty-gaps.test.js` (18 cases). Findings that revised the doc:
   - **The corpus cannot be filtered at build time.** `zoekt-index` has no file-level exclusion —
     only `-ignore_dirs`, which cannot name a file. The doc's "gitignore filter on the corpus" is
     not implementable as written. Enforcement moved to `normalize()`, the single choke point every
     search result crosses, which is *stronger*: it also protects shards built by an older sextant
     and covers git roots (a committed `.env` is a common accident).
   - **The leak is worse than "the shard contains it."** `zoekt.search` returned the whole line —
     `STRIPE_WEBHOOK_TOKEN=sk_live_…` — at score 501, with the DB password in the `after` context.
   - **`.env.example` must be KEPT.** It is the declared-manifest signal (required env keys); the
     denylist exempts the `example|sample|template|dist|defaults` family explicitly.
   - **The doctor action had to be hoisted.** All 16 existing `actions.push` sites are above the
     line where the Actions block is rendered into `lines`; an action pushed in the zoekt section
     never appears. That ordering is why the dead-daemon condition went unnoticed.
   - **One pre-existing test encoded the old lie.** `test/intel-scan.test.js:184` asserted
     `reason === "head_changed"` for a non-git root. Its stated invariant (non-git scans usable,
     structural freshness fail-closed) is unchanged and still asserted; only the fabricated label
     moved to `git_absent`, plus `rescanUseless`.
   - **Deferred, deliberately:** starting the daemon from SessionStart/the watcher (#5 mechanism 1).
     That is a behaviour expansion with the 101 GB home-dir incident in its history and needs to be
     routed through the root guard, corpus pre-check and circuit breaker in its own change. The
     9 dark repos stay dark; they are now *loud* about it instead.
2. ~~**Legibility (#1).** `source` on `path_miss`, the `empty_fallback` payload, `sid` + contamination
   flag, the dominance guard **keyed on git common-dir**, `turn_outcome` with `blockBytes`. Expect
   the pooled surface to print nothing for a long time; that is the correct output.~~
   **✅ DONE 2026-07-27.** All four exits emit `retrieval.turn_outcome`
   (delivered / deduped / holdback / empty), verified by driving the hook. Two corrections:
   - **`source` on `path_miss` was DROPPED as inert.** A miss is by construction an open of a file
     that was NOT surfaced — `classifyOpen` returns `{hit:false, source:null}` — so the field could
     only ever be null and no rate follows from it. The denominator has to come from the injection
     side, and now does: **`surfacedBySource`** on the funnel row, a deliberately distinct field
     (the verifier's correction was right — `injectedBySource` is `{graph_merged, text_only}` while
     `path_hit.source` is `{path_match, exported_symbol, …}`, colliding on `text_only`).
   - **The first live read printed `268.8% opened`** — all-time hits over a since-ship denominator.
     Numerator and denominator now cover the same turns (`hitsBySourceScoped`, joined on turn id),
     and the report labels the scope. A rate that can exceed 1 is the exact lying-instrument class
     this arc exists to kill; it was caught by *rendering* it, not by reading the code.

   **Enrollment, 2026-07-27:** the holdback arm is on at 50% on **6 repos** — sextant, jan25,
   somaNotes, glasshud, defGen2 (enabled earlier the same day) and open-interpreter-fork (added
   after the step-4 fix un-darkened it; 1,143 events, 6th by volume). dictum/sinter were
   deliberately NOT added: pooling is UNSTRATIFIED, so heterogeneous low-volume repos add confound
   without materially raising the accrual rate. Source of truth is
   `~/.claude/sextant-fleet-roots`. **The confound is a TIME problem, not a config problem** — the
   armed turns in the pool are historical while holdback turns only exist where the flag has had
   time to fire, so TVD falls as the other five accrue (measured 0.79 -> 0.625 within the hour, as
   jan25 produced its first holdback turns). Do not read the delta until it clears 0.5, and note
   that clearing the guard is necessary, not sufficient: at the observed fleet turn hit-rate,
   detecting a 2x lift still needs ~712 turns/arm.

   The dominance guard measures **total variation distance** between the two arms' repo
   distributions (≥0.5 → refuse), keyed on **git common-dir** so a linked worktree is not counted
   as a separate repo. On the live 5-root pool it reads **tvd 0.79 → CONFOUNDED**: holdback is
   100% sextant (2 turns), armed is spread over 4 repos with somaNotes dominant (17 of 29). Both
   gates now report `CONFOUNDED`, and the report says the contrast would be *between repos*, not
   between arms — **more data does not fix it**, only enabling the arm on the same repos does.
3. ~~**Adjudicate the allocation question** with S4 section tagging (#7 S4) — free, existing corpus,
   6,237 rows. **No eviction from the static body and no further retrieval investment ships before
   this lands.**~~ **✅ DONE 2026-07-27 — ADJUDICATED. See below.**
4. ~~**Un-dark, upstream first (#6).** Status-fingerprint budget + root-anchored managed-path filter
   (converts 202 events, uncontested). Then the coherence yield for workflow-subagent spawns. The
   git-only degrade arm last, and only with a `head_changed` fixture.~~
   **✅ (a) AND (b) DONE 2026-07-27. (c) DEFERRED — see below.**

   **(a) The upstream fix, proven end-to-end on a real repo.** Re-measured with the real status
   path list (expanding untracked directories — a naive `git status --porcelain` probe undercounts
   by ~200×, which is worth knowing before anyone re-measures this): somaNotes **316 paths /
   20.4 MiB**, open-interpreter-fork **309 paths / 392.9 MiB** (dominated by 50–58 MiB pytest
   artifacts). Both fixes were necessary and neither was sufficient alone — nested `.planning/` is
   5.0 MiB of somaNotes' 20.4, so excluding it still leaves 15.4 MiB over the 8 MiB cap.
   - Managed-path exclusion now matches `/.planning/` and `/.claude/` at **any depth**. The doc's
     4.7 MiB `.design-handoff/.planning/intel/zoekt/index/*.zoekt` is confirmed exactly.
   - The budget bail-out **degrades instead of nulling**: an over-budget file is fingerprinted by
     size+mtime+inode (`bytes: 0`, so it doesn't consume the content budget the later files need),
     and the count is reported as `degradedFiles` rather than implied. The no-read invariant the
     original guard owned is preserved and now asserted directly.
   - **Result:** `open-interpreter-fork` went `statusHash: null` → a real anchor, and from
     permanently `status_changed` → **`fresh: true`** once state was recorded. Driving the hook
     there then produced `subagentstart.injected` **521 bytes** with real hotspots, where the
     previous row was `skipped {orientation_unavailable}`.
   - **Landmine hit and corrected in-flight:** recording scan state without rescanning made that
     repo assert fresh against a stale graph — a false-fresh I introduced. Fixed by running a real
     scan (19s, 350 files). Do not use `recordScanState` as a shortcut to "clear" staleness.

   **(b) The coherence gate now yields for spawn paths pretask cannot reach.** 34 of 34
   `coherence_enabled` skips carried `agentType: "workflow-subagent"` with **zero** `pretask.*`
   events — the gate removed the only delivery and substituted nothing. Narrow set
   (`PRETASK_UNREACHABLE`), not a deletion, so the experiment's delivery contract holds everywhere
   pretask does fire and a coherence repo cannot receive two orientation blocks.

   **(c) The git-only degrade arm stays DEFERRED**, and (a) is the reason. The 202-event class it
   was aimed at is now fixed upstream without relaxing silent absence at all, so the degrade arm
   would be spending the project's strictest invariant on a much smaller residual. Re-derive the
   residual from telemetry before reconsidering it.
5. ~~**Gated on (3): the NL bridge (#4)** in its guarded form (test-path exclusion + fan-in≥5, barrel
   routing, formatter + `classifyDetailSource` branches, per-repo df percentile). Batch its
   SCHEMA_VERSION bump with every other pending one.~~ **✅ DONE 2026-07-27, with one guard replaced
   on evidence.**

   **The fan-in floor had to go, and the fixture is why.** The verifier's recommendation was to
   reuse both docs/012 guards — test-path exclusion AND `EXPORT_INJECT_MIN_FANIN` (5). The
   test-path exclusion is kept. The fan-in floor would have **broken this candidate's own
   kill-gate**: the committed fixture's gold file `app/feature_gate.py` has **fan-in 4**, so the
   floor excludes the very file the FAIL-pre exists to recover. Fan-in asks "is this file
   important"; a lexical lane needs "is this token discriminating", and **document frequency**
   answers that directly.
   - df cap is a **per-repo p95 with a floor of 3**, not the proposed constant `df > 12`. Measured
     p95: fixture **3**, sextant **5**, jan25 **15**, somaNotes **27** — so 12 is p99 on one repo
     and ~p85 on another, i.e. two strictnesses wearing one number (the verifier's own point,
     confirmed with numbers). p95 excludes the real offenders everywhere measured (`default` df=82
     on sextant, `test` df=666 on somaNotes, `test` df=159 on jan25) while keeping the fixture's
     `registry` at df=3.

   **FAIL-pre → PASS-post, driven on the committed fixture.** Before: the graph lane returned ONLY
   `app/test_flag_rollout.py` (a test file, path_match 60), `searchFast` returned 0 hits even after
   its Tier-2 AND fallback, gold absent from every layer. After: `app/feature_gate.py` at **rank 1**
   (`export_token`, 87.74), barrel `app/__init__.py` below it at 80 via `reexport_chain` (no B3
   pathology), and `app/test_feature_gate.py` — which genuinely matches the token — dropped by the
   test guard.

   **Regression gates byte-identical**, as predicted: self-eval 21/21 (0.904/0.909/+0.015), hook
   eval 21/21, Vapor **delta +0.0000** both paths. That is the leak-detector working — Layer 5
   fires only when Layers 1–3 are empty.

   **Both silent wiring gaps closed**: `format-retrieval.js` renders `export name contains: <terms>`
   (deliberately not "exports X" — the match is on a word INSIDE the name), and
   `trajectory.js:classifyDetailSource` maps it, so the offline half of the field gate measures
   something.

   **Mutation-checked, and it corrected the doc.** Three mutations each fail a case in
   `test/export-token-bridge.test.js`: removing barrel routing, removing the test-path exclusion,
   and firing Layer 5 unconditionally. **The eval case does NOT guard barrel routing** — with that
   routing removed it still passes 8/8, because the merge layer keeps the def ahead on this corpus.
   The first draft of its `notes` claimed otherwise; corrected. Two of my own test bugs were caught
   the same way: the leak assertion was vacuous until the fixture used a case-distinctive name that
   actually clears Layer 1's docs/012 gate, and a filename that cannot be reached by Layer 4
   path-match.
6. **Subtraction.** ~~MCP `recordEvent` → 30 days → `defer_loading` → cut (#3). D–F disposition on
   surface-area grounds (#8). `swift_relations` (92 rows fleet-wide, zero production row-level
   readers — keep `swift_declarations` and the health counter, drop ~350 lines of the most
   parser-fragile code). Measure `reexports` (19 rows, one repo) on the next three onboarded repos
   before cutting it.~~ **PARTIALLY DONE 2026-07-27. Two claims REFUTED by fleet measurement;
   nothing was deleted.**

   **✅ MCP instrumented.** `mcp.invoked {tool, ok, durationMs}` on every handler via the single
   `tools/call` dispatch, plus `tool: "(tools/list)"` with the tool count — the definition-LOAD
   denominator, which is the number the cut/defer decision actually turns on and which call counts
   alone cannot supply. Verified by driving the server. **Root-resolution trap avoided:** the server
   resolves its repo from `process.cwd()` and `_root` is set *inside* each handler, so it is null at
   dispatch time; recording blind would write another repo's jsonl, or CREATE `.planning/intel` in
   an arbitrary directory — the 101 GB self-bootstrap failure. It writes only when the state dir
   already exists. **Do not cut before the 30 days of data this now collects.**

   **✅ A latent honesty defect found while checking the cut's blast radius.** `lib/orient.js:139`
   *hardcoded* `"This repo's MCP server exposes: sextant_search, sextant_explain, sextant_related,
   sextant_health."` as a string literal — naming **4 of the 9** registered tools, so the injected
   "fact" was already incomplete, and deferring or removing any tool would have made it false. Now
   derived from `mcp/server.js:TOOL_NAMES` and filtered against what is really registered, so a
   rename cannot leave a phantom behind. This is the exact confidently-stale assertion the project
   exists to prevent, sitting inside the orientation block itself.

   **❌ REFUTED — `reexports` is not "19 rows, one repo".** Measured fleet-wide: **348 rows across
   4 repos** (`.claude` 261, DwoodAmo 67, somaNotes 19, dark-roast-theme 1). The doc's figure was
   somaNotes alone. The "measure before cutting" item is therefore **answered: KEEP.** It is
   populated, and it backs Layer 3 plus the def-over-barrel guards.

   **❌ REFUTED as framed — `swift_relations` is 128 rows across 3 repos**, not 92, alongside 887
   `swift_declarations` (dictum 74/495, dark-roast-theme 36/248, somaNotes 18/144). Confirmed:
   `findRelationsByTarget` has **zero production callers** (only `test/graph-swift.test.js`), and
   extraction IS separable (`extractDeclarations` and `extractRelations` are distinct functions
   called separately in `intel.js`), so the proposed split is architecturally clean. **But deleting
   it is not the best available subtraction.** `docs/ideas/009 #8` rates *consuming* it composite 42
   as the cheap pathfinder that validates the relation-altitude pattern BEFORE the expensive
   symbol-level blast radius — and its failure would be the kill signal for that whole trilogy.
   Deleting ~350 working lines forecloses that, to save a carrying cost that is a dormant table
   rather than hot-path work, on a fleet that does contain Swift. Also note the Swift health counter
   reads the table for its direct/heuristic confidence split. **Recommendation: keep; wire the 009
   #8 consumer or leave dormant. Do not delete.**

   **⏸ Phases D–F: NOT decided here.** docs/034 explicitly ruled "code left dormant… do not delete
   it" and proved Phase C fires via `test/claims-hook-e2e.test.js`. Step 0 already removed the only
   measured HARM (34 silenced spawns) with a one-line flag flip, so the remaining case is
   surface-area alone — a scope judgement that belongs to the maintainer, not to an agent
   overriding a prior explicit decision.
7. **Cost, unhurried.** `extractBatch` (#9) as a CPU move, after a committed perf fixture exists and
   after the first-ever test of its failure fallback.

Deliberately **not** sequenced: the rg fallback (#11), the Phase-A `start_line` repair, and any new
injected fact class.

---

## THE ALLOCATION QUESTION — ADJUDICATED (2026-07-27)

Section tagging shipped (`lib/trajectory.js:parseStaticBlock` + a per-section split that had been
gated to `mode === "retrieval"`, which was the other half of the blindness). Run over 152 sessions
across 11 repos, 6,946 observed file-opens:

| static section | coverage | opened/surfaced |
|---|---|---|
| `recent` | **16.3%** | 507/3,103 |
| `public_api` | 11.7% | 119/1,014 |
| `hotspots` | 11.2% | 171/1,525 |
| `entry_points` | **2.0%** | 17/846 |

**The headline result: `entry_points` performs BELOW the permutation null.** The static lane's null
is **11.31%** — that is the coverage a *random plausible same-repo file set* earns. `entry_points`
reads **2.0% on n=846**. The row sextant specifically labels "Likely entry points" is opened roughly
**5.6× less often than a random file from the same repo**. It is not weak signal; on this corpus it
is anti-signal, and it is spending bytes in the highest-volume injection surface to do it.
(Caveat, stated because it matters: the null is computed per-lane, not per-section, so this is a
comparison against the aggregate static null rather than an entry-points-specific one. The gap is
large enough — 5.6× — that a per-section null is unlikely to reverse it, but it would sharpen it.)

**The `recent` result cuts the other way and settles S3.** Recent changes is both the largest
section (3,103 surfaced rows) and the highest-earning (16.3%). docs/035 already sent S3 (cut the
blackout body's derivable bytes) back on derivability grounds; the rate now says the same thing
quantitatively. **Do not cut `recent`.**

**But the lift caveat governs all of it.** Static coverage is 12.54% against an 11.31% null —
**lift 1.11×**, essentially chance. Retrieval is 3.10% against a 1.81% null — **lift 1.71×**. So the
static body's 4× raw-coverage advantage is *mostly the recency correlation trap*: `recent` lists the
files the agent is already working on, so it predicts opens it did not cause. That is the honest
resolution of "the two metrics rank the lanes oppositely" — **they are measuring different things,
and both are right**: static covers more opens, retrieval causes more of the ones it covers.

**⚠ CORRECTED 2026-07-27 — the aggregate was hiding two opposite signals.** Splitting
`entry_points` by the tag each row already carries (`— declared` vs `(heuristic)`), same corpus:

| bucket | coverage | n |
|---|---|---|
| `entry_points_declared` | **21.1%** | 16/76 |
| `entry_points_heuristic` | **0.1%** | 1/749 |

The declared rows are the **highest-earning section in the entire summary** — above `recent` at
16.6%. The 2.0% aggregate was a blend of the best and the worst signal sextant produces, so
**evicting the section wholesale, as recommended immediately below, would have deleted its
strongest rows.** Shipped instead: the filename-heuristic tier is no longer rendered; manifest
`— declared` and Swift `— @main` rows (both things the AUTHOR wrote down) stay. `isEntryPoint()`
is untouched elsewhere — it keeps its +10% scoring signal and its test-path gating; only the CLAIM
is withdrawn. Effect: somaNotes 2197 → 2148 chars (now under the clamp, so nothing truncates and
the freed bytes go to `recent`); somaNotes/jan25/defGen2 render no entry-points section at all,
which is correct under silent absence — they have neither a manifest entry nor `@main`.

**Consequences for the plan:**
1. **`entry_points` is the eviction candidate**, not `recent` and not `public_api`. It is the only
   section that is decision-grade (n=846), well below the null, and its byte cost buys nothing.
2. **Raw coverage may no longer be cited for the static lane without its lift.** A 1.11× lift means
   most of that 12.54% would have happened anyway.
3. **Retrieval investment is NOT refuted** — it is the only lane with a real lift. What is refuted is
   the framing that its 6.4% share of credited opens makes it the minor lane; those are the opens it
   actually steered.
4. The instrument is permanent, so any future eviction has a before/after.

## Honest uncertainty

**The deepest uncertainty is that the project's two headline metrics disagree about which lane
matters, and the disagreement has never been adjudicated.** Coverage says the static summary; lift
says retrieval. Only lift has ever been cited. Everything ranked here that touches either lane is
conditional on that adjudication, which is why S4 sits at step 3 and costs nothing.

**Second: every turn-level instrument is at n ≈ 0.** 29 distinct scored turns fleet-wide.
`retrieval.deduped` = 0 rows. `gate:"version_only"` = 0 firings. 1 scored holdback turn. Fresh
structural retrieval rows: 13, one opened, accruing at ~0.8/day. Anything computed off
`turnHitRate`, `turnBenefitDelta`, the `gate` label, or per-source structural rates should be treated
as unobserved for at least another month. **Judge the docs/033 Tier-3 work by whether it FIRES, not
by what it says** — the instruments are correct; they have not observed anything yet.

**Third: the canonical benefit anchor has moved and is one repo.** Today's run reads **1.77×**
(not the 2.52× anchor), and per-repo: somaNotes **2.76× on 1,371 surfaced rows (82% of the corpus)**,
open-interpreter-fork 1.47×/142, sextant **0.78×/43**, defGen2 **null (0 opened of 56 across 8
sessions)**, jan25 46.25× on 21 rows (meaningless). Cite it as *"1.77× on the 2026-07-27 window, and
it is somaNotes"* — not as a fleet property. The ~2× robustness floor in memory does not hold on the
current corpus.

**Fourth: the blackout-reason rank is not stable and no fix should depend on it.** Content-driven
staleness is 92.7–93.7% of blackouts either way, but *which* of `head_changed`/`status_changed` leads
depends on whether rotated `.old` generations are counted (forensics: status 49.4% of 1,079
current-file events; the injected-body verifier: head 47.8% of 1,781 including `.old`). Version-driven
is 5.6% and already handled — and docs/033 Tier 2 #5's justification ("76.2% of stale reads on the
dogfood repo") is **the most unrepresentative statistic in the project**: sextant blackouts itself by
**shipping**; the fleet blackouts by **working**.

**Fifth: nothing here has a counterfactual.** Blast radius outperforms retrieval 2.52× on
open-precision, but with an inflated denominator (session-cumulative UNION vs most-recent-set) and
**no holdback arm at all**. Open-precision is precision-flavoured with an unbounded denominator.
Every per-source number is correlational. Outside Cursor's one production A/B, **no tool in this
category publishes a counterfactual** — which is simultaneously sextant's most defensible position
and the reason none of its own numbers can yet be called a result.

**Sixth: the evidence base is JS/TS/Python-only, on 9 active repos, one of which is 69% of the
recent data.** Treat every horizon, every threshold, and every "fleet-wide" claim in this document as
scoped to that population.
---

## Main-loop verification (independent re-run, 2026-07-27)

The synthesis above was produced by subagents. Before filing it, the load-bearing claims were
re-checked in the main loop, read-only, against the live tree.

| Claim | As written | Independent re-run | Verdict |
|---|---|---|---|
| self-eval on HEAD | 0.9042 / 0.9092 / +0.0152, 21/21 | `meanMRR 0.9041666`, `meanNDCG 0.9092245`, `graphLiftNDCG 0.0151814`, 21/21 | CONFIRMED |
| published eval numbers are stale | docs say 0.900 / 0.920 / +0.012 | `CLAUDE.md:311`, `README.md:381`, `README.md:389` | CONFIRMED — **three** sites, not two |
| `retrieval.path_miss` carries no `source` | asserted | `commands/hook-posttooluse.js:888` — `recordEvent(root, "retrieval.path_miss", { tool, arm, turn })` | CONFIRMED |
| `empty_fallback` payload is empty | `recordEvent(root, "retrieval.empty_fallback", {})` | verbatim at `9e44cab:commands/hook-refresh.js:859` | CONFIRMED |
| non-git zoekt corpus cannot exclude a file | `-ignore_dirs` is directories only | `lib/zoekt.js:222-239` — the non-git arm passes only `-ignore_dirs`; the git arm uses `zoekt-git-index` (committed content) | CONFIRMED |
| no redaction anywhere on the injection path | 0 hits | `grep -niE "redact\|sanitiz\|secret"` over format-retrieval / merge-results / zoekt / hook-refresh = **0** | CONFIRMED |
| a raw 60-char line excerpt is injected | `lib/format-retrieval.js` | `:133` — `f.zoektHit.line.trim().slice(0, 60)` | CONFIRMED |
| cross-repo zoekt poisoning precondition | manus-api-mcp: dead pid, HTTP 200 | `daemon.json` pid 3880578 **dead**, port 6075 answers **200**; jan25 (3019390) and glasshud (1153012) dead, HTTP 000 | CONFIRMED |
| the allocation question | retrieval 3.1% / 1.77x vs static 12.1% / 1.13x | retrieval **410 inj / 1,679 surfaced / 53 opened / 3.2% / lift 1.74**; static **691 / 6,253 / 771 / 12.3% / lift 1.12** | CONFIRMED |
| structural-row scarcity | 13 rows, 1 opened | `exported_symbol` 8 (1 opened) + `reexport_chain` 3 (0) + `swift_decl_other` 2 (0) = **13 / 1** | CONFIRMED exactly |

**One correction, and it strengthens the doc's own argument.** The Bottom line offers a caveat in
retrieval's favour — *"retrieval's few hits arrive first (rank 1 vs 3), which is the
orientation-latency argument the coverage number cannot see."* That caveat is weaker than stated.
On the same run, `firstTouchHitPct` is **static 33.1% vs retrieval 7.0%** and `firstTouchRank1Pct`
is **static 9.4% vs retrieval 3.6%**. Retrieval's median first-touch rank of 1 is **conditional on
hitting at all**, and it hits first-touch **4.7x less often**. So on all three absolute measures —
coverage, first-touch hit rate, rank-1 rate — the static summary leads, and retrieval leads only on
incremental permutation lift. The allocation question in §Gaps is **sharper**, not softer, than the
body states.

**Line-number caveat.** Every `file:line` cite was taken against `9e44cab`.
`commands/hook-refresh.js` has since accumulated **+135/-13** uncommitted lines from a concurrent
session, so cites into that one file drift (`empty_fallback` :859 → :981 in the working tree).
Resolve cites with `git show 9e44cab:<path>` rather than against the live tree.
