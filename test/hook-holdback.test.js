"use strict";

// Tests for the injection-OFF HOLDBACK ARM (009 #1 follow-up) — the per-turn A/B
// that turns open-precision from a correlation into a causal benefit number.
//
// Locks:
//   - decideArm: default-off (armed), force flag, pct=100, content-stale → armed
//   - holdback turn: NO <codebase-retrieval> block, BUT the injected-set is
//     persisted tagged arm:"holdback", a retrieval.holdback event fires, and the
//     static summary is shown instead (orientation preserved)
//   - armed turn: the block IS emitted and the injected-set is tagged arm:"armed"
//   - PostToolUse stamps the arm on path_hit/path_miss; legacy sets default armed
//   - telemetry splits open-precision by arm and computes benefitDelta

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync, execSync } = require("child_process");

const graph = require("../lib/graph");
const freshness = require("../lib/freshness");
const telemetry = require("../lib/telemetry");
const { decideArm } = require("../commands/hook-refresh");
const { readInjectedArm } = require("../commands/hook-posttooluse");
const { summarize } = require("../commands/telemetry");

const BIN = path.resolve(__dirname, "..", "bin", "intel.js");

// ─── decideArm (pure) ──────────────────────────────────────────────────────

describe("decideArm — default-off, force, pct, stale interaction", () => {
  it("defaults to armed when no env (a normal install is never degraded)", () => {
    assert.equal(decideArm({}, false, {}), "armed");
  });
  it("honors SEXTANT_HOLDBACK_FORCE for deterministic tests", () => {
    assert.equal(decideArm({}, false, { SEXTANT_HOLDBACK_FORCE: "holdback" }), "holdback");
    assert.equal(decideArm({}, false, { SEXTANT_HOLDBACK_FORCE: "armed" }), "armed");
  });
  it("honors a stdin payload _holdbackForce field", () => {
    assert.equal(decideArm({ _holdbackForce: "holdback" }, false, {}), "holdback");
  });
  it("holds back at pct=100, never at pct=0", () => {
    assert.equal(decideArm({}, false, { SEXTANT_HOLDBACK_PCT: "100" }), "holdback");
    assert.equal(decideArm({}, false, { SEXTANT_HOLDBACK_PCT: "0" }), "armed");
  });
  it("forces armed on a content-stale turn regardless of pct/force", () => {
    // Holdback governs the graph-authority contribution, already suppressed when
    // stale — withholding there would conflate "we withheld" with "index stale."
    assert.equal(decideArm({}, true, { SEXTANT_HOLDBACK_PCT: "100" }), "armed");
    assert.equal(decideArm({}, true, { SEXTANT_HOLDBACK_FORCE: "holdback" }), "armed");
  });
});

// ─── readInjectedArm (pure) ─────────────────────────────────────────────────

describe("readInjectedArm — arm tag with legacy default", () => {
  it("reads the arm field", () => {
    assert.equal(readInjectedArm({ arm: "holdback", paths: [] }), "holdback");
    assert.equal(readInjectedArm({ arm: "armed", paths: [] }), "armed");
  });
  it("defaults legacy sets (no arm field) to armed", () => {
    assert.equal(readInjectedArm({ paths: [] }), "armed");
    assert.equal(readInjectedArm(null), "armed");
  });
});

// ─── telemetry: per-arm open-precision + benefitDelta ───────────────────────

describe("telemetry — open-precision split by arm + benefitDelta", () => {
  it("computes armed/holdback precision and the causal delta", () => {
    const ev = (name, extra) => ({ name, ...extra });
    const events = [
      // armed: 3 hits, 1 miss → 75%
      ev("retrieval.path_hit", { source: "exported_symbol", arm: "armed" }),
      ev("retrieval.path_hit", { source: "path_match", arm: "armed" }),
      ev("retrieval.path_hit", { source: "text_only", arm: "armed" }),
      ev("retrieval.path_miss", { arm: "armed" }),
      // holdback: 1 hit, 3 misses → 25%
      ev("retrieval.path_hit", { source: "exported_symbol", arm: "holdback" }),
      ev("retrieval.path_miss", { arm: "holdback" }),
      ev("retrieval.path_miss", { arm: "holdback" }),
      ev("retrieval.path_miss", { arm: "holdback" }),
    ];
    const s = summarize(events);
    assert.equal(s.retrieval.openPrecisionByArm.armed, 0.75);
    assert.equal(s.retrieval.openPrecisionByArm.holdback, 0.25);
    // benefit = armed − holdback = 0.50
    assert.equal(s.retrieval.benefitDelta, 0.5);
    // raw per-arm counts (the volume gate the holdback-benefit cron reads)
    assert.deepEqual(s.retrieval.armCounts.armed, { hits: 3, misses: 1, scored: 4 });
    assert.deepEqual(s.retrieval.armCounts.holdback, { hits: 1, misses: 3, scored: 4 });
  });
  it("benefitDelta is null with no holdback arm (default install)", () => {
    const events = [
      { name: "retrieval.path_hit", source: "path_match", arm: "armed" },
      { name: "retrieval.path_miss", arm: "armed" },
    ];
    const s = summarize(events);
    assert.equal(s.retrieval.benefitDelta, null);
    assert.equal(s.retrieval.openPrecisionByArm.armed, 0.5);
  });
  it("legacy path events with no arm count as armed", () => {
    const events = [
      { name: "retrieval.path_hit", source: "path_match" }, // no arm
      { name: "retrieval.path_miss" },
    ];
    const s = summarize(events);
    assert.equal(s.retrieval.openPrecisionByArm.armed, 0.5);
    assert.equal(s.retrieval.benefitDelta, null);
  });
});

