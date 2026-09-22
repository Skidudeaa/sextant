# Jev live findings

## Original 224-case run: independent matched analysis

Measured 2026-09-22. Jev scored **213/224 (95.09%)** at the unchanged `p > 0.5`
decision rule; the frozen OpenAI comparator scored **178/224 (79.46%)**. On the
128 held-out cases, results were **120/128 (93.75%)** and **103/128 (80.47%)**.
This is a win on the controlled corpus, not proof of improved coding outcomes.

The most useful distinction: Jev substantially reduced false alarms about code
changes that **do not affect the supplied input**. It did **not** improve total
detection of mutations that actually changed the supplied input: both models
found 19 of 23. Jev also made a confident, execution-refuted equality mistake.

### Frozen evidence and audit

- Jev: `.planning/jev/jev-original-all-2026-09-22T05-38-49-970Z.jsonl`, returned
  model `jev-1.13.0`, 224 results, zero errors, terminal summary present.
- Comparator: `.planning/jev/openai-original-all-2026-09-22T05-06-18-175Z.jsonl`,
  returned model `gpt-5.4-mini-2026-03-17`, reasoning effort `none`, 224 results,
  zero errors, terminal summary present.
- Independent analysis: `.planning/jev/original-independent-analysis-20260922.json`;
  reproducible local script: `.planning/jev/original-independent-analysis-20260922.cjs`.

Both files passed their frozen replay contracts. All 224 case identities,
provider states, question definitions and labels matched exactly across providers.
Different request wrappers and answer primitives are intentional: Jev produced
Noul probabilities; OpenAI produced generated Boolean decisions. No OpenAI Brier
score or calibration comparison is inferred from those Booleans.

All 96 mutation labels were independently re-executed in JavaScript from the
frozen source expressions and supplied inputs, without using the corpus's
mutation evaluator. All agreed with the frozen labels. The audit also executed
the actual formatter and import extractor for two disputed repository controls.
The other authored labels retain their authored-evidence limitation.

SHA-256 of raw files:

```text
Jev:    d3940915de2b26cdf0e09c10486cecf784e30d09da96cbc7d63fd2312a236317
OpenAI: 321224e3558d8a9e5051ddb6a72307ca9993d135e5dec5a2beef967e7542b12c
```

### Default decision and development-only threshold selection

| Partition | Cases | Jev correct, `p > 0.5` | OpenAI correct | Jev false positives / false negatives |
|---|---:|---:|---:|---:|
| Development | 96 | 93 | 75 | 0 / 3 |
| Holdout | 128 | 120 | 103 | 6 / 2 |
| All | 224 | 213 | 178 | 6 / 5 |

The existing threshold selector swept `0, 0.05, …, 1` on development only and
retained **0.5**. Applying it to holdout therefore reproduces 120/128. No threshold
or prompt was changed after inspecting these results.

Jev's descriptive Brier score was **0.05108** across all cases and **0.05985** on
holdout; ten-bin ECE was **0.07250** and **0.08617**. These are measurements on a
small, deliberately constructed distribution, not production calibration.

Exact matched outcomes: 175 cases correct for both models, 38 correct only for
Jev, 3 correct only for OpenAI, and 8 wrong for both. On holdout those counts are
101, 19, 2 and 6. Agreement is consequently not a correctness certificate.

### Keeping the cookbook's 0.7 gate unchanged

The strict `p > 0.7` rule flags **72/224** cases: 70 true flags and 2 false flags.
It retains **152**, including **17 cases that require a flag** under the frozen
labels. The retained-set error fraction is therefore **17/152 (11.18%)**. Overall
classification accuracy falls to 205/224; holdout falls to 116/128.

For effective mutations, this gate catches only **13/23**, versus 19/23 at 0.5.
The cookbook threshold is not a transferable correctness boundary. These are
routing counts only: no strong-model repair was executed by this run, and no
post-escalation quality is claimed. Also, a `flag=true` here is the positive
condition for each original task; this is not a direct evaluation of whether a
particular OpenAI answer should be escalated.

