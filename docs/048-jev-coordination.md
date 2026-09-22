# Jev and disjoint agent edits: executable coordination diagnostic

Run: 2026-09-22; model returned by every request: `jev-1.13.0`; seed: `20260922`. All 32 planned requests completed without an error. This is a diagnostic over eight authored protocol families, with four related scenarios per family, not 32 independent real agent incidents or a held-out evaluation.

Jev caught 14 of 16 merged regressions, but its higher-order interaction judgments were unreliable: only 10/32 cases had all three heads correct, and 18/32 produced logically inconsistent thresholded decisions. Cheap semantic coordination is plausible as a signal to investigate; this run does not support allowing or blocking merges from these direct heads.

## Independent execution and request integrity

The frozen manifest and exact ordered request hashes passed strict replay against the pinned source. An independent native JavaScript evaluator then executed baseline, A-only, B-only, and merged functions with a fresh exact input for every evaluation: 128 executions. It did not call the harness VM evaluator or reuse its output encoding. All 96 labels and all 128 saved outcomes matched. Model answers were read from raw response Nouls, not cached predictions or the saved summary. Independently derived confusion counts, Brier scores, all-three correctness, and contradiction counts agreed with the harness summary. Provider requests contain code, input and comparison instructions; they contain no labels, outcomes, scenario names or rationales.

The three definitions concern exactly one supplied input: joint regression means merged differs from baseline; emergent conflict requires both isolated edits to preserve baseline while their merge differs; mutual repair requires both isolated edits to differ while their merge restores baseline. All decisions use the fixed threshold `p > 0.5`; no threshold was fitted.

## Results

| Head | TP | FP | TN | FN | Correct | Positive precision | Positive recall | Brier |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| joint_regression | 14 | 5 | 11 | 2 | 25/32 | 73.7% | 87.5% | 0.1428 |
| emergent_conflict | 8 | 12 | 12 | 0 | 20/32 | 40.0% | 100.0% | 0.2069 |
| mutual_repair | 8 | 13 | 11 | 0 | 19/32 | 38.1% | 100.0% | 0.2072 |

All eight genuine emergent conflicts and all eight mutual repairs were detected, but there were respectively 12 and 13 false positives. Those full-recall results therefore do not establish a useful discriminator. The deliberately limited path-overlap comparator predicts no conflict for every case: 16/32 correct on joint regression, with all 16 actual regressions missed. Jev improves that accuracy to 25/32, although this does not compare it with static interface analysis or tests.

Logical violations include asserting emergent conflict without joint regression, asserting repair together with joint regression, or asserting both emergent conflict and repair. These cannot all be true under the supplied definitions. The next bounded experiment asks only two additional atomic questions, whether each isolated edit differs from baseline, then derives the interaction labels in JavaScript. Internal consistency will follow by construction; accuracy must still be measured against execution.

| Family | All three correct | Correct individual heads |
|---|---:|---:|
| field_names | 1/4 | 8/12 |
| units | 2/4 | 9/12 |
| enum_validation | 0/4 | 8/12 |
| metadata_validation | 4/4 | 12/12 |
| ordering | 1/4 | 6/12 |
| nullability | 1/4 | 8/12 |
| cache_keys | 0/4 | 6/12 |
| fallback_precedence | 1/4 | 7/12 |

The 32 requests consumed 22,983 input tokens and 1,984 output tokens. At the published input rate of $0.042 per million with free output, estimated verifier cost is $0.000965286; this is a rate calculation, not an invoice. Observed end-to-end client latency: median 184.3 ms, p95 372.0 ms (nearest rank), range 138.5–424.0 ms, cumulative request latency 6.41 seconds. These are 32 sequential observations, not a concurrency or throughput benchmark.

## Every case with an incorrect head

For each case, the outcome order is baseline, A-only, B-only, merged. P values and gold labels are ordered joint regression, emergent conflict, mutual repair. Both file paths are always disjoint: A edits `src/producer.js`, B edits `src/consumer.js`. Programs below are the exact submitted function source; these failures are genuine disagreements with execution under the supplied fixed-input task.

