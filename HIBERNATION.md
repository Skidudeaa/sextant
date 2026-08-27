# Sextant hibernation checkpoint

Date: 2026-08-26
Status: active; verification ledger below
Resume posture: preserved project, no implied sunset

## Decision

Pause development and ambient use. Preserve Sextant as a coherent, reproducible
research artifact that can be resumed when either agent integration changes or a
sharper product hypothesis justifies another experiment.

This is not a claim that repository orientation is useless. It is a ruling that
Sextant's current intervention has not earned more development or background
operational cost.

## Evidence at the pause

Source state at inventory:

- `main` at `8aba246`, matching local `origin/main` tracking state
- last source change: 2026-08-08
- pre-existing untracked path: `.serena/`
- no Sextant watcher process or Sextant user service observed on 2026-08-26
- a daily holdback cron, global Codex MCP registration, global Kimi prompt hook,
  and repo-local integrations still exist; hibernation is therefore not active

The overdue decision-gate read used:

```bash
node bin/intel.js telemetry \
  --roots-file /root/.claude/sextant-fleet-roots \
  --include-old \
  --since 2026-08-08T20:00:00Z
```

Observed window: 2026-08-08 through 2026-08-25, 8,273 events across six
configured roots.

| Signal | Result | Interpretation |
|---|---:|---|
| Freshness stale/blackout rate | 27.6% | Better than the pre-fix ~45%, still operationally high |
| Retrieval turns | 224 | 91 delivered, 92 empty, 37 holdback, 4 deduped |
| Armed turn hit-rate | 5.9% (3/51) | Directionally worse than holdback |
| Holdback turn hit-rate | 8.7% (2/23) | Under the predeclared 30-turn reporting floor |
| Overall surfaced-file open precision | 0.8% | Precision-flavored proxy, not coverage or correctness |
| MCP use | 1,055 calls / 370 loads | Real use, but 1,052 calls came from Codex |

Verdict: the causal read is underpowered and contaminated, so it does not support
calling the hypothesis proven, disproven, beneficial, or harmful. Stratification
also reverses the pooled directional story: SomaNotes slightly favored armed
retrieval (3/48 versus 1/19 hit turns), while defGen2's apparent negative result
came from one holdback hit across only six scored turns. Thirty of 74 scored turns
were in sessions that drew both arms, including 14 of 23 holdback turns, so prior
injected context could carry into the nominal control. Hibernation, if chosen,
must be justified by opportunity cost and operational burden rather than by a
claim that this experiment falsified Sextant.

The full audit is in
[`docs/041-hibernation-results-review.md`](docs/041-hibernation-results-review.md).

## Activation boundary

Hibernation is active only after all of these are separately verified:

1. **Evidence frozen** — mutable fleet telemetry and the exact integration
   inventory are archived with checksums outside the working tree.
2. **Source anchored** — this checkpoint and journal are committed, a signed or
   annotated hibernation tag identifies the commit, and the commit/tag exist on
   the remote.
3. **Background work stopped** — every Sextant watcher is stopped and the daily
   holdback cron is disabled without changing unrelated cron entries.
4. **Ambient injection stopped** — Claude, Codex, and Kimi integrations cannot
   auto-start watchers, inject context, or expose the MCP tool surface. Disabling
   must not leave agent startup errors.
5. **State retained** — `.planning/intel` evidence is not deleted during
   hibernation. Generated indexes can be discarded later only after the archive
   is verified.
6. **External posture set deliberately** — GitHub remains available and clearly
   described as paused. Do not archive the GitHub repository unless the owner
   wants its read-only semantics; do not delete packages, releases, issues, or
   history.

## Recommended execution sequence

### Phase 1 — freeze

- Capture `git status`, commit graph, remote refs, dependency lockfile hash, Node
  version, and the exact test result.
- Archive the six fleet roots' `.planning/intel` directories, the roots file,
  Sextant-specific cron line, and Sextant integration fragments. Keep permissions
  restrictive; telemetry is operational evidence, not a public artifact.
