# Jev against actual Sextant retrieval

Date: 2026-09-22. Status: runnable isolated experiment; actual repository candidate collection verified; provider quality not yet measured.

## What runs

[`experiments/jev/repository.js`](../experiments/jev/repository.js) copies allowed tracked working-tree files into a disposable snapshot, runs Sextant's actual `intel.scan()` and `retrieve()` on that snapshot, then builds bounded Jev questions over the returned files and source excerpts. It uses the existing 21-query [`scripts/eval-dataset.json`](../scripts/eval-dataset.json), with labels retained only in local artifacts.

This isolation is necessary because `retrieve()` calls `intel.health()`, whose initialization can write local Claude hook settings. All generated index and settings files belong to the snapshot. The experiment does not initialize the live checkout, start watchers, install integrations, or change the runtime retrieval pipeline.

Collection pins the existing `rg` plus graph route, including the evaluation harness's `rerankMinResolutionPct: 0`. It does not claim equivalence to a warmed Zoekt backend. Candidate order comes from real retrieval. At most eight returned files reach Jev, each with up to two actual line windows capped at 1,500 bytes. The complete request is capped at 40,000 bytes. Oversized single-line hits are omitted rather than presented as a complete span.

For each file, a Noul asks whether the supplied source evidence directly helps with the query. A Choice selects the best file or `none`. Candidate IDs map to exact paths in the request itself; answer-map keys alone do not carry semantics for Jev. No dataset labels, relevance patterns, explanations, hashes, or unbounded repository contents enter provider state.

## Commands

Collect and inspect all 21 queries, with zero provider calls:

```bash
node experiments/jev/repository.js inspect
```

`dry` is an alias for `inspect`. Optional `--limit N` selects the first N cases in existing dataset order; `--candidates N` permits 1–8 candidates. The model defaults to pinned `jev-1.13.0` and can be explicitly changed with `--model`.

Collection outputs a new directory under `.planning/jev/`, containing:

- `snapshot/`: filtered local source plus disposable index/settings.
- `manifest.json`: original HEAD, individual source SHA-256 hashes, aggregate source hash, dataset hash, runner hash, model, bounds, and timestamp.
- `tasks.json`: requests, exact candidate/path/span mapping, local labels, request hashes, retrieval warnings, and untruncated returned file ranking.
- `summary.json`: baseline and candidate-coverage metrics; no model-quality claims.

When `TYPESAFE_API_KEY` is available, run a previously collected artifact through the isolated client:

```bash
node experiments/jev/repository.js live \
  --input .planning/jev/repository-validated \
  --out .planning/jev/repository-validated-live.jsonl
```

The output path must be new. The runner checks artifact and request hashes and reconstructs each bounded request before any provider call. It emits durable manifest/result/error/summary records, preserves actual returned model and token usage, and stops on the first error. It does not retry silently. The published input-token estimate is not an invoice and excludes failed calls.

The persisted request bytes are reproducible. Remote model outputs are not promised to be deterministic; collection uses no random sampling, so the manifest records fixed order and a null seed.

## Pollution and source boundaries

Exclusions happen **before indexing and search**, because post-filtering can leave candidate ranking polluted. The snapshot excludes the experiment directory, docs numbered 042 and above, existing evaluation-label/harness noise, generated state, agent settings, sensitive paths identified by Sextant's existing `isSensitivePath()`, and symlinks. Only tracked regular files are copied. Working-tree modifications are included and hashed; untracked files are omitted. Deleted tracked files are omitted and listed among exclusions. Source bytes and HEAD are rechecked while constructing the snapshot.

The sensitive-path guard is a path policy, not a proof that arbitrary source code contains no embedded secrets. Provider input is limited to the explicit source windows stored in `tasks.json`; those bytes are available for review before live execution.

## Metrics

