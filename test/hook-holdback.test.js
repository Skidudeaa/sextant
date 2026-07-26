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
const { summarize, printSummary } = require("../commands/telemetry");

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
  it("treats out-of-range or malformed pct as default-off (armed)", () => {
    // A typo'd pct=150 must NOT silently lock the install into 100% holdback.
    assert.equal(decideArm({}, false, { SEXTANT_HOLDBACK_PCT: "150" }), "armed");
    assert.equal(decideArm({}, false, { SEXTANT_HOLDBACK_PCT: "101" }), "armed");
    assert.equal(decideArm({}, false, { SEXTANT_HOLDBACK_PCT: "-5" }), "armed");
    assert.equal(decideArm({}, false, { SEXTANT_HOLDBACK_PCT: "abc" }), "armed");
    // Boundary stays valid: 100 = deliberate always-holdback (test usage).
    assert.equal(decideArm({}, false, { SEXTANT_HOLDBACK_PCT: "100" }), "holdback");
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
  it("arm key order is deterministic (sorted) even when holdback events come first", () => {
    // Map/Set iteration is insertion-ordered — without sorting, a window whose
    // first scored open happens to be a holdback turn would flip the --json key
    // order run-to-run.
    const events = [
      { name: "retrieval.path_hit", source: "path_match", arm: "holdback" },
      { name: "retrieval.path_miss", arm: "armed" },
    ];
    const s = summarize(events);
    assert.deepEqual(Object.keys(s.retrieval.armCounts), ["armed", "holdback"]);
    assert.deepEqual(Object.keys(s.retrieval.openPrecisionByArm), ["armed", "holdback"]);
  });
  it("printSummary gates the causal BENEFIT DELTA claim on >=30 scored per arm", () => {
    // benefitDelta computes from the first scored open per arm, but rendering an
    // n=1 precision as "the causal lift" misleads (73 days at 20%-on-one-repo
    // accrued exactly 1 holdback turn). JSON keeps the raw value; the summary
    // must print DORMANT with the raw counts until both arms reach volume.
    const ev = (name, arm, turn) => ({ ts: 1752000000000, name, source: "path_match", arm, turn });
    const lowN = [
      ...Array.from({ length: 40 }, (_, i) => ev("retrieval.path_hit", "armed", i + 1)),
      ev("retrieval.path_miss", "holdback", 500),
    ];
    const low = printSummary("/x", summarize(lowN));
    assert.match(low, /benefit delta: DORMANT \(accruing\) — holdback n=1, armed n=40 scored/);
    assert.doesNotMatch(low, /BENEFIT DELTA/);
    assert.doesNotMatch(low, /counterfactual present/);

    // docs/033 Tier 3: opens alone are NOT enough. `decideArm` randomizes once
    // per TURN, and at ~28 opens/turn an opens-only floor of 30 clears after a
    // single randomized turn per arm — so the surface could print a DORMANT
    // turn line and an ALL-CAPS causal per-open claim two lines apart. 30 opens
    // per arm concentrated in ONE turn per arm must stay DORMANT.
    const opensButOneTurn = [
      ...Array.from({ length: 30 }, () => ev("retrieval.path_hit", "armed", 1)),
      ...Array.from({ length: 30 }, () => ev("retrieval.path_miss", "holdback", 2)),
    ];
    const correlated = printSummary("/x", summarize(opensButOneTurn));
    assert.doesNotMatch(correlated, /BENEFIT DELTA \(armed − holdback\)/);
    assert.match(correlated, /turns are the randomization unit/);

    // At volume on BOTH floors (>=30 opens and >=30 turns per arm) it renders.
    const atVolume = [
      ...Array.from({ length: 30 }, (_, i) => ev("retrieval.path_hit", "armed", i + 1)),
      ...Array.from({ length: 30 }, (_, i) => ev("retrieval.path_miss", "holdback", 100 + i)),
    ];
    const ok = printSummary("/x", summarize(atVolume));
    assert.match(ok, /BENEFIT DELTA \(armed − holdback\): 100\.0 pts/);
    assert.doesNotMatch(ok, /DORMANT/);
    // per-arm rows carry the sample size either way
    assert.match(ok, /armed {6}open-precision 100\.0% {2}\(n=30 scored\)/);
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
  const rawSummary = "## Codebase intelligence\n- test\n";
  fs.writeFileSync(path.join(dir, ".planning", "intel", "summary.md"), rawSummary);
  assert.equal(
    await require("../lib/summary-binding").writeManifest(dir, rawSummary, { db, graph }),
    true
  );
  return dir;
}

function runHook(dir, prompt, armForce, sessionId = "hb-test") {
  const res = spawnSync(process.execPath, [BIN, "hook", "refresh"], {
    cwd: dir,
    input: JSON.stringify({ prompt, session_id: sessionId }),
    encoding: "utf8",
    timeout: 20000,
    env: {
      ...process.env,
      SEXTANT_HOLDBACK_FORCE: armForce,
      // Exercise the Claim Ledger publication boundary too: only a block the
      // parent actually saw may become a served-claims capsule.
      SEXTANT_CAPSULE: "1",
      SEXTANT_COHERENCE: "1",
      SEXTANT_SYNC_RESCAN: "0",
    },
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
      assert.ok(
        fs.existsSync(path.join(dir, ".planning", "intel", ".capsule.hb-armed")),
        "armed block publishes its served-claims capsule"
      );
      assert.ok(
        fs.readdirSync(path.join(dir, ".planning", "intel"))
          .some((n) => n.startsWith(".agent-capsule.parent_")),
        "armed block publishes an immutable parent serve snapshot"
      );
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
      assert.ok(
        !fs.existsSync(path.join(dir, ".planning", "intel", ".capsule.hb-hold")),
        "holdback must not record unseen rows as served claims"
      );
      assert.ok(
        !fs.readdirSync(path.join(dir, ".planning", "intel"))
          .some((n) => n.startsWith(".agent-capsule.")),
        "holdback must not publish an unseen parent serve snapshot"
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("delivers a child-claim invalidation on a conversational/static-summary prompt", async () => {
    const dir = await buildFixture("coherence-static");
    const sessionId = "coh-static";
    try {
      const armed = runHook(
        dir,
        "where is resolveImportPath defined",
        "armed",
        sessionId
      );
      assert.match(armed.stdout, /<codebase-retrieval>/);
      const cap = JSON.parse(fs.readFileSync(
        path.join(dir, ".planning", "intel", `.capsule.${sessionId}`),
        "utf8"
      ));
      const C = require("../lib/coherence");
      const claims = require("../lib/claims");
      const parentKey = C.parentAgentKey(sessionId);
      const childKey = C.childAgentKey(parentKey, "tool-child");
      const rel = "lib/resolveImportPath.js";
      const childClaims = claims.mintClaims(dir, [{
        path: rel,
        source: "exported_symbol",
        symbol: "resolveImportPath",
        line: 1,
      }]);
      assert.ok(C.writeSnapshot(dir, C.buildSnapshot({
        taskId: cap.taskId,
        agentKey: childKey,
        parentAgentKey: parentKey,
        spawnToolUseId: "tool-child",
        kind: "child",
        state: "spawn_prepared",
        createdAt: Date.now(),
        repo: cap.repo,
        intent: { text: "inspect child" },
        workset: { primary: [{ path: rel }], support: [], witnesses: [], hazards: [], unknowns: [] },
        servedClaims: childClaims,
        blockHash: "child",
      })));
      fs.writeFileSync(
        path.join(dir, rel),
        "function renamedImportPath(spec) { return spec; }\nmodule.exports = { renamedImportPath };\n"
      );

      const conversational = runHook(dir, "thanks", "armed", sessionId);
      assert.match(conversational.stdout, /<sextant-context-delta>/);
      assert.match(conversational.stdout, /<sextant-agent-coherence>/);
      assert.match(conversational.stdout, /Claim prepared for recorded spawn no longer holds for child_/);
      assert.doesNotMatch(conversational.stdout, /Claim served no longer holds for child_/);
      assert.match(conversational.stdout, /<codebase-intelligence>/);
      const events = telemetry.readEvents(dir);
      assert.ok(events.some((e) => e.name === "contextdelta.emitted" && e.invalidated >= 1));
      assert.ok(events.some((e) => e.name === "coherence.report_eligible"));
      assert.ok(events.some((e) => e.name === "coherence.delta_delivered"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records an eligible parent-prompt report even when no whole finding fits", async () => {
    const dir = await buildFixture("coherence-budget");
    const sessionId = "coh-budget";
    try {
      const armed = runHook(
        dir,
        "where is resolveImportPath defined",
        "armed",
        sessionId
      );
      assert.match(armed.stdout, /<codebase-retrieval>/);
      const cap = JSON.parse(fs.readFileSync(
        path.join(dir, ".planning", "intel", `.capsule.${sessionId}`),
        "utf8"
      ));
      const C = require("../lib/coherence");
      const parentKey = C.parentAgentKey(sessionId);
      const shared = Array.from(
        { length: 5 },
        (_, i) => `long/${i}-${"x".repeat(220)}.js`
      );
      const workset = {
        primary: shared.map((p) => ({ path: p })),
        support: [], witnesses: [], hazards: [], unknowns: [],
      };
      for (const toolId of ["budget-a", "budget-b"]) {
        assert.ok(C.writeSnapshot(dir, C.buildSnapshot({
          taskId: cap.taskId,
          agentKey: C.childAgentKey(parentKey, toolId),
          parentAgentKey: parentKey,
          spawnToolUseId: toolId,
          kind: "child",
          state: "spawn_prepared",
          createdAt: Date.now(),
          repo: cap.repo,
          intent: { text: toolId },
          workset,
          servedClaims: [],
          blockHash: toolId,
        })));
      }

      const before = telemetry.readEvents(dir);
      const conversational = runHook(dir, "thanks", "armed", sessionId);
      const added = telemetry.readEvents(dir).slice(before.length);
      assert.doesNotMatch(conversational.stdout, /<sextant-agent-coherence>/);
      assert.equal(
        added.filter((e) => e.name === "coherence.report_eligible" && e.surface === "parent_prompt").length,
        1,
        "render budget must not erase the eligible denominator"
      );
      assert.equal(
        added.filter((e) => e.name === "coherence.delta_delivered" && e.surface === "parent_prompt").length,
        0,
        "a header-only/empty report was not delivered"
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
