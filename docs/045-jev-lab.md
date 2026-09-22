# Jev experiment ledger

Started 2026-09-21 at owner request. This is active experimental development in
the preserved Sextant checkout. Fleet hooks, watchers, and services are outside
the experiment. Baseline source is `95712cc45636cc5cc4a11e97511f44dd1489a08f`.

## Completed campaign checkpoint — 2026-09-22

Recorded **2,866 successful Jev inference calls**, one failed attempt, and
**232 successful OpenAI comparator calls**. Calls include repeated and related
cases; these are not counts of independent observations. Jev's recorded
1,863,051 input tokens imply **$0.078248142** at the published rate, excluding
unknown failed-request usage, the earlier tool-only contract smoke, OpenAI and
agent-team costs. This is an estimate, not an invoice. The full file inventory,
SHA-256 hashes and counts are in `.planning/jev/campaign-summary.json`.

The final experimental suite passed **174/174 tests**. The preserved original
Sextant suite had previously passed **1,411 tests, two skipped**, integration
scripts and 21/21 retrieval evaluation tasks. No runtime source or ambient hook
integration was changed. The temporary credential process exited after the last
live call; the supplied credential was not written into the checkout or artifacts.

| Evidence | Result | Implication |
| --- | --- | --- |
| Original controlled comparison | Jev 213/224; mini 178/224; holdout 120/128 vs 103/128 | A measured advantage on this corpus, dominated in mutation cases by fewer false alarms. |
| Verbatim-source claims | 32/32 verdicts; 31/32 refutation selections | Supports the explicit-scope prototype; does not prove general code correctness. |
| Mutated real-source controls | 14/16 verdicts; both regex misses coherent and confident | The consistency gate does not catch all wrong answers. |
| Type representation, new-value confirmation | Raw 25/32; annotations 30/32; literals 32/32 | Preserve executable syntax and explicit types; validate transfer to new tasks. |
| Coordination composition | All-three accuracy 14/32 to 19/32; emergent recall 8/8 to 1/8 | Higher aggregate accuracy and coherence can hide a critical recall failure. |

Reports: [original/matrix](046-jev-live-findings.md),
[mechanism probes](047-jev-mechanism-probes.md),
[coordination](048-jev-coordination.md). The opt-in source checker and its actual
live canaries are described below.

## What is built

- A dependency-free client for the documented TypeSafe HTTP API, with strict
  typed responses, mandatory model/token stamps, bounded deadlines, and explicit
  failures. HTTP transport tests are not Jev capability measurements.
- 128 authored controls in 16 families: retrieval relevance, evidence
  sufficiency, contradiction, freshness, imports, intent, injection, behavioral
  changes, test gaps, authority, cross-file contracts, answerability, conflicting
  tasks, schema fabrication, and repository-grounded claims/retrieval.
- 96 additional executable JavaScript controls in 12 families. Their labels come
  from running the reference and modified expressions on identical inputs.
  Cosmetic changes always preserve outputs; semantic mutations include both
  affected and unaffected inputs. These test the given inputs only.
- Ten question treatments: original Noul, logical negation, Choice, reversed
  Choice order, two-level Score, opaque question ID, irrelevant padding, and
  speculative fan-out, plus two source-injection attacks that demand yes/no
  independently of the true label. All together: **224 cases / 2,240 requests**.
- The full matrix has completed with zero provider errors. It consumed 1,455,988
  input tokens (estimated **$0.0611515**) at p50 **177 ms**, p95 **253 ms**.
  Variant-level findings and repeat controls are in [046](046-jev-live-findings.md).
- A repaired extraction-cascade experiment that checks structure locally,
  traverses schema fields, and distinguishes missing evidence from a suspect
  extraction. It deliberately supports a documented flat-schema subset and
  rejects unsupported schema constructs.
- 32 additional refutation tasks over verbatim, hashed Sextant source: 16 paired
  claims with supporting, contradicting, or insufficient evidence, and explicit
  selection of the scope that refutes the claim. These include distractor-bearing
  cases where none of the source scopes establish runtime/public-delivery facts.

The primary-source investigation and 28 proposed research directions are in
[042](042-jev-research.md). Repository opportunity analysis is in
[043](043-jev-opportunities.md). The actual repository retrieval experiment and
its isolated-snapshot commands are in [044](044-jev-repository-experiments.md).

## Run it

Offline tests and request inventory:

```bash
npm run test:jev
npm run lab:jev -- inspect --corpus all \
  --variants original,negated,choice,choice-reversed,score,opaque-id,padding,fanout,injected-yes,injected-no
```

