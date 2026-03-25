"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { mergeResults } = require("../lib/merge-results");

// ─── Graph-only results ─────────────────────────────────────────────

describe("mergeResults — graph only (no zoekt)", () => {
  it("returns graph files with boosted scores", () => {
    const graphResults = {
      files: [
        { path: "lib/graph.js", hitType: "exported_symbol", matchedTerms: ["loadDb"], fanIn: 5, score: 100 },
        { path: "lib/intel.js", hitType: "path_match", matchedTerms: ["intel"], fanIn: 13, score: 60 },
      ],
    };

    const result = mergeResults(graphResults, []);
    assert.equal(result.files.length, 2);
    // Graph boost: 100 * 1.4 = 140
    assert.equal(result.files[0].path, "lib/graph.js");
    assert.equal(result.files[0].fusedScore, 140);
    assert.equal(result.files[0].graphSignal, "exported_symbol");
    assert.equal(result.files[0].zoektHit, null);
    // Second file: 60 * 1.4 = 84
    assert.equal(result.files[1].path, "lib/intel.js");
    assert.equal(result.files[1].fusedScore, 84);
  });

  it("preserves fanIn and matchedTerms", () => {
    const graphResults = {
      files: [
        { path: "lib/resolver.js", hitType: "exported_symbol", matchedTerms: ["resolveImport"], fanIn: 3, score: 100 },
      ],
    };

    const result = mergeResults(graphResults, []);
    assert.equal(result.files[0].fanIn, 3);
    assert.deepEqual(result.files[0].matchedTerms, ["resolveImport"]);
  });
});

// ─── Zoekt-only results ─────────────────────────────────────────────

describe("mergeResults — zoekt only (no graph)", () => {
  it("returns zoekt files with raw scores", () => {
    const zoektHits = [
      { path: "lib/scoring.js", lineNumber: 42, line: "function adjustScore(hit) {", score: 85 },
      { path: "lib/retrieve.js", lineNumber: 10, line: "const scoring = require('./scoring');", score: 30 },
    ];

    const result = mergeResults({ files: [] }, zoektHits);
    assert.equal(result.files.length, 2);
    assert.equal(result.files[0].path, "lib/scoring.js");
    assert.equal(result.files[0].fusedScore, 85);
    assert.equal(result.files[0].graphSignal, null);
    assert.equal(result.files[0].zoektHit.lineNumber, 42);
  });

  it("deduplicates multiple zoekt hits for the same file (keeps best)", () => {
    const zoektHits = [
      { path: "lib/scoring.js", lineNumber: 10, line: "line one", score: 30 },
      { path: "lib/scoring.js", lineNumber: 42, line: "line two (best)", score: 85 },
      { path: "lib/scoring.js", lineNumber: 50, line: "line three", score: 40 },
    ];

    const result = mergeResults({ files: [] }, zoektHits);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].fusedScore, 85);
    assert.equal(result.files[0].zoektHit.lineNumber, 42);
    assert.equal(result.files[0].zoektHit.line, "line two (best)");
  });
});

// ─── Both graph and zoekt ───────────────────────────────────────────