### coordination/field_names/emergent-conflict

Input: `7`. Outcomes: `7`, `7`, `7`, `8`. Gold: `true, true, false`; P: `0.94, 0.72, 0.64`. Wrong heads: `mutual_repair`. Decisions also violate the logical definitions.

```js
// Baseline producer
x => ({ value: x })
// Baseline consumer
r => r.value
// Agent A edited producer
x => ({ value: x, legacy: x + 1 })
// Agent B edited consumer
r => r.legacy ?? r.value
```

### coordination/field_names/one-sided-regression

Input: `7`. Outcomes: `7`, `undefined`, `7`, `undefined`. Gold: `true, false, false`; P: `0.81, 0.76, 0.25`. Wrong heads: `emergent_conflict`.

```js
// Baseline producer
x => ({ value: x })
// Baseline consumer
r => r.value
// Agent A edited producer
x => ({ payload: x })
// Agent B edited consumer
r => { return r.value; }
```

### coordination/field_names/benign-pair

Input: `7`. Outcomes: `7`, `7`, `7`, `7`. Gold: `false, false, false`; P: `0.28, 0.57, 0.53`. Wrong heads: `emergent_conflict`, `mutual_repair`. Decisions also violate the logical definitions.

```js
// Baseline producer
x => ({ value: x })
// Baseline consumer
r => r.value
// Agent A edited producer
x => ({ value: x, meta: "ok" })
// Agent B edited consumer
r => Number(r.value)
```

### coordination/units/mutual-repair

Input: `2`. Outcomes: `2000`, `NaN`, `undefined`, `2000`. Gold: `false, false, true`; P: `0.14, 0.58, 0.77`. Wrong heads: `emergent_conflict`. Decisions also violate the logical definitions.

```js
// Baseline producer
x => ({ seconds: x })
// Baseline consumer
r => r.seconds * 1000
// Agent A edited producer
x => ({ milliseconds: x * 1000 })
// Agent B edited consumer
r => r.milliseconds
```

### coordination/units/one-sided-regression

Input: `2`. Outcomes: `2000`, `2000000`, `2000`, `2000000`. Gold: `true, false, false`; P: `0.88, 0.61, 0.71`. Wrong heads: `emergent_conflict`, `mutual_repair`. Decisions also violate the logical definitions.

```js
// Baseline producer
x => ({ seconds: x })
// Baseline consumer
r => r.seconds * 1000
// Agent A edited producer
x => ({ seconds: x * 1000 })
// Agent B edited consumer
r => 1000 * r.seconds
```

### coordination/enum_validation/mutual-repair

Input: `"ready"`. Outcomes: `1`, `-1`, `-1`, `1`. Gold: `false, false, true`; P: `0.76, 0.42, 0.82`. Wrong heads: `joint_regression`. Decisions also violate the logical definitions.

```js
// Baseline producer
x => ({ status: x })
// Baseline consumer
r => ({ ready: 1, done: 2 }[r.status] ?? -1)
// Agent A edited producer
x => ({ status: x.toUpperCase() })
// Agent B edited consumer
r => ({ READY: 1, DONE: 2 }[r.status] ?? -1)
```

### coordination/enum_validation/emergent-conflict

Input: `"ready"`. Outcomes: `1`, `1`, `1`, `-1`. Gold: `true, true, false`; P: `0.67, 0.58, 0.56`. Wrong heads: `mutual_repair`. Decisions also violate the logical definitions.

```js
// Baseline producer
x => ({ status: x })
// Baseline consumer
r => ({ ready: 1, done: 2 }[r.status] ?? -1)
// Agent A edited producer
x => ({ status: x, format: "v2" })
// Agent B edited consumer
r => r.format === "v2" ? ({ READY: 1, DONE: 2 }[r.status] ?? -1) : ({ ready: 1, done: 2 }[r.status] ?? -1)
```

### coordination/enum_validation/one-sided-regression

Input: `"ready"`. Outcomes: `1`, `-1`, `1`, `-1`. Gold: `true, false, false`; P: `0.92, 0.36, 0.61`. Wrong heads: `mutual_repair`. Decisions also violate the logical definitions.