With `TYPESAFE_API_KEY` supplied in the process environment, start with the small
smoke run, then the full matrix. Each output path must be new; the runner refuses
to overwrite an existing experiment.

```bash
npm run lab:jev -- live --limit 8 --model jev-1.13.0 \
  --out .planning/jev/smoke.jsonl
npm run lab:jev -- live --corpus all --model jev-1.13.0 \
  --variants original,negated,choice,choice-reversed,score,opaque-id,padding,fanout,injected-yes,injected-no \
  --out .planning/jev/matrix.jsonl
npm run lab:jev -- report --input .planning/jev/matrix.jsonl \
  --out .planning/jev/matrix-summary.json
```

The seed is printed and defaults to `20260921`. It controls request order, not
remote-model determinism. Requests are sequential, stop on the first provider
failure, and have no hidden retries. JSONL evidence is flushed after every
request, so a partial run remains inspectable. Reports can be made from partial
runs and show planned, completed, failed, and unattempted request counts. Replay
requires observations to follow the frozen sequential schedule. Different
returned model versions receive separate reports; they never share threshold
selection or invariance measurements.

The manifest freezes the corpus, labels, model selection, Git revision, source
hashes, and time. Result rows retain raw typed responses, token usage, latency,
and request fingerprints. Replay checks fingerprints, validates responses, and
recomputes scores from frozen labels. Cached derived scores are not authoritative.
Raw task inputs contain no labels, rationales, split IDs, or oracle outputs.

## Interpretation

Thresholds are selected using development cases only. Scenario pairs never cross
splits. Four authored families and six executable families are held out entirely.
This supports scenario/family transfer checks, not independent repository or
real-world productivity claims. The existing Sextant repository cases are
self-referential and manually transcribed; they are not a blind external set.

Reports include confusion counts, Brier error, empirical reliability bins,
false acceptance, selective risk versus coverage, probability changes across
equivalent presentations, latency, and recorded token usage. The holdout
threshold sweep is descriptive; choosing its best point would contaminate it.
The probability-margin abstention curve is explicitly separate from TypeSafe's
Choice/Score `confidence`. Noul does not return that confidence field.

Cost estimates use the published Jev rate of $0.042 per million input tokens,
with free output, accessed 2026-09-21. They exclude failed-request usage and are
not billing records. More heads can increase false escalation; maximum head
probability is a routing statistic, not automatically a calibrated probability
of any error.

## Evidence so far

- Preserved Sextant baseline: `npm test` passed with a temporary test-only
  launcher: **1,411 passed, two skipped**, integration scripts passed, retrieval
  evaluation **21/21**. The suite generated a hook-only `.claude/settings.json`;
  that exact new file was removed after the run.
- Published SDE defect independently reproduced: an empty extraction generates
  no field-level gates; unknown fields raise a schema lookup error. Local
  regression tests cover both and the schema-owned repair.
- Executable mutation controls: **96 labels derived locally**, including all
  48 cosmetic controls preserving behavior and at least one changed/unchanged
  input per semantic mutation family. Independent hand-derived truth tables
  agree with all 96 labels. Another 32 of the 128 authored labels were executed
  independently and agreed; 96 authored labels remain unexecuted.
- Actual isolated-source retrieval on 21 existing tasks: primary candidate
  coverage **20/20 answerable tasks**, mean relevant-file recall **0.95**,
  MRR **0.89464**, nDCG **0.89404**, plus one no-answer control. These establish
  candidate quality before Jev, not reranking improvement.
- An authenticated OpenAI control smoke used `gpt-5.4-mini-2026-03-17` with
  reasoning disabled and unchanged yes/no task inputs. It got **6/8** balanced
  authored development cases correct, with **1,601 input / 84 output tokens**,
  mean latency **866.95 ms**, and estimated cost **$0.00157875**. The two misses
  were constructor-bypassing test coverage and an explicit code-retrieval intent
  case. This is a tiny comparator sample, not a Jev comparison. Evidence:
  `.planning/jev/openai-smoke-2026-09-22T05-02-49-028Z.jsonl`.
- The subsequent frozen **224-case** run completed with **zero failures** on the
  same model and unchanged prompt: **178/224 correct (79.46%)**, development
  **75/96**, holdout **103/128**. Authored cases scored **100/128**; executable
  mutations scored **78/96**. Usage was **45,869 input / 2,736 output tokens**,
  estimated cost **$0.04671375**, and mean latency **740.23 ms**. Independent
  replay exactly matched the stored summary. This establishes a conventional
  model comparator only; its holdout outputs will not be used to tune prompts.
  Evidence: `.planning/jev/openai-original-all-2026-09-22T05-06-18-175Z.jsonl` and
  `.planning/jev/openai-original-all-summary.json`.
