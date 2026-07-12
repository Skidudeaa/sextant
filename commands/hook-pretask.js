"use strict";

// PreToolUse Task/Agent hook — subagent orientation Lane A (docs/018 + 022).
//
// Fires in the PARENT session when it is about to spawn a subagent (matcher
// "Task|Agent"; the tool arrives as tool_name "Agent" with input keys
// description/prompt/subagent_type/...). Returns `updatedInput` with a
// compact facts-only <codebase-intelligence> block APPENDED to
// tool_input.prompt — the injection-equivalent for subagents, which receive
// NO hook injection of their own (0/~205 transcripts, docs/016 R4 + 022 R-B).
//
// THE PRIME DIRECTIVE — never-modify-on-doubt: a corrupted Task call breaks
// agent spawning for the whole session, which is strictly worse than an
// unoriented subagent. Every error path, guard failure, or uncertainty exits
// 0 with NO stdout (tool call proceeds byte-identical). This is stronger
// than the other hooks' never-throw rule.
//
// Field-verified output pattern (docs/recon/018-subagents/pretask-hook.js,
// R-A PASS on general-purpose + Explore): hookSpecificOutput with
// permissionDecision "allow" + updatedInput. Residual pre-registered risk:
// how updatedInput renders in the INTERACTIVE permission dialog was not
// observable headless — this hook stays dogfood-wired (not in `sextant init`)
// until that spot check happens.

const { recordEvent } = require("../lib/telemetry");

async function run() {
  try {
    const root = process.cwd();

    // Root guard: hooks adopt cwd without the user naming it; refuse
    // non-project roots BEFORE touching any state (no telemetry either —
    // recordEvent would mkdir .planning/intel and self-bootstrap the refusal
    // away, the exact bug class the guard exists to stop).
    const { checkRoot } = require("../lib/root-guard");
    if (!checkRoot(root, { requireMarker: true }).ok) return;

    const { readStdinJson } = require("../lib/cli");
    const data = await readStdinJson();
    if (!data || typeof data !== "object") return;

    const ti = data.tool_input;
    if (!ti || typeof ti !== "object" || Array.isArray(ti)) return;
    if (typeof ti.prompt !== "string" || !ti.prompt) return;

    // Never double-inject: a re-fired hook, a retried Task call, or a
    // subagent spawning its own subagent may already carry a block.
    if (ti.prompt.includes("</codebase-intelligence>")) {
      recordEvent(root, "pretask.skipped", { reason: "already_injected" });
      return;
    }

    const { buildOrientationBlock } = require("../lib/orient");
    const built = await buildOrientationBlock(root, ti.prompt);
    if (!built) {
      // Silent absence: content-stale graph / no graph / internal error.
      recordEvent(root, "pretask.skipped", { reason: "no_block" });
      return;
    }

    const updated = { ...ti, prompt: ti.prompt + "\n\n" + built.block };

    // Serialize BEFORE writing anything: if this JSON can't be produced,
    // the unmodified tool call must proceed.
    let out;
    try {
      out = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: "sextant: appended codebase orientation block",
          updatedInput: updated,
        },
      });
    } catch {
      return;
    }

    recordEvent(root, "pretask.injected", {
      subagentType: typeof ti.subagent_type === "string" ? ti.subagent_type : null,
      bytes: built.bytes,
      taskFiles: built.taskFiles.length,
    });
    process.stdout.write(out);
  } catch {
    // never-modify-on-doubt: silence = unmodified Task call.
  }
}

module.exports = { run };
