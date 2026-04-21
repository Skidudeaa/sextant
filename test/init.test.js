"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { hasSextantHook, checkClaudeHooks } = require("../commands/init");
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

  it("checkClaudeHooks detects both hooks when both are wired", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-init-"));
    try {
      fs.mkdirSync(path.join(tmp, ".claude"));
      fs.writeFileSync(
        path.join(tmp, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "sextant hook sessionstart" }] }],
            UserPromptSubmit: [{ matcher: "*", hooks: [{ type: "command", command: "sextant hook refresh" }] }],
          },
        }),
      );
      const result = checkClaudeHooks(tmp);
      assert.equal(result.exists, true);
      assert.equal(result.sessionStart, true);
      assert.equal(result.userPromptSubmit, true);
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
