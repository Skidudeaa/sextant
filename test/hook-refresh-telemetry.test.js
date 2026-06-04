"use strict";

// T1.3 — Measurable proof that the hook retrieval pipeline emits the
// classifier/injection telemetry that lets later retrieval changes prove
// they worked (fire-rate denominator + empty-injection rate).
//
// DETERMINISM: we spawn `node bin/intel.js hook refresh` with cwd set to a
// prepared fixture repo whose graph.db is prebuilt on disk (a single
// exported symbol).  We deliberately DO NOT build a zoekt index for the
// fixture — no daemon.json means searchFast() returns empty immediately, so
// the merged result set is graph-only and the injected `source` label is
// deterministically `graph_merged`.  No live/cold zoekt dependency (see the
// project's cold-zoekt-flake lesson).
//
// After each run we read the fixture's telemetry.jsonl back through the same
// lib/telemetry reader the production audit surface uses and assert on the
// recorded `retrieval.*` events.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const graph = require("../lib/graph");
const telemetry = require("../lib/telemetry");
const { summarize } = require("../commands/telemetry");

const BIN = path.resolve(__dirname, "..", "bin", "intel.js");

// Build a fixture repo whose on-disk graph.db exports a distinctive,
// identifier-shaped symbol so the classifier fires (retrieve:true) AND the
// graph lane returns a hit on its own.  PascalCase/camelCase name guarantees
// hasIdentifierShape() so classification crosses the retrieval threshold.
async function buildFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-hook-telemetry-"));
  fs.mkdirSync(path.join(dir, ".planning", "intel"), { recursive: true });

  const db = await graph.loadDb(dir);
  graph.upsertFile(db, {
    relPath: "lib/resolveImportPath.js",
    type: "js",
    sizeBytes: 500,
    mtimeMs: 1,
  });
  graph.replaceExports(db, "lib/resolveImportPath.js", [
    { name: "resolveImportPath", kind: "named" },
  ]);
  await graph.persistDb(dir);

  return dir;
}

// Spawn the hook with a crafted stdin payload and the fixture as cwd.
// Returns the parsed telemetry events recorded by THIS run (the fixture is
// freshly created so the file only holds events from this invocation).
function runHook(dir, prompt) {
  const res = spawnSync(process.execPath, [BIN, "hook", "refresh"], {
    cwd: dir,
    input: JSON.stringify({ prompt, session_id: "t13-test" }),
    encoding: "utf8",
    timeout: 20000,
  });
  return {
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    status: res.status,
    events: telemetry.readEvents(dir).filter((e) => String(e.name || "").startsWith("retrieval.")),
  };
}

describe("hook-refresh telemetry — code-relevant prompt", () => {
  let dir;
  before(async () => {
    dir = await buildFixture();
  });
  after(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("emits retrieval.classified{retrieve:true} and retrieval.injected{source:graph_merged}", () => {
    const { stdout, events } = runHook(dir, "where is resolveImportPath defined");

    // The hook must actually have injected a retrieval block for this to be a
    // meaningful injected-event assertion.
    assert.ok(
      stdout.includes("<codebase-retrieval>"),
      `expected a <codebase-retrieval> block, got stdout:\n${stdout}`
    );

    const classified = events.find((e) => e.name === "retrieval.classified");
    assert.ok(classified, "expected a retrieval.classified event");
    assert.equal(classified.retrieve, true, "classifier should fire on a code-relevant prompt");
    assert.equal(typeof classified.confidence, "number");
    assert.equal(typeof classified.termCount, "number");
    assert.ok(classified.termCount >= 1, "expected at least one extracted term");

    const injected = events.find((e) => e.name === "retrieval.injected");
    assert.ok(injected, "expected a retrieval.injected event");
    // DETERMINISTIC label: zoekt has no index for the fixture (no daemon.json),
    // so every final file came from the graph lane → graph_merged.
    assert.equal(injected.source, "graph_merged");
    assert.equal(typeof injected.fileCount, "number");
    assert.ok(injected.fileCount >= 1, "expected at least one injected file");

    // Disjoint: the injected branch must NOT also emit empty_fallback.
    assert.equal(
      events.find((e) => e.name === "retrieval.empty_fallback"),
      undefined,
      "injected run must not also emit empty_fallback"
    );
  });
});

describe("hook-refresh telemetry — conversational prompt", () => {
  let dir;
  before(async () => {
    dir = await buildFixture();
  });
  after(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("emits retrieval.classified{retrieve:false} and NO retrieval.injected", () => {
    const { events } = runHook(dir, "thanks, that makes sense!");

    const classified = events.find((e) => e.name === "retrieval.classified");
    assert.ok(classified, "expected a retrieval.classified event even on the skip branch");
    assert.equal(classified.retrieve, false, "conversational prompt should not trigger retrieval");

    assert.equal(
      events.find((e) => e.name === "retrieval.injected"),
      undefined,
      "skip branch must not emit retrieval.injected"
    );
  });
});

describe("telemetry summarize — retrieval aggregation", () => {
  it("computes fire-rate, empty-injection rate, and source breakdown", () => {
    const events = [
      { ts: 1, name: "retrieval.classified", retrieve: true, confidence: 1, termCount: 2 },
      { ts: 2, name: "retrieval.classified", retrieve: false, confidence: 0.2, termCount: 1 },
      { ts: 3, name: "retrieval.classified", retrieve: true, confidence: 0.8, termCount: 3 },
      { ts: 4, name: "retrieval.injected", source: "graph_merged", fileCount: 3 },
      { ts: 5, name: "retrieval.injected", source: "text_only", fileCount: 1 },
      { ts: 6, name: "retrieval.empty_fallback" },
    ];
    const r = summarize(events).retrieval;
    assert.equal(r.classifiedTotal, 3);
    assert.equal(r.classifiedRetrieve, 2);
    // fire-rate = 2 retrieve / 3 classified
    assert.ok(Math.abs(r.fireRate - 2 / 3) < 1e-9, `fireRate ${r.fireRate}`);
    assert.equal(r.injected, 2);
    assert.equal(r.emptyFallback, 1);
    // empty-injection rate = 1 empty_fallback / 2 retrieve-classified
    assert.equal(r.emptyInjectionRate, 0.5);
    assert.equal(r.injectedBySource.graph_merged, 1);
    assert.equal(r.injectedBySource.text_only, 1);
  });

  it("returns null rates and zero counts on an empty event set", () => {
    const r = summarize([]).retrieval;
    assert.equal(r.classifiedTotal, 0);
    assert.equal(r.classifiedRetrieve, 0);
    assert.equal(r.fireRate, null);
    assert.equal(r.injected, 0);
    assert.equal(r.emptyFallback, 0);
    assert.equal(r.emptyInjectionRate, null);
    assert.deepEqual(r.injectedBySource, {});
  });
});
