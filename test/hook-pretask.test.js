"use strict";

// Subagent orientation Lane A (docs/018 + 022): the PreToolUse Task/Agent
// hook that appends a facts-only <codebase-intelligence> block to a spawning
// subagent's prompt via updatedInput.
//
// Locks the pre-registered ship blockers:
//   - never-modify-on-doubt: bad stdin / missing prompt / refused root /
//     stale graph → NO stdout at all (unmodified Task call)
//   - byte cap: the appended block never exceeds ORIENT_MAX_BYTES
//   - freshness gate at spawn: content-stale → silent absence
//   - facts-only shape: block carries Repo/Index facts, original prompt
//     survives byte-identical at the front
//   - refused roots create NO state (no telemetry self-bootstrap)

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync, execSync } = require("child_process");

const { buildOrientationBlock, ORIENT_MAX_BYTES } = require("../lib/orient");

const BIN = path.resolve(__dirname, "..", "bin", "intel.js");

function hermeticEnv() {
  return {
    ...process.env,
    SEXTANT_HOLDBACK_PCT: "0",
    SEXTANT_HOLDBACK_FORCE: "",
    SEXTANT_SYNC_RESCAN: "0",
  };
}

function gitInit(dir) {
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "t@t"', { cwd: dir });
  execSync('git config user.name "t"', { cwd: dir });
  execSync("git config commit.gpgsign false", { cwd: dir });
}

function runHook(cwd, stdinObj) {
  const res = spawnSync(process.execPath, [BIN, "hook", "pretask"], {
    cwd,
    encoding: "utf8",
    env: hermeticEnv(),
    input: typeof stdinObj === "string" ? stdinObj : JSON.stringify(stdinObj),
    timeout: 30000,
  });
  return res;
}

function taskInput(prompt, extra = {}) {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: {
      description: "probe",
      prompt,
      subagent_type: "general-purpose",
      ...extra,
    },
  };
}

