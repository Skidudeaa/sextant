"use strict";

// TASK CAPSULE (docs/027 Phase B) — locks the role-based workset compiler,
// the durable capsule envelope, and the renderer. Deterministic, no spawn.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { compileWorkset } = require("../lib/workset");
const capsuleLib = require("../lib/capsule");
const { formatCapsule } = require("../lib/format-capsule");

// Merged-hit fixtures (shape from mergeResults). No disk region resolution
// fires here (paths don't exist), so region stays absent — role logic is the SUT.
const HITS = [
  { path: "lib/graph.js", graphSignal: "exported_symbol", matchedTerms: ["loadDb"], fanIn: 34, zoektHit: { lineNumber: 120 } },
  { path: "lib/util.js", graphSignal: "path_match", matchedTerms: ["util"], fanIn: 5, zoektHit: { lineNumber: 3 } },
  { path: "lib/misc.js", graphSignal: null, fanIn: 1, zoektHit: { lineNumber: 9 } },
  { path: "lib/more.js", graphSignal: null, fanIn: 2 },
  { path: "test/graph.test.js", graphSignal: "text_only", fanIn: 0, zoektHit: { lineNumber: 8 } },
  { path: "A.swift", graphSignal: "swift_decl_type", matchedTerms: ["Widget"], startLine: 44, fanIn: 2 },
];