- Live Jev inference resumed on 2026-09-22 after the owner supplied a credential
  to a temporary process environment. The original 224-case run completed with
  **213/224 correct**, including **120/128 holdout**, versus mini's 178/224 and
  103/128. Estimated Jev input cost was **$0.004020**; median request latency was
  **184 ms**. Full evidence and limitations are in [046](046-jev-live-findings.md).
- On 32 verbatim-source tasks, Jev classified **32/32** supporting, contradicting
  and insufficient claims correctly and selected refutation scopes correctly on
  **31/32**. One supporting verdict nevertheless selected a refuting scope;
  the new opt-in assumption checker explicitly surfaces such disagreement.
- On identical real retrieval pools, Choice reranking improved MRR from
  **0.89464 to 0.93750**; Noul reranking reached **0.90833**. All 17 initially
  rank-one results remained rank one. These are development results on a small,
  easy corpus; gold-label ambiguity and the trivial no-answer control are
  documented in [044](044-jev-repository-experiments.md).
- All **2,240 request shapes** passed the client contract validator with explicit
  offline response fixtures. These fixtures were not written as model results
  or scored as capability measurements.
- Initial experimental suite: **116 tests passed** with `npm run test:jev`;
  `git diff --check` passed. The source-backed refutation snapshot is frozen at
  `.planning/jev/refutation-frozen.json` and contains 32 tasks, each with three
  typed questions. Its fingerprint is
  `909f353a28c9978e295683a867143bc090ce9080468090cc708a22048d2ac2b2`.

Independent harness tests reproduced and then locked fixes for model-version
pooling, silently incomplete reports, impossible response order, duplicate paid
variants, unplanned results, and invalid error rows. Hand-computed confusion,
Brier, and reliability-bin controls also pass. These are measurement-quality
checks, not additional model successes.

The paired cascade analysis has run over both providers' original observations:

```bash
node experiments/jev/compare.js \
  .planning/jev/openai-original-all-2026-09-22T05-06-18-175Z.jsonl \
  .planning/jev/jev-original-all-2026-09-22T05-38-49-970Z.jsonl
```

It validates frozen evidence for both runs, matches identical original tasks,
and estimates the mini answer's error signal as `p` when mini answered false
or `1 - p` when mini answered true. Development-only routing thresholds are then
evaluated on holdout. Its oracle-escalation accuracy is explicitly an optimistic
upper bound; no unexecuted reasoning-model repair is counted as successful.
The development-selected zero-observed-error gate retained only **23/128**
holdout answers and escalated **105/128**. It retained no observed mistakes,
but its low coverage undermines the cheap-cascade hypothesis for these tasks.
Evidence: `.planning/jev/live-paired-cascade.json`.

The source-backed refutation experiment can be rerun with a process credential:

```bash
node experiments/jev/refutation.js live \
  --input .planning/jev/refutation-frozen.json \
  --out .planning/jev/refutation-live.jsonl
node experiments/jev/refutation.js report \
  --input .planning/jev/refutation-live.jsonl
```

The overlapping eight smoke/full-run comparator tasks produced two different
decisions despite the same returned model stamp and unchanged question prompt.
The smoke requested the alias and the full run requested the resolved snapshot.
This small descriptive overlap is a reason to measure repeatability, not a
standalone reliability estimate.

### Matched-control follow-up audit

Replayed the same immutable 224-case comparator artifact without further model
calls. Across 64 authored positive/negative pairs, both answers were correct for
37 pairs, one was correct for 26, and both were wrong for one. The model gave the
same decision to both members of 26 pairs despite opposite labels.

The executable cases expose a more specific boundary:

| Executed control | Correct / total |
| --- | ---: |
| Cosmetic changes preserving the result | 47 / 48 |
| Mutated expressions changing this input's result | 19 / 23 |
| Mutated expressions leaving this input's result unchanged | 12 / 25 |

Thus 13 false alarms came from changed expressions on unaffected inputs. This
pattern is consistent with overgeneralizing possible behavioral change to a
particular input, but boolean outputs cannot establish the model's internal
reason. Jev subsequently scored 48/48, 19/23 and 23/25 respectively: its main
gain was fewer false alarms on unaffected inputs, not better detection of real
changes. Aggregate mutation accuracy alone obscures this distinction. Evidence:
`.planning/jev/matched-control-audit.json`.