function readTelemetry(root) {
  try {
    return fs
      .readFileSync(path.join(root, ".planning", "intel", "telemetry.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

describe("hook pretask — Lane A injection", () => {
  let root;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-pretask-"));
    fs.writeFileSync(
      path.join(root, "widgetizer.js"),
      "const helper = require('./helper');\nmodule.exports.widgetize = () => helper();\n"
    );
    fs.writeFileSync(path.join(root, "helper.js"), "module.exports = () => 42;\n");
    gitInit(root);
    execSync("git add -A && git commit -qm init", { cwd: root });
    execSync(`node ${BIN} scan --root ${root} --force`, { stdio: "ignore", env: hermeticEnv() });
  });

  after(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("appends a byte-capped facts block via updatedInput; original prompt intact at front", () => {
    const prompt = "Find where widgetize is defined and explain its callers.";
    const res = runHook(root, taskInput(prompt));
    assert.equal(res.status, 0);
    assert.ok(res.stdout, "expected hookSpecificOutput on stdout");
    const out = JSON.parse(res.stdout);
    const hso = out.hookSpecificOutput;
    assert.equal(hso.hookEventName, "PreToolUse");
    assert.equal(hso.permissionDecision, "allow");
    const updated = hso.updatedInput;
    // never mangle: every original key survives, prompt starts byte-identical
    assert.equal(updated.description, "probe");
    assert.equal(updated.subagent_type, "general-purpose");
    assert.ok(updated.prompt.startsWith(prompt), "original prompt must lead");
    const appended = updated.prompt.slice(prompt.length);
    assert.match(appended, /<codebase-intelligence>/);
    assert.match(appended, /Repo: /);
    assert.match(appended, /import resolution/);
    assert.ok(
      Buffer.byteLength(appended.trim(), "utf8") <= ORIENT_MAX_BYTES,
      `block ${Buffer.byteLength(appended.trim(), "utf8")}B exceeds cap ${ORIENT_MAX_BYTES}`
    );
    // telemetry: injection recorded with the agent type
    const inj = readTelemetry(root).filter((e) => e.name === "pretask.injected");
    assert.ok(inj.length >= 1);
    assert.equal(inj[inj.length - 1].subagentType, "general-purpose");
  });

  it("never double-injects: a prompt already carrying a block passes unmodified", () => {
    const res = runHook(
      root,
      taskInput("do a thing\n\n<codebase-intelligence>\nold\n</codebase-intelligence>")
    );
    assert.equal(res.status, 0);
    assert.equal(res.stdout, "", "must not emit updatedInput");
  });

  it("never-modify-on-doubt: malformed stdin JSON → no output, exit 0", () => {
    const res = runHook(root, "{not json");
    assert.equal(res.status, 0);
    assert.equal(res.stdout, "");
  });

  it("never-modify-on-doubt: tool_input without a string prompt → no output", () => {
    const res = runHook(root, { tool_name: "Agent", tool_input: { description: "x" } });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, "");
  });

  it("freshness gate at spawn: content-stale graph → silent absence", () => {
    // move HEAD past the recorded scan state
    fs.writeFileSync(path.join(root, "newfile.js"), "module.exports = 1;\n");
    execSync("git add -A && git commit -qm drift", { cwd: root });
    try {
      const res = runHook(root, taskInput("Find where widgetize is defined."));
      assert.equal(res.status, 0);
      assert.equal(res.stdout, "", "stale graph must inject nothing");
      const skips = readTelemetry(root).filter((e) => e.name === "pretask.skipped");
      assert.ok(skips.some((e) => e.reason === "no_block"));
    } finally {
      // restore fresh state for any later cases
      execSync(`node ${BIN} scan --root ${root} --force`, { stdio: "ignore", env: hermeticEnv() });
    }
  });

  it("refused root (no project marker): no output AND no state created", () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-pretask-bare-"));
    try {
      const res = runHook(bare, taskInput("hello"));
      assert.equal(res.status, 0);
      assert.equal(res.stdout, "");
      assert.ok(
        !fs.existsSync(path.join(bare, ".planning")),
        "refusal must not self-bootstrap state"
      );
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("buildOrientationBlock — content shape", () => {
  let root;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-orient-"));
    fs.writeFileSync(path.join(root, "a.js"), "const b = require('./frobnicate');\n");
    // stem-exact path lane target (CJS `module.exports.X` isn't captured as a
    // named export, so the export lane has nothing here — path match is the
    // deterministic graph signal for this fixture)
    fs.writeFileSync(path.join(root, "frobnicate.js"), "module.exports = () => 1;\n");
    gitInit(root);
    execSync("git add -A && git commit -qm init", { cwd: root });
    execSync(`node ${BIN} scan --root ${root} --force`, { stdio: "ignore", env: hermeticEnv() });
  });

  after(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("carries identity, health, hotspots; surfaces task-matching files", async () => {
    const built = await buildOrientationBlock(root, "where is frobnicate implemented?");
    assert.ok(built, "fresh scanned repo must build a block");
    assert.match(built.block, /^<codebase-intelligence>\n/);
    assert.match(built.block, /\n<\/codebase-intelligence>$/);
    assert.match(built.block, /Repo: /);
    assert.match(built.block, /Index: 2 files/);
    assert.match(built.block, /frobnicate\.js/);
    assert.ok(built.taskFiles.some((f) => f.path === "frobnicate.js"));
    assert.ok(built.bytes <= ORIENT_MAX_BYTES);
  });

  it("facts only — no imperative 'Use …' phrasing (docs/022 constraint)", async () => {
    const built = await buildOrientationBlock(root, "where is frobnicate implemented?");
    assert.ok(built);
    assert.doesNotMatch(built.block, /\bUse the\b|\bcall this\b|\byou should\b/i);
  });

  it("returns null on a root with no graph", async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-orient-bare-"));
    try {
      assert.equal(await buildOrientationBlock(bare, "anything"), null);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});
