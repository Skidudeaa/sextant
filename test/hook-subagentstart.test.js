"use strict";

// Default Lane-A SubagentStart delivery. These tests cross the real CLI
// process boundary so they cover dispatch, strict root adoption, coherence
// gating, freshness, the final publication fence, and telemetry together.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const telemetry = require("../lib/telemetry");

const BIN = path.resolve(__dirname, "..", "bin", "intel.js");

function hookEnv(extra = {}) {
  return {
    ...process.env,
    SEXTANT_CAPSULE: "0",
    SEXTANT_COHERENCE: "0",
    SEXTANT_HOLDBACK_PCT: "0",
    SEXTANT_HOLDBACK_FORCE: "",
    SEXTANT_SYNC_RESCAN: "0",
    ...extra,
  };
}

function gitInit(root) {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
}

function buildFreshRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-subagentstart-"));
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "lib", "widget.js"),
    "module.exports.widget = () => 42;\n"
  );
  gitInit(root);
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: root });

  const scan = spawnSync(
    process.execPath,
    [BIN, "scan", "--root", root, "--force"],
    { encoding: "utf8", env: hookEnv(), timeout: 30_000 }
  );
  assert.equal(scan.status, 0, scan.stderr || scan.stdout || "scan failed");
  return root;
}

function payload(extra = {}) {
  return {
    hook_event_name: "SubagentStart",
    session_id: "subagentstart-test-session",
    agent_id: "agent-test-1",
    agent_type: "general-purpose",
    ...extra,
  };
}

function runHook(root, input = payload(), extraEnv = {}) {
  return spawnSync(process.execPath, [BIN, "hook", "subagentstart"], {
    cwd: root,
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env: hookEnv(extraEnv),
    timeout: 30_000,
  });
}

function events(root) {
  return telemetry
    .readEvents(root)
    .filter((event) => String(event.name || "").startsWith("subagentstart."));
}

describe("hook subagentstart — composable default Lane A", () => {
  let root;

  before(() => {
    root = buildFreshRepo();
  });

  after(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("emits a freshness-gated repo-generic block through additionalContext", () => {
    const res = runHook(root);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(res.stdout, "expected a SubagentStart response");

    const out = JSON.parse(res.stdout);
    assert.deepEqual(Object.keys(out), ["hookSpecificOutput"]);
    assert.equal(out.hookSpecificOutput.hookEventName, "SubagentStart");
    const block = out.hookSpecificOutput.additionalContext;
    assert.match(block, /^<codebase-intelligence>/);
    assert.match(block, /Repo: /);
    assert.match(block, /Index: 1 files/);
    assert.doesNotMatch(
      block,
      /Files matching this task's terms/,
      "SubagentStart has no task prompt and must not invent one"
    );

    const injected = events(root).filter((event) => event.name === "subagentstart.injected");
    assert.ok(injected.length >= 1);
    const last = injected[injected.length - 1];
    assert.equal(last.agentType, "general-purpose");
    assert.equal(last.bytes, Buffer.byteLength(block, "utf8"));
    assert.ok(Number.isFinite(last.durationMs));
  });

  it("is silent under the explicit Phase-F coherence gate", () => {
    const res = runHook(root, payload(), {
      SEXTANT_CAPSULE: "1",
      SEXTANT_COHERENCE: "1",
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, "");

    const skipped = events(root).filter((event) =>
      event.name === "subagentstart.skipped" && event.reason === "coherence_enabled"
    );
    assert.ok(skipped.length >= 1, "coherence handoff must be observable out of band");
    assert.equal(skipped[skipped.length - 1].agentType, "general-purpose");
  });

  it("silently rejects malformed lifecycle input", () => {
    const beforeCount = events(root).length;
    const res = runHook(root, { hook_event_name: "SubagentStart", agent_type: "Explore" });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, "");
    assert.equal(events(root).length, beforeCount, "uncertain input must not create telemetry");
  });

  it("withholds output when HEAD/status moves after orientation validation", () => {
    const preloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-subagentstart-fence-"));
    const preload = path.join(preloadDir, "move-at-publication.js");
    const target = path.join(root, "lib", "widget.js");
    const freshnessPath = path.resolve(__dirname, "..", "lib", "freshness.js");
    fs.writeFileSync(
      preload,
      `"use strict";\n` +
        `const fs = require("fs");\n` +
        `const freshness = require(${JSON.stringify(freshnessPath)});\n` +
        `const originalCapture = freshness.captureCurrentState;\n` +
        `freshness.captureCurrentState = function(root) {\n` +
        `  const target = ${JSON.stringify(target)};\n` +
        `  const original = fs.readFileSync(target);\n` +
        `  fs.appendFileSync(target, "// publication race\\n");\n` +
        `  try { return originalCapture(root); } finally { fs.writeFileSync(target, original); }\n` +
        `};\n`
    );

    try {
      const nodeOptions = [process.env.NODE_OPTIONS, "--require", preload]
        .filter(Boolean)
        .join(" ");
      const res = runHook(root, payload(), { NODE_OPTIONS: nodeOptions });
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.stdout, "", "moved facts must not cross stdout");
      const moved = events(root).filter((event) =>
        event.name === "subagentstart.skipped" && event.reason === "fingerprint_moved"
      );
      assert.ok(moved.length >= 1);
      assert.equal(
        execFileSync("git", ["status", "--porcelain", "--", "lib/widget.js"], {
          cwd: root,
          encoding: "utf8",
        }),
        "",
        "the race probe must restore its fixture"
      );
    } finally {
      fs.rmSync(preloadDir, { recursive: true, force: true });
    }
  });

  it("withholds repo facts when the graph is content-stale", () => {
    fs.appendFileSync(path.join(root, "lib", "widget.js"), "// dirty after scan\n");
    const res = runHook(root);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, "");
    const unavailable = events(root).filter((event) =>
      event.name === "subagentstart.skipped" && event.reason === "orientation_unavailable"
    );
    assert.ok(unavailable.length >= 1);
  });
});

describe("hook subagentstart — strict root guard", () => {
  it("refuses a markerless directory without creating Sextant state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-subagentstart-refused-"));
    try {
      const res = runHook(root);
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.stdout, "");
      assert.equal(fs.existsSync(path.join(root, ".planning")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
