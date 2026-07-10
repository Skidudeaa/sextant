#!/usr/bin/env node
"use strict";

// R-A probe hook (docs/018 Phase 0): fires on PreToolUse for the subagent-
// spawning tool (matcher "Task|Agent" in the probe settings.json).  Two jobs:
//   1. LOG the payload shape (tool_name, tool_input keys, subagent_type) so
//      the runner can prove the hook fired and see what the tool is called.
//   2. Return `updatedInput` with a marker line APPENDED to tool_input.prompt.
//      If the spawned subagent can quote the marker back, the parent-session
//      PreToolUse channel is a working injection point for subagent
//      orientation (Lane A of docs/018).
// Never-modify-on-doubt: any parse failure or missing prompt → exit 0 with no
// output (tool call proceeds unmodified).

const fs = require("fs");

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let data = {};
  try {
    data = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  const log = process.env.SXRA_LOG || "/tmp/sxra-pretask-log.jsonl";
  const ti = data.tool_input || {};
  try {
    fs.appendFileSync(
      log,
      JSON.stringify({
        ts: Date.now(),
        hook_event: data.hook_event_name,
        tool_name: data.tool_name,
        input_keys: Object.keys(ti),
        subagent_type: ti.subagent_type || null,
        prompt_head: typeof ti.prompt === "string" ? ti.prompt.slice(0, 60) : null,
      }) + "\n"
    );
  } catch { /* logging is best-effort */ }

  if (typeof ti.prompt !== "string") process.exit(0);
  const updated = {
    ...ti,
    prompt:
      ti.prompt +
      "\n\nSXMARK-4217: this line was appended by a parent-session PreToolUse hook via updatedInput.",
  };
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "R-A probe: marker injection",
        updatedInput: updated,
      },
    })
  );
  process.exit(0);
});