```js
// Baseline producer
x => ({ status: x })
// Baseline consumer
r => ({ ready: 1, done: 2 }[r.status] ?? -1)
// Agent A edited producer
x => ({ status: "queued" })
// Agent B edited consumer
r => r.status === "ready" ? 1 : r.status === "done" ? 2 : -1
```

### coordination/enum_validation/benign-pair

Input: `"ready"`. Outcomes: `1`, `1`, `1`, `1`. Gold: `false, false, false`; P: `0.38, 0.56, 0.21`. Wrong heads: `emergent_conflict`. Decisions also violate the logical definitions.

```js
// Baseline producer
x => ({ status: x })
// Baseline consumer
r => ({ ready: 1, done: 2 }[r.status] ?? -1)
// Agent A edited producer
x => ({ status: x, allowed: ["ready", "done", "queued"] })
// Agent B edited consumer
r => ({ ready: 1, done: 2, queued: 3 }[r.status] ?? -1)
```

### coordination/ordering/mutual-repair

Input: `[3, 1, 2]`. Outcomes: `3`, `2`, `2`, `3`. Gold: `false, false, true`; P: `0.51, 0.63, 0.91`. Wrong heads: `joint_regression`, `emergent_conflict`. Decisions also violate the logical definitions.

```js
// Baseline producer
x => ({ items: [...x] })
// Baseline consumer
r => r.items[0]
// Agent A edited producer
x => ({ items: [...x].reverse() })
// Agent B edited consumer
r => r.items[r.items.length - 1]
```

### coordination/ordering/emergent-conflict

Input: `[3, 1, 2]`. Outcomes: `3`, `3`, `3`, `2`. Gold: `true, true, false`; P: `0.69, 0.86, 0.6`. Wrong heads: `mutual_repair`. Decisions also violate the logical definitions.

```js
// Baseline producer
x => ({ items: [...x] })
// Baseline consumer
r => r.items[0]
// Agent A edited producer
x => ({ items: [...x], display: [...x].reverse() })
// Agent B edited consumer
r => (r.display ?? r.items)[0]
```

### coordination/ordering/one-sided-regression

Input: `[3, 1, 2]`. Outcomes: `3`, `1`, `3`, `1`. Gold: `true, false, false`; P: `0.46, 0.82, 0.64`. Wrong heads: `joint_regression`, `emergent_conflict`, `mutual_repair`. Decisions also violate the logical definitions.

```js
// Baseline producer
x => ({ items: [...x] })
// Baseline consumer
r => r.items[0]
// Agent A edited producer
x => ({ items: [...x].sort((a, b) => a - b) })
// Agent B edited consumer
r => r.items.at(0)
```

### coordination/nullability/mutual-repair

Input: `null`. Outcomes: `'absent'`, `''`, `'null'`, `'absent'`. Gold: `false, false, true`; P: `0.71, 0.49, 0.69`. Wrong heads: `joint_regression`. Decisions also violate the logical definitions.

```js
// Baseline producer
x => ({ value: x })
// Baseline consumer
r => r.value === null ? "absent" : String(r.value)
// Agent A edited producer
x => ({ value: x === null ? "" : x })
// Agent B edited consumer
r => r.value === "" ? "absent" : String(r.value)
```

### coordination/nullability/one-sided-regression

Input: `null`. Outcomes: `'absent'`, `'undefined'`, `'absent'`, `'undefined'`. Gold: `true, false, false`; P: `0.81, 0.73, 0.61`. Wrong heads: `emergent_conflict`, `mutual_repair`. Decisions also violate the logical definitions.

```js
// Baseline producer
x => ({ value: x })
// Baseline consumer
r => r.value === null ? "absent" : String(r.value)
// Agent A edited producer
x => ({ value: x === null ? undefined : x })
// Agent B edited consumer
r => r.value === null ? "absent" : `${r.value}`
```

### coordination/nullability/benign-pair

Input: `null`. Outcomes: `'absent'`, `'absent'`, `'absent'`, `'absent'`. Gold: `false, false, false`; P: `0.36, 0.48, 0.56`. Wrong heads: `mutual_repair`.

