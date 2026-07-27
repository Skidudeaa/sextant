"use strict";

// Default Lane-A delivery for Claude Code subagents. SubagentStart context is
// additive: multiple matching hooks can contribute context without competing
// to replace the Agent tool input. Phase F deliberately stays on the existing
// PreToolUse path because its prompt-derived workset and tool_use_id join are
// part of the experiment contract; this handler is therefore silent whenever
// coherence is enabled.

const { recordEvent } = require("../lib/telemetry");

// Spawn paths that hook-pretask (PreToolUse `Task|Agent`) demonstrably does NOT
// intercept, so the Phase-F coherence gate must not silence this lane for them —
// there would be no substitute delivery at all. Kept as an explicit, narrow set
// rather than an inverted rule: a type is added here only after telemetry shows
// spawns arriving with no corresponding pretask event.
const PRETASK_UNREACHABLE = new Set(["workflow-subagent"]);

// Compare only the content anchors validated by buildOrientationBlock. A
// known anchor becoming unknown is a mismatch, so publication fails closed.
function sameValidatedRepo(validated, current) {
  if (!validated || !current) return false;
  return (
    (validated.head ?? "") === (current.head ?? "") &&
    (validated.statusHash ?? "") === (current.statusHash ?? "")
  );
}

async function run() {
  try {
    const root = process.cwd();

    // Hooks adopt cwd without an explicit user choice. Refuse before reading
    // or writing Sextant state so an arbitrary directory cannot bootstrap its
    // own marker through telemetry.
    const { checkRoot } = require("../lib/root-guard");
    if (!checkRoot(root, { requireMarker: true }).ok) return;

    const { readStdinJson } = require("../lib/cli");
    const data = await readStdinJson();
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    if (data.hook_event_name !== "SubagentStart") return;
    if (typeof data.agent_id !== "string" || !data.agent_id) return;
    if (typeof data.agent_type !== "string" || !data.agent_type) return;

    const startedAt = Date.now();
    const coherence = require("../lib/coherence");
    if (coherence.coherenceEnabled(root) && !PRETASK_UNREACHABLE.has(data.agent_type)) {
      // The gate exists so the Phase-F experiment owns delivery via PreToolUse
      // `Task|Agent` (hook-pretask), which carries the prompt-derived workset and
      // the tool_use_id join. That reasoning holds only for spawns pretask can
      // actually reach.
      //
      // It does not reach workflow-spawned agents. Measured over sextant's
      // window: 34 of 34 `subagentstart.skipped {reason:"coherence_enabled"}`
      // events carried agentType "workflow-subagent", and ZERO `pretask.*`
      // events fired for them — every recent coherence.report row is
      // surface:"parent_prompt" (hook-refresh), not pretask. So for that spawn
      // path the gate silenced the ONLY lane reaching the child and substituted
      // nothing, and workflow-subagent is the dominant agentType fleet-wide
      // (149 of 240 spawns). docs/018 pre-registered exactly this as deferred
      // debt: "workflow-spawned agents may ride a different spawn path than
      // Task."
      //
      // Yielding for that type only — rather than deleting the gate — keeps the
      // experiment's delivery contract intact everywhere pretask does fire, so
      // a coherence repo cannot get two orientation blocks.
      recordEvent(root, "subagentstart.skipped", {
        reason: "coherence_enabled",
        agentType: data.agent_type,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    // SubagentStart has no task prompt or spawning tool_use_id. Build only the
    // repo-generic facts block; never infer a prompt from transcript layout or
    // guess a join across parallel spawns.
    const { buildOrientationBlock } = require("../lib/orient");
    const built = await buildOrientationBlock(root, "");
    if (!built) {
      recordEvent(root, "subagentstart.skipped", {
        reason: "orientation_unavailable",
        agentType: data.agent_type,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    // Final publication fence: graph-derived facts may cross stdout only if
    // the exact HEAD/status pair validated by the builder still holds now.
    let current;
    try {
      current = require("../lib/freshness").captureCurrentState(root);
    } catch {
      recordEvent(root, "subagentstart.skipped", {
        reason: "fingerprint_check_failed",
        agentType: data.agent_type,
        durationMs: Date.now() - startedAt,
      });
      return;
    }
    if (!sameValidatedRepo(built.validatedRepo, current)) {
      recordEvent(root, "subagentstart.skipped", {
        reason: "fingerprint_moved",
        agentType: data.agent_type,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    const out = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SubagentStart",
        additionalContext: built.block,
      },
    });
    try {
      process.stdout.write(out);
    } catch {
      recordEvent(root, "subagentstart.skipped", {
        reason: "stdout_failed",
        agentType: data.agent_type,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    recordEvent(root, "subagentstart.injected", {
      agentType: data.agent_type,
      bytes: built.bytes,
      durationMs: Date.now() - startedAt,
    });
  } catch {
    // Never throw and never emit partial context. Silence leaves the child
    // spawn untouched and lets other SubagentStart hooks proceed normally.
  }
}

module.exports = { run };