// ─── integration: the hook actually withholds on a holdback turn ────────────

function gitInit(dir) {
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  execSync("git config commit.gpgsign false", { cwd: dir });
}

function installSextantShim() {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-shim-hb-"));
  fs.writeFileSync(path.join(shimDir, "sextant"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(shimDir, "sextant"), 0o755);
  const prev = process.env.PATH;
  process.env.PATH = shimDir + path.delimiter + prev;
  return () => { process.env.PATH = prev; try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch {} };
}

async function buildFixture(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sextant-hb-${prefix}-`));
  fs.mkdirSync(path.join(dir, ".planning", "intel"), { recursive: true });
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  gitInit(dir);
  fs.writeFileSync(path.join(dir, "lib", "resolveImportPath.js"),
    "function resolveImportPath(spec) { return spec; }\nmodule.exports = { resolveImportPath };\n");
  execSync("git add -A", { cwd: dir });
  execSync('git commit -q -m "x"', { cwd: dir });
  const db = await graph.loadDb(dir);
  graph.upsertFile(db, { relPath: "lib/resolveImportPath.js", type: "js", sizeBytes: 500, mtimeMs: 1 });
  graph.replaceExports(db, "lib/resolveImportPath.js", [{ name: "resolveImportPath", kind: "named" }]);
  freshness.recordScanState(db, dir);
  await graph.persistDb(dir);
  // Minimal static summary so the holdback fallback has something to show.
  fs.writeFileSync(path.join(dir, ".planning", "intel", "summary.md"), "## Codebase intelligence\n- test\n");
  return dir;
}

function runHook(dir, prompt, armForce, sessionId = "hb-test") {
  const res = spawnSync(process.execPath, [BIN, "hook", "refresh"], {
    cwd: dir,
    input: JSON.stringify({ prompt, session_id: sessionId }),
    encoding: "utf8",
    timeout: 20000,
    env: { ...process.env, SEXTANT_HOLDBACK_FORCE: armForce },
  });
  const injPath = path.join(dir, ".planning", "intel", `.last_injected_paths.retrieval.${sessionId}`);
  let injected = null;
  try { injected = JSON.parse(fs.readFileSync(injPath, "utf8")); } catch {}
  return {
    stdout: res.stdout || "",
    injected,
    events: telemetry.readEvents(dir).filter((e) => String(e.name || "").startsWith("retrieval.")),
  };
}

describe("hook-refresh HOLDBACK arm — withholds the block, keeps the counterfactual", () => {
  // Each turn gets its OWN fixture so the repo-level telemetry.jsonl isolates the
  // events that turn produced (an armed turn in a shared repo would leak its
  // retrieval.injected into the holdback turn's event read).
  let restoreShim;
  before(() => { restoreShim = installSextantShim(); });
  after(() => { if (restoreShim) restoreShim(); });

  it("ARMED: emits the <codebase-retrieval> block and tags the set arm:armed", async () => {
    const dir = await buildFixture("armed");
    try {
      const { stdout, injected, events } = runHook(dir, "where is resolveImportPath defined", "armed", "hb-armed");
      assert.ok(stdout.includes("<codebase-retrieval>"), `armed turn must emit the block, got:\n${stdout}`);
      assert.ok(injected && injected.arm === "armed", `set must be tagged armed, got ${JSON.stringify(injected)}`);
      assert.ok(injected.paths.length >= 1, "armed set must carry surfaced paths");
      assert.ok(events.some((e) => e.name === "retrieval.injected"), "armed turn records retrieval.injected");
      assert.ok(!events.some((e) => e.name === "retrieval.holdback"), "armed turn does not record holdback");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("HOLDBACK: suppresses the block but persists the set tagged arm:holdback + fires retrieval.holdback", async () => {
    const dir = await buildFixture("hold");
    try {
      const { stdout, injected, events } = runHook(dir, "where is resolveImportPath defined", "holdback", "hb-hold");
      assert.ok(!stdout.includes("<codebase-retrieval>"),
        `holdback turn must NOT emit the retrieval block, got:\n${stdout}`);
      // orientation preserved: the static summary is shown instead
      assert.ok(stdout.includes("<codebase-intelligence>"),
        `holdback turn must fall back to the static summary, got:\n${stdout}`);
      assert.ok(injected && injected.arm === "holdback",
        `set must be tagged holdback, got ${JSON.stringify(injected)}`);
      assert.ok(injected.paths.length >= 1,
        "holdback set must still carry the paths we WOULD have surfaced (the counterfactual)");
      assert.ok(events.some((e) => e.name === "retrieval.holdback"),
        "holdback turn must record a retrieval.holdback event");
      assert.ok(!events.some((e) => e.name === "retrieval.injected"),
        "holdback turn must NOT record retrieval.injected (nothing was injected)");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