The existing harness's relevance convention is preserved: primary file gain 2, other relevant files gain 1, acceptable files gain 0.5. MRR uses the primary file, with a rank-10 ceiling. nDCG's ideal denominator includes all labeled relevant/acceptable files, including those missing from the candidate pool.

Reported arms are:

- `baseline`: original candidate order.
- `noul`: candidates sorted by absolute relevance probability; ties preserve baseline order.
- `choiceRelative`: candidates sorted by Choice probability regardless of `none`.
- `choice`: the returned `choice` is placed first (including probability ties), followed by the remaining probability ordering; a winning `none` produces an empty ranking.

Positive-query MRR/nDCG exclude no-answer controls; those controls have separate evaluated/correct counts. This avoids penalizing a correct empty answer as failed retrieval. Candidate recall and primary-file coverage remain explicit. A reranker cannot repair a missing file, and file-level presence does not prove the bounded excerpts include decisive context.

## Actual local result

Verified artifact: `.planning/jev/repository-validated/`, collected from HEAD `95712cc45636cc5cc4a11e97511f44dd1489a08f`. Dataset SHA-256: `d89e36d7a5d42d4660ff33c669b8527bb657a6febb36bc183c5a1afc0c09fa00`.

| Measurement | Observed |
| --- | ---: |
| Queries collected | 21 |
| Positive-query primary file coverage | 20/20 |
| Mean relevant-file recall | 0.95 |
| Baseline primary-file MRR | 0.8946428571 |
| Baseline nDCG | 0.8940420468 |
| No-answer controls | 1 |
| Provider calls | 0 |
| Largest request | 13,537 bytes |
| Locally snapshotted source files | 330 |

`path-002` omits secondary gold `lib/intel.js`; `cross-002` omits secondary gold `bin/intel.js`. Their primary files are present. This documents a candidate ceiling before spending on semantic reranking.

The earlier `.planning/jev/repository-first/` collection predates the no-answer denominator correction and its stored summary is superseded by `repository-validated`. Its requests were not sent to a provider.

Ran `node --test experiments/jev/repository.test.js`: 11 passed. Tests exercise label stripping, candidate/path identity, sensitive-path and symlink exclusion, actual dirty-file snapshot bytes, omitted-gold metrics, empty candidates, no-answer denominators, malformed responses, tampered artifacts, fake-transport live orchestration, and durable partial failure records. Fake-transport results verify the runner and metrics, not Jev intelligence.

Independent replay found and corrected three reporting defects: Choice ties must honor the returned selected option; different actual model versions must not share a pooled quality curve; duplicate result IDs must not inflate denominators. Summaries now partition results under `byModel`, omit pooled model quality when versions differ, reject duplicate/unknown result IDs, and report planned/succeeded/failed/pending counts with missing identities. Live evaluation records both the original collection runner hash and current evaluator hash. The existing frozen collection remains valid input; its historical manifest is not rewritten to pretend it used newer evaluation code.

## Interpretation and next experiment

This is an existing self-referential dataset developed alongside Sextant. It is useful for integration and regression measurement; it is not an independent code-intelligence benchmark. The high baseline leaves limited headroom. A win here would justify testing held-out natural-language tasks, wrong-premise requests, negative controls, and executable behavior mutations on another repository. It would not establish improved coding-agent task completion or justify restoring ambient fleet integration.

## Actual-source refutation and answerability tasks

[`refutation.js`](../experiments/jev/refutation.js) adds **32 tasks in 16 matched pairs**. Each pair proposes a positive and negative claim over identical evidence. The evidence consists of 3–4 verbatim AST-extracted declarations from tracked Sextant source, with file/scope SHA-256 hashes, source offsets, line locations, and HEAD. No generated behavioral summaries substitute for code. Candidate ordering rotates deterministically using seed `20260922`, so refuting evidence does not always occupy the first option.