describe("workset — compileWorkset roles", () => {
  const ws = compileWorkset(HITS, { root: "/nonexistent", resolutionPct: 98 });

  it("def-signal and top-rank non-tests are primary; tests are witnesses", () => {
    const primary = ws.primary.map((e) => e.path);
    assert.ok(primary.includes("lib/graph.js"), "export signal → primary");
    assert.ok(primary.includes("A.swift"), "swift decl → primary");
    assert.ok(primary.includes("lib/util.js"), "top-rank non-test → primary");
    assert.deepEqual(ws.witnesses.map((e) => e.path), ["test/graph.test.js"]);
  });

  it("beyond the top-N non-def files fall to support", () => {
    // Non-test ranks: graph(1) util(2) misc(3) more(4). PRIMARY_TOP=3, so misc
    // is still primary (top-3) and only more.js (rank 4, no def signal) is support.
    const support = ws.support.map((e) => e.path);
    assert.deepEqual(support, ["lib/more.js"]);
    assert.ok(ws.primary.map((e) => e.path).includes("lib/misc.js"), "rank-3 is primary");
  });

  it("high fan-in surfaces become hazard notes; low resolution adds a health hazard", () => {
    assert.ok(ws.hazards.some((h) => h.includes("lib/graph.js high fan-in (34)")));
    const ws2 = compileWorkset(HITS, { root: "/nonexistent", resolutionPct: 80 });
    assert.ok(ws2.hazards.some((h) => /resolution 80%/.test(h)));
  });

  it("carries the {line, symbol} breadcrumb for the Phase-A region lane", () => {
    const g = ws.primary.find((e) => e.path === "lib/graph.js");
    assert.equal(g.line, 120);
    assert.equal(g.symbol, "loadDb"); // symbol only for def-signals
    const u = ws.primary.find((e) => e.path === "lib/util.js");
    assert.equal(u.symbol, undefined, "path_match term is not a code symbol");
  });

  it("accepts hitType as an alias for graphSignal (MCP graph-only path)", () => {
    const ws3 = compileWorkset([{ path: "x.js", hitType: "exported_symbol", matchedTerms: ["foo"], fanIn: 1 }], { root: "/n" });
    assert.equal(ws3.primary[0].source, "exported_symbol");
    assert.equal(ws3.primary[0].symbol, "foo");
  });

  it("Swift primary (unsupported region lang) is counted in unknowns", () => {
    assert.ok(ws.unknowns.some((u) => /can't resolve to regions/.test(u)));
  });
});

describe("capsule — envelope build/persist/fingerprint", () => {
  it("builds a stable taskId per session with the workset + repo fingerprint", () => {
    const ws = compileWorkset(HITS, { root: "/n" });
    const c1 = capsuleLib.buildCapsule({ root: "/n", sessionKey: "s1", taskText: "fix loadDb", workset: ws, nowMs: 1000 });
    const c2 = capsuleLib.buildCapsule({ root: "/n", sessionKey: "s1", taskText: "other", workset: ws, nowMs: 2000 });
    assert.equal(c1.taskId, c2.taskId, "taskId is stable per session");
    assert.equal(c1.status, "orienting");
    assert.deepEqual(c1.servedClaims, []);
    assert.deepEqual(c1.touchedRegions, []);
    assert.equal(c1.intent.text, "fix loadDb");
  });

  it("does not group raw session ids that collide after filename sanitization", () => {
    const { deriveSessionKey } = require("../lib/session");
    const slashKey = deriveSessionKey({ session_id: "session/a" });
    const underscoreKey = deriveSessionKey({ session_id: "session_a" });
    const a = capsuleLib.buildCapsule({ root: "/n", sessionKey: slashKey, taskText: "a" });
    const b = capsuleLib.buildCapsule({ root: "/n", sessionKey: underscoreKey, taskText: "b" });
    assert.notEqual(slashKey, underscoreKey);
    assert.notEqual(a.taskId, b.taskId);
    assert.notEqual(
      capsuleLib.capsuleFile("/n", slashKey),
      capsuleLib.capsuleFile("/n", underscoreKey)
    );
  });

  it("round-trips through disk and reads the latest by mtime", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sx-capsule-"));
    fs.mkdirSync(path.join(dir, ".planning", "intel"), { recursive: true });
    try {
      const ws = compileWorkset(HITS, { root: dir });
      const cap = capsuleLib.buildCapsule({ root: dir, sessionKey: "sX", taskText: "t", workset: ws, nowMs: 5 });
      assert.equal(capsuleLib.writeCapsule(dir, "sX", cap), true);
      const back = capsuleLib.readCapsule(dir, "sX");
      assert.equal(back.taskId, cap.taskId);
      const latest = capsuleLib.readLatestCapsule(dir);
      assert.equal(latest.taskId, cap.taskId);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("capsuleFreshness flags a moved HEAD as stale", () => {
    const cap = { repo: { head: "aaaaaaa", statusHash: "h1" } };
    // repoFingerprint reads the CURRENT repo (sextant itself); a bogus stored
    // head can never equal it, so this must report stale head_changed.
    const fr = capsuleLib.capsuleFreshness(process.cwd(), cap);
    assert.equal(fr.fresh, false);
  });

  it("carries task-long edit evidence across a fresh workset compilation", () => {
    const prior = capsuleLib.buildCapsule({
      root: "/n",
      sessionKey: "s1",
      taskText: "first prompt",
      workset: compileWorkset(HITS, { root: "/n" }),
      nowMs: 1000,
    });
    prior.servedClaims = [{ id: "old" }];
    prior.touchedRegions = [{ path: "lib/graph.js", exportsAdded: ["x"] }];
    prior.status = "changing";

    const next = capsuleLib.buildCapsule({
      root: "/n",
      sessionKey: "s1",
      taskText: "second prompt",
      workset: compileWorkset(HITS.slice(0, 2), { root: "/n" }),
      nowMs: 2000,
    });
    next.servedClaims = [{ id: "new" }];
    const carried = capsuleLib.carryForwardCapsule(next, prior);

    assert.equal(carried.createdAt, 1000);
    assert.equal(carried.status, "changing");
    assert.deepEqual(carried.touchedRegions, prior.touchedRegions);
    assert.deepEqual(carried.servedClaims, [{ id: "new" }], "new served baseline replaces old");
    assert.equal(carried.intent.text, "second prompt");
  });

  it("merges edit evidence that lands after refresh staging but before publication", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sx-capsule-race-"));
    fs.mkdirSync(path.join(root, ".planning", "intel"), { recursive: true });
    const sessionKey = "capsule-race";
    const workset = { primary: [], support: [], witnesses: [], hazards: [], unknowns: [] };
    try {
      const first = capsuleLib.buildCapsule({ root, sessionKey, taskText: "first", workset });
      assert.equal(capsuleLib.writeCapsule(root, sessionKey, first), true);

      // Refresh stages from the old capsule, then PostToolUse appends before the
      // refresh publishes. The final locked merge must retain that late append.
      const staged = capsuleLib.carryForwardCapsule(
        capsuleLib.buildCapsule({ root, sessionKey, taskText: "refreshed", workset }),
        first
      );
      assert.equal(capsuleLib.appendTouchedRegion(root, sessionKey, {
        path: "lib/a.js",
        exportsAdded: ["late"], exportsRemoved: [], importsAdded: [], importsRemoved: [],
      }), true);
      assert.equal(capsuleLib.writeCapsulePreservingEvidence(root, sessionKey, staged), true);
      const final = capsuleLib.readCapsule(root, sessionKey);
      assert.equal(final.intent.text, "refreshed");
      assert.deepEqual(final.touchedRegions.map((entry) => entry.exportsAdded), [["late"]]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on an existing lock and never reaps another owner's path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sx-capsule-lock-"));
    const sessionKey = "locked-session";
    const stateDir = path.join(root, ".planning", "intel");
    const lock = path.join(stateDir, `.capsule-lock.${capsuleLib.shortHash(sessionKey)}`);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(lock, "999999:other-owner");
    // An old mtime must not authorize check-then-unlink stale recovery.
    fs.utimesSync(lock, new Date(0), new Date(0));
    try {
      assert.equal(capsuleLib.writeCapsule(root, sessionKey, { taskId: "blocked" }), false);
      assert.equal(fs.readFileSync(lock, "utf8"), "999999:other-owner");
      assert.equal(capsuleLib.readCapsule(root, sessionKey), null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("capsule gate — default-off contract (never degrades a normal install)", () => {
  const { capsuleEnabled } = require("../commands/hook-refresh");
  it("is OFF by default (no env, no config)", () => {
    // Point at a dir with no .codebase-intel.json so config lookup is empty.
    assert.equal(capsuleEnabled("/nonexistent-repo", {}), false);
  });
  it("SEXTANT_CAPSULE=1 turns it on; =0 forces off", () => {
    assert.equal(capsuleEnabled("/n", { SEXTANT_CAPSULE: "1" }), true);
    assert.equal(capsuleEnabled("/n", { SEXTANT_CAPSULE: "true" }), true);
    assert.equal(capsuleEnabled("/n", { SEXTANT_CAPSULE: "0" }), false);
    assert.equal(capsuleEnabled("/n", { SEXTANT_CAPSULE: "false" }), false);
  });
});

describe("format-capsule — render + persisted-set shape", () => {
  it("renders role sections and returns files in persisted-set shape", () => {
    const ws = compileWorkset(HITS, { root: "/n" });
    const cap = capsuleLib.buildCapsule({ root: "/n", sessionKey: "s", taskText: "t", workset: ws, nowMs: 1 });
    const { text, files } = formatCapsule(cap, { maxChars: 2000 });
    assert.ok(text.includes("### Task capsule"));
    assert.ok(text.includes("PRIMARY"));
    assert.ok(text.includes("WITNESSES"));
    // files are the flattened FILE entries (not hazard/unknown notes), in
    // {path, source, line?, symbol?} shape the PostToolUse region lane reads.
    const g = files.find((f) => f.path === "lib/graph.js");
    assert.deepEqual(g, { path: "lib/graph.js", source: "exported_symbol", line: 120, symbol: "loadDb" });
    assert.ok(!files.some((f) => /high fan-in/.test(f.path)), "notes are not files");
  });

  it("def rows show `defines <symbol>` without a misleading region span", () => {
    const ws = compileWorkset(HITS, { root: "/n" });
    const cap = capsuleLib.buildCapsule({ root: "/n", sessionKey: "s", taskText: "t", workset: ws, nowMs: 1 });
    const { text } = formatCapsule(cap, { maxChars: 2000 });
    assert.ok(text.includes("defines loadDb"));
  });

  it("under a tight cap, PRIMARY survives and lower-priority sections drop", () => {
    const ws = compileWorkset(HITS, { root: "/n" });
    const cap = capsuleLib.buildCapsule({ root: "/n", sessionKey: "s", taskText: "t", workset: ws, nowMs: 1 });
    const { text, files } = formatCapsule(cap, { maxChars: 120 });
    assert.ok(text.includes("PRIMARY"), "primary never dropped");
    assert.ok(files.length >= 1, "at least one primary file persisted");
    assert.ok(!text.includes("UNKNOWNS"), "unknowns dropped first under a tight cap");
  });

  it("empty workset → empty render", () => {
    const cap = capsuleLib.buildCapsule({ root: "/n", sessionKey: "s", taskText: "t", workset: undefined, nowMs: 1 });
    assert.deepEqual(formatCapsule(cap, { maxChars: 500 }), { text: "", files: [] });
  });
});
