---
title: Next functional targets — grounded roadmap
status: researched
priority: high
feasibility: high
source: deep-research workflow (54 agents, adversarially scored)
researched: 2026-06-04
method: 6-lens candidate generation → dedup → per-candidate opus killer-judge + independent skeptic → composite ranking
---

# Next Functional Targets — Grounded Roadmap

> Synthesis of a deep-research + adversarial-ranking pass aimed at the question:
> *what should sextant build next to increase the tangible benefit it provides to Claude Code sessions?*
>
> Every target below is grounded in real code (file:line), the eval debt, the dogfooding
> field reports, or cited external research, and was stress-tested against `DESIGN_PHILOSOPHY.md`
> (no embeddings / no LLM-in-pipeline / no semantics / ≤2200-char summary / degrade-don't-guess).
> 30 raw candidates → 17 deduped → **15 survived an adversarial kill pass, 2 were killed.**
> Several candidates had their *own* pitches corrected against the live code — those corrections
> are preserved inline because they are the load-bearing part.
>
> **Kill-on-no-fixture rule:** any target whose FAIL-pre case cannot be manufactured on an existing
> corpus is *inert* and must not ship on faith. This is noted per-target.

## Bottom line

The highest-leverage cluster is **closing the honesty leaks in the production hook path** — the
UserPromptSubmit lane (`graph-retrieve.js` + `merge-results.js`) that agents hit on *every* code
prompt. It has two verified holes:

- **Not freshness-gated** — `applyFreshnessGate` is wired only at `hook-refresh.js:61` (the
  static-summary branch); zero freshness calls in `graph-retrieve.js` / `merge-results.js`.
- **Uninstrumented** — zero `recordEvent` calls in `commands/hook-refresh.js`; telemetry fires only
  at `cli.js` ×3 and `scan.js` ×1.

**The single most important target is retrieval-pipeline telemetry (T1.3)** — not because it moves a
scoreboard number, but because it is the *denominator* that lets every other retrieval change prove
it worked. The A4 NL-recall gap (57% failure) shipped undetected for months precisely because
empty-injection rate had no metric. Build the denominator first.

The two best *agent-visible* wins behind it are **authoritative entry-points (T1.1)** and
**freshness-gating the retrieval lane (T1.2)**.

---

## Tier 1 — build these first

### T1.1 — Authoritative entry-point map from manifests · composite 39
*Lenses converged: agent's pain, supervisor's pain, extracted-but-discarded data, philosophy-compatible prior art.*
*Scores — benefit 4 · feasibility 5 · evidence 5 · philosophy 5 · measurability 5.*

**Tangible session benefit.** An agent told "start with the likely entry points" (the canonical
first move on an unfamiliar repo) lands on the real CLI dispatcher instead of an internal watcher
helper. The supervisor stops burning the first turns redirecting from the wrong starting file. The
map's most load-bearing claim — *where to begin* — becomes a parsed declaration, not a regex guess.

**Gap + evidence (verified).** `isEntryPoint` (`lib/utils.js:83–104`) JS branch is
`/(src\/)?(main|index|app|root|router|routes)\.(ts|tsx|js|jsx|mjs|cjs)$/i` — **no `(^|/)` anchor**,
so `lib/zoekt-reindex.js` matches as a substring of the `index.js` alternative. The real dispatcher
`bin/intel.js` matches no pattern. `summary.js:53` already reads `package.json` into memory and
`summary.js:66` `existsSync`-checks `pyproject.toml` — the manifests are in hand; the authoritative
`bin` / `[project.scripts]` fields are never parsed.
*(Live confirmation: this repo's own session-start banner lists "Likely entry points:
`lib/extractors/index.js`, `lib/zoekt-reindex.js`" — a re-export barrel and the false positive,
with `bin/intel.js` absent.)*

**Mechanism within constraints (two scored deltas, not one).**
1. One-line word-boundary fix on the JS branch (`(^|/)` anchor). **Shared with `retrieve.js`
   `ENTRY_POINT_BOOST`** — `zoekt-reindex.js` loses a false +10% retrieval boost — so re-run
   `npm run test:eval` and confirm MRR / graphLiftNDCG are flat. Drop any blanket "MRR unchanged" wording.
2. Thread the already-loaded-but-discarded `pkg` object into the entry-point builder, parse `pkg.bin`
   (string|map), hand-parse `pyproject [project.scripts]` (~20 lines, no new dep), source-tag each row
   (`— declared` / `(heuristic)` / `— @main`). Union manifest-authoritative entries ahead of heuristic
   ones. Drop the Next.js `app/page` glob from v1 — it edges toward route-surface guessing.

Manifest declarations are facts producible without inference — the most authoritative entry-point
signal possible. Replaces wrong rows in the ≤2200-char summary; no net rows added.

**Measurable proof.** Self-repo fixture asserting the entry-point list. FAIL-PRE: includes
`lib/zoekt-reindex.js`, excludes `bin/intel.js`; **also** `lib/extractors/index.js` (a re-export
barrel) is injected as an entry point on HEAD and the regex fix alone won't remove it — only
manifest-authoritative ordering demotes it. PASS-POST: includes `bin/intel.js` from `package.json bin`,
demotes/excludes the false positives, rows source-tagged. Add `[project.scripts]` to the existing
`fixtures/python-eval/pyproject.toml`.

**Effort.** Small, ~1–1.5 days.

**Strongest counter + rebuttal.** *Counter:* the headline symptom is killable by the one-line regex
anchor alone, so bundling inflates impact. *Rebuttal:* the manifest half closes what the regex
provably cannot — it cannot invent `bin/intel.js` (a real declared entry matching no filename
pattern) nor demote the legitimate barrel `lib/extractors/index.js` below the declared bin.
*Correction to the original pitch:* `mcp/server.js` is **not** a manifest-declared entry — don't
claim manifest parsing surfaces it (the regex anchor's exclusion handles it, not `bin`).

### T1.2 — Freshness-gate the code-prompt retrieval path · composite 35.6
*Lenses converged: agent's pain, supervisor's pain.*
*Scores — benefit 4 · feasibility 5 · evidence 4 · philosophy 5 · measurability 4.*

**Tangible session benefit.** The agent stops confidently opening or editing a file renamed/deleted
in the branch just switched to. On stale state the retrieval block strips graph-sourced authority
boosts (leaving live rg/zoekt text-evidence) and carries an explicit STALE marker, so neither agent
nor supervisor trusts a stale map.

**Gap + evidence (verified).** `applyFreshnessGate` is called only at `hook-refresh.js:61`
(static-summary path). Zero `checkFreshness`/`applyFreshnessGate` references in `graph-retrieve.js`
or `merge-results.js`. `GRAPH_BOOST=1.4` (`merge-results.js:15`), `FUSION_BONUS=1.2` (:20),
`DEF_SCORE_FLOOR=600` (:44) apply unconditionally. A direct "drift must be loud" / "degrade don't
guess" violation.

**Mechanism within constraints.** `mergeResults` already takes `opts` (line 154) — thread one `stale`
flag gating `GRAPH_BOOST`/`FUSION_BONUS`/`DEF_SCORE_FLOOR`. Call existing `freshness.checkFreshness(root)`
before the code-relevant branch (cached meta read, already paid on the summary path). Prepend a
one-line STALE marker. Reuse the existing `.rescan_pending` single-flight trigger. `fs.existsSync`-drop
graph-only-injected paths that no longer exist. Evidence (rg/zoekt) survives the gate because it is
recomputed live; only structure is suppressed — the evidence-vs-structure separation the philosophy demands.

**Measurable proof (two independent assertions).** (a) STALE-marker presence on the
`<codebase-retrieval>` block — deterministic, the clean fail-pre/pass-post; (b) `existsSync`-drop of a
**deleted-file** path injected graph-only — the genuinely dangerous case, far more robust than
"renamed file demoted" (which depends on zoekt still indexing the old path). Make the deleted-path drop
load-bearing. **Critical no-op check:** graphLiftNDCG on the *fresh* Vapor fixture must be byte-unchanged
— the gate must be inert when fresh, or it silently taxes the strategy's headline metric.

**Effort.** Small-to-medium, ~1–2 days.

**Strongest counter + rebuttal.** *Counter:* the "35.8% stale-hit" telemetry is from the *summary*
path; per-prompt the classifier routes to retrieval XOR summary, so phantom-path frequency is a
fraction-of-a-fraction. *Rebuttal:* the inflated rate wounds the framing, not the target — the
hard-constraint violation is real and the boosts apply unconditionally; a *deleted* file yields no
zoekt hit, so graph-only injection of a deleted path is genuine and unguarded today. Re-ground the
benefit on the retrieval path's *own* stale rate via the new telemetry counter (T1.3).

### T1.3 — Instrument the hook retrieval pipeline · composite 35 · **FOUNDATIONAL**
*Lenses converged: retrieval fidelity & eval debt, make benefit measurable.*
*Scores — benefit 3 · feasibility 5 · evidence 5 · philosophy 5 · measurability 4.*

**Tangible session benefit.** Maintainer-facing, but the denominator for everything else. From one
`sextant telemetry` run on any real repo: what fraction of code prompts produced a graph-merged hit
vs text-only vs empty fallback to static summary. Future recall regressions (a new SKIP_TERM swallowing
real queries) surface as a rising empty-injection rate instead of a silent dogfooding miss months later.

**Gap + evidence (verified).** `recordEvent` fires at exactly 4 sites — `cli.js:133/147/151`,
`scan.js:190` — and **none in `commands/hook-refresh.js`**. No counter for classifier fire/skip,
retrieval-hit vs static-fallback, graph-merged vs text-only, or empty-injection. Exactly how A4 shipped
undetected. `lib/telemetry.js` is purpose-built for hot-path use (never-throws, rotation-bounded, namespaced).

**Mechanism within constraints.** Drop-in `recordEvent` at the real decision points (use the *actual*
branches, verify offsets at build time: classify at ~`hook-refresh.js:127`, classifier-skip→static at
~:135, merge at ~:195, empty-output→static at ~:210, real injection at ~:245). Emit disjoint events:
`retrieval.classified {retrieve, confidence, termCount}`, `retrieval.injected {source, fileCount}`,
`retrieval.empty_fallback {}`. **Do not** re-emit a `stale` signal the freshness lane (T1.2) owns.
Extend `commands/telemetry.js` aggregation. <1ms append; out-of-band JSONL, never injected → zero budget cost.

**Measurable proof.** New test drives `hook-refresh` against a fixture where the classifier fires AND
merge returns a graph_merged hit; assert telemetry contains `classified` + `injected{source:'graph_merged'}`
(not merely "a retrieval.* event present"); and on a non-code prompt, `classified{retrieve:false}` with
NO `injected` event. FAIL-PRE: zero retrieval.* events.

**Effort.** Small, ~0.5 day.

**Strongest counter + rebuttal.** *Counter:* moves zero scoreboard metrics, zero in-session benefit;
"foundational telemetry" risks being a perpetual justification for low-benefit infra. *Rebuttal:* the
`.last_retrieval` marker (already written, consumed by the statusline) covers only the success case — it
does not expose empty-injection rate, the exact failure mode that hid A4. "Drift must be loud" applied to
the retrieval lane is a core mandate. *Open design point:* how to assign the `source` label when both
graph and zoekt contribute (check `graphResults.files.length` vs `zoektHits.length` before merge).

---

## Tier 2 — strong; build after the measurement floor exists

### T2.1 — Symbol-level blast radius · composite 34.7
*Lenses converged: agent's pain, supervisor's pain, extracted-but-discarded data.*

**Benefit + gap.** When about to change an exported function, the agent sees "imported by 3 files"
instead of the coarse file-level "graph.js imported by 9." `js_ast_imports.js` returns only
`{specifier, kind}` (specifiers dropped); `python_ast.py:237–238` captures name+asname but `python.js`
folds it to the module specifier; the `imports` table has no `consumed_symbols` column.

**Mechanism.** Capture `node.specifiers` in the Babel extractor; thread `imp.name/asname` through
`python.js`; add an indexed symbol-edge table (prefer the `import_symbols` design in
`docs/plans/2026-03-31-001` over a JSON column — it can be indexed); add `findSymbolImporters`; surface
in `sextant_explain` + a one-line retrieval note. Static AST facts only. SCHEMA_VERSION bump (version-stamped
by the freshness gate, so it forces one clean rescan).

**Measurable proof + load-bearing correction.** The original example
(`findSymbolImporters('lib/graph.js','findReexportChain')`) is **flawed on this CommonJS repo**:
`graph.js` is consumed via namespace `require` (`const graph = require('./graph')`), so the consumed
symbol lives at the *call site*, not the import — the symbol→file edge doesn't exist statically. Ground
the fixture on a **named-import/ESM or Python from-import edge** (Python is at-import-site, works cleanly).
Assert the `*`-namespace fallback explicitly so the degrade path is locked. Add a **symbol-coverage health
metric** (fraction of import edges with concrete symbol names) surfaced in `doctor` — without it the
file-level fallback is a silent guess.

**Effort.** Medium, ~2–3 days.

**Counter + rebuttal.** *Counter:* symbol-level precision only materializes for ESM/destructured-CJS;
on CommonJS-namespace (this repo, much of Node) it collapses to today's file-level fan-in, and the
motivating example even mis-attributes `intel.js` as an importer (grep: only `graph-retrieve.js` and
`retrieve.js` call `findReexportChain`). *Rebuttal:* the benefit is real but narrower than "9→3" implies;
scope it as a Phase-1 slice (defer transitive BFS), make the namespace fallback loud, ground the test on a
real named-import edge.

### T2.2 — Classifier calcification guard · composite 31.9 · verdict: revise
*Lens: make benefit measurable.*

**Benefit + gap (verified empirically).** `shouldRetrieve("merge results scoring")` →
`{retrieve:false, conf:0.15, terms:["results","scoring"]}`. `merge` is in SKIP_TERMS (`classifier.js:145`)
AND ACTION_VERBS (:235); surviving terms aren't identifier-shaped so the score stays sub-threshold.

**Required reframe (why "revise").** The original pitch flagged this as a *bug* to fix by forcing
`expectRetrieve:true`. That is a contested product decision — the classifier's documented bias
(`classifier.js:5–7`) is "false positives that inject irrelevant context are worse than missed
retrievals." Reframe from "dead-zone fix corpus" to **"verdict calcification guard"**: default every seed
to its *current intended* verdict, so the value is catching accidental SKIP_TERM/threshold regressions, not
litigating thresholds. Quarantine `merge results scoring` in a separate `xfail`/pending bucket
("product decision: should sub-threshold multi-noun NL prompts retrieve?") and settle it with the maintainer.

**Corrections.** Several seed prompts already pass (`session middleware` → `retrieve:true`, verified);
`test/classifier.test.js` already has ~84 `retrieve` verdict assertions — the true delta is consolidation/
extension of that file, not a net-new `fixtures/classifier-eval/`. scope-003/004 are retrieval-quality
cases, not the classifier precedent the original claimed.

**Effort.** Small, ~0.5–1 day.

### T2.3 — Wire `swift_relations` into `sextant_related` · composite 30.5 · verdict: revise
*Lenses converged: agent's/supervisor's pain, extracted-but-discarded data, retrieval fidelity, prior art.*

**Benefit + gap (verified).** `findRelationsByTarget` (`graph.js:908`, exported :1009) has **zero
production callers**. `swift_relations` is populated every scan (`intel.js:584 replaceSwiftRelations`) with
direct/heuristic confidence tagging (`swift.js:573` extends=direct, :606 conforms_to=heuristic). The most
authoritative cross-symbol signal the extractor produces is dead weight.

**Required scope correction (why "revise").** Do **not** wire this into `graph-retrieve.js` Layer 2 (the
<50ms hook lane) — injecting N conformers into a 10-slot result displaces the canonical def, and the
`vapor-codable-001` precedent (graph injection of a broadly-conforming protocol name drops nDCG
0.399→0.084) is a real regression mode. Scope to the **deliberate `sextant_related`/MCP path only** (10s
budget). Note `sextant_related` is currently file-keyed (`mcp/server.js`), so a symbol-keyed branch (or a
distinct `sextant_relations` tool) is a contract change — budget for it (contradicts the "only call sites"
feasibility claim).

**Measurable proof.** Ground the eval case in a *real* blast-radius query whose ground truth is
independently a conformer set ("what implements Middleware") — not a case reverse-engineered to pass.
Assert `findRelationsByTarget` is invoked from the MCP path. Drop the graphLiftNDCG-on-Vapor claim unless
the case enters the standard corpus with def-protective ground truth. *(The cited CodeCompass paper
arXiv:2602.20048 post-dates the knowledge cutoff — treat as directional, not load-bearing.)*

**Effort.** Small-to-medium, ~1–2 days.

### T2.4 — Two-token NL recall recovery · composite 30.1 · verdict: revise
*Lens: retrieval fidelity & eval debt.*

**Benefit + gap (verified).** `zoekt.js:548` gates Tier-3 token-coverage-OR at `tokens.length >= 3`;
`searchFast` has no Tier-3. A 2-token query exhausting phrase+AND falls through with zero recovery on both
lanes — the residual half of the A4 class.

**Why "revise" — redundancy risk is real.** Both Tier-3 blocks fire only after Tier-2 AND returns zero,
and the documented A4 recovery is attributed to the **AND fallback**, not OR. For 2 tokens, AND already
surfaces files containing *both*; Tier-3 OR only helps the strictly narrower case where the two tokens never
co-occur in one file — and over 2 tokens, distinct-coverage ranking is weakly discriminating (0/1/2), risking
floating a high-frequency single-token consumer above the canonical def.

**Gate.** Ship the CLI gate edit (`>=3`→`>=2`, one constant) **only if** a concrete 2-token
AND-zero/OR-recovers fixture can be manufactured (FAIL-pre: revert constant → canonical absent; PASS-post).
If no such case exists, the edit is inert — drop it. For `searchFast` Tier-3: require an actual warm-Vapor
latency probe proving the `deadline - Date.now() > 60` gate keeps p95 < 180ms (the comment documents a
247–316ms overrun) AND a reproduced 2-token Swift case; absent both, drop the searchFast half.

**Effort.** Small-to-medium, ~1 day.

### T2.5 — Session-trajectory harness · composite 30.5 · verdict: revise
*Lens: make benefit measurable.*

**Benefit + gap.** A `sextant eval-trajectory` command parses session JSONL, joins injected
`<codebase-retrieval>` paths against subsequent Read/Edit `file_path`s, reports hit-rate and
hallucinated-path rate — the first benefit signal grounded in real agent behavior.

**Required reframe.** "Surfaced-then-opened rate" is **causally confounded** (no counterfactual
sextant-OFF arm in the JSONL — can't distinguish "sextant steered" from "agent would have opened it
anyway"). **Lead with hallucinated-path rate** (Read/Edit against a path that doesn't exist) as the
load-bearing metric — a clean, baseline-free honesty signal instantiating "degrade don't guess." Demote
surfaced-then-opened to a descriptive cohort stat with an explicit "correlational, no counterfactual" caveat.
Correct the evidence figure: the "60 instances" count includes literal `<codebase-retrieval>` strings in
commit messages/diffs (this *is* the sextant repo); real injection records with parseable paths are ~10–11.

**Effort.** Medium, ~1 day for the offline CLI + fixture. *(Cited AGENTS.md paper arXiv:2602.11988
measures a static upfront dump, not targeted per-prompt injection — don't overstate it.)*

---

## Tier 3 — opportunistic / measurement hygiene (each needs its noted correction)

- **Per-case graphLiftNDCG + negative-floor guard (27.5).** `eval-retrieve.js:103/109` already computes
  `withGraph`/`withoutGraph` nDCG per case then **discards it into one aggregate**. *Keep:* persist per-case
  `liftNDCG` — surfaces both the +1.0 `vapor-uri-001` win *and* the hidden `vapor-codable-001` −0.315
  regression. *Cut:* the G1/G2/G3 tier taxonomy and a `>= 0.20` "replicate CodeCompass 23.2pp" gate (corpus
  has only 2–3 non-zero-lift cases; an external-number-pegged gate proves nothing). *Replace with:* a
  **negative-floor regression guard** (assert no case lift < −0.05 on Vapor) so the conformance-query
  regression fails-pre and must be understood or accepted as debt.

- **Test-to-code coverage map (26.3, revise).** Filter `neighbors().dependents` through `isTestPath`.
  *Corrections:* (1) `sextant_explain` returns fan-in *counts*, not the dependents list — target
  `handleRelated` (which does return dependents) or add a `neighbors()` call. (2) `isTestPath` is **not
  exported** from `retrieve.js` and `merge-results.js:fileTypePenalty` carries a drifting hand-synced copy —
  refactor to a shared predicate first or you add a third copy. (3) Demote "zero-test-dependent = coverage
  gap" to a neutral "no test files import this directly" note — integration/e2e tests don't import their
  targets, so a gap label violates degrade-don't-guess.

- **`sextant_symbols` MCP tool (24.9, revise — Swift-only).** *Verified fatal flaw in the multi-language
  framing:* the exports table (`graph.js:63`) has no line column and `js_ast_exports.js` captures no `loc` —
  per-symbol line numbers exist *only* in `swift_declarations.start_line`. For JS/TS/Python the tool returns
  at most names+kinds, byte-identical to `sextant_explain`. Re-scope to **Swift-only** (one grouped SELECT
  ordered by `start_line`, surfacing parsed-but-discarded `parentName`/`signatureHint`). Cross-language needs
  a schema + extractor change — separate, larger piece.

- **Swift `parentName`/`signatureHint` disambiguation (23, revise).** *Verified architectural mismatch:* the
  pipeline collapses to one entry per *file path* at three layers (`graph-retrieve.js addOrUpgrade`,
  `merge-results.js fileMap`, format one-line-per-file), so "two lines both `encode` with different `(in X)`"
  cannot pass without a per-file→per-declaration rewrite the candidate disclaims. *Re-scope:* the real latent
  bug is that `format-retrieval.js` has **no render branch** for `swift_decl_type` hits (they show as bare
  paths). Add that branch + thread one representative decl's `parentName`+`startLine`; assert
  `decl: <symbol> (in <parentName>)` renders.

- **Function-level localization eval tier (21.1, revise).** *Verified false premise:* `format-retrieval.js:76`
  emits `L<n>` only from `f.zoektHit.lineNumber`, and `merge-results.js` gives graph-only-injected files
  `zoektHit:null` — so for the injection-dependent cases this targets (`vapor-uri-001`, `vapor-ext-001`) there
  is *no* line number in the output to compare. *Cheap path:* tighten existing `relevantHitPatterns` + add
  `maxPrimaryRank` gates. *Real path:* first plumb `startLine` through graph-retrieve→merge→format (itself a
  legitimate win — pointing the agent at the class-declaration line), then add `recallDefLine@k`.

- **Loud staleness on the statusline (23.3, revise — retarget surface).** *Verified surface error:* the
  candidate proposed editing `renderStatusLine` (`cli.js`), whose only call site is
  `hook-refresh.js:95 process.stderr.write(...)` — invisible to the user per the visibility model. The real
  user-facing surface is `scripts/statusline-command.sh`, which already has watcher `stale`/`off` states
  (lines 87–94) but reads no `.rescan_pending`/freshness state. Retarget to the bash script
  (`[ -f .rescan_pending ]`, near-zero cost). *Critical:* drive the loud "stale" dot **only** from git-derived
  freshness reasons (head_changed/status_changed), NOT scanner_version_changed — otherwise every routine
  upgrade flips healthy idle repos to yellow, re-introducing the cried-wolf alarm the freshness redesign deleted.

---

## Deliberately rejected (the kills are as useful as the picks)

- **NL-concept hotspot-restore — KILLED, path mismatch.** Proposed narrowing the hotspot strip at
  `retrieve.js:339–359`, which lives **only** in the CLI/MCP `retrieve()` path. But its benefit ("concept
  question → results lead with the central hub") flows through the **UserPromptSubmit hook**, which uses
  `graph-retrieve.js` + `merge-results.js` — no HOTSPOT_BOOST, no def-site strip; `merge-results.js` already
  ranks by `fanIn` directly. The behavior already holds on the production path; the strip it changes is in
  code the hook never calls.

- **Swift enclosing-type boost on the hook — KILLED, wrong failure mode.** Headlined "repairs `vapor-elf-001`
  (hook mrr=0)." Verified against `fixtures/vapor-hook-baseline.json`: elf-001's ranked files for "extension
  EventLoopFuture" contain **no EventLoopFuture extension file at all** — a **recall** failure, not ranking.
  A +10% boost cannot promote a file that isn't a candidate. Mechanism also misdirected (Signal 8
  extension-target already works on the hook; Signal 7 reads the always-empty `before[]`), and
  `graph-retrieve.js` discards `parentName` before scoring, so "already in the result objects" is false.

- **Git-churn hotspot — effectively rejected.** Motivated by **zero observed retrieval failures**; the proposed
  proof ("author a fixture where churn is decisive, then prove churn was decisive") is the hollow-verification
  trap. Churn would be a stored time-windowed integer aging on a clock the freshness gate (HEAD + status-hash)
  doesn't watch — a "fresh" graph could carry a 90-day-stale churn distribution. Decisive structural objection:
  stable canonical implementations (retry logic, auth) have *low* churn, so a churn boost would promote transient
  high-churn boilerplate above the canonical source — the opposite of intent. Ground on a real dogfooded miss
  first, or kill.

**Hard-kill constraints respected throughout:** no candidate proposes embeddings/vector search, LLM calls in
the pipeline, compiler-backed Swift semantics, or summaries >2200 chars. Every survivor adds
structural/evidence facts producible without inference.

---

## Recommended sequencing

The ordering respects the one real dependency — **you cannot prove a retrieval change on the hook path until
the hook path is instrumented** — and front-loads the cheapest agent-visible win.

1. **T1.3 — Retrieval-pipeline telemetry (~0.5 day).** Build the denominator first. Unblocks measured proof for
   steps 2, 3, 4, and the freshness target's own stale-rate. Use the verified branch offsets, not the originally-cited ones.
2. **T1.1 — Authoritative entry-points (~1–1.5 days).** Cheapest agent-visible win; independent of everything.
   Split the regex fix from the manifest union; re-run `npm run test:eval` to confirm the shared
   `ENTRY_POINT_BOOST` change leaves MRR/graphLiftNDCG flat.
3. **T1.2 — Freshness-gate the retrieval lane (~1–2 days).** Add `retrieval.stale_hit` as part of this work and
   report the retrieval path's *own* stale rate. Verify graphLiftNDCG on the *fresh* Vapor fixture is byte-unchanged.
4. **Per-case graphLiftNDCG + negative-floor guard (~0.5 day).** Surfaces the hidden `vapor-codable-001` −0.315
   regression. Do this before T2.3/T2.4 so any scoring/injection change has a regression floor to trip.
5. **T2.2 — Classifier calcification guard (~0.5–1 day).** No-regression guard (current verdicts), with
   `merge results scoring` quarantined as an explicit `xfail` product decision.
6. **T2.1 — Symbol-level blast radius (~2–3 days).** SCHEMA_VERSION bump, so batch it deliberately. Ground the
   fixture on a Python from-import edge; surface the symbol-coverage health metric.
7. **T2.3 / T2.4 / T2.5** — each gated on a *grounded* fixture per its revision note. Build T2.4's CLI gate edit
   only if a real 2-token AND-zero case can be manufactured; otherwise inert, drop it. T2.3 stays off the hook lane.
8. **Tier 3 surface refinements** opportunistically: the statusline retarget (bash script, not the stderr
   function) and the swift_decl render branch are each ~0.5 day and independently shippable.

**Honest uncertainty.** The strategy scoreboard (self-eval MRR, graphLiftNDCG) is self-referential and neutral
on the home corpus, and the retrieval path is uninstrumented today — which is *why* T1.3 leads. Several Tier-2/3
benefits (2-token recall, churn, conformer injection) are asserted from plausible mechanism, not a reproduced
miss on a real repo. Treat any of them as **kill-on-no-fixture**: if the FAIL-pre case can't be manufactured on
an existing corpus, the change is inert and should not ship on faith.