The tasks examine behavior that exact-symbol retrieval misses: visible candidate truncation, reminder budget overrun, stale-text rendering, delivered-workset filtering, neutral context roles, capped overlap displays versus full totals, the two coherence gates, unknown provenance, inverse structural changes, oversized-single-line clamp exceptions, environment-template suffixes, closure disclaimers, repository-state equality, and explicit backend selection. Two additional pairs ask about current public delivery and production runtime execution. Static local source establishes neither polarity of those current-event claims, so both must remain `insufficient` rather than treating missing support as a contradiction.

The provider request carries only the proposed claim and actual source scopes. It asks for:

- A three-way verdict: `supports`, `contradicts`, or `insufficient`.
- The strongest directly refuting scope, or `none`.
- A Noul indicating whether the supplied evidence resolves the claim's truth at all.

Labels, group/polarity metadata, rationales, and hashes stay local. Author-written rationales explain which guard, return value, or observation boundary supports each label. The 28 determinate tasks contain 14 support and 14 contradiction labels; four current-event tasks require insufficient evidence. These are development cases, not an independently held-out benchmark. Keep both polarities in the same split in any later experiment.

Validate source and request construction with zero provider calls:

```bash
node experiments/jev/refutation.js inspect
node --test experiments/jev/refutation.test.js
```

Freeze the source, labels and exact provider requests into a new immutable-by-fingerprint local artifact:

```bash
node experiments/jev/refutation.js freeze --out .planning/jev/refutation-frozen.json
```

The current 32 tasks were frozen at that path. The file records model `jev-1.13.0`, seed `20260922`, source hashes and coordinates, collector hash, exact label-free requests, request hashes, and a whole-artifact fingerprint. Rebuilding source tasks verifies current tracked bytes; replaying a frozen artifact uses its captured evidence rather than silently substituting newer source. A later collection requires a new filename. Largest observed request: **6,314 bytes**.

With a key available, execute and replay the frozen plan:

```bash
node experiments/jev/refutation.js live \
  --input .planning/jev/refutation-frozen.json \
  --out .planning/jev/refutation-live.jsonl
node experiments/jev/refutation.js report --input .planning/jev/refutation-live.jsonl
```

Live execution reconstructs and validates all requests before creating its new output file, then calls the existing isolated client without retries. Its manifest embeds the frozen experiment and the evaluator hash. Every result is tied to a request hash and the exact sequential plan. A failure writes a sanitized error and a durable partial summary, then stops. Reports reject duplicate/out-of-order results, changed request fingerprints, and events after an error.

Metrics remain separate: three-way verdict confusion/accuracy, exact refutation-scope accuracy including `none`, and answerability confusion/Brier score at the fixed `p > 0.5` threshold. Refutation-required and `none`-required counts are also shown separately. Summaries report planned, completed, failed and unattempted identities. Every quality metric is partitioned by actual returned model; there is no mixed-model quality average. Latency and input/output tokens are recorded by model.

The CommonJS module exports `{tasks, buildRequest, validateTasks, buildTasks, readScope, SEED, freezeTasks, validateFrozen, report, runFrozen, main}`. Supplying an injected client to `runFrozen` marks the entire run `mock-transport`; its output explicitly says no provider intelligence was measured.

Ran the refutation test suite: **15 passed**. Besides checking provenance and label exclusion, tests execute real formatter, workset, clamp, sensitive-path, and gate behavior; non-exported pure predicates are evaluated from their exact AST source. Fake-transport tests independently verify confusion/Brier arithmetic, actual-model partitions, immutable fingerprints, exact scheduling, and partial failure records. Those checks establish runner behavior and concrete labels for the exercised cases. They do not establish Jev accuracy. No constructor-bypass case was invented: the available Sextant source supplied stronger directly testable behavior boundaries.

## Pre-result product decision criteria

Recorded September 22 before this reviewer opened any live Jev result. These are engineering advancement gates chosen for this program, not statistically validated safety guarantees. A miss remains a recorded miss; later prompt changes require a new experiment rather than moving these thresholds retrospectively.