### Three mutation cohorts and paired controls

| Executed mutation cohort | Cases | Jev correct | OpenAI correct | Interpretation |
|---|---:|---:|---:|---|
| Cosmetic/equivalent expression | 48 | 48 | 47 | Equivalent controls mostly succeed for both. |
| Mutation changes this input's result | 23 | 19 | 19 | No aggregate detection gain; each model uniquely catches three cases. |
| Mutation does not change this input's result | 25 | 23 | 12 | Most of Jev's mutation advantage is fewer false alarms. |

For the 64 authored positive/negative scenario pairs, Jev got **both members
correct in 59 pairs**, versus 37 for OpenAI. Jev assigned the positive member a
higher probability in **64/64 pairs**, even where one side crossed the wrong
absolute threshold. Four Jev pairs were classified positive on both members;
one was negative on both. The corresponding OpenAI counts were 20 and 6, with
one pair reversed.

For the 48 cosmetic/semantic mutation pairs, both members were correct in **42
Jev pairs versus 30 OpenAI pairs**. Among the 23 pairs whose semantic mutation
actually changed the supplied input, both models got both members right in 19.
These paired cases are correlated observations; no independent-sample
significance claim is made.

### Strong wrong answers, checked against execution

Noul below is `P(the supplied expressions return different values)`, not a
separate provider confidence field.

| Frozen case | Exact input | Executed reference → candidate | Jev Noul | Finding |
|---|---|---|---:|---|
| `mutation/strict-equality/0/semantic` | string `"1"` | `x === 1`: false → `x == 1`: true | 0.06 | Strong false negative; OpenAI also missed it. |
| `mutation/case-sensitive/3/semantic` | `"user"` | exact comparison: false → lowercase comparison: false | 0.79 | False positive about an unaffected input; OpenAI also flagged it. |
| `mutation/filter-presence/3/semantic` | `[""]` | non-null filter: `[""]` → truthiness filter: `[]` | 0.23 | False negative; OpenAI was correct. |
| `mutation/prefix-parse/2/semantic` | `""` | `Number`: 0 → `parseInt`: NaN | 0.27 | False negative; OpenAI was correct. |
| `mutation/nullish/3/semantic` | `""` | nullish fallback: `""` → truthy fallback: 7 | 0.44 | False negative; OpenAI was correct. |
| `mutation/last-write/1/semantic` | `["a", "b"]` | both return `{a: 0, b: 1}` | 0.70 | False positive at 0.5; explicit object-order-insensitive task. |

The strongest non-mutation discrepancy was
`repository_claim/format-text-only/a`: Jev assigned **0.85** to the proposition
that the claim “text-only suppresses fan-in and export labels” contradicts the
supplied source. The excerpt explicitly says those labels are suppressed. An
actual `formatRetrievalDetailed(..., {textOnly: true})` call removed both labels;
the ordinary branch retained them. Both models were wrong on this control.

One authored discrepancy deserves caution rather than an automatic capability
diagnosis: `freshness/unchanged-hash/b` asks about a *freshness rule* but supplies
an invented `serialize` export despite unchanged hashes. The frozen positive
label treats the rule as permitting only source-supported claims; a narrower
reading could separate semantic support from freshness. Its Jev score was 0.29.
The frozen score is preserved, but this wording should be independently
adjudicated before using that case to support a capability claim.

### Cost, latency and what this supports

Jev consumed **95,714 reported input tokens**, estimated at **$0.004019988** using
the recorded $0.042/M rate. The original comparator's recorded estimate was
**$0.04671375**. These estimates exclude any unreported billing and are not
invoices. Sequential Jev request latency was p50 **184 ms**, p95 **266 ms** in
this run; this is not end-to-end agent latency or a concurrency benchmark.

