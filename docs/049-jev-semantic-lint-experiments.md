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

**Amendment, 2026-10-12 (reanalysis of the frozen `report.json`, no new provider calls).** The low-history table above omits line count. On the same churn ≤ 2 subset, within-repo AUC weighted by file count:

| Label source | LOC | Jev business rules | churn | fan-in |
| --- | --- | --- | --- | --- |
| Jev fix labels | 0.693 | 0.720 | 0.637 | 0.543 |
| regex fix labels | 0.666 | 0.697 | 0.632 | 0.525 |

Jev's margin over a free line count is about 0.03, not the 0.08 over churn. Spearman(Jev business rules, LOC) on these 592 files is 0.72; the per-file score is a max over chunks, so longer files get more draws. Comparing only fixed/unfixed pairs in the same repo and the same LOC quintile, Jev business rules scores 0.63 and churn (0, 1 or 2 commits) scores 0.69. DwoodAmo supplies 379 of the 592 files and 42 of the 72 positives; on Sextant, jan25 and defGen2 Jev is at or below LOC. The leave-one-repo-out gain is positive with a CI excluding zero in 2 of 5 repos under Jev labels and in none under regex labels. Read "beats churn on the two-thirds of files that have almost no history" as: a small size-adjusted signal, concentrated in one repo.

The "v2 running" note in §6 is stale: v2 stopped after extracting Sextant's commits and produced no Jev responses or report.

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

## 9. Hunk replay: Jev as diff triage (2026-10-12)

Question: reading a changed function before and after, does Jev predict that the change will later need a fix, beyond change size and file history? This tests the unmerged edit sieve (`lib/jev-sieve.js`) as a review-time ranking of a diff. Code: `experiments/jev/hunk-replay.js`; artifacts: `.planning/jev/hunk-replay/`. Run on Sextant `74014c5`, `jev-1.13.0`, 7,820 requests, 0 failures, 15.99M input tokens, $0.67.

**Design.** Same five repos as section 7. Unit = (commit, file, enclosing function) with at least one added code line, for commits in the first 70% of each history. Label = SZZ: a later commit whose subject matches the fix regex removed or rewrote a line that `git blame -w` attributes to that commit inside that function. Labels use the regex only. Two arms per unit on identical state (`path`, `symbol`, `before_source`, `after_source`): the sieve's six questions verbatim, and four narrow defect-risk questions. Gates were written to `manifest.json` before any provider call: (A) concordance of the arm's primary score over fixed/unfixed pairs in the same repo and changed-line bin ≥ 0.60; (B) pooled leave-one-repo-out AUC gain over eight baseline features with a bootstrap 95% CI above zero. An arm survives only with both.

**Coverage.** The sieve accepts only edits to a function that already existed under a unique name.

| | units | later fixed | changed lines |
| --- | --- | --- | --- |
| all changed units | 17,574 | 2,152 | 334,921 |
| sieve-eligible | 3,910 (22%) | 604 (28%) | 34,832 (10%) |

Of the 1,548 fixed units it cannot see, 860 are in new files, 306 are new functions and 297 are module-level code.

**Results** (3,910 units, 604 fixed):

| Arm | primary score | Gate A (≥ 0.60) | LORO AUC baseline → full | delta, 95% CI | recall at 20% of changed lines |
| --- | --- | --- | --- | --- | --- |
| sieve | behavior_changed | 0.583, fail | 0.658 → 0.680 | +0.022 (0.014 to 0.030), pass | 0.364 → 0.402 |
| risk | interacting_conditions | 0.591, fail | 0.658 → 0.665 | +0.007 (0.002 to 0.013), pass | 0.364 → 0.382 |

Function length alone (`scopeLoc`) reaches 0.615 on Gate A's measure, above every Jev answer (best: `sieve.units` 0.592, `risk.interacting_conditions` 0.591). The sieve's gain is positive in four of five repos (Sextant −0.001).

**Reading.** Kill criterion met: neither arm passes both gates. The signal is real and small. Jev adds about 0.02 AUC on top of size and history, which moves recall from 36% to 40% of later-fixed functions at a fixed reading budget, inside the 28% of later-fixed units the sieve can see. A free line count of the function ranks better than any single Jev answer. The direct "introduces a defect" question (0.581) was no better than the narrow ones, as in section 7.

**Caveats.** Regex fix labels are noisy and cap every AUC here. SZZ cannot label a fix that only adds lines. The 0.60 threshold was chosen in advance and not tuned; both arms missed it by 0.01 to 0.02. Two arms were tested.

