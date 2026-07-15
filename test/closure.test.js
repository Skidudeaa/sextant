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
const claimsLib = require("../lib/claims");
const { buildClosure, renderClosure } = require("../lib/closure");

function coherenceEnv(enabled) {
  const priorCapsule = process.env.SEXTANT_CAPSULE;
  const priorCoherence = process.env.SEXTANT_COHERENCE;
  process.env.SEXTANT_CAPSULE = "1";
  process.env.SEXTANT_COHERENCE = enabled ? "1" : "0";
  return () => {
    if (priorCapsule === undefined) delete process.env.SEXTANT_CAPSULE;
    else process.env.SEXTANT_CAPSULE = priorCapsule;
    if (priorCoherence === undefined) delete process.env.SEXTANT_COHERENCE;
    else process.env.SEXTANT_COHERENCE = priorCoherence;
  };
}

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
  function fixture(touchedRegions) {
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
      touchedRegions: touchedRegions || [
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
      assert.equal(r.claims.unverifiable, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports claim snapshots that could not be checked as unverifiable", () => {
    const dir = fixture([]);
    const file = path.join(dir, "large.js");
    try {
      fs.writeFileSync(file, "served\n");
      const capsule = capsuleLib.readCapsule(dir, "sX");
      capsule.servedClaims = claimsLib.mintClaims(
        dir,
        [{ path: "large.js", source: "text_only", line: 1 }],
        { nowMs: 1 }
      );
      capsuleLib.writeCapsule(dir, "sX", capsule);
      fs.truncateSync(file, 3 * 1024 * 1024);

      const report = buildClosure(dir, { sessionKey: "sX" });
      assert.deepEqual(report.claims, {
        unchanged: 0,
        changed: 0,
        invalidated: 0,
        unverifiable: 1,
      });
      assert.match(
        renderClosure(report),
        /Context consistency \(served facts\): 0 unchanged, 0 re-derived, 0 invalidated, 1 unverifiable since served/
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aggregates repeated edit records into unique changed files and net totals", () => {
    const dir = fixture([
      {
        path: "lib/orient.js",
        exportsAdded: ["rankTaskRegions"],
        exportsRemoved: [],
        importsAdded: ["./regions"],
        importsRemoved: [],
      },
      {
        path: "lib/orient.js",
        // A later graph-relative observation can repeat the earlier facts.
        exportsAdded: ["rankTaskRegions", "rankTaskCapsule"],
        exportsRemoved: [],
        importsAdded: ["./regions"],
        importsRemoved: [],
      },
      {
        path: "lib/graph.js",
        exportsAdded: [],
        exportsRemoved: ["legacyLookup"],
        importsAdded: [],
        importsRemoved: [],
      },
    ]);
    try {
      const r = buildClosure(dir, { sessionKey: "sX" });
      assert.equal(r.changedFiles.length, 2, "count unique paths, not edit records");
      assert.deepEqual(r.changedFiles[0], {
        path: "lib/orient.js",
        exportsAdded: ["rankTaskRegions", "rankTaskCapsule"],
        exportsRemoved: [],
        importsAdded: ["./regions"],
        importsRemoved: [],
      });
      assert.deepEqual(r.structural, {
        exportsAdded: 2,
        exportsRemoved: 1,
        importsAdded: 1,
        importsRemoved: 0,
      });
      assert.match(renderClosure(r), /Changed files \(observable structure\): 2/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cancels explicitly reversed structural observations from the closure net", () => {
    const dir = fixture([
      {
        path: "lib/orient.js",
        exportsAdded: ["temporaryExport", "keptExport"],
        exportsRemoved: [],
        importsAdded: ["./temporary"],
        importsRemoved: [],
      },
      {
        path: "lib/orient.js",
        exportsAdded: [],
        exportsRemoved: ["temporaryExport"],
        importsAdded: [],
        importsRemoved: ["./temporary"],
      },
      {
        path: "lib/graph.js",
        exportsAdded: [],
        exportsRemoved: ["removedThenRestored"],
        importsAdded: [],
        importsRemoved: [],
      },
      {
        path: "lib/graph.js",
        exportsAdded: ["removedThenRestored"],
        exportsRemoved: [],
        importsAdded: [],
        importsRemoved: [],
      },
    ]);
    try {
      const r = buildClosure(dir, { sessionKey: "sX" });
      assert.deepEqual(r.changedFiles, [{
        path: "lib/orient.js",
        exportsAdded: ["keptExport"],
        exportsRemoved: [],
        importsAdded: [],
        importsRemoved: [],
      }]);
      assert.deepEqual(r.structural, {
        exportsAdded: 1,
        exportsRemoved: 0,
        importsAdded: 0,
        importsRemoved: 0,
      });
      const text = renderClosure(r);
      assert.match(text, /\+exports keptExport/);
      assert.doesNotMatch(text, /temporaryExport|removedThenRestored|\.\/temporary/);
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

  it("includes recorded agent-serve overlap without claiming coordination or attribution", () => {
    const root = fixture([]);
    const restoreEnv = coherenceEnv(true);
    try {
      const sessionKey = "sX";
      const cap = capsuleLib.readCapsule(root, sessionKey);
      const coherence = require("../lib/coherence");
      const parent = coherence.parentAgentKey("closure-parent");
      for (const [agentKey, kind] of [[parent, "parent"], [coherence.childAgentKey(parent, "spawn-1"), "child"]]) {
        coherence.writeSnapshot(root, coherence.buildSnapshot({
          taskId: cap.taskId,
          agentKey,
          parentAgentKey: kind === "child" ? parent : null,
          spawnToolUseId: kind === "child" ? "spawn-1" : null,
          kind,
          createdAt: Date.now(),
          repo: cap.repo,
          intent: cap.intent,
          workset: cap.workset,
          servedClaims: [],
          blockHash: agentKey,
        }));
      }

      const report = buildClosure(root, { sessionKey });
      assert.equal(report.agentCoherence.snapshotCount, 2);
      assert.equal(report.agentCoherence.overlapPairTotal, 1);
      const text = renderClosure(report);
      assert.match(text, /Recorded agent boundaries: 2/);
      assert.match(text, /recorded workset-overlap pairs: 1/);
      assert.doesNotMatch(text, /\b(lock|owner|authored|assigned|conflict)\b/i);
    } finally {
      restoreEnv();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("default-off closure ignores retained Phase-F snapshots and preserves its prior shape", () => {
    const root = fixture([]);
    const restoreEnv = coherenceEnv(false);
    try {
      const cap = capsuleLib.readCapsule(root, "sX");
      const coherence = require("../lib/coherence");
      assert.ok(coherence.writeSnapshot(root, coherence.buildSnapshot({
        taskId: cap.taskId,
        agentKey: "retained_agent",
        kind: "child",
        createdAt: Date.now(),
        repo: cap.repo,
        intent: cap.intent,
        workset: cap.workset,
        servedClaims: [],
      })));

      const report = buildClosure(root, { sessionKey: "sX" });
      assert.equal(Object.hasOwn(report, "agentCoherence"), false);
      assert.doesNotMatch(
        renderClosure(report),
        /Recorded agent boundaries|Agent coherence|workset-overlap/
      );
    } finally {
      restoreEnv();
      fs.rmSync(root, { recursive: true, force: true });
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
