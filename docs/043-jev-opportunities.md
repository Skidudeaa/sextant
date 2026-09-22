# Jev experiments for Sextant

Research baseline: 2026-09-21, Sextant `95712cc45636cc5cc4a11e97511f44dd1489a08f`.
This is an experimental research surface, not an activation of dormant hooks.
The current user explicitly requested exploration with Jev; the older blanket
prohibition on LLM calls in `CLAUDE.md` does not prohibit this separate lab.

## Thesis and evidence boundary

Sextant already knows where code is, what imports what, which bytes changed,
and what evidence reached an agent. Jev might be useful as a cheap *question
about those observations*: does this evidence answer the actual task, does this
claim overstate what was checked, or do these disjoint changes disagree on a
shared protocol? Its value must be measured against the current deterministic
pipeline and a reasoning-model comparator. A typed answer is not correctness.

The strongest opportunity is **deciding what evidence is missing**, then
spending the next read or expensive model call there. Generic reranking alone
would repeat a saturated experiment on easy self-repo definition lookups.

Historical correction matters. `HIBERNATION.md` and
`docs/041-hibernation-results-review.md` withdrew the original pooled causal
reading: repository imbalance and mixed-arm session carryover contaminated it.
The prior intervention was not disproven. We should not reuse file-open rate
alone as the success criterion for this new intervention.

## Current seams, not invented architecture

| Observed seam | Present behavior | Experimental Jev question | First falsifiable comparison |
|---|---|---|---|
| `lib/classifier.js:shouldRetrieve` → `commands/hook-refresh.js` | Lexical prompt classification before retrieval | Does the current turn actually require repository evidence, including anaphoric follow-ups? | Recover missed code tasks without firing on quoted identifiers in translation or prose. |
| `lib/graph-retrieve.js:graphRetrieve` and `lib/merge-results.js:mergeResults` | Graph/text candidates merged with lexical and definition signals | Is each candidate useful for this task, including requested tests or callers? | Baseline versus candidate-level verification on identical candidate pools; measure candidate recall ceiling first. |
| `lib/format-retrieval.js:formatRetrievalDetailed` | Owns the actual rendered subset under the context cap | Does the *visible* evidence suffice to answer the question? | Measure unsupported-answer reduction and additional reads, using only the rendered subset as model state. |
| `lib/claims.js:diffClaims` | Byte snapshots, rederived symbol positions and publication fence | Does an agent's natural-language claim exceed this direct evidence? | Catch “definition exists → production executes it” without retracting supported structural facts. |
| `lib/coherence.js:worksetOverlap` | Path/region intersections, not semantic conflict proof | Do disjoint edits disagree on producer/consumer contracts? | Compare with path overlap on field renames, units, cache keys and closed enums; require explicit counterevidence. |
| `lib/closure.js` with `lib/structural-delta.js` | Reports structural changes, witnesses observed and gaps | Do observed tests actually distinguish the changed behavior? | Constructor, cancellation, boundary and route-serialization mutation controls. |
| `lib/capsule.js` and claim provenance | Retains served evidence by task and repository fingerprint | Has new evidence invalidated the assumption behind an agent's next step? | Replay before/after task snapshots; distinguish new uncertainty from actual contradiction. |
| `lib/cochange.js` | History-derived partners can lack import edges | Does the co-change pair express a shared behavioral contract? | Compare protocol-linked pairs against release/changelog co-change distractors. |

Relevant history was inspected through current callers and targeted Git history:
`0892fb9` introduced classifier/graph retrieval, `0d28a0f` wired the hook pipeline,
`674a0cb` closed stale graph labels in hook output, `8b1da3d` introduced the claim
ledger, `edf40e3` introduced bounded coherence, and `6d1cf70` repaired classifier
prose gating. Current `commands/hook-refresh.js` still calls `graphRetrieve`,
`mergeResults`, and `formatRetrievalDetailed`. Existing stale-content suppression
and claim snapshot fences remain authoritative. No alternate worktree history
was executed; the listed old temporary worktree is prunable.

## Runnable initial corpus

`experiments/jev/cases.js` exports `{ cases }`: 128 labeled cases, 64 matched
scenario pairs, 16 families. A pair shares task/context/questions and changes
the observed evidence or candidate. Every pair has one `flag=false` and one
`flag=true` control. There is no sampling or unseeded randomness.

| Partition | Cases | Purpose |
|---|---:|---|
| Development | 48 | Two scenario groups from each of 12 development families; threshold/prompt work only here. |
| Scenario holdout | 48 | Two different groups from each of those families. |
| Family holdout | 32 | Entirely withheld families: task overlap, schema fabrication, repository claims, repository retrieval. |

Sixteen cases are manually transcribed, revision-pinned repository evidence;
112 are explicitly synthetic minimal scenarios. All labels are authored, not
physician-adjudicated, developer-adjudicated by an independent reviewer, or
produced by Jev. The set measures bounded discrimination and can expose failure;
it cannot establish real-repository effectiveness or production calibration.
Repository cases are mostly easier source-understanding controls, not a claim
that a full retrieval session was replayed.

Provider payloads must contain **only** `state` and `questions` plus the pinned
model. Keep `id`, `groupId`, `expected`, rationale, split and provenance out of
the inference input. The HTTP API explicitly says question IDs are not used in
inference; every question therefore specifies its target in instructions.

Run the corpus checks with:

```bash
node --test experiments/jev/cases.test.js
```

These checks establish pair structure, partition separation, label exclusion,
revision/path provenance and several actual Sextant behaviors. They do not
evaluate Jev. Live results require provider/model/usage stamps and separate
reports, including failures rather than treating missing scores as approvals.