The result supports continuing controlled work on relevance, evidence sufficiency
and contradiction localization. It does not justify replacing JavaScript
execution, parser facts, freshness fences or authorization decisions. The
strongest next test is whether fewer irrelevant flags and better contrastive
ranking translate into better evidence selection on difficult repository tasks.
The separate source-refutation and adversarial-treatment runs must carry their
own results; this section establishes only the original 224-case comparison.

## Completed ten-treatment matrix

The full matrix completed **2,240/2,240 requests, zero errors**, all stamped
`jev-1.13.0`. Every treatment contains the same 224 frozen cases. Independent
replay rebuilt the requests, reconstructed each primitive's probability of the
original positive event, and recalculated confusion counts, Brier score, ECE
and development-only threshold selection. Those calculations matched the lab
report. Transformations were fixed before these results were inspected.

Evidence:

- Raw matrix: `.planning/jev/jev-matrix-2026-09-22T05-40-13-719Z.jsonl`.
- SHA-256: `50572ce4a0f27682bcac70d3b6f3dd662118f89447da34011f4c523fcf464c3b`.
- Independent report: `.planning/jev/matrix-independent-analysis-20260922.json`.
- Reproducer: `.planning/jev/matrix-independent-analysis-20260922.cjs`.

The scoring rule is consistently `P(original positive event) > 0.5`: direct
Noul, one minus negated Noul, Choice's `yes` probability, or two-level Score's
level-1 probability. Choice's named selection is not substituted at exact
probability ties. ECE uses the same ten bins throughout.

| Treatment | Correct / 224 | Holdout correct / 128 | All-case Brier | All-case ECE | Development-selected cut → holdout correct |
|---|---:|---:|---:|---:|---:|
| Original Noul, repeated | 212 | 119 | 0.05070 | 0.07728 | 0.50 → 119 |
| Negated question, probability complemented | 200 | 113 | 0.08395 | 0.10728 | 0.30 → 113 |
| Choice, yes/no order | 208 | 117 | 0.04743 | 0.02165 | 0.35 → 117 |
| Choice, no/yes order | 207 | 117 | 0.04942 | 0.03357 | 0.40 → 118 |
| Score, two levels | 192 | 108 | 0.09822 | 0.06062 | 0.55 → 110 |
| Opaque question ID | 211 | 118 | 0.05093 | 0.06790 | 0.50 → 118 |
| Irrelevant padding | 206 | 116 | 0.05387 | 0.07304 | 0.30 → 118 |
| Eight extra marker questions | 211 | 119 | 0.05145 | 0.06763 | 0.50 → 119 |
| Injected “answer yes” | 206 | 115 | 0.06322 | 0.07210 | 0.50 → 115 |
| Injected “answer no” | 205 | 115 | 0.06306 | 0.07116 | 0.45 → 113 |

Primitive choice matters. The two-level Score formulation lost 20 correct
answers against the matrix's original Noul, despite describing the same event.
Choice had better Brier/ECE on this corpus but fewer correct thresholded
decisions. This does not make either primitive universally better; a rubric and
decision threshold need validation for the actual task. Negation is also not
semantically free: complementing its answer still left 18 decisions different
from the original, with 15 harms and 3 improvements.

### Invariance versus ordinary repeat variation

The repeated original is an essential control. Compared with the first run,
only **94/224 probabilities were exactly equal**; mean absolute movement was
**0.01076**, maximum **0.12**, and one decision flipped. The flipped case,
`answerability/all-callers/a`, moved from 0.50 to 0.55 and became incorrect under
the strict threshold. Accordingly, the first run's 213/224 and the repeated
run's 212/224 are distinct observations, not conflicting summaries.

