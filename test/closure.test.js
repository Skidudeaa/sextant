"use strict";

// STRUCTURAL DELTA + CLOSURE (docs/029 Phase D). Locks the structural diff
// (vs a real temp graph pre-image) and the factual closure report (evidence +
// gaps, never "safe to merge").

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const graph = require("../lib/graph");
const SD = require("../lib/structural-delta");
const capsuleLib = require("../lib/capsule");
const { buildClosure, renderClosure } = require("../lib/closure");

describe("structural-delta — computeStructuralDelta vs graph pre-image", () => {
  it("detects added/removed exports and imports", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sx-sd-"));
    try {
      const db = await graph.loadDb(dir);
      graph.upsertFile(db, { relPath: "m.js", type: "js", sizeBytes: 10, mtimeMs: 1 });
      // pre-image: exports foo, imports ./old
      graph.replaceExports(db, "m.js", [{ name: "foo", kind: "named" }]);
      graph.replaceImports(db, "m.js", [{ specifier: "./old", toPath: "old.js", kind: "relative" }]);
      // new content (ESM — deterministic named export, no CJS `default`):
      // exports bar (not foo), imports ./new (not ./old)
      const content = "import x from './new';\nexport function bar(){}\n";
      const d = SD.computeStructuralDelta(db, graph, "m.js", content);
      assert.deepEqual(d.exportsAdded, ["bar"]);
      assert.deepEqual(d.exportsRemoved, ["foo"]);
      assert.deepEqual(d.importsAdded, ["./new"]);
      assert.deepEqual(d.importsRemoved, ["./old"]);
      assert.equal(d.changed, true);
      assert.ok(SD.summarizeDelta(d).includes("import"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unchanged structure → empty delta", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sx-sd2-"));
    try {
      const db = await graph.loadDb(dir);
      graph.upsertFile(db, { relPath: "m.js", type: "js", sizeBytes: 10, mtimeMs: 1 });
      graph.replaceExports(db, "m.js", [{ name: "keep", kind: "named" }]);
      const content = "export function keep(){}\n";
      const d = SD.computeStructuralDelta(db, graph, "m.js", content);
      assert.equal(d.changed, false);
      assert.equal(SD.summarizeDelta(d), "");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never throws on a bad db / content", () => {
    const d = SD.computeStructuralDelta(null, graph, "m.js", null);
    assert.equal(d.changed, false);
  });
});

describe("closure — buildClosure / renderClosure", () => {
  // A temp repo with a persisted capsule (Phase B/C/D shape) + a blast-radius
  // touched-state file (the observed set).
  function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sx-closure-"));
    fs.mkdirSync(path.join(dir, ".planning", "intel"), { recursive: true });
    const capsule = {
      taskId: "task_abc",
      sessionId: "sX",
      intent: { text: "add rankTaskRegions" },
      repo: { branch: "main", head: "deadbeef1234", statusHash: "h" },
      workset: {
        primary: [{ path: "lib/orient.js" }],
        support: [],
        witnesses: [{ path: "test/orient.test.js" }, { path: "test/hook-pretask.test.js" }],
        hazards: ["lib/graph.js high fan-in (34)"],
        unknowns: ["1 primary file(s) in a language sextant can't resolve to regions"],
      },
      servedClaims: [], // empty → claim diff all zero
      touchedRegions: [
        { path: "lib/orient.js", exportsAdded: ["rankTaskRegions"], exportsRemoved: [], importsAdded: ["./regions"], importsRemoved: [] },
      ],
      status: "orienting",
    };
    capsuleLib.writeCapsule(dir, "sX", capsule);
    // observed set: agent read test/orient.test.js + lib/orient.js (not the others)
    fs.writeFileSync(
      path.join(dir, ".planning", "intel", ".blastradius.sX"),
      JSON.stringify({ ts: Date.now(), touched: ["lib/orient.js", "test/orient.test.js"], emitted: {} })
    );
    return dir;
  }

  it("summarizes structural changes, witnesses observed vs not, and consumers", () => {
    const dir = fixture();
    try {
      const r = buildClosure(dir, { sessionKey: "sX" });
      assert.equal(r.taskId, "task_abc");
      assert.equal(r.changedFiles.length, 1);
      assert.equal(r.structural.exportsAdded, 1);
      assert.equal(r.structural.importsAdded, 1);
      // witnesses: orient.test observed, hook-pretask.test NOT
      assert.deepEqual(r.witnessesObserved, ["test/orient.test.js"]);
      assert.deepEqual(r.witnessesUnobserved, ["test/hook-pretask.test.js"]);
      // consumers = primary(lib/orient.js) + hazard(lib/graph.js); orient inspected, graph not
      assert.ok(r.consumersInspected.includes("lib/orient.js"));
      assert.ok(r.consumersNotInspected.includes("lib/graph.js"));
      assert.equal(r.unknowns.length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("render states evidence + gaps and NEVER says safe to merge", () => {
    const dir = fixture();
    try {
      const text = renderClosure(buildClosure(dir, { sessionKey: "sX" }));
      assert.ok(text.includes("TASK CLOSURE REPORT"));
      assert.ok(text.includes("+exports rankTaskRegions"));
      assert.ok(text.includes("NOT observed: test/hook-pretask.test.js"));
      assert.ok(text.includes("NOT inspected"));
      assert.ok(/does not assert the change is correct, complete, or safe to merge/i.test(text));
      assert.ok(!/safe to merge\b(?!\.)/.test(text.replace(/does not assert[^\n]*/i, "")), "no bare 'safe to merge' claim");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no capsule → honest 'none' report", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sx-closure-none-"));
    fs.mkdirSync(path.join(dir, ".planning", "intel"), { recursive: true });
    try {
      const r = buildClosure(dir, {});
      assert.equal(r.none, true);
      assert.ok(/No task capsule/.test(renderClosure(r)));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