The additional executable audit runs original/changed fixture code, actual
Sextant import extraction, Babel type-import AST checks, and finite protocol
checks:

```bash
node --test experiments/jev/cases.test.js experiments/jev/oracles.test.js
node experiments/jev/oracles.js
```

Executed result on this baseline: **32/32 audited case labels agree**, across
behavior change, dependency edges, test gaps and cross-file invariants. The
other **96 labels remain authored and not independently executed**. Explicit
label-flip and observation-change controls demonstrate that the audit can
disagree with fixture labels. The test-gap audit actually executes each supplied
test against original and changed behavior; constructor bypass leaves both
versions passing, whereas real construction kills the missing-initialization
mutation. The VM executes only these committed fixtures, not arbitrary input.

The current `shouldRetrieve` baseline also ran on the four distinct intent
prompts. It agrees with two tasks and overfires on both “Thanks, that was
useful.” and the explicitly self-contained translation of a quoted identifier.
That is **two task-level disagreements**, represented by four paired-case
disagreements, not four independent failures. This establishes useful baseline
headroom; no Jev improvement has yet been measured by this audit.

One edge-contract finding changes integration design: current Sextant extraction
intentionally retains `import type` as `kind: "import"`. The independent Babel
AST shows `importKind: "type"`, which has no runtime import. A future semantic
edge layer must preserve the existing structural import graph and express
runtime/type-only distinctions separately; silently redefining that graph would
break existing semantics.

## Near and far experiments

1. **Evidence acquisition controller.** Ask whether the current excerpts answer
   each atomic claim; read only the next candidate needed to resolve the gap.
   Compare tokens, reads, latency and unsupported conclusions with fixed top-k.
   Novelty is a hypothesis, not a claim that nobody has attempted it.
2. **Counterfactual context deletion.** Remove one excerpt at a time and ask
   whether answerability changes. A context block that survives deletion was
   either redundant or never informative; validate by withheld-answer accuracy.
3. **Semantic cross-agent contention.** Cross-product *changed interfaces*
   rather than whole files, then ask narrow producer/consumer compatibility
   questions. Prove gains specifically on disjoint-file conflicts invisible to
   path-overlap, and count needless coordination on independent same-file edits.
4. **Claim debt meter.** Track unsupported assertions introduced between agent
   turns. Retractions and fresh evidence pay down debt; a confident restatement
   does not. Test against independent evidence review rather than Jev judging
   its own prior scores.
5. **Behavior-preserving edit sieve.** Let deterministic extraction nominate
   changed boundaries; Jev flags ordering, timing, nullability and units for
   focused tests. A negative flag never proves equivalence.
6. **Test distinguishability.** Ask whether a particular test can distinguish
   original from mutated behavior before paying to execute expensive suites.
   Validate by actually running the mutations; “looks covered” is not coverage.
7. **Intent lineage arbitration.** Ask whether an old rationale still applies
   after a newer explicit contract. Preserve speaker, timestamp and revision;
   never infer author rationale from a diff alone.
8. **Semantic cache invalidation.** Use changed source facts to nominate cached
   natural-language claims for rechecking. Hashes still determine whether bytes
   changed; Jev only prioritizes what to re-read or retract provisionally.
9. **Graph edge type checking.** Distinguish direct/runtime/type-only/re-export/
   historical relationships for rendering and research. Keep parser facts;
   do not turn the model into an authoritative import resolver.
10. **Negative-space search.** Detect a missing required branch or unsupported
    all-callers conclusion, then retrieve counterexamples. This targets absence
    mistakes a top-k relevance score often misses.
11. **Context poisoning isolation.** Test active source instructions against
    quoted security examples and code string literals; retain contradicting
    evidence rather than blindly dropping everything adversarial-looking.
12. **Cost-aware uncertainty experiments.** Compare whole-record judging,
    decomposed field checks, independent calls, batch calls, polarity reversal
    and question-order permutations. These are stability probes, not automatic
    calibration improvements.

## Evaluation that can kill the thesis

Freeze development decisions before reading holdout outcomes. Report per-family
precision/recall, false acceptance, abstention/coverage, Brier score and paired
control accuracy. Report scenario and family holdout separately. A balanced
synthetic set cannot estimate production base rates or calibrate a deployment
threshold. Use group-level uncertainty estimates, because paired cases are not
independent observations.

Require a concrete gain over a deterministic baseline **and** compare with an
always-escalate reasoning model. Candidate ranking cannot rescue an absent gold
file. A faster API call alone cannot prove saved task time. Errors in API input,
missing answer IDs, malformed probabilities, timeouts or provider failures are
failed evaluations, not accepted cheap answers.

The next evidence step after synthetic screening is historical Sextant query
replay with frozen candidate sets and independently reviewed task-level gold.
Any ambient canary should randomize by session/task rather than switching arms
within a continuing context, stratify by repository and client, and distinguish
correct answer or repair outcomes from file-open telemetry. No fleet restore is
needed to conduct the initial experiments.

## TypeSafe sources inspected

The complete [documentation index](https://docs.typesafe.ai/llms.txt) was fetched
before selecting pages. The [HTTP API reference](https://docs.typesafe.ai/api)
documents `POST /v1/systemone`, structured state, typed questions, explicit Noul
criteria and question-ID invisibility. The index also identifies the current
[model jaggedness page](https://docs.typesafe.ai/model-jaggedness/jev-1.13),
[reranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe),
[RAG passage classification](https://docs.typesafe.ai/cookbooks/classifying_rag_passages),
and [SDE cascade](https://docs.typesafe.ai/cookbooks/sde_cascade).
Vendor cookbook results and calibration claims are vendor evidence; this corpus
does not independently reproduce them.