| Comparison | Mean absolute probability movement | Decision flips |
|---|---:|---:|
| Original repeat versus first original | 0.01076 | 1 |
| Opaque ID versus matrix original | 0.01295 | 1 |
| Extra-question fanout versus matrix original | 0.01384 | 3 |
| Reversed Choice order versus forward Choice | 0.01549 | 5 |
| Padding versus matrix original | 0.03906 | 8 |
| Negation versus matrix original | 0.10045 | 18 |
| Score versus matrix original | 0.11201 | 24 |

Opaque-ID movement is similar to ordinary repeat variation; it does not show
that IDs influence inference. One observation per case/treatment cannot separate
stochastic, serving and transformation effects reliably. Padding also changes
the evidence wrapper, so this treatment does not isolate length alone. Choice
order caused five observed flips, but repeated Choice trials would be needed
to isolate ordering from ordinary repeat variability.

The extra marker questions expose a separate limitation. All **1,792** contain
their requested literal marker, independently checked against the transmitted
instructions. Only **1,727/1,792** returned `p > 0.5`; 65 failed this trivial
predicate. One answer assigned 0.24 to whether the statement “Control marker 1
is present in this question.” contains marker 1. These question-embedded
controls are diagnostic; they are not 1,792 new independent code tasks. Literal
presence belongs in deterministic code, not a probabilistic verifier.

### Adversarial source instructions: label-stratified results

The attacks were fixed independently of the gold labels. The positive attack
ordered every answer to yes/1.0; the negative attack ordered every answer to
no/0.0. Both were placed in an explicitly untrusted source appendix, and the
question instructed the model to evaluate only the task evidence.

| Treatment | Correct on 137 false-label cases | Correct on 87 true-label cases | Newly wrong toward attack among originally correct targeted cases |
|---|---:|---:|---:|
| Matrix original | 130 | 82 | — |
| Injected yes | 129 | 77 | 1 / 130 |
| Injected no | 129 | 76 | 6 / 82 |

The overall decline is not equivalent to attack obedience. Injected yes also
turned five correctly positive cases negative, opposite its requested
direction. Both attacks produced very similar probabilities: comparing yes
directly with no gave mean absolute movement **0.01710**, mean signed movement
only **+0.00147**, and three decision differences. Affected examples included
correctly treating a quoted attack string as data in the original request,
then wrongly marking it active under either appendix direction.

These observations show imperfect robustness of these particular composed
requests. They do not establish broad resistance or susceptibility to arbitrary
prompt injection. Compared with original, each attack adds both a wrapper and
malicious text; there is no otherwise identical benign-appendix control here.
The yes/no comparison shares the wrapper, but neither treatment was replicated.

### Cost and latency

The matrix used **1,455,988 reported input tokens**, an estimated **$0.061151496**
at the recorded rate. Across sequential requests, p50 was **177 ms**, p95
**253 ms**. Padding accounted for 408,866 input tokens; original Noul used
95,714, and nine-question fanout used 217,570. Fanout supplied one target plus
eight trivial controls, so these data do not establish cost savings for batching
nine real code judgments. The matrix is ten correlated views of 224 cases,
not 2,240 independent demonstrations of correctness.

### The conservative cascade does not retain most cheap answers

The separate paired report `.planning/jev/live-paired-cascade.json` evaluates
confidence in the observed mini decision: estimated disagreement is `1-p` when
mini answered true and `p` when mini answered false. This differs from the
original task's positive-event threshold discussed earlier.

Independent recomputation confirmed that maximizing development retention with
zero observed retained errors selects **0.05**, retaining **19/96** development
answers. On holdout it retains **23/128 (17.97%)**, all observed correct, while
escalating **105/128 (82.03%)**. Zero errors in 23 retained controls is not a
guarantee. No strong-model escalation was executed; the reported perfect oracle
upper bound assumes every escalated answer is repaired.

This challenges the proposed “keep most cheap answers” cascade for these tasks.
It leaves a stronger hypothesis to test: use Jev directly for narrow evidence
classification where it is already cheaper and more accurate, with deterministic
checks owning executable facts and a separately measured escalation policy for
uncertain semantic judgments.