describe("mergeResults — fusion (graph + zoekt)", () => {
  it("applies fusion bonus when file appears in both", () => {
    const graphResults = {
      files: [
        { path: "lib/graph.js", hitType: "exported_symbol", matchedTerms: ["loadDb"], fanIn: 5, score: 100 },
      ],
    };
    const zoektHits = [
      { path: "lib/graph.js", lineNumber: 78, line: "async function loadDb(root) {", score: 50 },
    ];

    const result = mergeResults(graphResults, zoektHits);
    assert.equal(result.files.length, 1);
    // Graph: 100 * 1.4 = 140, Zoekt: 50, Sum: 190, Fusion: 190 * 1.2 = 228
    assert.equal(result.files[0].fusedScore, 228);
    assert.equal(result.files[0].graphSignal, "exported_symbol");
    assert.ok(result.files[0].zoektHit);
    assert.equal(result.files[0].zoektHit.lineNumber, 78);
  });

  it("does NOT apply fusion bonus to files only in one source", () => {
    const graphResults = {
      files: [
        { path: "lib/graph.js", hitType: "exported_symbol", matchedTerms: ["loadDb"], fanIn: 5, score: 100 },
      ],
    };
    const zoektHits = [
      { path: "lib/other.js", lineNumber: 1, line: "something", score: 50 },
    ];

    const result = mergeResults(graphResults, zoektHits);
    assert.equal(result.files.length, 2);
    // graph.js: graph-only, no fusion — 100 * 1.4 = 140
    const graphFile = result.files.find((f) => f.path === "lib/graph.js");
    assert.equal(graphFile.fusedScore, 140);
    // other.js: zoekt-only, no fusion — 50
    const zoektFile = result.files.find((f) => f.path === "lib/other.js");
    assert.equal(zoektFile.fusedScore, 50);
  });

  it("ranks fusion files above single-source files", () => {
    const graphResults = {
      files: [
        { path: "lib/a.js", hitType: "exported_symbol", matchedTerms: ["foo"], fanIn: 2, score: 80 },
        { path: "lib/b.js", hitType: "path_match", matchedTerms: ["bar"], fanIn: 0, score: 60 },
      ],
    };
    const zoektHits = [
      { path: "lib/a.js", lineNumber: 5, line: "export function foo() {", score: 40 },
    ];

    const result = mergeResults(graphResults, zoektHits);
    // lib/a.js: (80*1.4 + 40) * 1.2 = (112 + 40) * 1.2 = 182.4
    // lib/b.js: 60*1.4 = 84
    assert.equal(result.files[0].path, "lib/a.js");
    assert.ok(result.files[0].fusedScore > result.files[1].fusedScore);
  });
});

// ─── Deduplication ──────────────────────────────────────────────────

describe("mergeResults — deduplication", () => {
  it("same file in graph and zoekt produces one entry", () => {
    const graphResults = {
      files: [
        { path: "lib/graph.js", hitType: "exported_symbol", matchedTerms: ["loadDb"], fanIn: 5, score: 100 },
      ],
    };
    const zoektHits = [
      { path: "lib/graph.js", lineNumber: 78, line: "async function loadDb(root) {", score: 50 },
    ];

    const result = mergeResults(graphResults, zoektHits);
    assert.equal(result.files.length, 1);
    // Should have both graph signal and zoekt hit
    assert.equal(result.files[0].graphSignal, "exported_symbol");
    assert.ok(result.files[0].zoektHit);
  });
});

// ─── maxFiles cap ───────────────────────────────────────────────────

describe("mergeResults — maxFiles cap", () => {
  it("caps output at maxFiles", () => {
    const graphResults = {
      files: Array.from({ length: 20 }, (_, i) => ({
        path: `lib/file${i}.js`,
        hitType: "path_match",
        matchedTerms: ["file"],
        fanIn: 0,
        score: 60 - i,
      })),
    };

    const result = mergeResults(graphResults, [], { maxFiles: 5 });
    assert.equal(result.files.length, 5);
    assert.equal(result.files[0].path, "lib/file0.js");
    assert.equal(result.files[4].path, "lib/file4.js");
  });

  it("defaults to 8 files when maxFiles not specified", () => {
    const graphResults = {
      files: Array.from({ length: 15 }, (_, i) => ({
        path: `lib/file${i}.js`,
        hitType: "path_match",
        matchedTerms: ["file"],
        fanIn: 0,
        score: 60,
      })),
    };

    const result = mergeResults(graphResults, []);
    assert.equal(result.files.length, 8);
  });
});

// ─── Empty results ──────────────────────────────────────────────────

describe("mergeResults — empty results", () => {
  it("empty graph + empty zoekt → empty files", () => {
    const result = mergeResults({ files: [] }, []);
    assert.deepEqual(result.files, []);
  });

  it("null/undefined inputs handled gracefully", () => {
    const result = mergeResults(null, null);
    assert.deepEqual(result.files, []);
  });

  it("missing files array handled gracefully", () => {
    const result = mergeResults({}, []);
    assert.deepEqual(result.files, []);
  });
});
