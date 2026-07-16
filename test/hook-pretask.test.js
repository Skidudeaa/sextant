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

function runHook(cwd, stdinObj, extraEnv = {}) {
  const res = spawnSync(process.execPath, [BIN, "hook", "pretask"], {
    cwd,
    encoding: "utf8",
    env: { ...hermeticEnv(), ...extraEnv },
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

  it("Phase F records a collision-safe child spawn-prepared capsule linked to the parent", () => {
    const payload = taskInput("Find where widgetize is defined and explain its callers.");
    payload.session_id = "parent/session";
    payload.tool_use_id = "tool/spawn-1";
    const res = runHook(root, payload, {
      SEXTANT_CAPSULE: "1",
      SEXTANT_COHERENCE: "1",
    });
    assert.equal(res.status, 0);
    assert.ok(res.stdout);

    const coherence = require("../lib/coherence");
    const snapshots = coherence.listSnapshots(root);
    const childKey = coherence.childAgentKey(
      coherence.parentAgentKey("parent/session"),
      "tool/spawn-1"
    );
    const child = snapshots.find((s) => s.agentKey === childKey);
    assert.ok(child, "expected an immutable child spawn-prepared snapshot");
    assert.equal(child.parentAgentKey, coherence.parentAgentKey("parent/session"));
    assert.equal(child.kind, "child");
    assert.equal(child.state, "spawn_prepared");
    assert.ok(child.workset.context.some((entry) => entry.path === "widgetizer.js"));
    assert.deepEqual(child.workset.primary, [], "compact child context must not invent roles");
    assert.ok(child.workset.context.every((entry) => !entry.region));
    assert.ok(child.servedClaims.some((c) => c.subject.path === "widgetizer.js"));
  });

  it("Phase F surfaces factual overlap to a second recorded spawn under the same parent", () => {
    const env = { SEXTANT_CAPSULE: "1", SEXTANT_COHERENCE: "1" };
    const first = taskInput("Find where widgetize is defined.");
    first.session_id = "overlap-parent";
    first.tool_use_id = "tool-a";
    assert.equal(runHook(root, first, env).status, 0);

    const second = taskInput("Explain the widgetize implementation and its callers.");
    second.session_id = "overlap-parent";
    second.tool_use_id = "tool-b";
    const res = runHook(root, second, env);
    assert.equal(res.status, 0);
    const out = JSON.parse(res.stdout);
    const appended = out.hookSpecificOutput.updatedInput.prompt.slice(second.tool_input.prompt.length);
    assert.match(appended, /<sextant-agent-coherence>/);
    assert.match(appended, /Recorded worksets share files/);
    assert.match(appended, /widgetizer\.js/);
    assert.doesNotMatch(appended, /\b(active|conflict|locks?|ownership)\b/i);
    assert.ok(Buffer.byteLength(appended.trim(), "utf8") <= ORIENT_MAX_BYTES);
  });

  it("records eligible findings when the child byte budget cannot deliver one", () => {
    const env = { SEXTANT_CAPSULE: "1", SEXTANT_COHERENCE: "1" };
    const first = taskInput("Find where widgetize is defined.");
    first.session_id = "budget-parent";
    first.tool_use_id = "tool-budget-a";
    assert.equal(runHook(root, first, env).status, 0);

    const preloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-pretask-budget-"));
    const preload = path.join(preloadDir, "fill-orientation-budget.js");
    const orientPath = path.resolve(__dirname, "..", "lib", "orient.js");
    fs.writeFileSync(
      preload,
      [
        `const orient = require(${JSON.stringify(orientPath)});`,
        `const original = orient.buildOrientationBlock;`,
        `orient.buildOrientationBlock = async (...args) => {`,
        `  const built = await original(...args);`,
        `  if (!built) return built;`,
        `  const open = "<codebase-intelligence>\\n";`,
        `  const close = "\\n</codebase-intelligence>";`,
        `  const fill = "x".repeat(orient.ORIENT_MAX_BYTES - Buffer.byteLength(open + close));`,
        `  const block = open + fill + close;`,
        `  return { ...built, block, bytes: Buffer.byteLength(block) };`,
        `};`,
      ].join("\n")
    );
    const second = taskInput("Explain widgetize and its callers.");
    second.session_id = first.session_id;
    second.tool_use_id = "tool-budget-b";
    const before = readTelemetry(root);
    const eligibleBefore = before.filter((event) => event.name === "coherence.report_eligible").length;
    const deliveredBefore = before.filter((event) => event.name === "coherence.delta_delivered").length;
    try {
      const res = runHook(root, second, { ...env, NODE_OPTIONS: `--require=${preload}` });
      assert.equal(res.status, 0);
      const out = JSON.parse(res.stdout);
      assert.doesNotMatch(out.hookSpecificOutput.updatedInput.prompt, /<sextant-agent-coherence>/);
      const afterEvents = readTelemetry(root);
      assert.equal(
        afterEvents.filter((event) => event.name === "coherence.report_eligible").length,
        eligibleBefore + 1
      );
      assert.equal(
        afterEvents.filter((event) => event.name === "coherence.delta_delivered").length,
        deliveredBefore,
        "a header-only render is not a delivered finding"
      );
    } finally {
      fs.rmSync(preloadDir, { recursive: true, force: true });
    }
  });

  it("treats a changed complete rewrite as ambiguous reuse of the same spawn id", () => {
    const env = { SEXTANT_CAPSULE: "1", SEXTANT_COHERENCE: "1" };
    const sessionId = "retry-payload-parent";
    const original = taskInput("Find where widgetize is defined.");
    original.session_id = sessionId;
    original.tool_use_id = "tool-retry";
    assert.equal(runHook(root, original, env).status, 0);

    const peer = taskInput("Find where widgetize is defined.");
    peer.session_id = sessionId;
    peer.tool_use_id = "tool-peer";
    assert.equal(runHook(root, peer, env).status, 0);

    const retried = runHook(root, original, env);
    assert.equal(retried.status, 0);
    const out = JSON.parse(retried.stdout);
    const appended = out.hookSpecificOutput.updatedInput.prompt.slice(original.tool_input.prompt.length);
    assert.match(appended, /<codebase-intelligence>/, "Lane A remains available");
    assert.doesNotMatch(
      appended,
      /<sextant-agent-coherence>/,
      "a changed Phase-F payload must not be published under a reused identity"
    );
    assert.ok(readTelemetry(root).some(
      (event) => event.name === "coherence.skipped" && event.reason === "spawn_id_reused"
    ));
    const C = require("../lib/coherence");
    const childKey = C.childAgentKey(C.parentAgentKey(sessionId), "tool-retry");
    assert.equal(C.readAgentSnapshot(root, childKey).state, "identity_ambiguous");
    assert.equal(
      C.listSnapshots(root).some((entry) => entry.agentKey === childKey),
      false,
      "an ambiguity tombstone must suppress the older spawn from reports"
    );

    const returnedBefore = readTelemetry(root).filter(
      (event) => event.name === "coherence.agent_returned"
    ).length;
    const post = spawnSync(process.execPath, [BIN, "hook", "posttooluse"], {
      cwd: root,
      encoding: "utf8",
      env: { ...hermeticEnv(), ...env },
      input: JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Agent",
        tool_use_id: "tool-retry",
        tool_input: original.tool_input,
        session_id: sessionId,
      }),
      timeout: 30000,
    });
    assert.equal(post.status, 0);
    assert.equal(
      readTelemetry(root).filter((event) => event.name === "coherence.agent_returned").length,
      returnedBefore,
      "a reused identity must never mark the old spawn returned"
    );
    assert.ok(readTelemetry(root).some(
      (event) => event.name === "coherence.skipped" && event.reason === "spawn_identity_ambiguous"
    ));
  });

  it("treats changed non-prompt tool input as reuse of a different spawn payload", () => {
    const env = { SEXTANT_CAPSULE: "1", SEXTANT_COHERENCE: "1" };
    const sessionId = "retry-nonprompt-parent";
    const first = taskInput("Find where widgetize is defined.");
    first.session_id = sessionId;
    first.tool_use_id = "tool-nonprompt-retry";
    first.tool_input.subagent_type = "Explore";
    assert.equal(runHook(root, first, env).status, 0);

    const changed = taskInput("Find where widgetize is defined.");
    changed.session_id = sessionId;
    changed.tool_use_id = first.tool_use_id;
    changed.tool_input.subagent_type = "general-purpose";
    changed.tool_input.description = "same prompt, different agent envelope";
    const retried = runHook(root, changed, env);
    assert.equal(retried.status, 0);
    const out = JSON.parse(retried.stdout);
    const appended = out.hookSpecificOutput.updatedInput.prompt.slice(changed.tool_input.prompt.length);
    assert.match(appended, /<codebase-intelligence>/);
    assert.doesNotMatch(appended, /<sextant-agent-coherence>/);

    const C = require("../lib/coherence");
    const childKey = C.childAgentKey(C.parentAgentKey(sessionId), first.tool_use_id);
    assert.equal(C.readAgentSnapshot(root, childKey).state, "identity_ambiguous");
  });

  it("Phase F never guesses a child id when tool_use_id is absent", () => {
    const before = fs.readdirSync(path.join(root, ".planning", "intel"))
      .filter((n) => n.startsWith(".agent-capsule.")).length;
    const payload = taskInput("Find where helper is defined.");
    payload.session_id = "missing-id-parent";
    const res = runHook(root, payload, {
      SEXTANT_CAPSULE: "1",
      SEXTANT_COHERENCE: "1",
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /<codebase-intelligence>/, "existing Lane A remains available");
    const after = fs.readdirSync(path.join(root, ".planning", "intel"))
      .filter((n) => n.startsWith(".agent-capsule.")).length;
    assert.equal(after, before, "no prompt-hash/random child identity may be invented");
    assert.ok(readTelemetry(root).some((e) => e.name === "coherence.skipped" && e.reason === "no_spawn_id"));
  });

  it("withholds Lane A when the repo moves after freshness validation", () => {
    const target = path.join(root, "helper.js");
    const originalContent = fs.readFileSync(target, "utf8");
    const preloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-pretask-toctou-"));
    const preload = path.join(preloadDir, "move-after-freshness.js");
    const freshnessPath = path.resolve(__dirname, "..", "lib", "freshness.js");
    fs.writeFileSync(
      preload,
      [
        `const fs = require("fs");`,
        `const freshness = require(${JSON.stringify(freshnessPath)});`,
        `const original = freshness.checkFreshness;`,
        `let moved = false;`,
        `freshness.checkFreshness = async (...args) => {`,
        `  const result = await original(...args);`,
        `  if (!moved) {`,
        `    moved = true;`,
        `    fs.writeFileSync(process.env.SEXTANT_TOC_MOVE_FILE, "module.exports = () => 99;\\n");`,
        `  }`,
        `  return result;`,
        `};`,
      ].join("\n")
    );

    const injectedBefore = readTelemetry(root).filter((e) => e.name === "pretask.injected").length;
    try {
      const res = runHook(root, taskInput("Find where widgetize is defined."), {
        NODE_OPTIONS: `--require=${preload}`,
        SEXTANT_TOC_MOVE_FILE: target,
      });
      assert.equal(res.status, 0);
      assert.equal(
        res.stdout,
        "",
        "a post-validation edit must withhold the entire Lane-A rewrite"
      );
      assert.equal(
        readTelemetry(root).filter((e) => e.name === "pretask.injected").length,
        injectedBefore,
        "withheld orientation must not be recorded as injected"
      );
      assert.ok(
        readTelemetry(root).some(
          (e) => e.name === "pretask.skipped" && e.reason === "fingerprint_moved"
        )
      );
    } finally {
      fs.writeFileSync(target, originalContent);
      fs.rmSync(preloadDir, { recursive: true, force: true });
      execSync(`node ${BIN} scan --root ${root} --force`, {
        stdio: "ignore",
        env: hermeticEnv(),
      });
    }
  });

  it("terminally withholds a registered spawn when the repo moves before stdout", () => {
    const target = path.join(root, "helper.js");
    const originalContent = fs.readFileSync(target, "utf8");
    const preloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-pretask-postreg-"));
    const preload = path.join(preloadDir, "move-after-register.js");
    const coherencePath = path.resolve(__dirname, "..", "lib", "coherence.js");
    fs.writeFileSync(
      preload,
      [
        `const fs = require("fs");`,
        `const coherence = require(${JSON.stringify(coherencePath)});`,
        `const original = coherence.registerSpawnSnapshot;`,
        `let moved = false;`,
        `coherence.registerSpawnSnapshot = (...args) => {`,
        `  const result = original(...args);`,
        `  if (!moved && result.status === "written") {`,
        `    moved = true;`,
        `    fs.writeFileSync(process.env.SEXTANT_TOC_MOVE_FILE, "module.exports = () => 101;\\n");`,
        `  }`,
        `  return result;`,
        `};`,
      ].join("\n")
    );
    const payload = taskInput("Find where widgetize is defined.");
    payload.session_id = "post-registration-fence";
    payload.tool_use_id = "tool-post-register";
    const env = {
      NODE_OPTIONS: `--require=${preload}`,
      SEXTANT_TOC_MOVE_FILE: target,
      SEXTANT_CAPSULE: "1",
      SEXTANT_COHERENCE: "1",
    };
    try {
      const res = runHook(root, payload, env);
      assert.equal(res.status, 0);
      assert.equal(res.stdout, "");
      const C = require("../lib/coherence");
      const childKey = C.childAgentKey(C.parentAgentKey(payload.session_id), payload.tool_use_id);
      assert.equal(C.readAgentSnapshot(root, childKey).state, "spawn_withheld");
      assert.ok(!C.listSnapshots(root).some((entry) => entry.agentKey === childKey));

      const returnedBefore = readTelemetry(root).filter(
        (event) => event.name === "coherence.agent_returned"
      ).length;
      const post = spawnSync(process.execPath, [BIN, "hook", "posttooluse"], {
        cwd: root,
        encoding: "utf8",
        env: { ...hermeticEnv(), SEXTANT_CAPSULE: "1", SEXTANT_COHERENCE: "1" },
        input: JSON.stringify({
          hook_event_name: "PostToolUse",
          tool_name: "Agent",
          tool_use_id: payload.tool_use_id,
          tool_input: payload.tool_input,
          session_id: payload.session_id,
        }),
        timeout: 30000,
      });
      assert.equal(post.status, 0);
      assert.equal(post.stdout, "");
      assert.equal(
        readTelemetry(root).filter((event) => event.name === "coherence.agent_returned").length,
        returnedBefore
      );
      assert.ok(readTelemetry(root).some(
        (event) => event.name === "coherence.skipped" && event.reason === "spawn_preparation_withheld"
      ));
    } finally {
      fs.writeFileSync(target, originalContent);
      fs.rmSync(preloadDir, { recursive: true, force: true });
      execSync(`node ${BIN} scan --root ${root} --force`, {
        stdio: "ignore",
        env: hermeticEnv(),
      });
    }
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

  it("counts orientation-unavailable Phase-F spawns in the lifecycle denominator", () => {
    fs.writeFileSync(path.join(root, "unscanned.js"), "module.exports = 2;\n");
    execSync("git add -A && git commit -qm stale-for-phase-f-denominator", { cwd: root });
    try {
      const payload = {
        ...taskInput("Find where widgetize is defined."),
        session_id: "phase-f-no-block-session",
        tool_use_id: "toolu_phase_f_no_block",
      };
      const res = runHook(root, payload, {
        SEXTANT_CAPSULE: "1",
        SEXTANT_COHERENCE: "1",
      });
      assert.equal(res.status, 0);
      assert.equal(res.stdout, "");
      const row = readTelemetry(root).find(
        (event) => event.name === "coherence.lifecycle" &&
          event.stage === "child_spawn" &&
          event.reason === "orientation_unavailable"
      );
      assert.ok(row, "upstream orientation absence must remain in the spawn denominator");
      assert.equal(row.outcome, "withheld");
      assert.equal(row.state, "orientation_unavailable");
      assert.match(row.taskKey, /^ctask_[a-f0-9]{24}$/);
    } finally {
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
    const current = require("../lib/capsule").repoFingerprint(root);
    assert.deepEqual(
      {
        head: built.validatedRepo.head,
        statusHash: built.validatedRepo.statusHash,
      },
      { head: current.head, statusHash: current.statusHash },
      "orientation must carry the scan-state anchors freshness validated"
    );
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
