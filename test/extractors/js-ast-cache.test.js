"use strict";

// Shared JS/TS parse front-end (docs/033 Tier 2 #6).
//
// intel.js:indexOneFile calls extractImports() and extractExports() back-to-back
// on the SAME source. Each lane used to run its own parser.parse() with
// byte-identical options, so every JS/TS file was parsed TWICE — 33.2% of a
// forced scan's CPU samples were @babel/parser, about half of it redundant.
//
// These tests lock the two properties that make sharing safe: the second lane
// is served from cache (the perf win), and a DIFFERENT source is never served a
// stale AST (the correctness constraint).

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const babel = require("@babel/parser");
const cache = require("../../lib/extractors/js_ast_cache");
const { extractImportsAST } = require("../../lib/extractors/js_ast_imports");
const { extractExportsAST } = require("../../lib/extractors/js_ast_exports");

// Count real parses by wrapping the module object js_ast_cache holds a
// reference to. Restores itself so other suites are unaffected.
function countingParses(fn) {
  const original = babel.parse;
  let calls = 0;
  babel.parse = (...args) => {
    calls++;
    return original.apply(babel, args);
  };
  try {
    fn();
  } finally {
    babel.parse = original;
  }
  return calls;
}

const SRC = `
import { a } from "./mod-a";
const b = require("./mod-b");
export const value = 1;
export { a };
`;

describe("js_ast_cache — single-parse front-end (docs/033)", () => {
  beforeEach(() => cache._resetCache());

  it("parses once when both extractor lanes run on the same source", () => {
    const calls = countingParses(() => {
      extractImportsAST(SRC, "ts");
      extractExportsAST(SRC, "ts");
    });
    assert.equal(calls, 1, "the export lane must reuse the import lane's AST");
  });

  it("returns the identical AST object on a repeat parse of the same source", () => {
    const first = cache.parseJs(SRC);
    const second = cache.parseJs(SRC);
    assert.ok(first, "expected a parse result");
    assert.equal(first, second, "same source must return the cached AST object");
  });

  it("re-parses when the source changes — a stale AST is never served", () => {
    const other = "export const different = 2;\n";
    const calls = countingParses(() => {
      cache.parseJs(SRC);
      cache.parseJs(other);
      cache.parseJs(SRC); // evicted by `other`; must parse again
    });
    assert.equal(calls, 3, "each distinct source must be parsed");
    // And the content actually differs — not just a re-parse of the same thing.
    assert.deepEqual(
      extractExportsAST(other, "js").map((e) => e.name),
      ["different"]
    );
  });

  it("caches a parse FAILURE so the second lane does not retry it", () => {
    // errorRecovery makes @babel/parser tolerant, so use input it cannot
    // produce a program for at all.
    const bad = "const = = = ;;; function ((( {{{ ]]]";
    const calls = countingParses(() => {
      extractImportsAST(bad, "js");
      extractExportsAST(bad, "js");
    });
    assert.equal(calls, 1, "a failed parse must not be re-attempted by the next lane");
  });

  it("still extracts correctly through the shared front-end", () => {
    // Behavior parity: sharing the AST must not change either lane's output.
    const imports = extractImportsAST(SRC, "ts");
    const exports = extractExportsAST(SRC, "ts");
    assert.deepEqual(imports.map((i) => i.specifier).sort(), ["./mod-a", "./mod-b"]);
    assert.deepEqual(exports.map((e) => e.name).sort(), ["a", "value"]);
  });

  it("treats empty source as 'no results', never as a parse failure", () => {
    assert.deepEqual(extractImportsAST("", "js"), []);
    assert.deepEqual(extractExportsAST("", "js"), []);
  });
});
