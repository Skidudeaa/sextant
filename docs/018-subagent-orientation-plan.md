# 018 — Subagent orientation: research + plan (NOT started; next-session handoff)

Date: 2026-07-02. Track 3 of the 2026-07-01 ideation, re-scoped by Phase 0 recon
(`docs/016-phase0-recon.md` R4): **no passive hook channel to subagents exists** —
0/200 historical subagent/workflow transcripts contain hook injections (13/13
main-session controls do), live probe confirmed. Everything below designs around
that ground truth.

## Verified channel map (docs research 2026-07-02; every claim needs FIELD verification — see the R1 lesson below)

| Channel | Status | What it can do |
|---|---|---|
| `.claude/settings.json` hooks firing IN the subagent | **DEAD** (R4, field) | nothing — docs claiming SessionStart fires for subagents lost to field evidence |
| **PreToolUse on the Agent/Task tool (parent session)** | docs-verified | `updatedInput` can REWRITE `tool_input.prompt` before the subagent spawns — parent hooks demonstrably fire, so this is the injection-equivalent for subagents |
| MCP tools (`.mcp.json`) | docs-verified + implied by R4 | subagents can call `sextant_*`; agent `tools:`/`mcpServers:` frontmatter can allowlist/denylist per agent |
| CLAUDE.md inheritance | field-verified for general-purpose (R4 probe saw it); docs: **Explore and Plan OMIT CLAUDE.md** by design, no setting to change that | static text only; no per-prompt freshness |
| SubagentStart/SubagentStop hooks (settings.json + agent frontmatter) | docs-verified, parent-side | output (`additionalContext`) reaches the PARENT conversation, not the subagent — a measurement channel, not an orientation channel |
| Agent `.md` body / frontmatter | docs-verified | static system instructions; no dynamic injection field exists |
| Agent SDK `hooks` option | docs-verified | per-agent-type SubagentStart matchers; same parent-side limitation |

**The R1 lesson applies with force**: for THIS exact surface, official docs already
claimed something (SessionStart fires for subagents) that field testing falsified.
No build starts before each load-bearing channel above is field-verified with a
marker experiment.

## Design sketch (what v1 probably is)

**Lane A — push at spawn (primary): PreToolUse Task-prompt injector.**
`sextant hook pretask` wired as a settings.json PreToolUse hook matching the
Agent/Task tool in the PARENT session. It reads `tool_input`, and returns
`updatedInput` with a compact orientation block PREPENDED (or appended) to
`tool_input.prompt`:

- Content: a subagent-budgeted variant of the static summary (~600–900 chars:
  root, health, top hotspots, entry point, "use sextant_search for code lookup") —
  possibly query-aware using the Task prompt itself as the classifier/retrieval
  input (the Task prompt IS the subagent's mission statement; running
  `graph-retrieve` on it is the same <50ms path the refresh hook uses).
- Freshness-gated exactly like every other injection point (silent absence on
  content-stale; the self-caused-drift exception probably does NOT apply here —
  a spawn is prompt-time, not action-time).
- No dedupe needed (each subagent context is fresh) but budget matters more:
  N parallel subagents × block size is a real multiplier.
- MUST be format-safe: `updatedInput` that corrupts the Task JSON breaks agent
  spawning for the whole session. The hook returns unmodified input on ANY
  internal error (the never-throw discipline, but stronger: never-modify-on-doubt).

**Lane B — pull (secondary): `sextant_orient` MCP tool.**
One compact tool ("call this first") returning the same subagent-budgeted summary.
Zero risk, works today, but depends on the agent choosing to call it — expect low
uptake without Lane A telling it to. Cheap to ship alongside.

**Lane C — measurement: SubagentStop + trajectory replay.**
- `eval-trajectory --include-subagents` already parses subagent transcripts; add a
  subagent-scoped lift report (did oriented subagents open surfaced files at above
  the permutation null?) — the SAME benefit-proof harness, new population.
- Optional: a SubagentStop settings.json hook records `subagent.completed` telemetry
  (parent-side, out-of-band) keyed by agent type for volume denominators.

## Phase 0 recon (half-day, kill criteria — run BEFORE any build)

1. **R-A: `updatedInput` field test.** Scratch repo, PreToolUse hook on the Agent
   tool that appends a marker line to `tool_input.prompt`; spawn a probe subagent
   that reports its prompt verbatim. KILL if `updatedInput` is ignored for the
   Agent tool, mangles the input, or surfaces confusingly in the permission dialog.
   Also measure: does it fire for ALL agent types (custom + built-in Explore/Plan)?
2. **R-B: per-agent-type CLAUDE.md matrix.** Spawn one probe per available type
   (general-purpose, Explore, Plan, custom) reporting whether CLAUDE.md text is in
   context. Explore/Plan omitting it (docs) makes Lane A MORE valuable for exactly
   the agent types most used for orientation-heavy work.
3. **R-C: subagent MCP smoke test.** A probe subagent calls `sextant_search` in a
   wired repo. KILL Lane B if MCP tools aren't actually reachable from subagents in
   this environment (R4 implied they are; verify).
4. **R-D: volume + benefit baseline.** DONE 2026-07-02 — snapshot:
   `eval-trajectory --include-subagents` scans **281 sessions (76 main + ~205
   subagent/workflow transcripts) and sessionsWithInjection stays 72** — i.e. the
   subagent population contributes ZERO injection turns (R4 re-confirmed at the
   measurement layer). The baseline for this feature is therefore stark: today,
   0 of ~205 subagent transcripts contain any sextant orientation. Post-ship
   success = oriented subagents appear in this population with their own lift row
   (main-session retrieval lift for reference on the same date: 1.93×, 70/946).
   Rolling-window caveat applies to all these counts.

## Ship blockers vs acceptable debt (pre-registered)

Ship blockers:
- R-A passes end-to-end (marker seen by the subagent, no Task breakage).
- Never-modify-on-doubt: any error path returns input unchanged; a corrupted Task
  call is strictly worse than an unoriented subagent.
- Byte-budget cap enforced (parallel-fleet multiplier).
- Freshness gate at the injection point (no stale structural claims to subagents —
  they can't see the statusline, so silent absence is their ONLY protection).
- Baseline snapshot (R-D) taken before first enable.

Acceptable debt v1:
- No per-agent-type targeting (inject for all types uniformly; refine later via
  matchers if R-A shows per-type behavior).
- Lane B uptake unmeasured beyond raw call counts.
- Workflow-spawned agents (the 136 `/workflows/` transcripts) may ride a different
  spawn path than Task — if R-A doesn't cover them, note and defer, don't chase.

## Open questions for the user

- Priority vs the blast-radius open-attribution follow-up (docs/017 lever #1)?
  This is the bigger prize (multi-agent workflows orient blind today); that one
  completes a measurement loop already half-built.
- Should Lane A inject for OTHER tools' subagents (e.g. workflow fleets) if the
  spawn path differs, or is Task-tool coverage enough for v1?
