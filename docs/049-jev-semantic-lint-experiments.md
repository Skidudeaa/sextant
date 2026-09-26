# Jev semantic-lint experiments

Run 2026-09-25 on Sextant `b483ab30dbf2a1e82a68b0433db5b938af4a3526`, model `jev-1.13.0` (returned by every scored response). All experiments are offline. No hook, watcher, or runtime path changed. Raw artifacts are under `.planning/jev/` (gitignored). Measured Jev input for sections 1–5: about 3.8M tokens, roughly $0.16 at $0.042/M; sections 6–8 add 3.8M, 4.6M and 11.3M tokens, plus unmetered tokens from responses the client rejected.

## Summary

| Experiment | Question | Result |
| --- | --- | --- |
| Test-witness selection (`witness.js`) | After an edit, which test files fail? | Jev ties the static ranking. Coverage plus static ranking reaches hit@1 0.89 with no model. |
| Commit-focus co-change (`cochange-focus.js`) | Does down-weighting bundle commits improve co-change prediction? | No. Indistinguishable from baseline (sign test p≈0.83). |
| Doc drift (`doc-drift.js`) | Do docs cite paths/symbols that are gone or wrong? | Deterministic: 0 dead symbols, 62 dead-path mentions after triage, mostly illustrative. Semantic: AUC 0.64, too weak. |
| Claim vs evidence (`claim-evidence.js`) | Do final messages claim checks the turn never ran? | 35/46 Codex "tests passed" claims have no test run in the same turn, but most relay other turns or workers. |
| Tree walk (`tree-walk.js`, docs/042 E09) | Can a Jev beam walk of the repo tree rescue empty graph results? | Undecided: 2 empty-graph queries; 54% of walks were rejected by the client before the rounding fix below. |
| Semantic locate v1 (`semantic-locate.js`) | Does Jev find the files and lines a prose request changes? | Sextant only: thin descriptors lose to the graph; line ranking leads but unproven. v2 running. |
| Defect prediction (`defect-predict.js`) | Does Jev reading code predict where fixes land? | Yes on low-history files: 0.70–0.72 AUC vs churn 0.63 and fan-in 0.53. |
| Role map (`role-map.js`) | Can Jev tag file roles, and does a role map beat the directory map? | Tagging yes (recall ≥0.8 on 6/7 roles). Routing no (11 vs 17 at matched size, p=0.34). |

One finding applies to every Jev integration: see "Provider rounds probabilities to cents".

## 1. Test-witness selection

**Design.** 120 seeded mutants (seed 20260925, one site per function, at most 4 per file, 53 source files, drawn from 9,684 operator/literal sites in 685 named functions). Each mutant was applied in a disposable worktree and all 82 eligible test files were run. A test file counts as killing only if it fails twice. Twelve files fail on unmodified main and were excluded: the ten `jev-*` acceptance tests whose `lib/` modules are not on main, `mcp-server`, and `sync-rescan`. 68 mutants were killed and 52 survived.

Jev got one request per mutant: the before/after function, the edited line, and 20 shortlisted test files (path, test titles, ≤1.4 KB excerpt), with one Noul per file ("would at least one test here fail?"). The shortlist comes from static signals only (direct import, name mention, transitive import, co-change). Coverage was recorded separately with `NODE_V8_COVERAGE`, including spawned CLIs, and was never shown to Jev.

**Results** (68 killed mutants; hit@k = a killing file in the top k, exact under random tie-breaking):

| Arm | hit@1 | hit@3 | MRR | AUC | shuffled order hit@1 / MRR |
| --- | --- | --- | --- | --- | --- |
| jev | 0.80 | 0.94 | 0.88 | 0.96 | 0.79 / 0.87 |
| static_priority (import, mentions, transitive, co-change) | 0.74 | 0.96 | 0.85 | 0.94 | same |
| direct_import | 0.60 | 0.85 | 0.74 | 0.81 | same |
| coverage | 0.65 | 0.83 | 0.76 | 0.98 | same |
| coverage_then_jev | 0.91 | 0.97 | 0.95 | 0.99 | 0.91 / 0.94 |
| coverage_then_static | 0.89 | 1.00 | 0.94 | 0.99 | same |
| random | 0.03 | 0.09 | 0.11 | 0.50 | same |