## 10. Rule guard: Jev checking shell commands against written rules (2026-10-12)

Question: started from Jev's measured strengths instead of a Sextant seam. Jev is best at yes/no judgments about language against a small context, is slow to raise false alarms, and answers in under 200 ms. Can it check a pending Bash command against written working rules with few enough false alarms for a PreToolUse hook? Code: `experiments/jev/rule-guard.js`; artifacts: `.planning/jev/rule-guard/`. `jev-1.13.0`, 1,687 requests, 0 failures, 30 s wall at concurrency 8, p50 136 ms, p95 183 ms, $0.055.

**Design.** Corpus: 1,607 distinct Bash commands from Sextant's Claude Code transcripts and Codex rollouts, redacted and cut at 1,500 characters. One request per command carrying eight rules as Nouls. Each rule also has 5 constructed violations, 5 near misses, and a hand-written regex, all written before any Jev answer. Preregistered: per-rule cutoff = highest of {0.5 … 0.95} that still flags 4 of the 5 constructed violations; kill if more than 0.5% of recorded commands raise a false alarm. Gold: Sonnet labelers that never saw a Jev score, on every (command, rule) pair flagged by Jev or the regex plus sampled unflagged pairs (411 pairs).

**Constructed cases.** All 40 violations scored ≥ 0.64 and all 40 near misses ≤ 0.57.

**Preregistered result: kill.** 9 of 1,607 commands raised a false alarm (0.56%); the limit was 8. The regex baseline raised 6 (0.37%). All nine Jev false alarms are on `reads_secret`; four are a task-queue `claim_token` UUID on the command line.

| Rule (cutoff) | labeled violations | Jev caught / false alarms | regex caught / false alarms |
| --- | --- | --- | --- |
| kills_process (0.9) | 12 | 4 / 0 | 4 / 0 |
| tmp_write (0.95) | 76 | 50 / 0 | 65 / 1 |
| sleep_wait (0.9) | 84 | 58 / 0 | 84 / 0 |
| reads_secret (0.7) | 29 | 11 / 9 | 29 / 6 |

The other four rules had no violation in the corpus and neither system flagged anything at these cutoffs.

**Exploratory, after seeing the labels.** Five constructed violations set the cutoffs too high. A second blind pass labeled the 53 remaining Jev flags at ≥ 0.5 (464 labels in total, 8 unclear). At a single cutoff of 0.7:

| Rule | known violations | Jev caught / false alarms | regex caught / false alarms |
| --- | --- | --- | --- |
| kills_process | 12 | 12 / 0 | 4 / 0 |
| tmp_write | 96 | 95 / 4 | 65 / 1 |
| sleep_wait | 84 | 83 / 0 | 84 / 0 |
| reads_secret | 29 | 11 / 9 | 29 / 6 |

With `reads_secret` left to the regex, the other seven rules at 0.7 raise false alarms on 4 commands (0.25%) and catch 190 of 192 known violations; the regexes catch 153. Jev's extra catches are things a keyword cannot see: 8 `omc-pair-runtime team shutdown` commands, and 30 writes through a shell variable assigned under `/tmp` earlier in the command. On `reads_secret` Jev is worse than the regex at every cutoff (AUC 0.82 on the labeled pool).

**Reading.** The guard as preregistered is dead. The exploratory numbers are the first place in this campaign where Jev beats a free baseline on real data, on two of four rules, and they are not evidence yet: the cutoff and the dropped rule were both chosen after seeing labels. The check that would settle it is a prospective run on commands not in this corpus, with cutoff 0.7 and the seven rules fixed in advance.

**Caveats.** "Known violations" are those found by either system or by sampling, so recall is relative. Labels are from a model, not a person. The second labeling pass was told that a `claim_token` is not a credential; the first pass decided that unaided. Most `tmp_write` violations are an older harness scratchpad under `/tmp/claude-0/`, so the count says little about how often the scratch policy is broken. Rules that need context beyond the command (such as "commit only when asked") were not tested. A command cut at 1,500 characters can hide a violation in its tail.

### Prospective confirmation (2026-10-12)

