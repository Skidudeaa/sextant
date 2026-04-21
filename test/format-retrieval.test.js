"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { formatRetrieval } = require("../lib/format-retrieval");

// ─── Graph results formatting ───────────────────────────────────────

describe("formatRetrieval — graph results", () => {
  it("formats exported_symbol entries", () => {
    const merged = {
      files: [
        {
          path: "lib/graph.js",
          graphSignal: "exported_symbol",
          matchedTerms: ["findExportsBySymbol"],
          zoektHit: null,
          fanIn: 4,
          fusedScore: 140,
        },
      ],
    };

    const output = formatRetrieval(merged);
    assert.ok(output.includes("### Relevant files"));
    assert.ok(output.includes("`lib/graph.js`"));
    assert.ok(output.includes("exports findExportsBySymbol"));
    assert.ok(output.includes("fan-in: 4"));
  });

  it("formats path_match entries", () => {
    const merged = {
      files: [
        {
          path: "watch.js",
          graphSignal: "path_match",
          matchedTerms: ["watcher"],
          zoektHit: null,
          fanIn: 2,
          fusedScore: 84,
        },
      ],
    };

    const output = formatRetrieval(merged);
    assert.ok(output.includes("`watch.js`"));
    assert.ok(output.includes("path match: watcher"));
    assert.ok(output.includes("fan-in: 2"));
  });

  it("formats reexport_chain entries", () => {
    const merged = {
      files: [
        {
          path: "src/index.js",
          graphSignal: "reexport_chain",
          matchedTerms: ["useState"],
          zoektHit: null,
          fanIn: 0,
          fusedScore: 112,
        },
      ],
    };

    const output = formatRetrieval(merged);
    assert.ok(output.includes("re-exports useState"));
  });
});

// ─── Mixed results (graph + zoekt) ─────────────────────────────────

describe("formatRetrieval — mixed results", () => {
  it("includes zoekt line references", () => {
    const merged = {
      files: [
        {
          path: "lib/intel.js",
          graphSignal: "exported_symbol",
          matchedTerms: ["withQueue"],
          zoektHit: { lineNumber: 37, line: "function withQueue(rootAbs, fn) {" },
          fanIn: 13,
          fusedScore: 228,
        },
      ],
    };

    const output = formatRetrieval(merged);
    assert.ok(output.includes("`lib/intel.js`"));
    assert.ok(output.includes("exports withQueue"));
    assert.ok(output.includes("L37:"));
    assert.ok(output.includes("fan-in: 13"));
  });

  it("omits fan-in when zero", () => {
    const merged = {
      files: [
        {
          path: "lib/new.js",
          graphSignal: null,
          matchedTerms: [],
          zoektHit: { lineNumber: 1, line: "const x = 1;" },
          fanIn: 0,
          fusedScore: 50,
        },
      ],
    };

    const output = formatRetrieval(merged);
    assert.ok(!output.includes("fan-in:"));
  });
});

// ─── maxChars clamping ──────────────────────────────────────────────

describe("formatRetrieval — maxChars clamping", () => {
  it("truncates when results exceed maxChars", () => {
    const merged = {
      files: Array.from({ length: 20 }, (_, i) => ({
        path: `lib/very-long-module-name-for-file-${i}.js`,
        graphSignal: "exported_symbol",
        matchedTerms: [`veryLongSymbolName${i}`],
        zoektHit: null,
        fanIn: i,
        fusedScore: 200 - i,
      })),
    };

    const output = formatRetrieval(merged, { maxChars: 300 });
    assert.ok(output.length <= 350); // Allow some tolerance for the tool reminder
    assert.ok(output.includes("### Relevant files"));
    // Should have fewer than 20 entries
    const lineCount = output.split("\n").filter((l) => l.startsWith("- ")).length;
    assert.ok(lineCount < 20);
    assert.ok(lineCount >= 1);
  });

  it("always includes at least one file entry", () => {
    const merged = {
      files: [
        {
          path: "lib/very-long-name-that-would-exceed-budget.js",
          graphSignal: "exported_symbol",
          matchedTerms: ["someLongIdentifier"],
          zoektHit: null,
          fanIn: 5,
          fusedScore: 140,
        },
      ],
    };

    const output = formatRetrieval(merged, { maxChars: 50 });
    // Even with tiny maxChars, first file should still appear
    assert.ok(output.includes("### Relevant files"));
    assert.ok(output.includes("- `"));
  });
});

// ─── Empty results ──────────────────────────────────────────────────

describe("formatRetrieval — empty results", () => {
  it("returns empty string for no files", () => {
    assert.equal(formatRetrieval({ files: [] }), "");
  });

  it("returns empty string for null input", () => {
    assert.equal(formatRetrieval(null), "");
  });

  it("returns empty string for undefined input", () => {
    assert.equal(formatRetrieval(undefined), "");
  });
});

// ─── Tool reminder ──────────────────────────────────────────────────

describe("formatRetrieval — tool reminder", () => {
  it("includes sextant_search MCP tool reminder at the end", () => {
    const merged = {
      files: [
        {
          path: "lib/graph.js",
          graphSignal: "exported_symbol",
          matchedTerms: ["loadDb"],
          zoektHit: null,
          fanIn: 5,
          fusedScore: 140,
        },
      ],
    };

    const output = formatRetrieval(merged);
    assert.ok(output.endsWith("Use the `sextant_search` MCP tool for deeper code search."));
  });

  it("tool reminder references the actual MCP tool name", () => {
    const merged = {
      files: [
        {
          path: "a.js",
          graphSignal: null,
          matchedTerms: [],
          zoektHit: null,
          fanIn: 0,
          fusedScore: 10,
        },
      ],
    };

    const output = formatRetrieval(merged);
    // Guard against regressing to the old ghost reference `sextant search` (no underscore).
    assert.ok(output.includes("sextant_search"));
    assert.ok(!/\bsextant search\b/.test(output));
  });
});
