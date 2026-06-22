"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  hasSextantHook,
  checkClaudeHooks,
  ensureCodexHooks,
  ensureCodexMcp,
  ensureAgentsMd,
} = require("../commands/init");
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

describe("init --codex — Codex hooks", () => {
  it("ensureCodexHooks writes a fresh .codex/hooks.json with both events", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-codex-"));
    try {
      const r = ensureCodexHooks(tmp);
      assert.equal(r.alreadyConfigured, false);
      const data = JSON.parse(fs.readFileSync(path.join(tmp, ".codex", "hooks.json"), "utf8"));
      assert.equal(hasSextantHook(data, "SessionStart"), true);
      assert.equal(hasSextantHook(data, "UserPromptSubmit"), true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ensureCodexHooks preserves the user's own Codex hooks (no clobber)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-codex-"));
    try {
      fs.mkdirSync(path.join(tmp, ".codex"));
      fs.writeFileSync(
        path.join(tmp, ".codex", "hooks.json"),
        JSON.stringify({ hooks: { SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "my-tool start" }] }] } })
      );
      ensureCodexHooks(tmp);
      const data = JSON.parse(fs.readFileSync(path.join(tmp, ".codex", "hooks.json"), "utf8"));
      const cmds = data.hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.command));
      assert.ok(cmds.includes("my-tool start"), "user's hook must survive");
      assert.ok(cmds.includes("sextant hook sessionstart"), "sextant hook must be added");
      assert.equal(hasSextantHook(data, "UserPromptSubmit"), true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ensureCodexHooks is idempotent — re-run reports alreadyConfigured, no dupes", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-codex-"));
    try {
      ensureCodexHooks(tmp);
      const r2 = ensureCodexHooks(tmp);
      assert.equal(r2.alreadyConfigured, true);
      const data = JSON.parse(fs.readFileSync(path.join(tmp, ".codex", "hooks.json"), "utf8"));
      const sessionCmds = data.hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.command))
        .filter((c) => c === "sextant hook sessionstart");
      assert.equal(sessionCmds.length, 1, "no duplicate sextant SessionStart hook");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("init --codex — Codex MCP (global config.toml)", () => {
  it("ensureCodexMcp reports exists:false when ~/.codex/config.toml is missing", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-home-"));
    try {
      const r = ensureCodexMcp(home);
      assert.equal(r.exists, false);
      assert.equal(r.alreadyRegistered, false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("ensureCodexMcp appends [mcp_servers.sextant] without disturbing existing tables", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-home-"));
    try {
      fs.mkdirSync(path.join(home, ".codex"));
      const original = `model = "gpt-5.5"\n\n[mcp_servers.chrome-devtools]\ncommand = "npx"\n`;
      fs.writeFileSync(path.join(home, ".codex", "config.toml"), original);
      const r = ensureCodexMcp(home);
      assert.equal(r.alreadyRegistered, false);
      const content = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
      assert.ok(content.startsWith(original), "existing config must be preserved verbatim");
      assert.match(content, /\[mcp_servers\.sextant\]\ncommand = "sextant"\nargs = \["mcp"\]/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("ensureCodexMcp is idempotent — second run detects the existing block", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-home-"));
    try {
      fs.mkdirSync(path.join(home, ".codex"));
      fs.writeFileSync(path.join(home, ".codex", "config.toml"), `model = "gpt-5.5"\n`);
      ensureCodexMcp(home);
      const r2 = ensureCodexMcp(home);
      assert.equal(r2.alreadyRegistered, true);
      const count = (fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8")
        .match(/\[mcp_servers\.sextant\]/g) || []).length;
      assert.equal(count, 1, "no duplicate registration");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("init --codex — AGENTS.md", () => {
  it("ensureAgentsMd creates AGENTS.md when absent", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-agents-"));
    try {
      const r = ensureAgentsMd(tmp);
      assert.equal(r.action, "created");
      const content = fs.readFileSync(path.join(tmp, "AGENTS.md"), "utf8");
      assert.match(content, /sextant_search/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ensureAgentsMd appends to an existing AGENTS.md that lacks sextant", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-agents-"));
    try {
      fs.writeFileSync(path.join(tmp, "AGENTS.md"), "# AGENTS.md\n\nProject notes.\n");
      const r = ensureAgentsMd(tmp);
      assert.equal(r.action, "appended");
      const content = fs.readFileSync(path.join(tmp, "AGENTS.md"), "utf8");
      assert.match(content, /Project notes\./, "existing content preserved");
      assert.match(content, /sextant_search/, "sextant section appended");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ensureAgentsMd leaves an AGENTS.md that already mentions sextant untouched", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-agents-"));
    try {
      const original = "# AGENTS.md\n\nUse sextant for search.\n";
      fs.writeFileSync(path.join(tmp, "AGENTS.md"), original);
      const r = ensureAgentsMd(tmp);
      assert.equal(r.action, "already-mentions");
      assert.equal(fs.readFileSync(path.join(tmp, "AGENTS.md"), "utf8"), original);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