The exploratory reading above was rerun on new data with everything fixed in `confirm/manifest.json` before the provider calls: cutoff 0.7, seven rules, `reads_secret` ignored, the same eight-question request. Confirmed only if at most 0.5% of commands raise a false alarm and Jev catches at least as many labeled violations as the regexes. Corpus: 1,600 Bash commands sampled from Claude Code sessions in jan25, defGen2, DwoodAmo and amoSportsCenter, none present in the first corpus, with every command that mentions a credential, somaNotes or patients removed first. 0 failures, p50 138 ms, p95 183 ms, $0.053. Gold: 437 blind labels (22 unclear), covering every Jev score ≥ 0.5 and every regex match.

**Result: confirmed.** Jev raised a false alarm on 7 of 1,600 commands (0.44%; the limit was 8) and caught 185 of 197 known violations. The regexes raised none and caught 111.

| Rule | known violations | Jev caught / false alarms | regex caught / false alarms |
| --- | --- | --- | --- |
| kills_process | 29 | 26 / 1 | 13 / 0 |
| discards_work | 9 | 9 / 3 | 0 / 0 |
| tmp_write | 85 | 78 / 2 | 34 / 0 |
| sleep_wait | 65 | 64 / 0 | 56 / 0 |
| commit_msg_shell_chars | 1 | 0 / 0 | 0 / 0 |
| stage_everything | 0 | 0 / 0 | 0 / 0 |
| pushes_remote | 8 | 8 / 1 | 8 / 0 |

The seven false alarms, read by hand: `systemctl reload nginx` flagged as restarting a service (arguably correct); three `git checkout --detach <sha>` flagged as discarding work; two writes under `/root/scratch/tmp/` taken for `/tmp`; one commit with no push, scored exactly 0.70. A sample of 20 violations that Jev caught and the regex missed were all real: `team shutdown` run through `subprocess.run`, `git stash -q`, `cd /tmp/… ` followed by a relative write, `time.sleep` and `asyncio.sleep` in inline scripts. Ten of Jev's twelve misses scored between 0.47 and 0.69. The one inline commit message containing a dollar sign scored 0.02, a literal check of the kind Jev also failed in docs/046.

**Reading.** On single-command rules Jev generalizes past the keywords a regex needs: it catches about two thirds more violations at a false-alarm rate of roughly one command in 230. That margin is thin (7 against a limit of 8, and the first run failed by one), and a regex has zero false alarms. Some regex misses, such as `git stash -q`, are fixable once seen; others, such as a write through a variable or after a `cd`, are not. Rules that depend on the conversation ("commit only when asked") remain untested, and those are the ones a regex cannot express at all.

## 11. Context rule: did the user ask for a commit or a push? (2026-10-12)

Question: section 10 left out rules that depend on the conversation. The language half of "commit only when asked" is whether the recent user messages ask for or authorize a commit; whether the command is a commit stays a regex. Does Jev answer that better than a keyword check on the same messages? Code: `experiments/jev/context-rule.js`; artifacts: `.planning/jev/context-rule/`. `jev-1.13.0`, 231 requests, 0 failures, under $0.01.

**Design.** Unit: a distinct window of up to three recent user messages (typed prompts and answers to questions the assistant asked, harness messages removed), taken at a Bash command in a Claude Code session of Sextant or the four repos of section 10. 217 windows exist; 211 remain after dropping any that mention a credential, somaNotes or patients; 44 preceded a recorded commit and 14 a push. Each window gets two Nouls (commit, push) with true/false criteria. Preregistered: authorized iff Noul ≥ 0.5; baselines are a keyword regex and the same with a negation guard; pass only if Jev is right more often than the better baseline with an exact sign test p < 0.05 on disagreements. Gold: 223 blind labels (8 unclear), covering every pair where Jev ≥ 0.2, a keyword hit, or a gated action followed, plus sampled controls. 20 authored trap windows are scored separately.

**Result: not established.**

| Set | n | Jev correct | keyword correct | Jev only / keyword only right | sign test |
| --- | --- | --- | --- | --- | --- |
| recorded windows, both questions | 215 | 201 | 195 | 18 / 12 | p = 0.36 |
| windows that preceded that action | 55 | 53 | 53 | 2 / 2 | p = 1 |
| commit question | 114 | 111 | 109 | 5 / 3 | p = 0.73 |
| push question | 101 | 90 | 86 | 13 / 9 | p = 0.52 |
| authored traps (commit) | 20 | 19 | 6 | 13 / 0 | p = 0.0002 |

The negation guard changed no recorded verdict. Ten of Jev's eleven wrong authorizations are on the push question, and seven of them follow a plain "commit it" with a push score between 0.53 and 0.66: Jev leaks a commit request into push.