```js
// Baseline producer
x => ({ value: x })
// Baseline consumer
r => r.value === null ? "absent" : String(r.value)
// Agent A edited producer
x => ({ value: x, source: "db" })
// Agent B edited consumer
r => r.value == null ? "absent" : String(r.value)
```

### coordination/cache_keys/mutual-repair

Input: `({ tenant: "acme", id: 7 })`. Outcomes: `'entry'`, `null`, `null`, `'entry'`. Gold: `false, false, true`; P: `0.86, 0.41, 0.55`. Wrong heads: `joint_regression`. Decisions also violate the logical definitions.

```js
// Baseline producer
x => ({ key: String(x.id), value: "entry" })
// Baseline consumer
r => r.key === "7" ? r.value : null
// Agent A edited producer
x => ({ key: `${x.tenant}:${x.id}`, value: "entry" })
// Agent B edited consumer
r => r.key === "acme:7" ? r.value : null
```

### coordination/cache_keys/emergent-conflict

Input: `({ tenant: "acme", id: 7 })`. Outcomes: `'entry'`, `'entry'`, `'entry'`, `null`. Gold: `true, true, false`; P: `0.22, 0.82, 0.68`. Wrong heads: `joint_regression`, `mutual_repair`. Decisions also violate the logical definitions.

```js
// Baseline producer
x => ({ key: String(x.id), value: "entry" })
// Baseline consumer
r => r.key === "7" ? r.value : null
// Agent A edited producer
x => ({ key: String(x.id), alternateKey: `${x.tenant}:${x.id}`, value: "entry" })
// Agent B edited consumer
r => (r.alternateKey ?? r.key) === "7" ? r.value : null
```

### coordination/cache_keys/one-sided-regression

Input: `({ tenant: "acme", id: 7 })`. Outcomes: `'entry'`, `null`, `'entry'`, `null`. Gold: `true, false, false`; P: `0.91, 0.52, 0.64`. Wrong heads: `emergent_conflict`, `mutual_repair`. Decisions also violate the logical definitions.

```js
// Baseline producer
x => ({ key: String(x.id), value: "entry" })
// Baseline consumer
r => r.key === "7" ? r.value : null
// Agent A edited producer
x => ({ key: String(x.id + 1), value: "entry" })
// Agent B edited consumer
r => { return r.key === "7" ? r.value : null; }
```

### coordination/cache_keys/benign-pair

Input: `({ tenant: "acme", id: 7 })`. Outcomes: `'entry'`, `'entry'`, `'entry'`, `'entry'`. Gold: `false, false, false`; P: `0.17, 0.47, 0.52`. Wrong heads: `mutual_repair`.

```js
// Baseline producer
x => ({ key: String(x.id), value: "entry" })
// Baseline consumer
r => r.key === "7" ? r.value : null
// Agent A edited producer
x => ({ key: String(x.id), value: "entry", tenant: x.tenant })
// Agent B edited consumer
r => r.key === String(7) ? r.value : null
```

### coordination/fallback_precedence/mutual-repair

Input: `0`. Outcomes: `'zero'`, `'0'`, `0`, `'zero'`. Gold: `false, false, true`; P: `0.39, 0.51, 0.87`. Wrong heads: `emergent_conflict`. Decisions also violate the logical definitions.

```js
// Baseline producer
x => ({ value: x })
// Baseline consumer
r => r.value === 0 ? "zero" : r.value
// Agent A edited producer
x => ({ value: String(x) })
// Agent B edited consumer
r => r.value === "0" ? "zero" : r.value
```

### coordination/fallback_precedence/one-sided-regression

Input: `0`. Outcomes: `'zero'`, `5`, `'zero'`, `5`. Gold: `true, false, false`; P: `0.89, 0.52, 0.5`. Wrong heads: `emergent_conflict`.

```js
// Baseline producer
x => ({ value: x })
// Baseline consumer
r => r.value === 0 ? "zero" : r.value
// Agent A edited producer
x => ({ value: x || 5 })
// Agent B edited consumer
r => r.value === 0 ? ("zero") : r.value
```