**Selected path:** an explicitly invoked, lab-only assumption check: provide a proposed claim and bounded real source scopes, then receive candidate evidence to inspect, its source fingerprint, and a model verdict distinguished from verified file facts. First measure whether it finds a useful contradiction or correctly requests missing evidence. Do not insert its verdict into the structural claim ledger, clear a stale/blackout gate, certify completion, or silently add an ambient network dependency. Existing CLI experiments are the initial entrypoint; a production command is contingent on later evidence.

Historical economics constrain that choice. The hibernation checkpoint records 27.6% stale/blackout reads, 92 empty retrieval turns out of 224, and only 0.8% surfaced-file open precision. Its armed/holdback comparison was underpowered and contaminated by mixed-arm sessions; it did not prove harm or benefit. Cheap verifier tokens do not repair missing candidates, stale evidence, or an intervention that rarely helps. An on-demand check avoids paying network latency on every prompt while its value remains unknown. [Hibernation evidence](../HIBERNATION.md)

| First live decision | Predeclared criterion | Consequence |
| --- | --- | --- |
| Evidence-boundary integrity | All four current public-delivery/runtime-event claims remain `insufficient`, with no selected refutation; answerability must stay at or below 0.5 | Any miss blocks promotion beyond the lab; a confident wrong assertion is a priority failure case |
| Source verdict discrimination | At least 26/28 determinate claims correct, including at least 13/14 contradictions | Below this, revise question/state design or abandon this formulation before expanding integration |
| Useful refutation localization | At least 12/14 contradictory claims select the authored refuting scope; at most one false refutation across 18 expected-`none` cases | Adjudicate alternate valid scopes against source before treating a selection miss as a model error; report original and adjudicated counts separately |
| Cost of an explicit check | Successful-call p95 wall time at most 2 seconds and mean estimated input cost at most $0.001/task; report failed-call count separately | Above either bound, keep asynchronous/offline research use only; no synchronous product path |
| Reranking as an alternative | Same candidate pool: MRR improvement at least 0.03, no aggregate nDCG loss, and no degradation on cases whose baseline primary file is already first | Otherwise deprioritize reranking; high existing accuracy and missing secondary gold limit available benefit |

Passing these small authored suites authorizes **held-out validation**, not a production release or fleet restoration. Before a disposable opt-in canary, require at least 100 fresh task groups from three repositories, with no paraphrase/mutation family crossing development and evaluation. Keep the thresholds and comparison policies fixed before reading that holdout. Compare correct issue resolution and unnecessary source reads against current retrieval, an always-`none` abstention control, literal symbol/path selection, and direct executable/AST checks wherever they solve the question exactly. The Jev path must improve a task outcome or reduce inspection work at matched success, not merely emit plausible probabilities. A future causal canary assigns treatment for the whole session to avoid the previous context-carryover defect.

Kill or narrow the integration if confident semantic judgments repeatedly overrule executable evidence, if uncertainty abstention manufactures an apparent accuracy gain by collapsing useful coverage, or if equal-budget deterministic checks win. Even strong static-source results cannot establish browser delivery, runtime execution, test effectiveness, or task completion without the corresponding observations.

## First live results: independent audit against those criteria

Audited only after terminal summaries were present. Both runs returned `jev-1.13.0`, completed every planned request, and recorded zero errors. Artifacts:

- `.planning/jev/jev-refutation-2026-09-22T05-40-13-719Z.jsonl`: 32 requests.
- `.planning/jev/jev-repository-2026-09-22T05-40-13-719Z.jsonl`: 21 requests.

This reviewer recomputed retrieval MRR/nDCG from the original frozen candidate IDs and raw provider probabilities without calling the runner's metric functions. All 98 refutation scope occurrences were checked against actual file hashes and exact source offsets. The original labels and advancement thresholds remain unchanged.