- Generate and verify SHA-256 checksums. Copy the archive off-host before calling
  the evidence durable.

### Phase 2 — quiesce

- Stop watchers using this checkout's explicit Node entrypoint; do not depend on
  the current shell's global `sextant` command.
- Remove or disable only the exact daily Sextant cron entry.
- Use a reversible global hibernation gate for ambient hook entrypoints, then
  disable the Codex MCP registration so Codex does not repeatedly launch a
  deliberately dormant server.
- Keep the source checkout and dependencies in place until a clean agent session
  proves there are no hook/MCP startup errors.

The global marker is:

```text
${XDG_CONFIG_HOME:-$HOME/.config}/sextant/hibernating
```

With the marker present, hook and injection entry points exit successfully
without output or state writes, watcher starts are refused, project-local MCP
servers initialize normally but advertise zero tools, and the shipped statusline
omits the Sextant segment. Explicit diagnostic commands remain available.

### Phase 3 — publish the pause

- Commit only `HIBERNATION.md` and `JOURNAL.md`; do not absorb `.serena/`.
- Annotated tag: `hibernate-2026-08-26`.
- Add a brief repository notice pointing here. Prefer a visible pause statement
  over GitHub's archive switch initially: the former preserves issue/discussion
  flexibility while still making project status honest.

### Phase 4 — verify

- No watcher process or Sextant user service.
- No Sextant cron invocation remains scheduled.
- Fresh Claude, Codex, and Kimi sessions in an initialized repo start without a
  Sextant block, Sextant tool surface, watcher spawn, or integration error.
- Archived checksums verify and remote commit/tag resolve to the intended SHA.

## Resume trigger

Resume only when at least one of these is true:

- agent platforms provide a cheaper, reliable native orientation/context seam;
- a narrowly scoped retrieval hypothesis has an offline win large enough to
  justify a new holdback test;
- wrong-root or structural hallucination failures become a measured bottleneck
  again; or
- Sextant's freshness-gate/evaluation machinery has a concrete downstream buyer.

Do not resume by reopening the old TODO list. Start with a new falsifiable thesis,
an explicit success/kill criterion, and the smallest supported client surface.

## First resume session

1. Read this file, `docs/040-handoff.md`, and `JOURNAL.md`.
2. Verify the hibernation tag, archive checksums, current agent-client contracts,
   Node/runtime compatibility, and remote state.
3. Restore integrations on one disposable repository only.
4. Run the full suite and one end-to-end hook/MCP proof.
5. Expand to the fleet only after the disposable canary is clean.

## Verification ledger

This section records completed evidence. Activation is not complete merely
because the source commit or tag exists.

- Source verification: DONE — 1,411 passed, 0 failed, 2 skipped; all shell
  integrations passed; retrieval eval 21/21
- Evidence archive and checksum verification: DONE LOCALLY — 13 MiB at
  `/root/backups/sextant-hibernation-20260826-20260827T015612Z`; tar, Git bundle,
  and SHA-256 verification passed; off-host copy remains unverified
- Watchers and Zoekt daemons stopped: DONE — one live jan25 watcher was stopped;
  three stale locks were cleaned; the final Sextant Zoekt daemon was terminated
- Daily cron disabled: DONE — the exact holdback-benefit entry was removed;
  unrelated cron entries were preserved
- Global hibernation marker active: DONE — root-owned mode 0600
- Global client registrations disabled: DONE — Codex MCP entry removed and Kimi
  `UserPromptSubmit` hook removed; their pre-change files are in the archive
- Dormant hook/MCP/statusline proof: DONE — hook stdout/stderr empty, MCP
  initialized with zero tools, statusline omitted the Sextant segment, and no
  watcher/Zoekt process remained
- Commit and annotated tag pushed: DONE — `hibernate-2026-08-26`
- Remote README and repository description updated: DONE