### coordination/fallback_precedence/benign-pair

Input: `0`. Outcomes: `'zero'`, `'zero'`, `'zero'`, `'zero'`. Gold: `false, false, false`; P: `0.71, 0.67, 0.55`. Wrong heads: `joint_regression`, `emergent_conflict`, `mutual_repair`. Decisions also violate the logical definitions.

```js
// Baseline producer
x => ({ value: x })
// Baseline consumer
r => r.value === 0 ? "zero" : r.value
// Agent A edited producer
x => ({ value: x ?? 5 })
// Agent B edited consumer
r => r.value === 0 ? ("zero") : r.value
```

## Evidence and limits

- Frozen live record: `.planning/jev/coordination-live.jsonl`.
- Independent native execution and metrics: `.planning/jev/coordination-independent.cjs`.
- Full independently checked case outcomes, probabilities and errors: `.planning/jev/coordination-independent-analysis-20260922.json`.
- Source and durable offline checks: `experiments/jev/coordination.js`, `experiments/jev/coordination.test.js`.

The eight families are field naming, units, enum validation, metadata validation, ordering, nullability, cache keys and fallback precedence. Related scenarios share code templates, so counts must not be interpreted as independent deployment samples. No real agent collaboration, repository merge, exhaustive input checking or production integration was tested. These fixtures are executable toy protocols, not universal equivalence proofs. No API calls were made during independent analysis.

## Final bounded follow-up: atomic decisions and Boolean composition

The follow-up completed all 32 requests, with every response stamped `jev-1.13.0`. It retained the exact same executable states, inputs and three direct questions, and added two questions: does A-only differ from baseline, and does B-only differ from baseline? All 64 additional labels were independently checked using native JavaScript during offline tests. The fixed threshold remained `p > 0.5`; no thresholds or prompts were tuned after seeing this run.

Let J, A and B be the thresholded merged, A-only and B-only regression answers. The derived decisions are `emergent = !A && !B && J` and `repair = A && B && !J`. These are Boolean decisions, not calibrated probabilities. Their logical consistency is guaranteed by construction.

**The decomposition improved total correctness while sharply reducing recall of the interactions it was intended to detect.** All-three correctness rose from 14/32 for direct answers in the same five-question request to 19/32 after composition. Contradictions fell from 18 to zero. However, emergent-conflict recall fell from 8/8 to 1/8, and mutual-repair recall fell from 8/8 to 4/8. A consistency check or headline accuracy would conceal this loss.

| Head | Same-request direct TP / FP / TN / FN | Derived TP / FP / TN / FN | Direct correct | Derived correct | Direct → derived positive recall |
|---|---|---|---:|---:|---:|
| Joint regression | 15 / 4 / 12 / 1 | 15 / 4 / 12 / 1 | 27/32 | 27/32 | 15/16 → 15/16 |
| Emergent conflict | 8 / 9 / 15 / 0 | 1 / 0 / 24 / 7 | 23/32 | 25/32 | 8/8 → 1/8 |
| Mutual repair | 8 / 13 / 11 / 0 | 4 / 1 / 23 / 4 | 19/32 | 27/32 | 8/8 → 4/8 |

The added atomic A-only head was correct on 24/32 cases (TP 15, FP 8, TN 9, FN 0; Brier 0.1480). B-only was correct on 29/32 (TP 7, FP 1, TN 22, FN 2; Brier 0.0696). Six actual emergent cases were incorrectly judged to regress when only A changed. That forces the derived emergent answer false even though the direct emergent head was correct. The cache-key emergent case instead failed because its merged-regression probability was only 0.24. Only metadata-validation's emergent conflict survived composition.