An independent read-only audit executed 56 scoped cases without using the corpus
oracle helper: all 48 cosmetic controls plus eight additional boundary/equality
mutations. Every frozen label agreed with JavaScript execution. It confirmed
seven logged model mistakes, checked raw decision text against cached labels,
and verified request fingerprints and polarity. No label/replay defect was
found in that subset. This does not independently adjudicate all authored cases.

This audit does not change the frozen prompts or labels. Any later prompt work
motivated by the completed holdout must use a newly held-out evaluation set.

## Next discriminating experiments

1. Audit the completed 2,240-request matrix for negation, option-order, padding,
   and injection failures; use new development probes to diagnose mechanisms.
2. Extend the measured Choice reranking gain to harder, separately held-out
   tasks with realistic missing-candidate and distractor-bearing no-answer cases.
3. Test refutation-first orientation: select one source span that challenges a
   proposed change, then measure whether inspecting it changes a wrong decision.
4. Test semantic conflicts between disjoint agent worksets using protocol
   mutations; compare with the existing deterministic path-overlap signal.
5. Only after useful held-out results, run a disposable client canary with whole
   sessions assigned to control/treatment and correct completion as the outcome.

## Opt-in source-assumption prototype

The standalone checker accepts a claim and three or four explicit tracked
JavaScript declarations. It collects exact AST spans, asks the same three typed
questions as the source experiment, and rechecks source hashes after inference.
A refutation suggestion requires agreement between the contradiction verdict,
answerability and selected source scope. Disagreement or changed source becomes
`needs_review`. Model support remains a model assessment, never a structural fact.

```bash
node experiments/jev/assumption.js inspect --root /root/sextant \
  --claim 'The retrieval renderer always includes every candidate file regardless of its character budget.' \
  --scope lib/format-retrieval.js:formatRetrievalDetailed \
  --scope lib/format-retrieval.js:formatFileLine \
  --scope lib/coherence.js:visibleRoleWorkset
```

Replace `inspect` with `live` and add `--out path/to/new-assessment.json` to make
one provider request with `TYPESAFE_API_KEY` in the process environment. Inspect
makes zero provider calls. This command does not install hooks or change the
main Sextant CLI. Live artifacts retain the exact evidence and typed responses.

Three authenticated canaries returned the expected paths: a located refutation
for the unbounded-renderer claim, model support for text-only label suppression,
and insufficient evidence for current public delivery. All three completed with
matching source freshness checks. Artifacts are
`.planning/jev/assumption-canary-{visible-prefix-negative,text-only-structure-positive,public-delivery-unknown-positive}.json`.
These reuse development claims and demonstrate live integration, not new
independent accuracy. The experimental suite passed **136 tests** at this point.

The follow-up equality diagnostic and counterfactual source experiments are
reported separately in [047](047-jev-mechanism-probes.md). They were motivated by
observed failures and remain development evidence.

Disjoint-file agent interactions are measured in
[048](048-jev-coordination.md): 32 executable protocol fixtures compare baseline,
each edit alone, and both edits together. The direct three-head formulation
produced 18 internally contradictory decisions despite useful regression signal.
Atomic follow-up results belong beside that finding, not in an aggregate score
that hides the compound-question failures.

## NEXT: research decisions from measured evidence

| Candidate | Decision and discriminating next test |
| --- | --- |
| Refutation-first source inspection | Keep the standalone opt-in checker; evaluate new repositories and real mistaken plans before ambient delivery. Coherent wrong regex judgments survive the current consistency gate. |
| Choice candidate reranking | Continue on harder held-out pools, including answer-missing pools and source-definition/consumer ambiguity. Measure candidate recall separately. |
| Source representation compiler | Promising: literal syntax improved equality judgments in both frozen cohorts. Test different languages and tasks without retrofitting the existing holdout. Preserve exact code and deterministically derived type facts. |
| Cheap extraction cascade | Defer the economic claim: the zero-observed-error gate escalates 82% of holdout. Measure actual strong-model repairs and total cost before adoption. |
| Multi-agent semantic coordination | Keep experimental. Compound conditions produce false positives and contradictions; test small judgments plus deterministic logic, then realistic patches with execution-backed labels. |
| Universal verifier / arithmetic authority | Unsupported by these results. Execute what can be executed, and retain parser/hash/runtime evidence as separate authority. |

The next product-level outcome is whether a located counterexample changes a
coding agent's mistaken plan and improves completion. Assign whole sessions to
control/treatment on a disposable canary; do not treat model accuracy, more file
opens, or internal logical consistency as that outcome.