**Reading.** Jev handles indirect and negated phrasing that a keyword cannot (the traps), and that phrasing barely occurs in the recorded sessions. The owner asks in the literal words ("yes commit it", "push it"), so a keyword check on the last three messages is right 91% of the time and Jev's 93% is not distinguishable from it at this size. For this owner's conversations the context half of the rule does not need a model.

**Caveats.** 211 windows from 25 sessions and one person; windows from the same session are correlated. The traps are authored by the experimenter. A three-message window cannot see standing permission given earlier or in instructions files. Labels are from a model.

## 12. Guard trial: the rule guard as a live hook on one repo (2026-10-13, running)

Question: section 10 showed Jev can tell which commands break a written rule. Nothing has shown that telling the agent changes what it does next, and that cannot be answered from recorded commands. Code: `experiments/jev/guard-hook.js`; events: `.planning/jev/guard-trial/events.jsonl` (mode 0600, gitignored).

**Design.** A Claude Code PreToolUse hook on Bash, wired in `/root/jan25/.claude/settings.local.json` and nowhere else. Each command sends the section 10 request unchanged (eight questions, `reads_secret` ignored, cutoff 0.7). The hook never blocks: a note travels as `hookSpecificOutput.additionalContext` and the command runs.

- Before any provider call a command is dropped if it mentions a credential, somaNotes or patients, or if the session's working directory is outside jan25. Dropped commands are counted and their text is not kept. The rest are cut to 1,500 characters and redacted, as in the replay.
- A flag becomes a note only for a rule the owner wrote, quoted from `~/.claude/CLAUDE.md`: `tmp_write`, `kills_process`, `discards_work`, `commit_msg_shell_chars`. `sleep_wait` and `stage_everything` are broader than anything written there, and a push is wrong only when nobody asked for it; those three are scored and logged without a note.
- Two deterministic vetoes, fitted on the section 10 confirmation data after the fact: `tmp_write` needs a bare `/tmp` or `~/.cache` path once `/root/scratch/tmp` is removed (2 false alarms gone, 78 of 78 true catches kept), and `discards_work` ignores a `git checkout --detach` with no stash, reset, restore or clean beside it (3 gone, 9 of 9 kept).
- Arms: a hash of (session, rule) fixes each pair to `armed` or `holdback` for the whole session. Holdback pairs are flagged in the log and the agent is told nothing.
- Any provider error or timeout (1.5 s) lets the command through and is counted.

**Fixed in advance** (the `PREREG` constant, committed before the hook was wired). Unit: a (session, rule) pair with a first flag and at least 5 later scored commands in that session. Outcome: the share of those later commands flagged on the same rule. Read only when each arm has 20 units. Pass: armed mean below holdback, one-sided permutation p < 0.05. Kill: the floor is met and p ≥ 0.05; or noted false alarms exceed 0.5% of scored commands (needs labels); or p95 hook time exceeds 1,000 ms.

**Checks before wiring.**

- `guard-hook.test.js`: 5 tests. Seven mutations (no sensitive-command drop, no root check, no temp-path veto, no detach veto, notes for unwritten rules, arm ignored, provider failure rethrown) each fail a test.
- Live provider, 22 synthetic commands through the hook script: 320 to 540 ms per command from process start, of which about 50 ms is node, about 90 ms module load with the compile cache, and the rest one cold provider call.
- Two headless Claude Code 2.1.287 sessions in a scratch repo running `git checkout -- no-such-file.txt`. Armed session: the note is in the transcript as a `hook_additional_context` attachment and the model quoted it. Holdback session: zero mentions, one logged flag.

**Seen in the probes, not yet measured.**

- `git checkout main` scored 0.75 on `discards_work` and would draw a note. A branch switch refuses to overwrite local changes, so that note is false.
- One identical command scored 0.62 and then 0.71 on `tmp_write` in two calls. Scores near the cutoff are not stable between calls.
- `pkill -x no-such-proc-xyz || true` scored under 0.3 on `kills_process`.
- The note arrives with the tool result, after the command has run. It cannot prevent the flagged command; it can only affect later ones.

**Limits.** The outcome is recurrence of the same flag, read by the same classifier, so a note that teaches the agent to phrase commands differently would look like compliance. Subagent commands share the parent's session id in the log and a note given to a subagent does not reach the parent. At roughly 7% of replay commands flagged on the four noted rules, 20 units per arm may take weeks on one repo.

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
