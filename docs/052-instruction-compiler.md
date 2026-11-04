# 052. Instruction compiler (2026-11-02, started)

## The bet

Sextant stops mapping code for prompts. It becomes the compiler for the instructions that coding agents receive. The compiler splits each instruction file into atoms and gives each atom one trigger: a file path, a command class, a prompt class, or "always". Claude Code delivers path atoms itself through `paths` rules. Sextant hooks deliver the rest, and a small pinned core loads at session start. This bet absorbs the docs/050 Context Ledger, because the docs/050 broker covered only hook text.

The runner-up was Jev as a Stage-2 pruner over Sextant results. It lost because no step in this fleet puts candidate files into a prompt, and every local Jev ranking test tied or lost to static signals (docs/049).

## Raw basis (measured 2026-11-01)

- 124 sessions in 60 days recorded an `instructions` attachment. They loaded 12,367,990 characters, with a median of 126,428 per session. Hook text (docs/050) was 8,274,223 characters, with a median of 28,884.
- Every project CLAUDE.md is over the 200-line target in the Claude Code docs. somaNotes grew from 12,617 characters (2026-03-01) to 77,504 (2026-10-01).
- The OMC block is 13,205 of the 21,694 characters in `~/.claude/CLAUDE.md`. At most 17 of 125 sessions had an OMC keyword in a user message.
- Two headless probes on Claude Code 2.1.309 (`/root/scratch/20261101-pathrule-probe`) showed three things:
  - A `paths` rule loads on Read of a matching file.
  - `InstructionsLoaded` reports `path_glob_match` with `agent_id`.
  - A subagent's load does not reach its parent.

## Instruments (`commands/atoms.js`, `test/atoms.test.js`)

The `sextant` binary is unlinked, so run each command as `node /root/sextant/bin/intel.js atoms …`.

- `atoms compile --dry-run [--roots a,b] [--json]` splits each CLAUDE.md at headings and numbered bold items, outside fenced blocks. It binds each atom to the tracked files it cites. Writing rule files is not built yet, and the command refuses to run without `--dry-run`.
- `atoms replay [--roots a,b] [--days N] [--json]` replays parent transcripts and their subagent transcripts. It scores four kinds of decision event against four channel sets, and it reports how much of each CLAUDE.md a session carries.
- `atoms exposure` is an `InstructionsLoaded` hook. It appends one row per load to `.planning/atoms/exposure.jsonl` (mode 0600), with paths only.
- The test has 5 cases, and eight mutations each fail it:
  - fence tracking removed;
  - the `a/`/`b/` diff prefix strip removed;
  - the child relay removed;
  - the command relay reading all output;
  - an edit scored after its own load;
  - cost counted after each call;
  - the review classifier without git's global options (`git -C <root> diff`);
  - dots mapped to `-` in the transcript directory name. Claude Code 2.1.309 maps only `/`, so `/root/.claude` is stored as `-root-.claude`.

## Compile dry-run (2026-11-02)

| Repo | Characters | Atoms | Path atoms | Share bound | Over 9,000 |
| --- | --- | --- | --- | --- | --- |
| sextant | 105,738 | 49 | 29 | 93.0% | 4 |
| somaNotes | 79,150 | 78 | 48 | 80.2% | 1 |
| defGen2 | 77,905 | 86 | 41 | 76.1% | 0 |
| physioTheater | 49,998 | 10 | 8 | 87.6% | 1 |
| DwoodAmo | 31,071 | 15 | 12 | 94.1% | 0 |
| jan25 | 29,188 | 37 | 9 | 77.0% | 1 |

## Replay result (2026-11-02, 60 days)

The replay covered 102 parent sessions and 126 subagent transcripts in six repos: somaNotes, jan25, defGen2, sextant, physioTheater and DwoodAmo. It printed aggregates only.

Channel sets:
- **native**: Claude Code loads a `paths` rule on Read, Write or Edit of a match, or on a one-file `cat`/`head`.
- **+cmd**: a relay also delivers atoms for bound files that a Bash command names, or that `git diff`/`git show` prints.
- **+output**: the relay also reads every other Bash output.
- **+child**: the parent also gets its subagent's atoms when the subagent finishes.

An edit or a spawn is in time only when the atom arrived before that tool call. A review or a return is in time when the atom arrives with the output being judged. The review and return rows are therefore covered by construction under their own relay, and only their native column carries information.

| Event | Events | Atom pairs | native | +cmd | +output | +child |
| --- | --- | --- | --- | --- | --- | --- |
| edit | 593 | 914 | 84.5% | 99.2% | 99.8% | 99.8% |
| review | 697 | 2,383 | 28.2% | 100.0% | 100.0% | 100.0% |
| spawn | 131 | 433 | 25.2% | 78.8% | 84.1% | 84.3% |
| return | 5 | 9 | 77.8% | 100.0% | 100.0% | 100.0% |
| all | 1,426 | 3,739 | **41.7%** | **97.4%** | 98.1% | 98.1% |

The review classifier counts `git -C <root> diff` and `git --no-pager show` (fixed 2026-11-02, after the first run). The first run missed 76 of 1,779 diff and show commands and reported 42.0% and 97.3%.

Median share of each CLAUDE.md in context, with eager delivery as 100%:

| Measure | native | +cmd | +output | +child |
| --- | --- | --- | --- | --- |
| at session end | 23.0% | 58.8% | 66.5% | 66.5% |
| per request (mean over the session's tool calls) | 23.0% | **48.4%** | 58.9% | 59.0% |

**Reading.**
- Native delivery alone fails the 90% kill gate, because agents review changes through `git diff` and name files in spawn prompts.
- The command relay passes the 95% go gate at about half of the per-request cost of eager delivery.
- Reading all Bash output adds 0.7 points of recall for 10.5 points of cost.
- The child relay adds nothing, because only 5 decision events were subagent returns with governed edits.
- The remaining gap is spawns: in 21% of spawn pairs, the parent names a file in a spawn prompt before any channel delivered its atoms. The subagent still gets those atoms natively when it opens the file.

**Caveats.**
- Recall is measured against the citation binding. An atom can govern files it does not cite, and "governing" does not prove that the agent needed the atom.
- The replay assumes that `git diff` and `sed -n` are not native reads. That is UNVERIFIED. If they are reads, native recall is higher.
- The replay uses today's tracked files.
- Unbound atoms count as ambient. The owner's sort can move some of them to command or prompt triggers.
- Per-request cost counts one request per tool call.

## Decisions (2026-11-02; the owner can reverse each one)

- **Relay design:** build native plus the command relay. Do not build the output relay or the child relay. The table above is the reason.
- **Exposure logging:** wired in the `settings.local.json` of jan25, defGen2, theLongWay and sextant. Backups are in `/root/scratch/20261102-atoms-settings-backup`. It records nothing new until those repos have `paths` rules, because transcripts already record session-start loads. To remove it, delete the `InstructionsLoaded` key.
- **somaNotes:** not wired. The replay already reads its transcripts offline, and exposure logging gains nothing there until the repo has rules.
- **The 17,184 lines of retrieval-era code:** not archived yet. The owner's rule requires a question before working code is removed, and Q1 does not need the deletion.

## Next

1. Build `atoms compile` without `--dry-run`. It writes `.claude/rules/*.md` with `paths` frontmatter and a pinned core, in a branch per repo.
2. Build the command relay as a PostToolUse Bash hook. It delivers the atoms of bound paths that a command names or that a diff prints, once per agent per session, and it reads the exposure log first.
3. Probe whether `git diff`, `sed -n` and `grep` on one file count as native reads.
4. Run the A/A test of the hook channel and write the power table before any live trial (docs/050 kill criteria, months 2 to 3).

## Amendment 2026-11-03: hand split instead of the compiler

The owner chose a hand trim over building `atoms compile` and the command relay. Each repo's CLAUDE.md was split by hand into a core file plus verbatim `.claude/rules/*.md` files with `paths:` lists. A split script checked that every non-blank line landed in exactly one output and that every glob matched a tracked file.

| Repo | Commit | CLAUDE.md before → after | Rules |
| --- | --- | --- | --- |
| sextant | 231734f | 105,738 → 3,265 | none (reference moved to docs/ARCHITECTURE.md) |
| defGen2 | 5e461f5, 3410a62 | 77,905 → 11,193 | 19 |
| somaNotes | ad3012194, e3c454414, f65689c13 | 79,150 → 36,934 | 18 |
| jan25 | b90d8c9d6 | 29,348 → 18,836 | 6 |

Why it beat the compiler: on sextant's old file the compiler still carried a median 17,095 chars per request, and the hand trim costs 3,265. On somaNotes, replaying 60 days gives a median 46,246 chars per request after the first split, against 79,150. Rule text was in context before 92.6% of edits, but only 40% of git diff reviews and 53.6% of spawn briefs. Path rules were verified live on Claude Code 2.1.318 in a scratch repo, defGen2, somaNotes and jan25.

What this changes in "Next": step 1 (write rule files) is done by hand. Step 2 (the command relay) is not built. Its only clear use now is loading `deploy.md` when `bin/deploy` runs in somaNotes. Steps 3 and 4 stay open but have no consumer. The decisions above are unchanged; this amendment records the change of course.

### Amendment 2026-11-03 (later): read semantics probed, command relay built

Read-semantics probe on Claude Code 2.1.318, in a scratch repo with a `src/**` rule, checked by the exposure log and a codeword:

| Agent action | Rule loads |
| --- | --- |
| Read, or Edit (after the edit runs; Edit works without a prior Read) | yes |
| one-file `sed -n <range>` | yes (now counted by `bashReadTarget`) |
| `grep -n … <file>`, `git diff`, `git diff <file>`, `git show` | no |

The command relay is `sextant atoms relay`, a PostToolUse Bash hook in `commands/atoms.js`. It shares `namedFiles`, `bashReadTarget` and `REVIEW_RE` with the replay. It is wired in the `settings.local.json` of jan25, defGen2 and somaNotes, and verified live in a scratch repo and jan25. Replay over 60 days with the relay channel:

| Repo | Sessions | Old eager | Per request, native / with relay | Recall, native / with relay |
| --- | --- | --- | --- | --- |
| jan25 | 22 | 29,188 | 18,736 / 20,203 | 60.1% / 97.1% |
| somaNotes | 62 | 79,150 | 44,397 / 57,632 | 67.9% / 98.8% |
| defGen2 | 8 | 77,905 | 11,066 / 18,688 | 11.1% / 100% |

The earlier jan25 edit gap (76.2%) was mostly edits to files the agent had seen only through Bash. With `sed -n` counted, native edit recall is 87.5%, and the relay brings it to 100%.

## Kill criteria

- **Month 2:** recall below 90% with the chosen channels. Today it is 97.4% on replay.
- **Month 2:** less than 30% of instruction characters get a non-pinned trigger after the owner's sort. Today the bound share is 76% to 94%.
- **Month 3:** the A/A test shows an arm difference, or the power table cannot detect a 25% relative rise in rule recurrence within nine months.
- **Months 4 to 6:** the lazy arm shows higher rule recurrence or a higher correction rate at one-sided p < 0.05, or the net context characters per session do not drop.
- **Month 9:** a pinned core grows over its budget while the lint runs.
