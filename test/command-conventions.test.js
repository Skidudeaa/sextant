"use strict";

// WHY: structural lint to prevent the watch-start / watch-stop / inject
// `--root` regression from re-emerging in a future command. Every command
// that takes user-facing CLI flags must resolve its root through the shared
// rootsFromArgs() parser (either via ctx.roots from bin/intel.js's standard
// dispatch, or directly for special-cased commands). The only legitimate
// users of process.cwd() are the hook commands, where Claude Code sets the
// cwd when invoking them and CLI flags don't apply.
//
// Caught three real bugs in 4a89721 and e1551ef. Pin the rule.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const COMMANDS_DIR = path.join(__dirname, "..", "commands");

// Hooks legitimately use process.cwd() — Claude Code sets cwd on invocation
// and the hook commands don't accept CLI flags. Anything else using cwd is
// the bug shape we're guarding against.
const HOOK_FILES = new Set(["hook-refresh.js", "hook-sessionstart.js"]);

describe("command conventions", () => {
  it("non-hook commands must not use process.cwd() to resolve their root", () => {
    const files = fs.readdirSync(COMMANDS_DIR).filter((f) => f.endsWith(".js"));
    const offenders = [];
    for (const f of files) {
      if (HOOK_FILES.has(f)) continue;
      const src = fs.readFileSync(path.join(COMMANDS_DIR, f), "utf8");
      // Strip line/block comments so a "WHY: don't use process.cwd()" comment
      // doesn't false-positive. Crude but adequate for our codebase style.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map((line) => line.replace(/\/\/.*$/, ""))
        .join("\n");
      if (/process\s*\.\s*cwd\s*\(\s*\)/.test(code)) {
        offenders.push(f);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "Non-hook commands must use rootsFromArgs() or ctx.roots, not process.cwd(). " +
        "Offenders: " +
        offenders.join(", ") +
        ". See commands/watch-stop.js or commands/inject.js for the correct pattern."
    );
  });

  it("every command file exports a run() function", () => {
    const files = fs.readdirSync(COMMANDS_DIR).filter((f) => f.endsWith(".js"));
    const offenders = [];
    for (const f of files) {
      const mod = require(path.join(COMMANDS_DIR, f));
      if (typeof mod.run !== "function") {
        offenders.push(f);
      }
    }
    assert.deepEqual(offenders, [], "Commands must export { run }: " + offenders.join(", "));
  });
});
