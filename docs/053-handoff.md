# 053. Handoff: instruction compiler instruments (2026-11-02)

This handoff was written at session end for a fresh instance. Read `JOURNAL.md` first, then `docs/052-instruction-compiler.md`. Sextant itself stays hibernated as docs/051 describes, and the `sextant` binary is unlinked. Run every command as `node /root/sextant/bin/intel.js atoms …`.

This session did not change the docs/051 items: the correction confirmation, the guard trial and the ledger. Read docs/051 for them. No step there can run before about 2026-11-09.

## State

| Item | State | How to read it |
| --- | --- | --- |
| `atoms compile --dry-run` | Built. Binds 76% to 94% of each CLAUDE.md. Without `--dry-run`, it refuses. | `atoms compile --dry-run --roots /root/jan25` |
| `atoms replay` | Built. 102 sessions: native 41.7%, plus command relay 97.4%, median 48.4% of CLAUDE.md characters per request | `atoms replay --roots a,b [--days N] [--json]` |
| `atoms exposure` hook | Live in the `settings.local.json` of jan25, defGen2, theLongWay and sextant | `.planning/atoms/exposure.jsonl` in this repo (gitignored, mode 0600) |
| Relay design | Decided: native plus the command relay. The output relay and the child relay are not built. | docs/052 "Decisions" |

The exposure log has 8 rows. Four came from the scratch probe repo. The other four came from this session's compaction in sextant:
- 3 `compact` rows: `~/.claude/CLAUDE.md`, `~/.claude/rules/omc-orchestration.md` and the sextant `CLAUDE.md`;
- 1 `include` row: `~/.claude/AGENT_INSTRUCTIONS.md`.

jan25, defGen2 and theLongWay have no rows yet, because no session has started there since the hook was added. Their first session should write a `session_start` row. If it does not, that is a defect.

## Commits this session

```
4096428 feat(atoms): instruction compiler instruments (docs/052)
```

## Next, in this order (docs/052 "Next")

1. **Write rule files.** Build `atoms compile` without `--dry-run`. It writes `.claude/rules/*.md` with `paths` frontmatter and a pinned core, in a branch per repo. Claude Code reads only `paths` from the frontmatter.
   - These atoms are over the 9,000-character hook limit and must be split first: 4 in sextant, and 1 each in somaNotes, physioTheater and jan25.
   - The owner sorts the unbound atoms (6% to 24% of each file) into pinned, command or prompt triggers. Kill criterion: less than 30% of characters get a non-pinned trigger.
2. **Command relay.** Build it as a PostToolUse Bash hook. Reuse `namedFiles` and the review regex in `commands/atoms.js`, so that the replay and the hook use one classifier. Deliver each atom once per agent per session. Read the exposure log first, so that atoms already loaded natively are not sent twice.
3. **Read-semantics probe.** Find out whether `git diff`, `sed -n` and a one-file `grep` trigger a path rule. Reuse `/root/scratch/20261101-pathrule-probe`. Its rule `alpha.md` binds `src/a.js` and holds the codeword HELIOTROPE-7. The probe directory expires about 2026-11-09.
4. **A/A test and power table.** Do these before any live trial. Use session-level hash arms (eager or lazy), crossed with the guard trial's (session, rule) hash.

## Facts that are slow to rediscover

- **Transcript directory names.** Claude Code 2.1.309 replaces only `/` with `-` and keeps dots, so `/root/.claude` is stored as `-root-.claude`. `lib/trajectory.js:612` uses the same mapping.
- **Subagent loads.** When a subagent loads a path rule, the parent does not get it (verified by probe, 2026-11-01).
- **Compaction.** It reloads the user and project instruction files with `load_reason: compact`. Nobody has observed whether path rules reload. 45 of 102 sessions compact, and 33% of tool calls come after a compaction.
  - If every atom is cleared at compaction, the replay still gives 97.2% recall and a 46.1% per-request cost. The decision does not depend on this.
- **Git forms.** `git diff` prints paths as `a/<path>` and `b/<path>`. Agents often run `git -C <root> diff`. The classifier handles both forms.
- **Rolling corpus.** The replay corpus includes live sessions, so counts drift between runs (697 or 699 review events). Always cite a number with its date.
- **What recall measures.** Recall is measured against the citation binding. An atom can govern files that it does not cite.

## Landmines

- **PHI.** somaNotes transcripts carry PHI. Print aggregates only. somaNotes is not wired for exposure.
- **Credentials in jan25.** jan25's `.claude/settings.local.json` holds two plaintext MongoDB connection strings with passwords in its permission allowlist. They were there before this session, and the file is gitignored. Never copy them into a document, a commit or a prompt.
- **The hook depends on this repo.** All four hooks run `node /root/sextant/bin/intel.js atoms exposure`. If this repo is checked out at a commit without `commands/atoms.js`, the hook fails in all four repos. It does not block the session, because InstructionsLoaded has no decision control.
- **Removing the hook.** Delete the `InstructionsLoaded` key from that repo's `settings.local.json`. The backups are in `/root/scratch/20261102-atoms-settings-backup` and expire about 2026-11-09.
- **Unit suite.** It shows 73 failures, the same count docs/051 recorded at `b64fd0d`: missing `lib/jev*` modules, the MCP tool-count test, and `spawn sextant ENOENT`. Run only the targeted files: `node --test test/atoms.test.js test/command-conventions.test.js test/ledger.test.js`.
- **Fracture review.** A Code Soak changed `commands/atoms.js` and its test after the build. A fresh fracture review has not run on `4096428`.
- **Retrieval-era code.** The 17,184 lines of retrieval-era code stay in place. The owner's rule requires a question before working code is removed, and nobody has asked it yet.
- **Standing rules.** Do not `npm link` sextant. Do not delete `refs/archive/pre-push-protection-20261028`.
