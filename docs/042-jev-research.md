# Jev research for Sextant

Accessed: 2026-09-21. Scope: primary-source documentation investigation and experiment design. This document does not claim measured Jev performance on Sextant. Live experiment results belong in separately timestamped artifacts.

## The useful product hypothesis

Sextant already knows how to find real paths, extract declarations, preserve provenance, and withhold stale structural claims. Jev could cheaply decide **which verified evidence a coding agent should inspect next, including evidence that challenges its plan**. The opportunity is a probabilistic inspection layer attached to an honest map.

The vendor explicitly says Jev does not generate code, explanations, or conversation. Its interface is bounded decisions over supplied text. This makes candidate selection, semantic triage, and evidence checks plausible; autonomous code reasoning remains a separate capability. [Coding-agent guidance](https://docs.typesafe.ai/introduction/coding-agents)

Repository constraints matter. [CLAUDE.md](../CLAUDE.md) historically excludes LLM calls from the pipeline, and [HIBERNATION.md](../HIBERNATION.md) describes an underpowered, contaminated benefit experiment. The owner's current request authorizes experimental exploration. That supports an isolated laboratory, not an unmeasured change to ambient hooks or fleet restoration. Existing structural guarantees should survive every candidate design.

## Source coverage and current contract

Started from the complete [documentation index](https://docs.typesafe.ai/llms.txt), then downloaded all indexed non-SDK documentation and selected JavaScript API references. Browser `web.open` failed for the index and initial pages; Python HTTPS retrieval succeeded. Temporary source copies are under `/tmp/sextant-jev-research`, so those copies are convenience evidence rather than durable artifacts.

| Property | Published current contract |
| --- | --- |
| Model | `jev-1.13.0`; `jev-latest` and `jev-preview` currently resolve to it |
| Price | $0.042 per million input tokens; output tokens free |
| Context | 64k tokens for state plus all questions; state plus longest question must fit 32k |
| Throughput | 250,000 tokens/second and 1,200 requests/minute; explicitly subject to change |
| Modalities | Text / structured textual state; no native images, audio, or video |
| Model discovery | `GET /v1/models` may list aliases without listing accepted versioned IDs |
| Customization | Same weights across accounts; domain adaptation through state/questions or downstream supervised models |

Pin the version in experiments and record the response model. Cookbook examples frequently use `jev-1.12`; their cached results are not measurements of 1.13. Vendor data-handling documentation says customer requests/responses are not training data; enterprise zero-retention is separately described, so do not infer zero retention for every account. [Models](https://docs.typesafe.ai/models)

`POST https://api.typesafe.ai/v1/systemone` accepts Bearer authorization and JSON `{model, state, questions}`. Responses contain `{model, answers, usage}`. Answer keys match supplied question keys, **but question keys are not visible to inference**: include target identifiers and semantics in instructions. HTTP documentation describes state as string/object/array; JavaScript types additionally admit `null`. Use non-null state until that discrepancy is tested. [HTTP API](https://docs.typesafe.ai/api), [JavaScript payload](https://docs.typesafe.ai/sdk/javascript/api/interfaces/SystemOneRequestPayload)

| Primitive | Request criteria | Returned signal | Appropriate Sextant use |
| --- | --- | --- | --- |
| Noul | Optional explicit `true` / `false` descriptions | `noul` in [0,1]; no confidence field | Whether one candidate supplies a specific missing fact |
| Choice | Map of options to descriptions; maximum 255 | Chosen option, option probabilities summing to one, confidence | Select a supplied path/span; preserve an absence option |
| Score | Ordered descriptions; 2–10 levels | Expected level, level distribution, legend, confidence | Ordinal usefulness/risk features, not exact quantities |

These output types constrain representation; they do not prove semantic correctness. [Noul](https://docs.typesafe.ai/primitives/noul), [Choice](https://docs.typesafe.ai/primitives/choice), [Score](https://docs.typesafe.ai/primitives/score)

Confidence summarizes the probability distribution; it is not synonymous with the winning probability or an independent calibrated probability of correctness. The interactive documentation labels its displayed formula an approximation. Preserve returned confidence and the full distribution; do not reconstruct an undocumented canonical formula. Calibrate task thresholds empirically. [Confidence](https://docs.typesafe.ai/confidence)

The JavaScript SDK has operational defaults worth overriding for experiments: 10-second timeout **per attempt**, no total retry budget; debug logging includes request bodies. Retry defaults include connection/timeouts, HTTP 408, 429, and 500–599, with two retries. This is broader than the HTTP page's 429/529 discussion. Record attempts and distinguish logical calls from network requests. [Client configuration](https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig), [Retry policy](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy)

## Failure boundaries to investigate explicitly

Vendor-documented 1.13 weaknesses include counting, numeric precision, date ordering, indirect questions, double negatives, distractor-heavy state, and adversarial state text. Noul complements need not sum to one; Noul and binary Choice need not agree. Thresholds do not transfer between primitives. These are reasons to measure bounded judgments while code owns arithmetic, provenance, path existence, freshness, and execution policy. Prompt-injection detection by Jev must itself be evaluated against prompt injection. [Jev jaggedness, reviewed September 17](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

TypeSafe attributes calibration to RLCD training. That is a vendor training claim; this investigation has neither weights nor an independent calibration benchmark. Group calibration does not imply correctness of any individual prediction. [System One](https://docs.typesafe.ai/concepts/system-one), [AI primer](https://docs.typesafe.ai/introduction/machine-learning-primer)

## What the cookbooks establish—and what they do not

| Cookbook | Vendor-reported observation / method | Sextant implication and measurement limit |
| --- | --- | --- |
| [SDE cascade](https://docs.typesafe.ai/cookbooks/sde_cascade) | Small extractor → field checks → expensive extractor; 100-prompt internal frontier; worked mini fabrication hard-coded | Field-level semantic flags are useful hypotheses. Neither the worked fabrication nor a historical cost curve measures a live codebase cascade. A shown implementation defect is reproduced below. |
| [Reranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe) | 40 CLERC queries × 30 BM25 candidates; top-1 5%→18%, top-10 38%→62%; 1,200 calls cost $0.0645 | Candidate selection is plausible. Legal relevance does not establish code relevance; candidate recall sets a hard ceiling. The demo uses one call per pair, not one shared candidate-set call. |
| [Parallel questions](https://docs.typesafe.ai/cookbooks/parallel_questions) | 13 questions, five repeats, one GDPR document; batched $0.000497/0.27s versus sequential singles $0.006090/2.71s | Shared-state batching is economically attractive. Its latency comparator is sequential singles. The table contains small probability differences; it does not establish universal batch invariance. |
| [Semantic find](https://docs.typesafe.ai/cookbooks/semantic_find) | Choice ranks 218 line IDs; a separate Noul tests answer existence | Use real source-span IDs plus an absolute evidence gate. Choice must rank something even if all candidates fail. Large files need deterministic chunking below 255 options. |
| [Hierarchical classification](https://docs.typesafe.ai/cookbooks/hierarchical_classification) | Greedy versus parallel beam traversal through taxonomies and cookbook source paths; geometric-mean edge score | Evaluate folder→file→scope search as a ranking heuristic. Geometric means are not calibrated leaf probabilities; path depth and branch arity can distort comparisons. |
| [Autoresearch](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery) | 1,200 development / 800 held-out wine reviews; 38 questions after five rounds give RMSE 1.77, versus 1.87 after first proposal and 2.47 word-count CatBoost | Learn semantic numeric features for downstream routing. Most published gain occurs on first proposal; the loop's incremental gain is modest. Keep repository/session families out of the optimization holdout. |
| [Skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion) | Broad ranking over 182 skills, then full-text verification of top three, with rejection permitted | Progressive disclosure can apply to code scopes, not just skills. Measure two-stage exclusion errors; a missed candidate cannot recover. |
| [Citation checks](https://docs.typesafe.ai/cookbooks/citation_check) | Exact quote matching precedes contextual support/contradiction judgment | Prove file/span/hash matches deterministically before asking whether a source supports a coding claim. Semantic verdicts remain advisory. |
| [Pre-parsed extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook) | Regex candidates → model selection → code copies original value | Candidate IDs can select actual exports, callers, and source lines without generating invented paths. Candidate omission remains the dominant failure. |
| [RAG passage classification](https://docs.typesafe.ai/cookbooks/classifying_rag_passages) | Relevance, usable evidence, contradiction, and instruction detection steer routing | Preserve contradictory evidence as an inspection target. Do not silently discard it for disagreeing with the task premise. |
| [Noul consistency](https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook) / [Choice consistency](https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook) | Repeated borderline cases; explicit uncertainty reduces conflicting actions but reduces automatic coverage | Report accuracy, abstention, conflicts, and coverage together. Determinism and high agreement can accompany consistently wrong or always-abstaining systems. |

### Independently replayed SDE defect

The shown `build_questions` traverses `record.items()`. Its gate excludes the overall question. I extracted the actual function from the downloaded cookbook and executed it with a lightweight Noul container and one-field schema, without any model/network inference:

| Input record | Observed result |
| --- | --- |
| `{}` | Zero field heads; the per-field gate cannot fire even with a high overall score |
| `{"date":""}` | `date::absence_wrong` exists |
| `{"extra":"x"}` | `KeyError` when looking up the unknown property |

The cookbook comment says a parse failure converted to `{}` escalates; the displayed function does not accomplish that. This is a code-path defect, not a measured Jev weakness. A correct experimental cascade must validate structure first, traverse schema-required properties, distinguish absent from empty, and explicitly handle extra properties. Never equate an empty verification battery with acceptance. [Displayed SDE implementation](https://docs.typesafe.ai/cookbooks/sde_cascade)

## Experimental portfolio

All rows below are proposals, not shipped capability or claims of novelty. `N` denotes Noul, `C` Choice, `S` Score. Ground truth should come from executable fixtures, source evidence, or blinded human labels—not from Jev's own answer.

| ID | Experiment and falsifiable hypothesis | Design / decisive measurement |
| --- | --- | --- |
| E01 | Natural-language relevance beats lexical ranking on lexical-gap queries | N per real scope; freeze candidate pool; MRR/nDCG and relevant-candidate recall versus current retrieval |
| E02 | Absolute answer-existence prevents confident irrelevant retrieval | C ranking + independent N; add no-answer tasks; false-positive rate at fixed answer recall |
| E03 | Intent triage rescues ambiguous code requests without spurious context | C on classifier borderline band; compare against `lib/classifier.js`; precision/recall and wall time |
| E04 | Source-span selection improves first inspection | C over parser-produced spans, not arbitrary generated line numbers; correct enclosing-scope rank |
| E05 | Definition/consumer/test/doc roles improve multi-role worksets | N per role and candidate; measure role coverage, not just file-open rate |
| E06 | Behavioral query expansion can stay within real vocabulary | C over repository identifiers derived in code; compare recall against original terms and broad OR search |
| E07 | Semantic reranking preserves exact-symbol strengths | Mixed exact/NL evaluation; reject aggregate wins hiding regression on exact definitions |
| E08 | Small-state judgments outperform large shared candidate state | Same candidates judged individually, in chunks, and together; quality/cost/latency frontier |
| E09 | Folder beam search can cheaply rescue absent lexical hits | C tree traversal vs graph/text shortlist; vary beam 1/2/4 and branching; missing-leaf recall per token |
| E10 | Refutation-first orientation catches wrong premises | N asks whether source contradicts a proposed assumption; pair true/false task premises; contradiction precision and correct repair rate |
| E11 | Counterfactual source ablation localizes decisive evidence | Remove one source span at a time; compare probability delta against known guard/return mutations; localization accuracy |
| E12 | Constraint coverage finds what a patch forgot | N per explicit user constraint against patch + local context; fixtures violate one constraint at a time; missed-constraint recall |
| E13 | Semantic workset collision detects coupling across disjoint files | N on two tasks plus verified paths/contracts; compare with exact path overlap; adjudicated coordination needs |
| E14 | Change-effect triage targets meaningful tests | N per available test scope and patch; measure detection of real mutants under a fixed test-time budget |
| E15 | Test-source mismatch identifies vacuous checks | C distinguishes behavior verification, implementation mirroring, unrelated coverage; mutation/positive controls, not test-name similarity |
| E16 | Claim auditing reduces unsupported completion claims | Deterministic file/quote match, then C supports/contradicts/insufficient; blinded claim labels; preserve `lib/closure.js` factual boundary |
| E17 | Rejected-approach applicability survives renames | N on recorded reason/preconditions + current candidate; compare stale/superseded/applicable examples; false revival rate |
| E18 | Intent-preserving source edits should preserve decisions | Rename local identifiers / reorder independent declarations / alter comments; compare paired probabilities and decisions |
| E19 | Behavior-changing minimal edits should change decisions | Flip guard, remove await, swap ordering, change null handling; pair with E18; sensitivity/specificity |
| E20 | Dead-path decoys expose narrative-over-code reliance | Put correct-looking comments in unreachable branches and wrong implementation in live branch; compare statement vs execution labels |
| E21 | Cross-language semantic features transfer | Parallel JS/Python/Swift examples; hold out language and repository; accuracy loss and coverage |
| E22 | Active question portfolios outperform a single holistic judge | N/S atomic heads vs holistic C; cost-matched held-out classification; ablate each head and correlated groups |
| E23 | Next-observation selection reduces investigation work | C selects from deterministic candidate reads/tests; replay hidden-evidence puzzles; steps to correct answer at equal success rate |
| E24 | Semantic graph hypotheses reveal missing inspection edges | N on candidate file pairs retrieved by existing structure/text; measure new true relationships through source review; never insert asserted import edges |
| E25 | Context poisoning can be measured and contained | Insert instructions into comments, docs, filenames, and string literals; compare protected instruction rubrics; attack success and benign false positives |
| E26 | API question decomposition has measurable failure boundaries | Compare direct/negated questions, N versus C, option order/count, duplicate distractors, key renaming; report instability rather than assume invariance |
| E27 | Semantic profile drift signals when an old task memory needs rereading | Ask fixed narrow questions on old/current scopes after deterministic freshness detection; detect behavioral vs cosmetic changes; avoid replacing freshness checks |
| E28 | Abstention-aware cost routing beats escalating every task | Current retrieval → Jev ambiguity/evidence checks → optional reasoning; cost, incorrect acceptance, latency, and success at matched coverage |

Existing anchors: [classifier](../lib/classifier.js), [scope finder](../lib/scope-finder.js), [closure](../lib/closure.js), [retrieval evaluation labels](../scripts/eval-dataset.json), and JS/Python/Swift fixtures. These are integration candidates discovered in source, not evidence that the experiments already work.

## Evaluation rules that make the learning credible

1. **Freeze before tuning.** Fix repository HEAD, file bytes, task labels, candidate pool, question revision, model, and seed. Record full distributions, versioned model, usage, latency, and errors. A seeded local corpus does not make remote inference deterministic.
2. **Separate transport from intelligence.** Unit tests with mock responses prove validation, batching, escalation, and metrics only. Live API outputs prove observed behavior on those inputs. Neither proves production benefit.
3. **Split by task family and repository/session.** Keep paraphrases and positive/negative mutations from the same seed task together. Cross-language variants belong to the same leakage group. Use a final holdout the autoresearch proposer never reads.
4. **Use fair candidates.** Run rerankers over identical pools. Measure retrieval recall before reranking. A semantic model cannot recover a missing file unless a separate tested discovery stage supplies it.
5. **Keep negative and mutation controls.** No-answer tasks, irrelevant but lexical matches, stale citations, malformed responses, prompt injection, unreachable code, and unrelated edits must all appear. Include positive controls so an always-abstaining verifier cannot pass.
6. **Keep metrics separate.** Report accuracy/Brier score, calibration by bins, selective risk/coverage, false acceptance, MRR/nDCG, relevant recall, wall-clock latency, attempts, tokens, and price assumptions. Apply uncertainty estimates at task-family level where examples are correlated.
7. **No arithmetic mythology.** Maximum field flag is a policy statistic, not automatically P(any error). Multiple correlated heads do not become independent votes; additional heads can inflate false escalation. Calibrate the complete policy.
8. **Measure learning against cheap controls.** Existing retrieval, deterministic checks, no intervention, one holistic question, and one hand-written atomic battery are useful baselines. An autoresearch loop must beat its first round on untouched tasks.
9. **End-to-end benefit is a later experiment.** If laboratory quality warrants it, use one disposable canary and assign treatment by entire session to prevent context carryover. Outcomes should include correct task completion and unnecessary inspection/edit work, not just whether surfaced files were opened.

## Recommended sequence

Start with E01/E02/E07/E08 and E18/E19/E25/E26: they establish basic relevance, honest absence, preservation of existing strengths, and sensitivity to evidence versus presentation. Then E10/E12/E16 test the more distinctive product idea: orientation that challenges assumptions and names missing substantiation. Build E22/E23/E28 only after those heads show discriminative value on untouched cases.

The radical bet worth testing is that Sextant's valuable output is sometimes **one well-chosen contradiction or missing observation**, rather than more context. Jev's cheap bounded decisions could make that affordable, but only a task-success experiment can establish it.
