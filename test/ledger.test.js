"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { census, normalize } = require("../commands/ledger");

const hookJson = context => JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext: context } });
const att = attachment => JSON.stringify({ type: "attachment", attachment });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));
  const project = path.join(root, "-root-a");
  fs.mkdirSync(path.join(project, "s1", "subagents"), { recursive: true });
  fs.writeFileSync(path.join(project, "s1.jsonl"), [
    att({ type: "hook_success", hookEvent: "SessionStart", command: "cat persona.md", content: "PERSONA" }),
    // Plain stdout on PostToolUse stays in the transcript.
    att({ type: "hook_success", hookEvent: "PostToolUse", command: "echo hi", content: "hi" }),
    // Two hooks on one tool call, each emitting JSON context: each row is
    // attributed by what its own run printed, not by order.
    att({ type: "hook_success", hookEvent: "PostToolBatch", toolUseID: "t1", command: "node other.js", content: "", stdout: hookJson("OTHER") }),
    att({ type: "hook_success", hookEvent: "PostToolBatch", toolUseID: "t1", command: "python3 footer.py", content: "", stdout: hookJson("FOOTER\nline") }),
    att({ type: "hook_additional_context", hookEvent: "PostToolBatch", toolUseID: "t1", content: ["FOOTER\nline"] }),
    att({ type: "hook_additional_context", hookEvent: "PostToolBatch", toolUseID: "t1", content: ["OTHER"] }),
    att({ type: "async_hook_response", hookEvent: "PostToolUse", hookName: "PostToolUse:Edit", stdout: "ASYNC", response: {} }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "0123456789" }] }] } }),
    '{"type":"attachment","attach',
  ].join("\n"));
  fs.writeFileSync(path.join(project, "s1", "subagents", "x.jsonl"), att({ type: "hook_success", hookEvent: "SessionStart", command: "sub", content: "SUB" }));
  const old = path.join(project, "old.jsonl");
  fs.writeFileSync(old, att({ type: "hook_success", hookEvent: "SessionStart", command: "old", content: "OLD" }));
  const past = new Date(Date.now() - 90 * 86400e3);
  fs.utimesSync(old, past, past);
  return root;
}

test("census counts what reaches the model, attributes JSON context to its own hook run, and skips subagents and old sessions", () => {
  const r = census(fixture(), { days: 60 });
  assert.equal(r.sessions, 1);
  assert.deepEqual(r.totals, { model: 7 + 11 + 5, unverified: 5, transcript: 2, toolResult: 10 });
  assert.deepEqual(Object.fromEntries(r.sources.map(s => [s.source, [s.visibility, s.chars, s.projects.join()]])), {
    "python3 footer.py": ["model", 11, "a"],
    "cat persona.md": ["model", 7, "a"],
    "node other.js": ["model", 5, "a"],
    "(unattributed async PostToolUse:Edit)": ["unverified", 5, "a"],
  });
  assert.equal(r.medianModelCharsPerSession, 23);
});

test("plugin versions and long tokens are taken out of source names", () => {
  assert.equal(normalize('node "/root/.claude/plugins/cache/omc/5.4.0/scripts/x.mjs"'), 'node "/root/.claude/plugins/cache/omc/<version>/scripts/x.mjs"');
  assert.equal(normalize("curl -H 'X-Key: fixture0123456789abcdefghijklmnopqrstuv' x"), "curl -H 'X-Key: <redacted>' x");
});