Paired first-hit comparisons (exact sign test):
- Jev beats direct import (35 better / 11 worse, p=0.0005) and coverage alone (34/11, p=0.0008).
- Jev vs static_priority: 15/9, p=0.31 ordered; 16/12, p=0.57 shuffled.
- coverage_then_jev vs coverage_then_static: 8/4, p=0.39 ordered; 10/5, p=0.30 shuffled.

Candidate order carried the static ranking in the default requests. A seeded shuffle of the same candidates moved Jev hit@1 from 0.80 to 0.79, so position was not the source of its score.

Jev's probabilities were well calibrated on the 2,400 shortlisted pairs: kill rate 1.1% in the 0–0.2 bin and 91% in the 0.8–1.0 bin, Brier 0.050. It flagged a file above 0.5 on 5 of 52 surviving mutants (8 in the shuffled run). The speculative `behavior_changes` question separated killed from surviving mutants only weakly (AUC 0.71). Latency p50 192 ms; about 10k input tokens per request.

**Reading.** Kill criterion met for Jev: it does not beat the static baseline, either alone or on top of coverage. The deterministic result is the useful one. Every killing file executed the mutated expression under coverage (68/68; no kill outside coverage), and ordering covering files by static signals puts a killing file first 89% of the time. A coverage map from one instrumented run of the suite would give Sextant a "tests likely affected" line with no model call.

**Caveats.** One repository, whose tests follow a module-per-file naming convention that favors static signals. Mutants are single-token operator/literal changes, not real edits. Mutants in the same file are correlated. Execution labels are per test file.

**Implementation note.** V8 attributes a short-circuit operator to the right operand's block. Execution is therefore checked at the expression start; checking the operator offset reported a line that ran as unexecuted (`witness.test.js` pins this).

## 2. Commit-focus weighting for co-change

Jev scored 128 of 139 eligible training commits (first 197 of 247 non-merge commits) on a three-level focus rubric. Evaluation: predict partners for 77 (commit, file) units in the last 50 commits. With co-change counts as a pure re-ranking of baseline's candidates (no floor):

| Arm | hit@1 | hit@3 | MRR |
| --- | --- | --- | --- |
| baseline | 0.35 | 0.61 | 0.485 |
| jevWeighted | 0.32 | 0.60 | 0.468 |
| jevHardDrop | 0.36 | 0.56 | 0.487 |
| sizeInverse (1/files) | 0.36 | 0.62 | 0.495 |
| sizeDrop (>3 files) | 0.30 | 0.52 | 0.426 |

Jev arms vs baseline: sign test p≈0.83–0.85. Only sizeDrop differs significantly, and it is worse (p=0.009). The focus score itself behaves as intended: its correlated "mentions more than one unrelated fix" Noul rises from 0.12 to 0.72 across focus buckets. It just doesn't change which partners are right. The first report used co-change's count floor, and fractional weights pruned candidates below it. That mixed weighting with pruning and made the size controls look dead; the table above removes the floor.

## 3. Documentation and memory drift

Deterministic scan of CLAUDE.md, README.md, 48 top-level docs, and 50 memory files: 1,239 path-like references and 134 `path:symbol` or `path:line` references. Results:
- 0 dead symbols.
- 293 dead paths. Most are generated per-repo artifacts, files Sextant writes into target repos, or other projects. After removing those and same-line "removed/legacy/external" mentions, 62 remain. They are mostly illustrative names (`main.swift`, `.ts`, `frontend/`) and enum values shaped like dotfiles. Full list: `.planning/jev/doc-drift/part1-scan.json`.

Semantic check: 28 claims, each paired with a source mutation that contradicts it. Paired discrimination was 5/28 and AUC 0.635 using the whole line; narrowing the claim to its own clause raised both arms together (AUC 0.640). The lowest-scored real claims (e.g. CLAUDE.md:177 on `decideArm`, :199 on `computeStructuralDelta`) are accurate but cite a symbol that only covers part of the sentence; the rest lives in a caller. That is an under-citation signal, not drift, and too weak to lint on.