| True emergent case | P(J) | P(A) | P(B) | Why derived misses |
|---|---:|---:|---:|---|
| field_names | 0.93 | 0.83 | 0.19 | A-only falsely judged changed |
| units | 0.81 | 0.54 | 0.15 | A-only falsely judged changed |
| enum_validation | 0.66 | 0.67 | 0.25 | A-only falsely judged changed |
| ordering | 0.71 | 0.68 | 0.22 | A-only falsely judged changed |
| nullability | 0.79 | 0.58 | 0.18 | A-only falsely judged changed |
| cache_keys | 0.24 | 0.24 | 0.26 | Joint regression missed |
| fallback_precedence | 0.87 | 0.70 | 0.30 | A-only falsely judged changed |
| metadata_validation | 0.96 | 0.48 | 0.12 | Correctly retained |

For example, field-names input `7` uses baseline producer `x => ({ value: x })`, consumer `r => r.value`, A's producer `x => ({ value: x, legacy: x + 1 })`, and B's consumer `r => r.legacy ?? r.value`. Independently executed outcomes are `7, 7, 7, 8` in baseline/A-only/B-only/merged order. A-only therefore does not regress, despite its reported probability 0.83. This is a failure on supplied code and fixed input, not uncertainty about unstated requirements.

The four mutual repairs lost through composition were enum validation, cache keys, nullability, and fallback precedence. Enum validation and cache keys falsely fired J at 0.80 and 0.70. Nullability fired J at 0.58 and missed B at 0.47. Fallback precedence missed B at 0.17: its baseline returns `"zero"`, B-only returns numeric `0`, and these are unequal under the explicit comparison contract. The exact functions for these cases are preserved in the original-error listings above or the frozen manifest; full five-head probabilities and decisions are in the comparison artifact.

### Matched corrections and regressions

Within the same five-question response, deriving emergent conflict corrected 9 direct false answers and regressed 7 correct answers. Deriving repair corrected 12 and regressed 4. Joint decisions are identical because both approaches use the same J answer.

Across the separate original three-question and follow-up five-question runs, all-three correctness moved from 10/32 to 19/32. That difference cannot be attributed entirely to composition: the direct answers themselves improved from 10/32 to 14/32 before composition. Exact cross-run counts are:

| Comparison | Joint corrected / regressed | Emergent corrected / regressed | Repair corrected / regressed | All three before → after |
|---|---:|---:|---:|---:|
| Original direct → new direct | 2 / 0 | 5 / 2 | 1 / 1 | 10 → 14 |
| Original direct → new derived | 2 / 0 | 12 / 7 | 12 / 4 | 10 → 19 |
| New direct → new derived | 0 / 0 | 9 / 7 | 12 / 4 | 14 → 19 |

The added question context and ordinary model variation are confounded in the cross-run comparison. This is a matched diagnostic, not a randomized estimate of a prompting intervention. All 32 cases remain development cases drawn from eight related templates.

### Cost, artifacts and disposition

The follow-up used 27,079 input tokens and 3,200 output tokens. Estimated cost at $0.042 per million input tokens and free output is $0.001137318. Observed median latency was 211.5 ms, nearest-rank p95 339.8 ms, range 138.4–423.2 ms, cumulative request latency 6.89 seconds.

- Frozen live record: `.planning/jev/coordination-atomic-live.jsonl`.
- Exact source and 11 passing offline tests: `experiments/jev/coordination-atomic.js` and `experiments/jev/coordination-atomic.test.js`.
- Frozen replay and prior-run comparison: `.planning/jev/coordination-atomic-comparison.json`.
- Reproduce: `node experiments/jev/coordination-atomic.js report --input .planning/jev/coordination-atomic-live.jsonl --baseline .planning/jev/coordination-live.jsonl`.

Neither direct compound judgments nor this straightforward Boolean composition supports an autonomous merge gate. The useful Sextant hypothesis remains an inexpensive request for focused evidence or an executable interaction test. Conflicting or uncertain semantic signals could prioritize which disjoint edits deserve a producer/consumer test; they must not be mistaken for proof of compatibility. No production behavior was changed, and no further experiments were started in this round.

A separate agent independently audited the completed follow-up without changing source: source/corpus/request fingerprints, schedule, identical states/oracles/direct heads, actual model stamps, and all 128 native execution outcomes matched. Its independently derived confusion counts and suppression analysis agreed with this report, including the distinction between the direct rerun gain and the subsequent Boolean-composition gain.
