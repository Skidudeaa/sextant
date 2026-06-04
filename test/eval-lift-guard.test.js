"use strict";

// Guards the per-case nDCG-lift surfacing (eval-retrieve.js) and the hard
// negative-lift floor (compare-vapor-eval.js Gate 3). The floor is the
// load-bearing piece: it turns the previously-soft per-case lift signal into a
// gate so a graph-injection regression on a single query can't hide behind the
// aggregate graphLiftNDCG.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { evaluateCase, round2 } = require("../scripts/eval-retrieve");

const COMPARATOR = path.join(__dirname, "..", "scripts", "compare-vapor-eval.js");

// ── Helpers ──────────────────────────────────────────────────────────

// Build a synthetic runResult in the shape evaluateCase consumes
// (runResult.result.results.{files,hits,related}).
function runResult(files) {
  return {
    durationMs: 1,
    result: {
      results: {
        files: files.map((p) => ({ path: p })),
        hits: [],
        related: [],
      },
      warnings: [],
      providers: { graph: { available: true } },
    },
  };
}

function tmpJson(obj) {
  const p = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "eval-lift-")),
    "data.json"
  );
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

// Run the comparator against two synthetic baseline/current JSONs.
function runComparator(baselineObj, currentObj) {
  const baselinePath = tmpJson(baselineObj);
  const currentPath = tmpJson(currentObj);
  const res = spawnSync("node", [COMPARATOR, baselinePath, currentPath], {
    encoding: "utf8",
  });
  return { code: res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
}

// A CLI-baseline-shaped case (carries withGraph.files + withoutGraph.ndcg).
// `liftNDCG` is set explicitly to the target lift; the graph/withoutGraph ndcg
// fields are derived so Gate 3 (which recomputes lift = g.ndcg - ng.ndcg) sees
// exactly `lift`. files identical so Gate 2 (top-3 retention) never trips.
function cliCase(id, lift, files = ["a.swift", "b.swift", "c.swift"]) {
  const ng = 0.5;
  const g = round2(ng + lift);
  return {
    id,
    query: id,
    withGraph: { ndcg: g, files },
    withoutGraph: { ndcg: ng, files },
  };
}

// A hook-baseline-shaped case: rankedFiles only, no withGraph/withoutGraph.
function hookCase(id, files = ["a.swift", "b.swift", "c.swift"]) {
  return { id, query: id, rankedFiles: files };
}

function baselineEnvelope(cases) {
  return { aggregates: { meanMRR: 0.8, meanNDCG: 0.8 }, cases };
}

// ── (a) eval-retrieve.js: liftNDCG is first-class ────────────────────

describe("eval-retrieve.js — per-case liftNDCG", () => {
  it("metrics.liftNDCG equals withGraph.ndcg - withoutGraph.ndcg", () => {
    // Graph ON ranks the primary def at rank 1 (nDCG 1.0); graph OFF buries it
    // below rank 3 (the canonical def absent from top-k → lower nDCG). This is
    // the URI-style injection win.
    const evalCase = {
      id: "synthetic-lift-001",
      category: "symbol",
      query: "Foo",
      relevantFiles: ["src/Foo.swift"],
      acceptableFiles: [],
      topK: 5,
    };
    const withGraph = runResult([
      "src/Foo.swift",
      "src/Bar.swift",
      "src/Baz.swift",
    ]);
    const withoutGraph = runResult([
      "tests/FooTests.swift",
      "src/Consumer.swift",
      "src/Other.swift",
      "src/Foo.swift",
    ]);

    const m = evaluateCase({ evalCase, withGraph, withoutGraph });

    assert.equal(typeof m.liftNDCG, "number", "liftNDCG present and numeric");
    assert.ok(m.withGraph.ndcg != null && m.withoutGraph.ndcg != null);
    const expected = round2((m.withGraph.ndcg ?? 0) - (m.withoutGraph.ndcg ?? 0));
    assert.equal(m.liftNDCG, expected);
    assert.ok(m.liftNDCG > 0, "graph-ON ranks the def higher → positive lift");
  });

  it("negative-lift case yields negative liftNDCG (the regression mode)", () => {
    // Graph OFF surfaces the canonical def at rank 1; graph ON displaces it
    // (the Codable-style displacement). liftNDCG must go negative.
    const evalCase = {
      id: "synthetic-neg-001",
      category: "symbol",
      query: "Codable",
      relevantFiles: ["src/ResponseCodable.swift"],
      acceptableFiles: [],
      topK: 5,
    };
    const withGraph = runResult([
      "src/Wrong.swift",
      "src/AlsoWrong.swift",
      "src/Nope.swift",
      "src/ResponseCodable.swift",
    ]);
    const withoutGraph = runResult([
      "src/ResponseCodable.swift",
      "src/Other.swift",
    ]);

    const m = evaluateCase({ evalCase, withGraph, withoutGraph });
    assert.ok(m.liftNDCG < 0, "displacing the def yields negative lift");
    assert.equal(
      m.liftNDCG,
      round2((m.withGraph.ndcg ?? 0) - (m.withoutGraph.ndcg ?? 0))
    );
  });
});

// ── (b) compare-vapor-eval.js Gate 3: the load-bearing gate ──────────

describe("compare-vapor-eval.js — Gate 3 negative-lift floor", () => {
  it("FAILS (exit 1) on a NON-allowlisted case at lift -0.20", () => {
    const baseline = baselineEnvelope([cliCase("vapor-x-001", -0.2)]);
    const current = baselineEnvelope([cliCase("vapor-x-001", -0.2)]);
    const { code, stdout } = runComparator(baseline, current);
    assert.equal(code, 1, "new negative-lift regression must fail the gate");
    assert.match(stdout, /vapor-x-001/);
    assert.match(stdout, /below negative-lift floor/);
  });

  it("PASSES (exit 0) for vapor-codable-001 at -0.315 (within -0.32 bound)", () => {
    const baseline = baselineEnvelope([cliCase("vapor-codable-001", -0.315)]);
    const current = baselineEnvelope([cliCase("vapor-codable-001", -0.315)]);
    const { code, stdout } = runComparator(baseline, current);
    assert.equal(code, 0, "accepted debt within bound passes");
    assert.match(stdout, /PASS: no regressions/);
  });

  it("FAILS (exit 1) for vapor-codable-001 at -0.40 (worse than -0.32 bound)", () => {
    const baseline = baselineEnvelope([cliCase("vapor-codable-001", -0.4)]);
    const current = baselineEnvelope([cliCase("vapor-codable-001", -0.4)]);
    const { code, stdout } = runComparator(baseline, current);
    assert.equal(code, 1, "worsening past accepted-debt bound must fail");
    assert.match(stdout, /vapor-codable-001/);
    assert.match(stdout, /worsened past accepted-debt bound/);
  });

  it("SKIPS hook-baseline-shape cases (rankedFiles only, no lift) — no false fail", () => {
    const baseline = baselineEnvelope([hookCase("vapor-uri-001")]);
    const current = baselineEnvelope([hookCase("vapor-uri-001")]);
    const { code, stdout } = runComparator(baseline, current);
    assert.equal(code, 0, "graph-only hook diffs carry no computable lift");
    assert.match(stdout, /PASS: no regressions/);
  });

  it("does not fail a case exactly at the floor (-0.05 is inclusive PASS)", () => {
    const baseline = baselineEnvelope([cliCase("vapor-edge-001", -0.05)]);
    const current = baselineEnvelope([cliCase("vapor-edge-001", -0.05)]);
    const { code } = runComparator(baseline, current);
    assert.equal(code, 0, "lift == floor is not below the floor");
  });
});