## 4. Claim vs evidence in agent transcripts

Only two Sextant Claude transcripts remain after retention, one of them the live session. The corpus was therefore 26 Codex rollouts whose cwd is `/root/sextant` or a worktree under it, all from 2026-09-22. That gave 648 final-message sentences in 109 requests. Jev classified claim kind; code checked the same turn's tool calls:

| Claim kind | n | unsupported / checkable |
| --- | --- | --- |
| tests_passed | 46 | 35/46 |
| command_ran_ok | 75 | 36/38 (37 name no command) |
| file_changed | 20 | 17/20 |
| verified_behavior (weak rule) | 57 | 15/57 |

Jev agreed with a narrow regex labeler on 24/29. The "unsupported" rate is not a fabrication rate. These were OMC lead sessions that relay worker and prior-turn results ("116 new tests pass"), and the check only looks at the current turn. A useful version needs session-wide and cross-session evidence, including worker transcripts.

## 5. Tree walk (E09)

Graph retrieval and Jev beam walks (B = 1, 2, 4) over Sextant's own tree. Queries: 22 commit subjects with leaking names filtered out, plus 1 transcript prompt. Only 2 queries produced an empty graph result, the subset the hypothesis is about, so the kill criterion could not be evaluated. 37 of 69 walks failed client validation on the rounding defect below, mostly on Choices over `test/` (88 children) and `lib/` (49). Treat beam2/beam4's 0.55–0.60 hit@1 on the surviving walks as survivorship-biased. The retrieval snapshot was HEAD, not each commit's parent, which favors the graph arm.

## 6. Semantic locate, Sextant only (v1)

Question: does Jev find the code a prose request is about? Query = commit subject; labels = the files and old-side lines the commit changed, evaluated at its parent. 246 commits; after dropping subjects that name a label file or one of its identifiers, 46 remain (`semantic-locate.js`, `.planning/jev/semantic-locate/`).

| File-level arm | hit@1 | hit@5 | MRR |
| --- | --- | --- | --- |
| graph (hook fast path) | .124 | .310 | .229 |
| retrieve() with rg | .062 | .200 | .151 |
| Jev over ≤350-char file descriptors | .063 | .247 | .168 |
| random | .042 | .187 | .135 |

Jev with thin descriptors barely beats random and loses to the graph (sign test 18/26, p=.29). On the 20 queries where the graph returned nothing, Jev doubles random hit@1 (.070 vs .035), too few to test. Inside the true file, Jev ranks changed lines better than query-term matching on every point metric (hit@5 .289 vs .191, random .126; 128 units), but the paired sign test is 65/62. v2 adds four more repos, a full-content ceiling arm, precomputable rich descriptors, and a Wilcoxon test.

## 7. Defect-location prediction

Question: can Jev, reading code, predict where fixes will land better than the signals Sextant has? Five repos (sextant, jan25, defGen2, DwoodAmo, amoSportsCenter), cutoff at each repo's 60th-percentile commit, 868 source files, 218 modified by a later fix. Fix commits were identified by a Jev Noul (primary) and by a keyword regex (secondary; 84% agreement). Jev answered seven atomic Nouls per file at the cutoff (`defect-predict.js`, `.planning/jev/defect-predict/`; 4.56M tokens, $0.19).

