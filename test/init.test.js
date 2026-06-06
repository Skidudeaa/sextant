"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { hasSextantHook, checkClaudeHooks } = require("../commands/init");
const intel = require("../lib/intel");
const fs = require("fs");
const path = require("path");
const os = require("os");

describe("init — hook detection", () => {
  it("hasSextantHook returns true for a 'sextant hook sessionstart' entry", () => {
    const settings = {
      hooks: {
        SessionStart: [{
          matcher: "*",
          hooks: [{ type: "command", command: "sextant hook sessionstart" }],
        }],
      },
    };
    assert.equal(hasSextantHook(settings, "SessionStart"), true);
  });

  it("hasSextantHook accepts the codebase-intel legacy alias", () => {
    // Back-compat: older projects still use `codebase-intel hook refresh`.
    const settings = {
      hooks: {
        UserPromptSubmit: [{
          matcher: "*",
          hooks: [{ type: "command", command: "codebase-intel hook refresh" }],
        }],
      },
    };
    assert.equal(hasSextantHook(settings, "UserPromptSubmit"), true);
  });

  it("hasSextantHook returns false when no sextant entry is present", () => {
    const settings = {
      hooks: {
        SessionStart: [{
          matcher: "*",
          hooks: [{ type: "command", command: "some-other-tool start" }],
        }],
      },
    };
    assert.equal(hasSextantHook(settings, "SessionStart"), false);
  });

  it("hasSextantHook returns false for missing event", () => {
    assert.equal(hasSextantHook({ hooks: {} }, "SessionStart"), false);
    assert.equal(hasSextantHook({}, "SessionStart"), false);
    assert.equal(hasSextantHook(null, "SessionStart"), false);
  });

  it("checkClaudeHooks reports exists:false when the file is missing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-init-"));
    try {
      const result = checkClaudeHooks(tmp);
      assert.equal(result.exists, false);
      assert.equal(result.sessionStart, false);
      assert.equal(result.userPromptSubmit, false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("checkClaudeHooks detects all three hooks when all are wired", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-init-"));
    try {
      fs.mkdirSync(path.join(tmp, ".claude"));
      fs.writeFileSync(
        path.join(tmp, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "sextant hook sessionstart" }] }],
            UserPromptSubmit: [{ matcher: "*", hooks: [{ type: "command", command: "sextant hook refresh" }] }],
            PostToolUse: [{ matcher: "Read|Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: "sextant hook posttooluse" }] }],
          },
        }),
      );
      const result = checkClaudeHooks(tmp);
      assert.equal(result.exists, true);
      assert.equal(result.sessionStart, true);
      assert.equal(result.userPromptSubmit, true);
      assert.equal(result.postToolUse, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("checkClaudeHooks reports postToolUse:false when the PostToolUse hook is absent", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-init-"));
    try {
      fs.mkdirSync(path.join(tmp, ".claude"));
      fs.writeFileSync(
        path.join(tmp, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "sextant hook sessionstart" }] }],
            UserPromptSubmit: [{ matcher: "*", hooks: [{ type: "command", command: "sextant hook refresh" }] }],
            // PostToolUse missing — pre-009 install
          },
        }),
      );
      const result = checkClaudeHooks(tmp);
      assert.equal(result.userPromptSubmit, true);
      assert.equal(result.postToolUse, false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("checkClaudeHooks reports only the hooks that are wired when one is missing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-init-"));
    try {
      fs.mkdirSync(path.join(tmp, ".claude"));
      fs.writeFileSync(
        path.join(tmp, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "sextant hook sessionstart" }] }],
            // UserPromptSubmit missing
          },
        }),
      );
      const result = checkClaudeHooks(tmp);
      assert.equal(result.sessionStart, true);
      assert.equal(result.userPromptSubmit, false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// The PostToolUse hook (009 #1 outcome substrate) must SELF-DEPLOY: intel.init
// runs on every prompt (via intel.health → the UserPromptSubmit hook), so an
// existing install gets the new hook merged in without re-running `sextant init`
// by hand — and without clobbering other hooks/MCP servers in settings.json.
describe("init — settings wiring (self-deploy)", () => {
  function hookCommands(settings, event) {
    const out = [];
    for (const group of settings?.hooks?.[event] || []) {
      for (const h of group?.hooks || []) out.push({ matcher: group.matcher, command: h.command });
    }
    return out;
  }

  it("intel.init wires all three hooks into a fresh settings.json", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-wire-"));
    try {
      await intel.init(tmp);
      const settings = JSON.parse(fs.readFileSync(path.join(tmp, ".claude", "settings.json"), "utf8"));
      assert.deepEqual(
        hookCommands(settings, "SessionStart").map((h) => h.command),
        ["sextant hook sessionstart"]
      );
      assert.deepEqual(
        hookCommands(settings, "UserPromptSubmit").map((h) => h.command),
        ["sextant hook refresh"]
      );
      const post = hookCommands(settings, "PostToolUse");
      assert.equal(post.length, 1);
      assert.equal(post[0].command, "sextant hook posttooluse");
      // tool matcher (not "*") so the hook only fires for file-targeting tools
      assert.equal(post[0].matcher, "Read|Edit|Write|MultiEdit|NotebookEdit");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("intel.init merges PostToolUse into a pre-009 install WITHOUT clobbering existing hooks", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-wire-"));
    try {
      fs.mkdirSync(path.join(tmp, ".claude"));
      // A pre-009 install: the two old hooks PLUS an unrelated user hook that
      // must survive the merge (the anti-clobber guarantee).
      fs.writeFileSync(
        path.join(tmp, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "sextant hook sessionstart" }] }],
            UserPromptSubmit: [{ matcher: "*", hooks: [{ type: "command", command: "sextant hook refresh" }] }],
            PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-own-linter" }] }],
          },
        })
      );
      await intel.init(tmp);
      const settings = JSON.parse(fs.readFileSync(path.join(tmp, ".claude", "settings.json"), "utf8"));
      const post = hookCommands(settings, "PostToolUse");
      // The user's unrelated Bash hook survives, and ours is added alongside.
      assert.ok(
        post.some((h) => h.matcher === "Bash" && h.command === "my-own-linter"),
        "pre-existing unrelated PostToolUse hook must be preserved"
      );
      assert.ok(
        post.some((h) => h.command === "sextant hook posttooluse" && h.matcher === "Read|Edit|Write|MultiEdit|NotebookEdit"),
        "sextant PostToolUse hook must be added under its own matcher"
      );
      // Idempotent: a second init adds no duplicate.
      await intel.init(tmp);
      const settings2 = JSON.parse(fs.readFileSync(path.join(tmp, ".claude", "settings.json"), "utf8"));
      const ours = hookCommands(settings2, "PostToolUse").filter((h) => h.command === "sextant hook posttooluse");
      assert.equal(ours.length, 1, "re-init must not duplicate the sextant PostToolUse hook");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
