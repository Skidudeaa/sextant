# Jev mechanism probes

Measured 2026-09-22. These are development diagnostics motivated by observed failures, not independent benchmarks or evidence for fleet activation.

## JavaScript input representation

Giving Jev explicit input types and executable literals corrected decisions on this small probe. Raw structured input scored **21/32**, added `typeof` and JSON-literal annotations **29/32**, and executable code literals **31/32**. The remaining literal error is confidently wrong: both `null === 0` and `null == 0` return false, but Jev assigned 0.91 probability to different results.

Artifacts: [runner](../experiments/jev/type-probe.js), [tests](../experiments/jev/type-probe.test.js), local `.planning/jev/type-probe-frozen.json` and `.planning/jev/type-probe-live.jsonl`. The immutable experiment fingerprint is `e50948d85be19f3cfd59ecc7682fd5a9b6367e869fb33470c3bb287336758725`. The live manifest embeds the identical frozen experiment; all 96 requests completed with actual model `jev-1.13.0`, zero errors and zero unattempted requests. Independent audit recomputed the fingerprint, compared embedded and standalone experiments, executed every expression using native JavaScript separately from the supplied VM oracle, and recalculated the confusion counts from raw responses.

The 32 semantic cases combine targets 0 and 7, eight inputs per target, and two candidate expressions. Inputs are the target number, target string, zero-padded target string, true, false, null, empty array and singleton target array. The reference is `x === target`; candidates are loose equality and reversed strict operands. Every case receives three representations with identical executable truth and the same narrow Noul question. Labels and oracle results remain local. Seed: 20260922; decision rule: `P(different) > 0.5`.

| Representation | TP | FP | TN | FN | Correct | Brier |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Typed JSON `input` plus expressions | 2 | 5 | 19 | 6 | 21/32 | 0.22853 |
| Same plus `inputTypeof` and `inputLiteral` | 8 | 3 | 21 | 0 | 29/32 | 0.10960 |
| Function bodies declaring the literal input | 8 | 1 | 23 | 0 | 31/32 | 0.03391 |

Annotations corrected eight raw-input decisions with zero regressions; literals corrected ten with zero regressions. Thus the effect includes decision corrections, not only confidence movement. All 16 reversed-strict cases were correct in every representation. Loose-equality cases scored 5/16, 13/16 and 15/16 respectively. The two altered representations recovered all eight actual behavioral differences at this threshold.

Selected loose-equality cases show both the effect and its limits. Values below are raw provider Noul probabilities; “different” is the executable label.

| Target | Input literal | Different | Structured | Annotated | Code literal |
| --- | --- | --- | ---: | ---: | ---: |
| 0 | `"0"` | yes | 0.04 | 0.94 | 0.98 |
| 0 | `"00"` | yes | 0.22 | 0.89 | 0.97 |
| 0 | `[0]` | yes | 0.06 | 0.79 | 0.91 |
| 7 | `"7"` | yes | 0.04 | 0.95 | 0.98 |
| 7 | `[7]` | yes | 0.10 | 0.52 | 0.98 |
| 7 | `[]` | no | 0.70 | 0.85 | 0.18 |
| 0 | `null` | no | 0.84 | 0.89 | 0.91 |

The annotated `[7]` success is only just above the decision threshold. Annotation increases confidence in the wrong `[]`/7 answer; literal syntax fixes it. The persistent null/0 failure becomes more confidently wrong. A formatting improvement cannot authorize treating Jev as an executable semantics oracle.

Total usage was 43,284 input and 1,920 output tokens; estimated input cost $0.001817928 at the recorded $0.042/M rate, excluding billing reconciliation. Median measured request latency was 168.23 ms, p95 250.29 ms. These requests are small and sequential; this is not a production latency benchmark.

## Documented transport versus inferred mechanism

Official sources accessed 2026-09-22:

- The API accepts structured JSON state, and the state guide recommends named fields for related context. Its examples include numeric JSON fields. [State](https://docs.typesafe.ai/concepts/state), [API](https://docs.typesafe.ai/api).
- The JavaScript SDK v0.6.0 explicitly admits nested numbers, strings, booleans, null, arrays and objects through `JsonValue`. Its client serializes the request using `JSON.stringify(req.body)` and sends JSON content type. It does not stringify each scalar into an undifferentiated string. [Pinned SDK types](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/types.ts), [Pinned SDK client](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/client.ts).
- Our experimental [client](../experiments/jev/client.js) similarly serializes the complete payload with `JSON.stringify`. In these requests the string `"7"` and number `7` remain distinct JSON values. No client-side scalar coercion explains the observed failure.
- TypeSafe recommends direct JSON structure for clarity and supporting data. It separately documents difficulties with indirection, numerical representations and exact computation. [Structured primitives](https://docs.typesafe.ai/primitives/advanced), [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13).

**Observed:** decisions depend strongly on how identical executable semantics are presented. **Hypothesis:** explicit literal syntax or redundant type evidence helps Jev attend to coercion-relevant distinctions. **Unknown:** the provider's exact model-side rendering of structured state; the examined public contract and SDK do not specify it. These results do not prove server-side type erasure, a tokenizer mechanism, or that JSON is generally inferior to prose/code. Documentation UI code that pretty-prints example JSON is not evidence about inference serialization.

There is one response per case and representation, with no identical-request repeat control inside this probe. We cannot isolate representation effects from stochastic variation, ordering or correlated cases. Cases were selected after a related model failure and are all development-only. The lower Brier score is descriptive on this selected set; it does not establish general calibration.

## Next discriminating check

Prospectively freeze the same comparison on new targets -2 and 11, with decimal-spelled numeric strings, before seeing responses. Keep the same question and independently execute every label. Report paired corrections/regressions separately from the first cohort. This is confirmation on new values within the same diagnostic family, not independent task validation. A later distinct test could randomize field order and include identical-request repeats to measure noise; do not combine that change with the first replication. For Sextant, exact execution/parser checks remain authoritative, while representation-aware Jev judgments can propose source scopes or tests for a human/agent to inspect.

## Prospective confirmation on new values

The proposed confirmation was frozen before its provider calls and completed on 2026-09-22. Targets are -2 and 11; the third input is now a decimal-spelled numeric string (`"-2.0"`, `"11.0"`). Other inputs, question, three representations and seed are unchanged. This intentionally remains development-only, within the same diagnostic family. There are six actual differences per representation, so its accuracy should not be compared with the first cohort as if the label distribution were identical.

Local artifacts: `.planning/jev/type-confirmation-frozen.json` and `.planning/jev/type-confirmation-live.jsonl`; fingerprint `91a385d011f208edf76fa84f7a0272237cf85e4c9abb73ceb2bb85c5925ece16`. Independent audit matched the live manifest to that snapshot, recomputed its hash, re-executed all labels with native JavaScript, and recounted raw responses. All 96 requests completed on `jev-1.13.0`, zero errors/unattempted.

| Representation | TP | FP | TN | FN | Correct | Brier | Corrections / regressions versus structured |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Structured | 0 | 1 | 25 | 6 | 25/32 | 0.19800 | baseline |
| Annotated | 6 | 2 | 24 | 0 | 30/32 | 0.06664 | 6 / 1 |
| Code literal | 6 | 0 | 26 | 0 | 32/32 | 0.01054 | 7 / 0 |

The direction repeated: structured input missed all six true differences, while both clearer representations detected them. Literal syntax corrected all seven baseline errors in this run. Annotation introduced a new false positive: with `x = [11]`, the equivalent expressions `x === 11` and `11 === x` were marked different at 0.56, versus 0.06 in both other forms. Thus the first cohort's “no annotation regressions” result did not repeat.

The same empty-array failure pattern also recurred. For `x = []`, neither `x === 11` nor `x == 11` returns true, yet structured and annotated probabilities of different results were 0.72 and 0.82; literal syntax returned 0.37. Conversely, `x = "-2.0"` correctly changes strict to loose equality: probabilities were 0.05, 0.87 and 0.98. The annotation for singleton `[-2]` again only narrowly crossed the decision threshold (0.52), while literal syntax returned 0.97.

Usage: 43,474 input and 1,920 output tokens, estimated $0.001825908; latency median 172.92 ms, p95 227.82 ms. Combined with the first diagnostic, this is evidence that explicit literals help this particular equality task. It does not resolve the mechanism, remove the first cohort's confident null/0 failure, establish general semantic reliability, or substitute for repeat controls and independent task validation.

## Counterfactual source changes

Jev detected three of four executable source mutations in this development probe. The completed 16-request run scored **14/16 verdicts and refutation scopes correct**, with correct verdict changes on **6/8 original–mutant pairs**. Each mutation was shown both with its actual existing comments preserved and with AST-identified comments replaced by whitespace. Verdicts agreed across **8/8 comment pairs**; each comment treatment scored 7/8. This is four related functions, not sixteen independent examples.

The [runner](../experiments/jev/counterfactual.js) holds the concrete-input claim, source paths, function names, scope position and two distractor scopes fixed within each group. Only the target implementation and comment treatment vary. Original and mutant source execute in disposable VM contexts; the codebase's runtime files are never modified. Scope evidence records original file hashes and line coordinates separately from hashes of transformed request source. No expected labels or mutation metadata enter provider requests.

| Source function | Concrete arguments | Original output | Mutant output | Mutation | Correct verdicts |
| --- | --- | --- | --- | --- | ---: |
| `clampChars` | `['A &amp; B', 6]` | `'A '` | `'A &amp'` | Disable incomplete-entity guard | 4/4 |
| `provenanceOf` | `['not-a-known-source']` | `'live_text'` | `'direct'` | Change unknown-source fallback | 4/4 |
| `isTestPath` | `['test_token.py']` | `true` | `false` | Change `test_` filename matcher to `check_` | 2/4 |
| `looksLikeDefinitionLine` | `['def run():']` | `true` | `false` | Change Python `def` matcher to `func` | 4/4 |

Both failures concern the mutated `isTestPath`. Jev still selected `supports` with probability **0.93 with comments** and **0.90 without comments**, while independently executed code returned false. It selected no refuting scope and assigned answerability 0.91/0.90. These are internally consistent but incorrect judgments: the prototype's disagreement guard cannot detect them. Removing comments did not fix the failure. The experiment does not establish whether familiar function naming, regex interpretation or another mechanism caused it.

Artifacts are local `.planning/jev/counterfactual-frozen.json`, `.planning/jev/counterfactual-live.jsonl`, `.planning/jev/counterfactual-error-replay.json` and `.planning/jev/counterfactual-rerun-live.jsonl`. Frozen fingerprint: `b78959a0bcd559dc807ade1fa515c5c837d2db18415871bdc8fa37e9164ac0fb`. The first run stopped after nine successful results on `pytest-filename:original:stripped`, leaving six requests unattempted. It retained a null HTTP status but no error code, so its cause is unrecoverable from that artifact. One exact-request diagnostic replay then succeeded. That success does not establish why the earlier call failed. Error recording was repaired to retain recognized client codes and static local diagnostic messages without exception text; a new full 16-request artifact then completed with zero errors or unattempted requests. All evidence remains preserved; results above use only the complete rerun.

The first nine successful requests were all verdict-correct, but `entity-boundary:original:stripped` selected a refuting scope while saying `supports`. The identical request in the complete rerun selected `none`. This observed repeat variation concerns the scope head; none of the nine repeated verdicts changed. The single successful failure replay is diagnostic evidence, not an additional independent scored case.

Independent audit matched the completed manifest to the original frozen experiment, recomputed its fingerprint, verified every request ID/hash and derived all 16 labels by separately running the displayed functions with native JavaScript. Current original file hashes still matched the archived origins at audit time. This freshness observation concerns original files; transformed request scopes intentionally differ from those files. Raw provider counts reproduced the stored summary exactly. The completed run used `jev-1.13.0`, 18,714 input and 1,848 output tokens, estimated input cost **$0.000785988**, median latency 174.70 ms and p95 356.63 ms. Those costs exclude the partial run, diagnostic replay and any unreported usage from the failed call.

The useful next check is to vary misleading function names and regex syntax while preserving executable semantics and concrete truth. Keep exact execution authoritative: internally coherent Jev support is a candidate judgment, not proof that a source claim holds.

## Atomic questions are not a universal repair

A further **64-request** run retained the diagnostic's raw structured and literal
representations, then asked three simultaneous Noul questions: whether outputs
differ, whether the reference returns true, and whether the candidate returns
true. JavaScript XOR of the latter two thresholded decisions supplies a second
change prediction. No independence assumption or joint probability is computed.

| Representation | Direct comparison correct | Atomic XOR correct | Corrections / regressions | Disagreements |
| --- | ---: | ---: | ---: | ---: |
| Structured input | 23/32 | 24/32 | 2 / 1 | 3 |
| Executable literal | 31/32 | 30/32 | 0 / 1 | 1 |

Decomposition did not improve both treatments. For literal input `[]` against
zero, the direct comparison correctly distinguished strict from loose equality
at P=0.57. The atomic candidate head assigned only 0.11 to the true result of
`[] == 0`, making XOR wrong. Conversely, atomic heads corrected two structured
false alarms on unchanged outcomes.

Four structured reversed-strict cases demonstrate a subtler failure: both
intermediate predictions were wrong, but their errors canceled in XOR. For
string `"0"`, `x === 0` and `0 === x` both return false; Jev assigned **0.98 to
true for each**, producing a correct equality judgment from two incorrect
intermediates. The other cases were strings `"00"`, `"7"` and `"07"`. A correct
derived answer therefore cannot validate the component judgments.

Evidence: `.planning/jev/atomic-frozen.json`, `atomic-live.jsonl`,
`atomic-independent-audit.json`, and the reproducible `audit-atomic.cjs` in the
same directory. The frozen fingerprint is
`6715d0ca436fcb1c80ae7f8e234124ef57295cd27d7b861c45da9a9a9d7be944`.
An independent audit checked all 128 native Boolean evaluations, all request
fingerprints, raw answers, and the result calculations. The provider completed
64/64 requests with no errors on `jev-1.13.0`, reporting 40,296 input tokens and
3,456 output tokens, an estimated **$0.001692432** input cost.

This is another development diagnostic. The direct head and atomic heads share
a request; comparing its direct-head score with an earlier single-head run also
changes batching and time. Tests caught a replay-authority defect before live
execution: result-row metadata could override frozen labels. Scoring now reads
labels and representation exclusively from the frozen plan, with an adversarial
regression that injects conflicting metadata.

Reproduce with new output paths:

```bash
node experiments/jev/atomic.js freeze .planning/jev/type-probe-frozen.json NEW-FROZEN.json
node experiments/jev/atomic.js live NEW-FROZEN.json NEW-LIVE.jsonl
node experiments/jev/atomic.js report NEW-LIVE.jsonl
```