| Predeclared criterion | Observation | Decision |
| --- | --- | --- |
| Public/runtime evidence boundary | All four verdicts `insufficient`; all refutation selections `none`; answerability 0.08, 0.08, 0.15, 0.11 | Met |
| At least 26/28 determinate verdicts, including 13/14 contradictions | 28/28 and 14/14 respectively | Met |
| At least 12/14 refutations located; at most one false refutation among 18 `none` labels | 14/14 located; one false refutation, 17/18 correct `none` | Met, exactly at the permitted false-refutation count |
| Explicit-check latency/cost | Refutation p95 299.6 ms; mean estimated input cost $0.000058716/task | Met |
| Choice reranking improvement at least 0.03 MRR, no nDCG loss, no harm to baseline-first cases | MRR +0.042857; nDCG +0.023225; all 17 baseline-first cases preserved | Met |
| Same reranking criterion for Noul sorting | MRR +0.013690; nDCG +0.000890 | Not met: incremental gain below 0.03 |

Refutation verdict accuracy was 32/32 across support, contradiction, and insufficient evidence. Answerability at the fixed threshold also scored 32/32, with Brier score 0.01148125. Total refutation input was 44,736 tokens, estimated at $0.001878912 using the recorded published rate. These are small authored development results, not calibrated error guarantees.

Repository Choice ranking improved frozen-label MRR from **0.894643 to 0.937500** and nDCG from **0.894042 to 0.917267**. The single no-answer control selected `none`. Successful-call p95 was 320.0 ms; 54,022 input tokens imply $0.002268924 total, or $0.000108044/task. Primary coverage remains 20/20 and mean relevant-file recall remains 0.95; reranking did not recover the two omitted secondary gold files.

### Failures and label ambiguity that the aggregate hides

**Inconsistent refutation heads.** For `inverse-delta:positive`, the verdict correctly selected support (probability 0.77, confidence 0.67), yet the independent refutation question selected `foldObservedPair` as opposing evidence (probability 0.57, confidence 0.42) instead of `none` (0.43). The [actual function](../lib/closure.js), lines 40–47, deletes an already-added value and records a removal only when that deletion fails. The executable control confirms cancellation. This is a false refutation, not an alternate valid citation. A proposed downstream rule that only displays a refutation when the verdict also says `contradicts` would suppress this case, but that rule was **not** part of the frozen experiment and needs prospective evaluation.

**A confident disagreement with incomplete gold is not automatically a model error.** `multi-003`, the bare query `resolutionPct`, selected `lib/graph.js` with probability 1.00/confidence 0.99, whereas frozen primary gold is `lib/summary.js`. The supplied [graph source](../lib/graph.js), line 1120, actually computes `resolutionPct`; the supplied [summary source](../lib/summary.js), lines 557–565 and 606–614, consumes it for display. The authored dataset omits the computation site from both relevant and acceptable files. The original score is retained, but this case cannot substantiate a hallucination claim. It exposes ambiguous query intent and incomplete relevance labels; any revised gold must be versioned for a new evaluation.

**A remaining user-facing target miss.** For bare query `statusline`, Choice selected acceptable `lib/cli.js` with probability 0.93/confidence 0.92; canonical `scripts/statusline-command.sh` improved from rank 7 to rank 2. The supplied [CLI excerpt](../lib/cli.js), lines 16–20, distinguishes diagnostic stderr from the configured user status line. The supplied [shell script](../scripts/statusline-command.sh), lines 3–11, identifies the user-visible implementation and installation path. This remains a primary-file localization miss under a defensible frozen label, despite aggregate improvement and high confidence. The model's certainty should not promote its selected path into an authoritative delivery claim.

No confidently wrong public-delivery or runtime-event assertion occurred in these four boundary controls. That limited observation does not license static code to answer future runtime questions. The outcome supports the **next held-out experiment** for explicit assumption checks and Choice reranking. It does not establish superiority over equal-budget deterministic checks or reasoning-model alternatives, causal coding productivity, general calibration, or readiness for ambient integration.