| Predictor | pooled AUC | recall of fixed files in top 20% of LOC |
| --- | --- | --- |
| churn | 0.818 | 0.399 |
| Jev: encodes business rules with interacting conditions | 0.779 | 0.422 |
| lines of code | 0.751 | 0.261 |
| past fixes | 0.743 | 0.312 |
| fan-in (Sextant's importance signal) | 0.668 | 0.362 |
| Jev: direct "likely to need a fix" | 0.610 | 0.317 |

On files with little history the order flips. Within-repo AUC, averaged by file count:

| Subset | files / fixed | churn | Jev business rules | fan-in |
| --- | --- | --- | --- | --- |
| churn ≤ 2, Jev fix labels | 592 / 72 | 0.637 | 0.720 | 0.543 |
| churn ≤ 2, regex fix labels | 592 / 63 | 0.632 | 0.697 | 0.525 |
| churn ≥ 5, regex fix labels | 148 / 101 | 0.769 | 0.583 | 0.471 |

Leave-one-repo-out logistic regression: adding the seven Jev features to churn, past fixes, LOC, fan-in and age raises pooled held-out AUC 0.850 → 0.865 (bootstrap CI +0.006 to +0.024) with Jev fix labels, but only +0.007 (CI −0.004 to +0.017) with regex labels.

**Reading.** Kill criterion not met. One narrow code-reading question beats fan-in everywhere and beats churn on the two-thirds of files that have almost no history. The two are complementary: churn finds the hot files, and Jev finds the risky ones among the quiet majority. The broad "will this need a fix" question is 0.17 AUC worse than the narrow one. Separately from Jev, churn is free from git, beats fan-in by 0.15 AUC, and Sextant does not use it for importance.

## 8. Semantic role map

Question: can Jev tag what each file does, and is a role map a better orientation map than the directory skeleton? Same five repos and cutoffs as section 7, 868 files (`role-map.js`, `.planning/jev/role-map/`; 11.3M tokens, $0.47).

Tagging (one Noul per role per file) against pattern detectors, which are proxies that miss things, so the negative rate is an upper bound on false positives:

| Role | detector positives | Jev recall | Jev rate on detector negatives |
| --- | --- | --- | --- |
| cli | 73 | 1.00 | 0.10 |
| http_api | 67 | 0.94 | 0.01 |
| ui_component | 147 | 1.00 | 0.03 |
| filesystem_io | 146 | 0.95 | 0.05 |
| external_api_client | 123 | 0.85 | 0.20 |
| persistence | 78 | 0.82 | 0.24 |
| llm_call | 65 | 0.62 | 0.04 |

A two-level taxonomy walk (Choice per level, beam 2) agreed with the flat tags on 88% of files.

Routing: for commits after the cutoff, a commit subject was routed through the role tags (R1) or through a directory map (R2), and each arm's candidate set was checked for the changed file. At matched set size, R1 beat R2 on 11 commits and lost on 17 (94 ties, n=122, sign test p=0.34). By area under the coverage-vs-size curve, R1 won 3 repos narrowly and lost DwoodAmo and amoSportsCenter by a wide margin. Stage B was capped at 25 queries per repo after an oversized Stage A request format used most of the budget.

**Reading.** Tagging works: Jev recovers pattern-detectable roles with recall ≥0.8 on 6 of 7. Routing prose requests through those tags does not beat routing through directories. The tags are useful as file facts (section 7's business-rules question is one), not as a route from a request to files.

## Provider rounds probabilities to cents

`jev-1.13.0` returns Choice and Score probabilities rounded to 0.01. Summed, n rounded values can miss 1 by up to n × 0.005. The experiment client required |sum − 1| ≤ 0.001. Consequences:
- about 13% of 6-option Choice responses rejected (claim-evidence)
- 5/8 identical 45-option requests rejected (tree-walk)
- a Score of 0.01 over a one-hot rounded distribution rejected (cochange-focus)

`experiments/jev/client.js` now allows n × 0.005 only when every value is a whole cent, with the matching per-level bound for Score, and keeps 0.001 otherwise. `client.test.js` pins the observed 0.99 case, and the test fails with the bound removed. The unmerged runtime client on the Jev branches (`lib/jev-client.js`) still has the strict check.

## Next

- If "tests likely affected" is wanted, build it deterministically: a per-test coverage map refreshed by an instrumented run, ordered by static signals. Measure it on real edits from history rather than synthetic mutants.
- Jev remains a candidate only where static signals are absent; this repo's naming conventions make them strong. A repo without module-per-file tests would be the next witness corpus.
- Tree walk needs a larger natural-language query set with empty graph results before another run.
