# 050. Context Ledger (2026-10-28, started)

## The bet

Sextant stops pushing a codebase map into prompts and becomes the one measured channel through which guidance reaches a coding agent. Every injection source is registered with a stated claim. Each source enters the agent through one broker that can hold it back per session, independently of the others. Each source is scored from transcripts against its claim. Rule text that is injected every session is replaced, rule by rule, by checks that fire when the rule applies: the Jev rule guard on Bash (docs/049 §10, §12), a graph caller check on Edit, and a claim-versus-evidence check at Stop.

The runner-up bet was Sextant as the agent's search primitive. It lost on a replay of 1,891 Bash file searches over five repos. When a search resolved to 1 to 3 defining files in the graph, the agent opened that file a median of 2 calls later, even when the file was new to it (n=40).

## Census: what hooks put into context

`sextant ledger census [--projects <path>] [--days <N>] [--json]` (`commands/ledger.js`, `test/ledger.test.js`). It reads top-level Claude Code transcripts and counts every hook injection by the hook command that produced it. It prints no injected text, because some transcripts carry PHI.

What counts as reaching the model:
- `additionalContext` on any event;
- plain stdout on SessionStart and UserPromptSubmit;
- a blocking error's reason.

Plain stdout on any other event lands in the transcript only (docs/016 R1). Async hook responses are counted separately, because nothing here shows whether they reach the model.

`additionalContext` rows carry no command. Each one is joined to the `hook_success` row of the same run, whose stdout holds the context. The join tries the same tool call first and then any run of the same event in that session. A transcript records a hook's `statusMessage` as its command when the hook has one. ponytail's source therefore reads "Loading ponytail mode...".

**Result, 60 days to 2026-10-28, 140 sessions:**
- 8,274,223 characters reached the model. That is 16.7% of the 49.6M characters of tool results, with a median of 28,884 per session.
- Another 500,946 characters were async responses, all from somaNotes edit and write hooks. Whether those reach the model is unverified.

| Source | Event | Chars | Share | Sessions |
| --- | --- | --- | --- | --- |
| somaNotes `cc_hooks.py post_batch` (state footer) | PostToolBatch | 5,176,064 | 62.6% | 80 |
| ponytail plugin | SessionStart | 1,129,248 | 13.6% | 139 |
| somaNotes OWNER RULES | SessionStart | 754,222 | 9.1% | 80 |
| OMC `pre-tool-enforcer.mjs` | PreToolUse | 360,771 | 4.4% | 134 |
| OMC `post-tool-verifier.mjs` | PostToolUse | 247,154 | 3.0% | 117 |
| `serena-hooks activate` | SessionStart | 240,002 | 2.9% | 134 |
| unattributed | UserPromptSubmit | 80,944 | 1.0% | 64 |
| somaNotes `orient_subsystem.py` | UserPromptSubmit | 76,242 | 0.9% | 50 |
| last30days `check-config.sh` | SessionStart | 74,520 | 0.9% | 138 |

**Correction to the moonshot numbers.** The moonshot's raw basis gave 10.0M characters, 20.5% of tool-result text and a median of 34.6k per session. That count included output that never reaches the model:
- plain stdout on PostToolUse, PreToolUse and Stop;
- non-blocking errors;
- whole async records, measured as JSON.

The figures above replace those numbers. The ranking of the sources did not change.

## Registry draft

`ledger/registry.json` lists the 8 largest attributed sources. Each entry has these fields:
- `match`: the recorded command;
- `event` and `kind` (all 8 are ambient);
- `pinned`;
- `holdbackPct`: 0 until the Q2 trials;
- a drafted `claim`.

Nothing reads the registry yet.

`pinned` is null on every entry and is the owner's call. Once the broker exists, `true` means the source is never withheld and `false` means it can be held back. The somaNotes footer, OWNER RULES and `orient_subsystem.py` have no claim, because their purpose is the owner's to state. somaNotes allows only deterministic outcomes. The UserPromptSubmit row matched no hook run, and its source has to be found before the broker ships.

## Correction outcome

Details are in docs/049 §13 (`experiments/jev/correction.js`). The moonshot's lexical regex caught 1 of 35 labeled corrections, so its 1.2% correction rate measured almost nothing. On 189 human-typed messages, Jev 1.14 at 0.5 had precision 0.86 and recall 0.71 (sign test against the regex p = 0.0003). That subset was defined after labeling, and the preregistered all-units comparison was not established (p = 0.54). The non-human turns in the sample took 15 of Jev's 19 false alarms. Until a prospective confirmation passes, the ledger has no validated correction outcome.

## Findings along the way (fixed 2026-10-28)

- Three Claude Code settings files still wired five Sextant hooks after the binary was removed on 2026-08-26 (HIBERNATION.md):
  - `/root/physioTheater/.claude/settings.json` (tracked);
  - the linked worktree `/root/physioTheater-head-ab1f301` (tracked);
  - `/root/sextant/.claude/settings.json` (untracked).

  In the last 60 days, 3 physioTheater sessions logged 299 exit-127 non-blocking errors from them. Each file held nothing else, so each is now `{}`. The two physioTheater copies are left uncommitted in that repo.
- `commands/tune.js` passed flag names without `--` to `lib/cli.js:flag`, which matches the literal argument. `--projects`, `--repo`, `--include-subagents` and `--json` were ignored, so the command always printed text for the whole of `~/.claude/projects`. All four flags now take effect.

## Critical path and kill criteria

These are as stated in the moonshot of 2026-10-28.

**Critical path:**
- **Q1:** broker and registry with exposure logging, an A/A test, the correction instrument and a power table.
- **Q2:** factorial holdback on the discretionary ambient sources, plus the fleet guard trial.
- **Q3:** compiled rules, the caller check and the Stop check, each run head to head against its ambient version.
- **Q4:** retire or convert sources, with median injected characters per session at or below half of today's.

**Kill criteria:**
- **Month 2:** the broker can't account for 95% of injected bytes, or the A/A test shows an arm difference.
- **Month 3:** the minimum detectable effect is above 50% relative on every outcome.
- **Months 3 to 4:** the fleet guard trial reaches its floor and reads no effect on both instruments.
- **Month 9:** no source has reached `AT_VOLUME`.

Today's baseline for the Q4 target is the 28.9k median above, not the moonshot's 34.6k.
