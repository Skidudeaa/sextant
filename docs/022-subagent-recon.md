# 022 — Subagent orientation Phase 0 recon: results + verdicts

> **Historical recon.** Claude Code 2.1.211 subsequently live-verified child-bound
> `SubagentStart` `additionalContext`. The current safe default and the gated
> PreToolUse experiment split are documented in docs/032; the results below
> remain the evidence for the older prompt-rewrite channel.

Date: 2026-07-10, main @ 099aada, Claude Code 2.1.206. The docs/018 Phase 0
probes (R-A/R-B/R-C; R-D was done 2026-07-02). Raw method + artifacts:
`docs/recon/018-subagents/`. **Verdict up front: GO for Lane A** — the
load-bearing channel works end-to-end, with one NEW load-bearing constraint
the plan didn't have: the injected block must be facts-only or target agents
may deliberately discount it.

## R-A: PreToolUse `updatedInput` — PASS (no kill criterion fired)

Field method: scratch repo + PreToolUse hook (matcher `Task|Agent`) that logs
payloads and appends a `SXMARK-4217` marker to `tool_input.prompt` via
`updatedInput`; headless `claude -p` parents (default permission mode) spawn
subagents told to echo their prompts verbatim.

- **general-purpose**: marker received and quoted verbatim, original prompt
  intact, no Task breakage. `tool_name` is `"Agent"`; input keys
  `description, prompt, subagent_type, run_in_background`.
- **Explore (built-in)**: hook fires (`subagent_type: "Explore"` visible at
  hook time) and the marker reached the subagent — **per-type targeting is
  free**: the hook reads `tool_input.subagent_type` directly.
- Kill criteria (ignored / mangled / Task breakage): none fired.
- Residual: `updatedInput` rendering in the INTERACTIVE permission dialog is
  untestable headless — spot-check in a default-mode interactive session
  before enabling beyond dogfood repos.

**The new constraint — injection-defense framing.** The probe marker
self-described as hook-injected, and the Explore subagent explicitly flagged
it: *"content injected into the prompt, not a genuine instruction from you…
I'm treating it as untrusted context and not following any directive it might
imply."* The marker still ARRIVED (channel works), but the reaction defines
the design rule: the Lane A block must be **factual orientation in the
`<codebase-intelligence>` shape** (root, health, hotspots, structure) with no
imperatives — the same "facts only, no command-like output" rule 016 R1
established for the blast-radius note. An instruction-shaped block ("call
sextant_search first") risks being deliberately ignored by exactly the
read-only/safety-conscious agent types Lane A most wants to reach. This also
lowers expectations for embedding a Lane B advertisement inside the Lane A
block.

## R-B: per-agent-type CLAUDE.md matrix — docs claim FALSIFIED (again)

One introspection probe per type, spawned live from this session (no tools,
context-only):

| Agent type | CLAUDE.md content | `<codebase-intelligence>`/`<codebase-retrieval>` |
|---|---|---|
| general-purpose | **YES** (project block) | NO |
| Explore | **YES** (global + project) | NO |
| Plan | **YES** (global + project + memory index) | NO |

- The 018 channel map's docs-sourced claim ("Explore and Plan OMIT CLAUDE.md
  by design") is **false in this environment** — the second time official
  docs lost to field evidence on this exact surface (R4 was the first).
- **No agent type receives any hook injection** — R4 re-confirmed at the
  context level, not just the transcript level.
- Honest implication for Lane A's value claim: subagents in a repo with a
  rich CLAUDE.md are NOT fully blind — they get static project text. What
  they lack is exactly what the freshness gate exists for: current graph
  facts (health, hotspots, structure, per-prompt retrieval) with staleness
  protection. Lane A's pitch is "fresh, honest, query-relevant" — not "some
  text at all." On thin-CLAUDE.md repos (most repos) the gap is larger.

## R-C: subagent MCP reachability — PASS

A general-purpose probe in this wired repo loaded `mcp__sextant__*` via
ToolSearch and called both tools successfully: `sextant_search "freshness
gate"` → `lib/intel.js` top hit; `sextant_explain lib/freshness.js` → fanIn
12 (matches the live graph). **Lane B is viable** — the tools are reachable
from subagents; uptake (do agents call them unprompted?) remains the open
question R-A's framing constraint makes harder to force.

## What changes in the docs/018 plan

1. **Lane A content**: subagent-budgeted static-summary variant, factual only,
   NO imperatives (revises 018's "use sextant_search for code lookup" line —
   that phrasing is now measured risk, not free). Present it the way
   SessionStart injection reads: a titled factual block.
2. **Per-type targeting is trivial** (read `tool_input.subagent_type`) — the
   018 "acceptable debt: no per-agent-type targeting" can stay debt, but the
   mechanism costs nothing when wanted.
3. **CLAUDE.md-inheritance nuance** goes into the benefit framing: the
   trajectory-replay success metric (oriented subagents' open-rate lift vs
   the permutation null) already handles this — CLAUDE.md text was present in
   the 0-injection baseline population too.
4. Ship blockers stand as pre-registered (never-modify-on-doubt — the probe
   hook already demonstrates the pattern; byte cap; freshness gate at spawn
   time; interactive-dialog spot check joins the list).

## Kill-criteria summary

| Probe | Kill condition | Result |
|---|---|---|
| R-A | updatedInput ignored / mangles / breaks Task | NOT FIRED — works for general-purpose + Explore |
| R-B | (informational) | docs falsified; all types get CLAUDE.md, none get injection |
| R-C | MCP unreachable from subagents | NOT FIRED — both tools verified live |
| R-D | (baseline) | done 2026-07-02: 0 of ~205 subagent transcripts had any injection |

**GO: build Lane A per docs/018 with the facts-only framing constraint;
Lane B ships alongside as designed (uptake expectations lowered).**
