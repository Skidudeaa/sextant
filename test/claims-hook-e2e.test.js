"use strict";

// Phase C claim ledger (docs/028) — the edit-then-reprompt loop, at the HOOK
// level, under its own name.
//
// WHY THIS FILE EXISTS (docs/033 Tier 3 item 8). Phase C served claims for 87
// days and emitted ZERO context-deltas in the field, which made "the lane is
// correct and simply had no qualifying event" indistinguishable from "the lane
// cannot fire". Driving the real sequence in a throwaway repo settles it: all
// four delta forms DO emit, with matching `contextdelta.emitted` telemetry. The
// field rate is parked (see docs/033); the MECHANISM is locked here.
//
// The only prior hook-level assertion for this lane lives in
// test/hook-holdback.test.js under a Phase-F title and behind
// SEXTANT_COHERENCE=1. That coupling means a Phase-C regression would look
// exactly like the permanent contextdelta.emitted=0 it already shows. So these
// cases run with capsule ON and coherence OFF — Phase C must hold on its own.
//
// The turn-1 → mutate → turn-2 shape is deliberate: a delta is a RETRACTION of
// a fact previously served, so it needs a real prior served baseline on disk,
// not a hand-seeded capsule. A fixture that pre-seeds servedClaims would pass
// while the minting half rotted.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync, execSync } = require("child_process");

const graph = require("../lib/graph");
const freshness = require("../lib/freshness");
const telemetry = require("../lib/telemetry");

const BIN = path.resolve(__dirname, "..", "bin", "intel.js");

function gitInit(dir) {
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  execSync("git config commit.gpgsign false", { cwd: dir });
}

