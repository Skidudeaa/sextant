"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  hasSextantHook,
  hasHookCommand,
  hasHookConflict,
  claudeHooksComplete,
  checkClaudeHooks,
  ensureCodexHooks,
  ensureCodexMcp,
  ensureAgentsMd,
  ensureKimiHooks,
} = require("../commands/init");
const intel = require("../lib/intel");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, spawnSync } = require("child_process");

const INTEL_MODULE = path.join(__dirname, "..", "lib", "intel.js");
const INIT_SCRIPT = [
  "const intel = require(process.argv[1]);",
  "const root = process.argv[2];",
  "const claudeScopeOptions = { home: process.argv[3], configDir: process.argv[4], managedFiles: [] };",
  "intel.init(root, { claudeScopeOptions }).catch((error) => { console.error(error); process.exitCode = 1; });",
].join("\n");

function initChildArgs(root) {
  const scopes = claudeScopeOptions(root);
  return ["-e", INIT_SCRIPT, INTEL_MODULE, root, scopes.home, scopes.configDir];
}

function claudeScopeOptions(root) {
  return {
    home: path.join(root, ".test-home"),
    configDir: path.join(root, ".test-claude-config"),
    managedFiles: [],
  };
}

function initIntel(root) {
  return intel.init(root, { claudeScopeOptions: claudeScopeOptions(root) });
}

function checkHooks(root) {
  return checkClaudeHooks(root, claudeScopeOptions(root));
}

