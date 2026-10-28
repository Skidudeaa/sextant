# 051. Handoff: Context Ledger start, fleet guard trial, correction probe (2026-10-28)

Written at session end for a fresh instance. Read `JOURNAL.md` first, then `docs/050-context-ledger.md` and `docs/049-jev-semantic-lint-experiments.md` §12 and §13. Sextant itself stays hibernated: the `sextant` binary is unlinked, and no Sextant hook runs anywhere. Everything below runs as plain `node` scripts.

## State

Everything is on `origin/main`. Nothing is in flight, and no step can run before about 2026-11-09.

| Item | State | How to read it |
| --- | --- | --- |
| Correction confirmation (docs/049 §13) | Pool 100 of 150; refuses until 150 | `node experiments/jev/correction.js freeze --confirm` |
| Guard trial (docs/049 §12) | ACCRUING, 9 units, all jan25; floor 20 per arm | `node experiments/jev/guard-hook.js report` |
| Ledger census (docs/050) | Built, run once over 60 days | `node bin/intel.js ledger census [--days N] [--json]` |
| Ledger registry | 8 sources, `pinned` set; nothing reads it yet | `ledger/registry.json` |

## Commits this session

```
1177216 docs(050): run the census through bin/intel.js while sextant is unlinked
c45bc3a lab(jev): count the correction confirmation floor after the sensitive drop (docs/049 §13)
a439721 journal: record the push-protection rewrite and its hash map
3bd9af3 docs(050): physioTheater settings fix is committed (8b24992)
fbc9a1e lab(jev): pool held-out units into the correction confirmation (docs/049 §13)
0f3942b ledger: set pinned on the 8 registered injection sources (docs/050)
83515fb ledger: census of hook injections, fleet guard trial, correction probe (docs/050, docs/049 §12-13)
994756f lab(jev): guard trial hook switched to jev-1.14.0 (docs/049 §12 amendment)
```

These hashes come from a history rewrite. GitHub push protection rejected fake Stripe and Slack tokens in `experiments/jev/semantic-locate.test.js`, so the 11 unpushed commits from `09bd1fe` on were rewritten to build those strings by concatenation. The old-to-new map is in `JOURNAL.md`. The old commits stay reachable locally at `refs/archive/pre-push-protection-20261028`, because frozen `.planning/jev` artifacts name `09bd1fe` and `b3dc7b9`. Do not delete that ref.

## When the pool reaches 150: the correction confirmation

The procedure is fixed in docs/049 §13. Do not change the question, the 0.5 cutoff, the regex or the pass rule.
1. `node experiments/jev/correction.js freeze --confirm`. It writes `.planning/jev/correction-confirm/label-tasks.json`.
2. Run two Sonnet labelers in parallel, never Haiku, each with the brief quoted verbatim in §13. A writes `labels-a.json` and B writes `labels-b.json` in that directory. B works in reverse order. Labelers must not see Jev scores or the regex.
3. `node experiments/jev/correction.js live --confirm`, then `report --confirm`. Report the verdict as it comes out.

The pool grows only from typed messages in jan25, theLongWay, defGen2, physioTheater, DwoodAmo and sextant, never somaNotes. The rate was 6 new units on 2026-10-28, and the 2026-11-09 estimate assumes about 4.7 a day. The scheduled check for Nov 11 existed only inside the session that wrote this handoff.

## Guard trial

The hook runs on PreToolUse Bash in the gitignored `.claude/settings.local.json` of all five enrolled repos. Its rows go to `.planning/jev/guard-trial/events.jsonl`.
- jan25 has logged since 2026-10-13.
- theLongWay logged 12 rows after enrollment: 6 scored and 6 dropped as sensitive.
- defGen2, physioTheater and DwoodAmo had logged nothing by session end. Either no Bash command has run there since enrollment, or open sessions haven't loaded the hook. Their first restarted session will show which. If they still show nothing, that is a defect.

To remove it from a repo, delete the guard-hook entry from that repo's `settings.local.json`. The pre-enrollment settings backups are in this session's scratchpad and expire 7 days after 2026-10-28.

## Ledger: next work, per the moonshot

Q1 is the broker and registry with exposure logging, an A/A test, the correction instrument and a power table. Before the broker ships, attribute the 81k characters of UserPromptSubmit context that matched no hook run. Kill criteria are in docs/050. The Q4 baseline is the 28.9k median characters per session, not the moonshot's 34.6k.

## Landmines

- **PHI.** somaNotes transcripts carry PHI. Print aggregates only. `correction.js` and `guard-hook.js` drop somaNotes, patient and credential-shaped text before any provider call. Keep it that way.
- **Unit suite.** 73 unit-suite failures were already there at `b64fd0d`. Causes: missing `lib/jev*` modules, `spawn sextant ENOENT` because the binary is unlinked, and an mcp-server test expecting 9 tools against 10. This session did not touch them. Run only the targeted files: `node --test experiments/jev/correction.test.js experiments/jev/guard-hook.test.js test/ledger.test.js` (14 pass).
- **Fake tokens.** Two shorter fake Slack tokens remain in the rule-guard tests. GitHub did not flag them, but a future pattern update could. Fix the same way if it does.
- **Shared pool.** 7 confirmation units are the owner's messages from the session that built the probe. The labelers and Jev never see that context, so this is over-representation, not bias.
- **Uncommitted worktree change.** `/root/physioTheater-head-ab1f301`, a detached worktree, still has its `.claude/settings.json` emptied but uncommitted. Committing there would make an orphan commit.
- **Do not `npm link` sextant.** The `sextant` binary should stay unlinked. Relinking would make any settings file that still names `sextant hook …` start running Sextant again.
