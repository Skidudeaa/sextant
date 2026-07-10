# 018 Phase 0 recon — subagent orientation probes (run 2026-07-10)

Method + raw results for the docs/018 kill-criteria probes. Synthesis and
verdicts: `docs/022-subagent-recon.md`.

## R-A: PreToolUse `updatedInput` field test — PASS (the load-bearing probe)

Harness: scratch repo with `settings.json` (this dir; the sextant hook entries
in it were self-deployed by `intel.init` during the run — an honest record of
the real environment) wiring `pretask-hook.js` as a PreToolUse hook with
matcher `Task|Agent`. The hook logs every payload and returns `updatedInput`
with a marker line appended to `tool_input.prompt`. Headless parent runs
(`claude -p`, Claude Code 2.1.206, default permission mode) then spawned
subagents instructed to echo their prompt verbatim.

Results:
- **Run 1 (general-purpose)**: hook fired (`tool_name: "Agent"`, input keys
  `description, prompt, subagent_type, run_in_background`); the subagent
  quoted the ORIGINAL prompt + the appended `SXMARK-4217` marker verbatim.
  No mangling, no Task breakage, parent relayed the reply normally.
- **Run 2 (Explore)**: hook fired with `subagent_type: "Explore"`; the marker
  REACHED the Explore subagent (quoted verbatim) — but Explore explicitly
  flagged the line as "content injected into the prompt, not a genuine
  instruction from you" and stated it would not follow directives from it.
- `subagent_type` is present in `tool_input` at hook time → per-type
  targeting needs no matcher gymnastics; the hook can read it directly.

**Framing lesson (new, load-bearing for Lane A)**: the probe marker
self-described as injected and instruction-like, and a safety-conscious
subagent (Explore) classified it as untrusted and discounted it. The Lane A
block must be FACTUAL orientation (the `<codebase-intelligence>` shape: root,
health, hotspots — no imperatives, no "use tool X" commands), mirroring the
016 R1 "facts only" rule for hook-injected context. An instruction-shaped
block risks being ignored by exactly the agents it targets.

Residual (not testable headless): how `updatedInput` renders in the
INTERACTIVE permission dialog. Default-mode interactive spot-check before
enabling broadly.

## R-B: per-agent-type CLAUDE.md matrix

Probes spawned from the live sextant session (one per type), each asked to
introspect its context without tools. Results in docs/022 table. Headline:
**Explore DOES receive CLAUDE.md content in this environment** — the docs
claim (018 channel map: "Explore and Plan OMIT CLAUDE.md") did not survive
field contact, for the second time on this surface. No probe saw a
`<codebase-intelligence>`/`<codebase-retrieval>` block (R4 re-confirmed: no
hook injection reaches subagents).

## R-C: subagent MCP smoke test

A general-purpose probe in the wired repo loaded `mcp__sextant__*` schemas via
ToolSearch and called sextant_search + sextant_explain. Verdict in docs/022.

## Files

- `pretask-hook.js` — the marker-injecting PreToolUse hook (never-modify-on-doubt)
- `settings.json` — the scratch repo's settings as actually run