function enableCoherence(root) {
  fs.writeFileSync(
    path.join(root, ".codebase-intel.json"),
    JSON.stringify({ capsule: true, coherence: true }) + "\n"
  );
}

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
      const result = checkHooks(tmp);
      assert.equal(result.exists, false);
      assert.equal(result.sessionStart, false);
      assert.equal(result.userPromptSubmit, false);
      assert.equal(result.filePostToolUse, false);
      assert.equal(result.subagentStart, false);
      assert.equal(result.taskPreToolUse, false);
      assert.equal(result.taskPostToolUse, false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("checkClaudeHooks detects the base surfaces plus experiment PreToolUse", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-init-"));
    try {
      enableCoherence(tmp);
      fs.mkdirSync(path.join(tmp, ".claude"));
      fs.writeFileSync(
        path.join(tmp, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "sextant hook sessionstart" }] }],
            UserPromptSubmit: [{ matcher: "*", hooks: [{ type: "command", command: "sextant hook refresh" }] }],
            PostToolUse: [
              { matcher: "Read|Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: "sextant hook posttooluse" }] },
              { matcher: "Task|Agent", hooks: [{ type: "command", command: "sextant hook posttooluse" }] },
            ],
            SubagentStart: [{ matcher: "*", hooks: [{ type: "command", command: "sextant hook subagentstart" }] }],
            PreToolUse: [{ matcher: "Task|Agent", hooks: [{ type: "command", command: "sextant hook pretask" }] }],
          },
        }),
      );
      const result = checkHooks(tmp);
      assert.equal(result.exists, true);
      assert.equal(result.sessionStart, true);
      assert.equal(result.userPromptSubmit, true);
      assert.equal(result.filePostToolUse, true);
      assert.equal(result.subagentStart, true);
      assert.equal(result.taskPreToolUse, true);
      assert.equal(result.taskPostToolUse, true);
      assert.equal(result.preTaskRequired, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("checkClaudeHooks reports filePostToolUse:false when PostToolUse is absent", () => {
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
      const result = checkHooks(tmp);
      assert.equal(result.userPromptSubmit, true);
      assert.equal(result.filePostToolUse, false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("checkClaudeHooks does not mistake file scoring for a Task/Agent return join", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-init-"));
    try {
      fs.mkdirSync(path.join(tmp, ".claude"));
      const settings = {
        hooks: {
          SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "sextant hook sessionstart" }] }],
          UserPromptSubmit: [{ matcher: "*", hooks: [{ type: "command", command: "sextant hook refresh" }] }],
          PostToolUse: [{ matcher: "Read|Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: "sextant hook posttooluse" }] }],
        },
      };
      fs.writeFileSync(
        path.join(tmp, ".claude", "settings.json"),
        JSON.stringify(settings)
      );
      assert.equal(
        hasHookCommand(
          settings,
          "PostToolUse",
          "sextant hook posttooluse",
          "Read|Edit|Write|MultiEdit|NotebookEdit"
        ),
        true
      );
      const result = checkHooks(tmp);
      assert.equal(result.filePostToolUse, true);
      assert.equal(result.taskPreToolUse, false);
      assert.equal(result.taskPostToolUse, false);
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
      const result = checkHooks(tmp);
      assert.equal(result.sessionStart, true);
      assert.equal(result.userPromptSubmit, false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects exec-form and background handlers as synchronous hook coverage", () => {
    for (const malformed of [
      { type: "command", command: "sextant hook pretask", args: [] },
      { type: "command", command: "sextant hook pretask", async: true },
      { type: "command", command: "sextant hook pretask", asyncRewake: true },
      { type: "command", command: "sextant hook pretask", if: "Agent(*)" },
    ]) {
      const settings = {
        hooks: { PreToolUse: [{ matcher: "Task|Agent", hooks: [malformed] }] },
      };
      assert.equal(
        hasHookCommand(settings, "PreToolUse", "sextant hook pretask", "Task|Agent"),
        false
      );
    }
  });

  it("honors CLAUDE_CONFIG_DIR when inspecting user hook conflicts", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-config-dir-"));
    const configDir = path.join(tmp, "custom-claude");
    const prior = process.env.CLAUDE_CONFIG_DIR;
    try {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, "settings.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [{
              matcher: "Task|Agent",
              hooks: [{ type: "command", command: "custom-user-rewriter" }],
            }],
          },
        })
      );
      process.env.CLAUDE_CONFIG_DIR = configDir;
      const state = intel.inspectClaudeHookScopes(tmp, { managedFiles: [] });
      assert.equal(state.externalPreTaskConflicts.length, 1);
      assert.equal(state.externalPreTaskConflicts[0].file, path.join(configDir, "settings.json"));
    } finally {
      if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prior;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("accepts injected managed sources for hermetic policy status", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-managed-"));
    try {
      const managed = path.join(tmp, "managed-settings.json");
      fs.writeFileSync(
        managed,
        JSON.stringify({ disableAllHooks: true, allowManagedHooksOnly: true })
      );
      const state = intel.inspectClaudeHookScopes(tmp, {
        ...claudeScopeOptions(tmp),
        managedFiles: [managed],
      });
      assert.equal(state.hooksDisabled, true);
      assert.equal(state.projectHooksBlockedByPolicy, true);
      assert.equal(state.hooksDisabledSource.file, managed);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// The complete hook set must SELF-DEPLOY: intel.init runs on every prompt (via
// intel.health → the UserPromptSubmit hook), so an existing install gets new
// lifecycle surfaces merged in without clobbering user hooks or MCP servers.
describe("init — settings wiring (self-deploy)", () => {
  function hookCommands(settings, event) {
    const out = [];
    for (const group of settings?.hooks?.[event] || []) {
      for (const h of group?.hooks || []) out.push({ matcher: group.matcher, command: h.command });
    }
    return out;
  }

  it("intel.init wires the safe base lifecycle into fresh default settings", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-wire-"));
    try {
      await initIntel(tmp);
      const settingsPath = path.join(tmp, ".claude", "settings.json");
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o600, "new settings must be private");
      assert.deepEqual(
        hookCommands(settings, "SessionStart").map((h) => h.command),
        ["sextant hook sessionstart"]
      );
      assert.deepEqual(
        hookCommands(settings, "UserPromptSubmit").map((h) => h.command),
        ["sextant hook refresh"]
      );
      const post = hookCommands(settings, "PostToolUse");
      assert.equal(post.length, 2);
      assert.ok(post.every((h) => h.command === "sextant hook posttooluse"));
      // tool matcher (not "*") so the hook only fires for file-targeting tools
      assert.ok(post.some((h) => h.matcher === "Read|Edit|Write|MultiEdit|NotebookEdit"));
      assert.ok(post.some((h) => h.matcher === "Task|Agent"));
      assert.deepEqual(hookCommands(settings, "SubagentStart"), [
        { matcher: "*", command: "sextant hook subagentstart" },
      ]);
      assert.deepEqual(hookCommands(settings, "PreToolUse"), []);
      const status = checkHooks(tmp);
      assert.equal(status.subagentStart, true);
      assert.equal(status.preTaskRequired, false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("intel.init upgrades an older install without clobbering existing hooks", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-wire-"));
    try {
      enableCoherence(tmp);
      fs.mkdirSync(path.join(tmp, ".claude"));
      // An older install: base hooks plus unrelated user Pre/PostToolUse hooks.
      // Both must survive the task-lifecycle promotion.
      fs.writeFileSync(
        path.join(tmp, ".claude", "settings.json"),
        JSON.stringify({
          env: { KEEP_ME: "1" },
          hooks: {
            SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "sextant hook sessionstart" }] }],
            UserPromptSubmit: [{ matcher: "*", hooks: [{ type: "command", command: "sextant hook refresh" }] }],
            PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-own-linter" }] }],
            PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-own-guard" }] }],
          },
        })
      );
      fs.chmodSync(path.join(tmp, ".claude", "settings.json"), 0o660);
      await initIntel(tmp);
      const settings = JSON.parse(fs.readFileSync(path.join(tmp, ".claude", "settings.json"), "utf8"));
      assert.equal(
        fs.statSync(path.join(tmp, ".claude", "settings.json")).mode & 0o777,
        0o660,
        "upgrade must preserve the existing settings mode"
      );
      assert.deepEqual(settings.env, { KEEP_ME: "1" }, "unrelated top-level settings must survive");
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
      assert.ok(
        post.some((h) => h.command === "sextant hook posttooluse" && h.matcher === "Task|Agent"),
        "Task/Agent return join must be installed"
      );
      const pre = hookCommands(settings, "PreToolUse");
      assert.ok(
        pre.some((h) => h.matcher === "Bash" && h.command === "my-own-guard"),
        "pre-existing unrelated PreToolUse hook must be preserved"
      );
      assert.ok(
        pre.some((h) => h.matcher === "Task|Agent" && h.command === "sextant hook pretask"),
        "Task/Agent orientation hook must be installed"
      );
      const ours = post.filter((h) => h.command === "sextant hook posttooluse");
      assert.equal(ours.length, 2, "upgrade must install exactly two PostToolUse matchers");
      const pretask = pre
        .filter((h) => h.command === "sextant hook pretask");
      assert.equal(pretask.length, 1, "upgrade must install exactly one PreToolUse hook");
      assert.deepEqual(hookCommands(settings, "SubagentStart"), [
        { matcher: "*", command: "sextant hook subagentstart" },
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("migrates an ordinary old install from PreToolUse rewriting to SubagentStart", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-wire-"));
    try {
      fs.mkdirSync(path.join(tmp, ".claude"));
      fs.writeFileSync(
        path.join(tmp, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [{
              matcher: "Task|Agent",
              hooks: [{ type: "command", command: "sextant hook pretask" }],
            }],
          },
        })
      );

      await initIntel(tmp);
      const settings = JSON.parse(
        fs.readFileSync(path.join(tmp, ".claude", "settings.json"), "utf8")
      );
      assert.deepEqual(hookCommands(settings, "PreToolUse"), []);
      assert.deepEqual(hookCommands(settings, "SubagentStart"), [
        { matcher: "*", command: "sextant hook subagentstart" },
      ]);
      const status = checkHooks(tmp);
      assert.equal(status.preTaskRequired, false);
      assert.equal(claudeHooksComplete(status), true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses to auto-compose an overlapping Task/Agent PreToolUse handler", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-wire-"));
    try {
      enableCoherence(tmp);
      fs.mkdirSync(path.join(tmp, ".claude"));
      const userCommand = "my-task-input-rewriter";
      fs.writeFileSync(
        path.join(tmp, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "sextant hook sessionstart" }] }],
            UserPromptSubmit: [{ matcher: "*", hooks: [{ type: "command", command: "sextant hook refresh" }] }],
            PreToolUse: [{
              matcher: "Agent|Task",
              hooks: [
                { type: "command", command: "sextant hook pretask" },
                { type: "command", command: userCommand },
              ],
            }],
          },
        })
      );
      await initIntel(tmp);
      const settings = JSON.parse(fs.readFileSync(path.join(tmp, ".claude", "settings.json"), "utf8"));
      const pre = hookCommands(settings, "PreToolUse");
      assert.deepEqual(pre, [{ matcher: "Agent|Task", command: userCommand }]);
      assert.equal(
        hasHookConflict(settings, "PreToolUse", "sextant hook pretask", "Task|Agent"),
        true
      );
      const status = checkHooks(tmp);
      assert.equal(status.taskPreToolUse, false);
      assert.equal(status.taskPreToolUseConflict, true);
      assert.equal(status.taskPostToolUse, true, "safe return join should still be repaired");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("repairs a malformed covering Sextant handler into synchronous shell form", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-wire-"));
    try {
      enableCoherence(tmp);
      fs.mkdirSync(path.join(tmp, ".claude"));
      fs.writeFileSync(
        path.join(tmp, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [{
              matcher: "Task|Agent",
              hooks: [{
                type: "command",
                command: "sextant hook pretask",
                args: [],
                async: true,
                asyncRewake: true,
                if: "Agent(*)",
              }],
            }],
          },
        })
      );
      await initIntel(tmp);
      const settings = JSON.parse(fs.readFileSync(path.join(tmp, ".claude", "settings.json"), "utf8"));
      const handler = settings.hooks.PreToolUse[0].hooks[0];
      assert.deepEqual(handler, { type: "command", command: "sextant hook pretask" });
      assert.equal(checkHooks(tmp).taskPreToolUse, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips project PreToolUse when local settings contain an overlapping handler", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-wire-"));
    try {
      enableCoherence(tmp);
      fs.mkdirSync(path.join(tmp, ".claude"));
      fs.writeFileSync(
        path.join(tmp, ".claude", "settings.local.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [{
              matcher: "Task|Agent",
              hooks: [{ type: "command", command: "my-local-task-rewriter" }],
            }],
          },
        })
      );
      await initIntel(tmp);
      const settings = JSON.parse(fs.readFileSync(path.join(tmp, ".claude", "settings.json"), "utf8"));
      assert.deepEqual(settings.hooks.PreToolUse, undefined);
      assert.equal(
        hookCommands(settings, "PostToolUse")
          .some((hook) => hook.matcher === "Task|Agent" && hook.command === "sextant hook posttooluse"),
        true,
        "non-rewriting return telemetry remains safe to install"
      );
      const status = checkHooks(tmp);
      assert.equal(status.taskPreToolUse, false);
      assert.equal(status.taskPreToolUseConflict, true);
      assert.equal(status.externalPreTaskConflicts.length, 1);
      assert.equal(status.externalPreTaskConflicts[0].scope, "local");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps project self-containment with a healthy deduplicated user-scoped Sextant PreToolUse", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-wire-"));
    try {
      enableCoherence(tmp);
      const scopes = claudeScopeOptions(tmp);
      fs.mkdirSync(scopes.configDir, { recursive: true });
      fs.writeFileSync(
        path.join(scopes.configDir, "settings.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [{
              matcher: "Agent|Task",
              hooks: [{ type: "command", command: "sextant hook pretask" }],
            }],
          },
        })
      );

      await initIntel(tmp);
      const settings = JSON.parse(
        fs.readFileSync(path.join(tmp, ".claude", "settings.json"), "utf8")
      );
      assert.deepEqual(hookCommands(settings, "PreToolUse"), [
        { matcher: "Task|Agent", command: "sextant hook pretask" },
      ]);
      const status = checkHooks(tmp);
      assert.equal(status.taskPreToolUse, true);
      assert.equal(status.taskPreToolUseConflict, false);
      assert.deepEqual(status.externalPreTaskConflicts, []);
      assert.equal(claudeHooksComplete(status), true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports disableAllHooks instead of declaring configured entries active", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-wire-"));
    try {
      fs.mkdirSync(path.join(tmp, ".claude"));
      fs.writeFileSync(
        path.join(tmp, ".claude", "settings.json"),
        JSON.stringify({ disableAllHooks: true })
      );
      await initIntel(tmp);
      const status = checkHooks(tmp);
      assert.equal(status.sessionStart, true, "entries are present");
      assert.equal(status.hooksDisabled, true, "runtime-disabled state must remain distinct");
      assert.equal(claudeHooksComplete(status), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("accepts historic Agent|Task matchers without double-wiring", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-wire-"));
    try {
      enableCoherence(tmp);
      fs.mkdirSync(path.join(tmp, ".claude"));
      fs.writeFileSync(
        path.join(tmp, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "sextant hook sessionstart" }] }],
            UserPromptSubmit: [{ matcher: "*", hooks: [{ type: "command", command: "sextant hook refresh" }] }],
            PostToolUse: [
              { matcher: "Read|Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: "sextant hook posttooluse" }] },
              { matcher: "Agent|Task", hooks: [{ type: "command", command: "sextant hook posttooluse" }] },
            ],
            PreToolUse: [{ matcher: "Agent|Task", hooks: [{ type: "command", command: "sextant hook pretask" }] }],
          },
        })
      );
      await initIntel(tmp);
      const settings = JSON.parse(fs.readFileSync(path.join(tmp, ".claude", "settings.json"), "utf8"));
      assert.equal(
        hookCommands(settings, "PostToolUse")
          .filter((h) => h.command === "sextant hook posttooluse").length,
        2
      );
      assert.equal(
        hookCommands(settings, "PreToolUse")
          .filter((h) => h.command === "sextant hook pretask").length,
        1
      );
      const status = checkHooks(tmp);
      assert.equal(status.taskPreToolUse, true);
      assert.equal(status.taskPostToolUse, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("sequential init processes are byte-idempotent", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-wire-"));
    try {
      const runInit = () => spawnSync(process.execPath, initChildArgs(tmp), {
        cwd: tmp,
        encoding: "utf8",
      });
      const first = runInit();
      assert.equal(first.status, 0, first.stderr || first.stdout);
      const settingsPath = path.join(tmp, ".claude", "settings.json");
      const once = fs.readFileSync(settingsPath, "utf8");
      const second = runInit();
      assert.equal(second.status, 0, second.stderr || second.stdout);
      const twice = fs.readFileSync(settingsPath, "utf8");
      assert.equal(twice, once, "re-running init must not rewrite or reorder settings");
      const settings = JSON.parse(twice);
      assert.equal(
        hookCommands(settings, "PostToolUse")
          .filter((h) => h.command === "sextant hook posttooluse").length,
        2
      );
      assert.equal(
        hookCommands(settings, "SubagentStart")
          .filter((h) => h.command === "sextant hook subagentstart").length,
        1
      );
      assert.equal(hookCommands(settings, "PreToolUse").length, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("serializes concurrent settings repairs without duplicates or debris", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-wire-"));
    const runInit = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, initChildArgs(tmp), {
        cwd: tmp,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr || stdout || `init child exited ${code}`));
      });
    });
    try {
      // Seed graph/summary state once, then remove only the settings output.
      // The six children now contend on the settings repair under test instead
      // of racing unrelated graph.db initialization locks.
      await initIntel(tmp);
      fs.rmSync(path.join(tmp, ".claude", "settings.json"));
      await Promise.all(Array.from({ length: 6 }, () => runInit()));
      const settingsPath = path.join(tmp, ".claude", "settings.json");
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      assert.equal(
        hookCommands(settings, "PostToolUse")
          .filter((h) => h.command === "sextant hook posttooluse").length,
        2
      );
      assert.equal(
        hookCommands(settings, "SubagentStart")
          .filter((h) => h.command === "sextant hook subagentstart").length,
        1
      );
      assert.equal(hookCommands(settings, "PreToolUse").length, 0);
      assert.deepEqual(
        fs.readdirSync(path.join(tmp, ".claude"))
          .filter((name) => name.includes(".tmp-") || name.includes(".sextant-lock")),
        [],
        "successful repairs must leave no temp or mutex contender files"
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("leaves unreadable user settings byte-identical", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-wire-"));
    const invalid = "{ definitely-not-json\n";
    try {
      fs.mkdirSync(path.join(tmp, ".claude"));
      const settingsPath = path.join(tmp, ".claude", "settings.json");
      fs.writeFileSync(settingsPath, invalid);
      await initIntel(tmp);
      assert.equal(fs.readFileSync(settingsPath, "utf8"), invalid);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("leaves a symlinked settings path and its target untouched", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-wire-"));
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-settings-target-"));
    try {
      fs.mkdirSync(path.join(tmp, ".claude"));
      const target = path.join(external, "settings.json");
      const original = JSON.stringify({ env: { KEEP_ME: "1" } }) + "\n";
      fs.writeFileSync(target, original);
      const settingsPath = path.join(tmp, ".claude", "settings.json");
      fs.symlinkSync(target, settingsPath);
      await initIntel(tmp);
      assert.equal(fs.lstatSync(settingsPath).isSymbolicLink(), true);
      assert.equal(fs.readFileSync(target, "utf8"), original);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(external, { recursive: true, force: true });
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

  it("ensureCodexHooks throws an actionable error when .codex is a file, not a dir", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-codex-"));
    try {
      fs.writeFileSync(path.join(tmp, ".codex"), ""); // stray 0-byte file
      assert.throws(() => ensureCodexHooks(tmp), /not a directory/);
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

  it("created AGENTS.md carries the v2 section: all 9 tools, no codex-specific hook claim", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-agents-"));
    try {
      ensureAgentsMd(tmp);
      const content = fs.readFileSync(path.join(tmp, "AGENTS.md"), "utf8");
      for (const tool of [
        "sextant_search", "sextant_related", "sextant_explain", "sextant_health",
        "sextant_scope", "sextant_orient", "sextant_focus", "sextant_task_status",
        "sextant_closure",
      ]) {
        assert.ok(content.includes(tool), `v2 section must list ${tool}`);
      }
      assert.ok(content.includes("sextant-managed:v2"), "version marker present");
      // The v1 defect: a hardcoded `.codex/hooks.json` sentence that is wrong
      // under every other client.
      assert.ok(!content.includes(".codex"), "no client-specific hook claim");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("replaces a v1 managed section in place, preserving user content around it", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-agents-"));
    try {
      const v1 =
        "# AGENTS.md\n\nUser intro.\n\n" +
        "## Orientation: use sextant before grepping\n\n" +
        "- A `.codex/hooks.json` hook injects a fresh codebase map at session start.\n" +
        "- `sextant_search` — ranked code search.\n\n" +
        "## User section\n\nKeep me.\n";
      fs.writeFileSync(path.join(tmp, "AGENTS.md"), v1);
      const r = ensureAgentsMd(tmp);
      assert.equal(r.action, "updated");
      const content = fs.readFileSync(path.join(tmp, "AGENTS.md"), "utf8");
      assert.ok(content.includes("User intro."), "content before the section preserved");
      assert.ok(content.includes("## User section\n\nKeep me."), "content after the section preserved");
      assert.ok(content.includes("sextant-managed:v2"), "section upgraded to v2");
      assert.ok(!content.includes(".codex/hooks.json"), "stale v1 sentence gone");
      assert.ok(content.includes("sextant_closure"), "v2 tool list present");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("is a byte-identical no-op when the v2 section is already present", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-agents-"));
    try {
      ensureAgentsMd(tmp);
      const original = fs.readFileSync(path.join(tmp, "AGENTS.md"), "utf8");
      const r = ensureAgentsMd(tmp);
      assert.equal(r.action, "already-current");
      assert.equal(fs.readFileSync(path.join(tmp, "AGENTS.md"), "utf8"), original);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("init --kimi — global [[hooks]] in ~/.kimi-code/config.toml", () => {
  const KIMI_CMD = 'command = "SEXTANT_CLIENT=kimi SEXTANT_REQUIRE_STATE=1 sextant hook refresh"';

  it("reports exists:false and creates nothing when config.toml is missing", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-kimi-home-"));
    try {
      const r = ensureKimiHooks(home);
      assert.equal(r.exists, false);
      assert.equal(r.alreadyConfigured, false);
      assert.ok(!fs.existsSync(path.join(home, ".kimi-code", "config.toml")), "must not synthesize global config");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("appends the hook block preserving existing config verbatim, with exactly two keys", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-kimi-home-"));
    try {
      fs.mkdirSync(path.join(home, ".kimi-code"));
      const original = 'default_model = "kimi-code/k3"\n\n[providers.kimi-code]\napi_key = "x"\n';
      fs.writeFileSync(path.join(home, ".kimi-code", "config.toml"), original);
      const r = ensureKimiHooks(home);
      assert.equal(r.exists, true);
      assert.equal(r.alreadyConfigured, false);
      const content = fs.readFileSync(path.join(home, ".kimi-code", "config.toml"), "utf8");
      assert.ok(content.startsWith(original), "existing config preserved verbatim");
      assert.match(content, /\[\[hooks\]\]\nevent = "UserPromptSubmit"\ncommand = "SEXTANT_CLIENT=kimi SEXTANT_REQUIRE_STATE=1 sextant hook refresh"\n/);
      // Kimi's hook schema is .strict() — the appended block must carry ONLY
      // event and command (no matcher, no timeout).
      const block = content.slice(content.indexOf("[[hooks]]"));
      const keys = block.match(/^[a-z_]+\s*=/gm) || [];
      assert.deepEqual(keys.map((k) => k.replace(/\s*=$/, "")), ["event", "command"]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("is idempotent — a second run appends nothing", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-kimi-home-"));
    try {
      fs.mkdirSync(path.join(home, ".kimi-code"));
      fs.writeFileSync(path.join(home, ".kimi-code", "config.toml"), 'default_model = "kimi-code/k3"\n');
      ensureKimiHooks(home);
      const after = fs.readFileSync(path.join(home, ".kimi-code", "config.toml"), "utf8");
      const r2 = ensureKimiHooks(home);
      assert.equal(r2.alreadyConfigured, true);
      assert.equal(fs.readFileSync(path.join(home, ".kimi-code", "config.toml"), "utf8"), after);
      const count = (after.match(/sextant hook refresh/g) || []).length;
      assert.equal(count, 1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("a commented-out sextant command does NOT count as wired", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-kimi-home-"));
    try {
      fs.mkdirSync(path.join(home, ".kimi-code"));
      fs.writeFileSync(
        path.join(home, ".kimi-code", "config.toml"),
        '# [[hooks]]\n# event = "UserPromptSubmit"\n# ' + KIMI_CMD + "\n"
      );
      const r = ensureKimiHooks(home);
      assert.equal(r.alreadyConfigured, false, "commented block must not satisfy the probe");
      const content = fs.readFileSync(path.join(home, ".kimi-code", "config.toml"), "utf8");
      assert.match(content, /^command = "SEXTANT_CLIENT=kimi/m, "live block appended");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