// The freshness gate spawns a detached background rescan on a stale read; a
// no-op `sextant` on PATH stops the real linked binary from scanning the
// fixture and racing after()'s rmSync (ENOTEMPTY).
function installSextantShim() {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-shim-claims-"));
  fs.writeFileSync(path.join(shimDir, "sextant"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(shimDir, "sextant"), 0o755);
  const prev = process.env.PATH;
  process.env.PATH = shimDir + path.delimiter + prev;
  return () => {
    process.env.PATH = prev;
    try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch {}
  };
}

const SOURCE =
  "function resolveImportPath(spec) {\n" +
  "  return spec;\n" +
  "}\n" +
  "module.exports = { resolveImportPath };\n";

async function buildFixture(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sextant-claims-${prefix}-`));
  fs.mkdirSync(path.join(dir, ".planning", "intel"), { recursive: true });
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  gitInit(dir);
  fs.writeFileSync(path.join(dir, "lib", "resolveImportPath.js"), SOURCE);
  execSync("git add -A", { cwd: dir });
  execSync('git commit -q -m "x"', { cwd: dir });

  const db = await graph.loadDb(dir);
  graph.upsertFile(db, {
    relPath: "lib/resolveImportPath.js",
    type: "js",
    sizeBytes: SOURCE.length,
    mtimeMs: 1,
  });
  graph.replaceExports(db, "lib/resolveImportPath.js", [
    { name: "resolveImportPath", kind: "named" },
  ]);
  freshness.recordScanState(db, dir);
  await graph.persistDb(dir);

  const rawSummary = "## Codebase intelligence\n- test\n";
  fs.writeFileSync(path.join(dir, ".planning", "intel", "summary.md"), rawSummary);
  assert.equal(
    await require("../lib/summary-binding").writeManifest(dir, rawSummary, { db, graph }),
    true
  );
  return dir;
}

const SESSION = "claims-e2e";

function runHook(dir, prompt) {
  const res = spawnSync(process.execPath, [BIN, "hook", "refresh"], {
    cwd: dir,
    input: JSON.stringify({ prompt, session_id: SESSION }),
    encoding: "utf8",
    timeout: 20000,
    env: {
      ...process.env,
      SEXTANT_CAPSULE: "1",
      // Phase C must hold WITHOUT Phase F. Also pin the arm: an ambient
      // SEXTANT_HOLDBACK_PCT from a dogfooding shell would withhold the block
      // at random and never mint a baseline (rotating-case flake).
      SEXTANT_COHERENCE: "0",
      SEXTANT_HOLDBACK_FORCE: "armed",
      SEXTANT_HOLDBACK_PCT: "0",
      SEXTANT_SYNC_RESCAN: "0",
    },
  });
  return {
    stdout: res.stdout || "",
    events: telemetry.readEvents(dir),
  };
}

function capsuleOf(dir) {
  return JSON.parse(
    fs.readFileSync(path.join(dir, ".planning", "intel", `.capsule.${SESSION}`), "utf8")
  );
}

const PROMPT = "where is resolveImportPath defined";

// Mint a served baseline and assert it is a real one. Returns the capsule.
function mintBaseline(dir) {
  const turn1 = runHook(dir, PROMPT);
  assert.ok(
    turn1.stdout.includes("<codebase-retrieval>"),
    `turn 1 must inject a block to mint claims, got:\n${turn1.stdout}`
  );
  const cap = capsuleOf(dir);
  assert.ok(
    Array.isArray(cap.servedClaims) && cap.servedClaims.length > 0,
    "turn 1 must persist a served-claims baseline"
  );
  return cap;
}

// A second prompt must differ from the first, or the retrieval block dedupes
// and the delta rides a path this test does not mean to exercise.
const REPROMPT = "explain the resolveImportPath helper and its callers";

describe("Phase C claim ledger — the edit-then-reprompt loop", () => {
  let restoreShim;
  before(() => { restoreShim = installSextantShim(); });
  after(() => { if (restoreShim) restoreShim(); });

  it("emits a CHANGED delta when a claimed file moves under the served baseline", async () => {
    const dir = await buildFixture("changed");
    try {
      mintBaseline(dir);

      // Push the definition down the file: the bytes change, the symbol lives.
      fs.writeFileSync(
        path.join(dir, "lib", "resolveImportPath.js"),
        "// padding\n".repeat(20) + SOURCE
      );

      const turn2 = runHook(dir, REPROMPT);
      assert.match(
        turn2.stdout,
        /<sextant-context-delta>/,
        "a mutated claimed file must produce a retraction block"
      );
      assert.match(turn2.stdout, /CHANGED/);
      const emitted = turn2.events.filter((e) => e.name === "contextdelta.emitted");
      assert.equal(emitted.length, 1, "the delta must be instrumented");
      assert.ok(emitted[0].changed >= 1, `expected >=1 changed, got ${emitted[0].changed}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits an INVALIDATED delta when the claimed file is removed", async () => {
    const dir = await buildFixture("removed");
    try {
      mintBaseline(dir);
      fs.rmSync(path.join(dir, "lib", "resolveImportPath.js"));

      const turn2 = runHook(dir, REPROMPT);
      assert.match(turn2.stdout, /<sextant-context-delta>/);
      assert.match(turn2.stdout, /INVALIDATED/);
      const emitted = turn2.events.filter((e) => e.name === "contextdelta.emitted");
      assert.equal(emitted.length, 1);
      assert.ok(
        emitted[0].invalidated >= 1,
        `expected >=1 invalidated, got ${emitted[0].invalidated}`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retracts on a CONTENT-STALE turn — the delta is disk-based, not graph-based", async () => {
    // The retraction lane deliberately runs on stale turns: it RETRACTS facts
    // rather than asserting new ones, so it stays honest when the graph does
    // not. This is the case that would silently disappear if the delta were
    // ever folded behind the same freshness gate as the retrieval block.
    const dir = await buildFixture("stale");
    try {
      mintBaseline(dir);
      fs.writeFileSync(
        path.join(dir, "lib", "resolveImportPath.js"),
        "// padding\n".repeat(20) + SOURCE
      );
      // A conversational prompt takes the static-summary path, and the tree is
      // now dirty, so this turn is content-stale by construction.
      const turn2 = runHook(dir, "thanks, that makes sense!");
      assert.match(
        turn2.stdout,
        /<sextant-context-delta>/,
        "retractions must survive the blackout body"
      );
      assert.equal(
        turn2.events.filter((e) => e.name === "contextdelta.emitted").length,
        1
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stays silent when no claimed file changed (the negative control)", async () => {
    const dir = await buildFixture("quiet");
    try {
      mintBaseline(dir);
      const turn2 = runHook(dir, REPROMPT);
      assert.doesNotMatch(
        turn2.stdout,
        /<sextant-context-delta>/,
        "an unchanged baseline must not manufacture a retraction"
      );
      assert.equal(
        turn2.events.filter((e) => e.name === "contextdelta.emitted").length,
        0
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
