"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  extractSymbolDef,
  computeEnhancedSignals,
  noiseWordRatio,
  isPythonPublicSymbol,
} = require("../lib/scoring");

describe("extractSymbolDef", () => {
  it("Python def", () => {
    assert.equal(extractSymbolDef("def greet(name):"), "greet");
  });

  it("Python async def", () => {
    assert.equal(extractSymbolDef("async def fetch_data():"), "fetch_data");
  });

  it("Python class", () => {
    assert.equal(extractSymbolDef("class MyModel(Base):"), "MyModel");
  });

  it("Python class with colon only", () => {
    assert.equal(extractSymbolDef("class Simple:"), "Simple");
  });

  it("JS export function", () => {
    assert.equal(extractSymbolDef("export function resolveImport(root) {"), "resolveImport");
  });

  it("JS export const arrow", () => {
    assert.equal(extractSymbolDef("export const handler = (req) => {"), "handler");
  });

  it("JS export class", () => {
    assert.equal(extractSymbolDef("export class Graph {"), "Graph");
  });

  it("Go func", () => {
    assert.equal(extractSymbolDef("func HandleRequest(w http.ResponseWriter, r *http.Request) {"), "HandleRequest");
  });

  it("Go method receiver", () => {
    assert.equal(extractSymbolDef("func (s *Server) Start() error {"), "Start");
  });

  it("Rust pub fn", () => {
    assert.equal(extractSymbolDef("pub fn process(input: &str) -> Result<()> {"), "process");
  });

  it("Rust pub async fn", () => {
    assert.equal(extractSymbolDef("pub async fn fetch(url: &str) -> Response {"), "fetch");
  });

  it("Rust struct", () => {
    assert.equal(extractSymbolDef("pub struct Config {"), "Config");
  });

  it("non-definition returns null", () => {
    assert.equal(extractSymbolDef("  console.log('hello');"), null);
  });

  it("empty string returns null", () => {
    assert.equal(extractSymbolDef(""), null);
  });

  it("non-string returns null", () => {
    assert.equal(extractSymbolDef(null), null);
    assert.equal(extractSymbolDef(undefined), null);
    assert.equal(extractSymbolDef(42), null);
  });

  it("CommonJS exports.X assignment", () => {
    assert.equal(extractSymbolDef("exports.resolveImport = function resolveImport(root) {"), "resolveImport");
  });

  // WHY: these tests lock in the JS/TS value-const pattern so future regex
  // edits don't silently regress it.  The motivating case is queries like
  // "resolutionPct" where the defining site is `const resolutionPct =
  // computeValue(...)` rather than a function declaration.
  describe("JS/TS value const/let/var", () => {
    it("recognizes const value assignments", () => {
      assert.equal(
        extractSymbolDef("const resolutionPct = localTotal > 0 ? Math.round(n) : 100;"),
        "resolutionPct"
      );
    });

    it("recognizes let and var assignments", () => {
      assert.equal(extractSymbolDef("let counter = 0"), "counter");
      assert.equal(extractSymbolDef("var legacyVal = something()"), "legacyVal");
    });

    it("recognizes TypeScript-typed const", () => {
      assert.equal(extractSymbolDef("const max: number = 42"), "max");
      assert.equal(extractSymbolDef("const cfg: Config = loadConfig();"), "cfg");
    });

    it("recognizes export const", () => {
      assert.equal(extractSymbolDef("export const HIT_COUNT_WEIGHT = 0.075;"), "HIT_COUNT_WEIGHT");
    });

    it("REJECTS require() RHS so imports aren't mis-flagged as defs", () => {
      assert.equal(extractSymbolDef("const scoring = require('./scoring');"), null);
      assert.equal(extractSymbolDef("const path = require(\"path\");"), null);
    });

    it("REJECTS import() RHS", () => {
      assert.equal(extractSymbolDef("const lazy = import('./lazy')"), null);
    });

    it("REJECTS destructuring (no single defined symbol on the line)", () => {
      assert.equal(extractSymbolDef("const { a, b } = obj"), null);
      assert.equal(extractSymbolDef("const [x, y] = arr"), null);
    });

    it("does not interfere with existing arrow-function pattern", () => {
      // Arrow functions must still extract as "rerankFiles", not lose the match.
      assert.equal(extractSymbolDef("const rerankFiles = (files) => files"), "rerankFiles");
    });
  });
});

describe("computeEnhancedSignals", () => {
  it("exact symbol match gives +40%", () => {
    const hit = { score: 10, line: "export function resolveImport(root) {", path: "lib/resolver.js" };
    const result = computeEnhancedSignals(hit, ["resolveImport"]);
    // exact_symbol +40% = 4, symbol_contains_query +12% = 1.2, export_match +10% = 1
    // adjustment should include +40% for exact symbol match
    assert.ok(result.adjustment >= 4, `expected adjustment >= 4, got ${result.adjustment}`);
  });

  it("explain mode returns signals array", () => {
    const hit = { score: 10, line: "export function resolveImport(root) {", path: "lib/resolver.js" };
    const result = computeEnhancedSignals(hit, ["resolveImport"], { explainHits: true });
    assert.ok(Array.isArray(result.signals));
    assert.ok(result.signals.some((s) => s.includes("exact_symbol")));
  });

  it("export match gives +10%", () => {
    const hit = { score: 10, line: "export const myThing = 42;", path: "lib/foo.js" };
    const result = computeEnhancedSignals(hit, ["myThing"], { explainHits: true });
    assert.ok(result.signals.some((s) => s.includes("export_match")));
  });

  it("noise penalty applies for high noise ratio", () => {
    const hit = { score: 10, line: "const let var function class return import export", path: "a.js" };
    const result = computeEnhancedSignals(hit, ["nothing"], { explainHits: true });
    assert.ok(result.signals.some((s) => s.includes("noise_ratio")));
    assert.ok(result.adjustment < 0, "noise penalty should decrease adjustment");
  });

  it("definition-site boost via symbol_contains_query", () => {
    const hit = { score: 10, line: "function extractImports(code) {", path: "lib/extractor.js" };
    const result = computeEnhancedSignals(hit, ["extract"], { explainHits: true });
    assert.ok(result.signals.some((s) => s.includes("symbol_contains_query")));
  });

  it("non-finite score defaults to base 1", () => {
    const hit = { score: NaN, line: "def greet():", path: "a.py" };
    const result = computeEnhancedSignals(hit, ["greet"]);
    assert.ok(Number.isFinite(result.adjustment));
  });

  it("Python public symbol boost", () => {
    const hit = { score: 10, line: "def process_data(x):", path: "app.py" };
    const result = computeEnhancedSignals(hit, ["process_data"], { explainHits: true });
    assert.ok(result.signals.some((s) => s.includes("python_public")));
  });

  it("no signals returned in non-explain mode", () => {
    const hit = { score: 10, line: "function foo() {", path: "a.js" };
    const result = computeEnhancedSignals(hit, ["foo"]);
    assert.equal(result.signals, undefined);
  });
});

describe("noiseWordRatio", () => {
  it("all noise words", () => {
    const ratio = noiseWordRatio("const let var function class return");
    assert.equal(ratio, 1);
  });

  it("all meaningful words", () => {
    const ratio = noiseWordRatio("resolveImport extractSymbol computeSignals");
    assert.equal(ratio, 0);
  });

  it("mixed noise and meaningful", () => {
    const ratio = noiseWordRatio("const resolveImport function");
    // 2 noise out of 3 words
    assert.ok(ratio > 0.5 && ratio < 0.8, `expected ratio ~0.67, got ${ratio}`);
  });

  it("empty string returns 0", () => {
    assert.equal(noiseWordRatio(""), 0);
  });

  it("non-string returns 0", () => {
    assert.equal(noiseWordRatio(null), 0);
    assert.equal(noiseWordRatio(undefined), 0);
  });
});

describe("isPythonPublicSymbol", () => {
  it("public def returns true", () => {
    assert.equal(isPythonPublicSymbol("def greet(name):"), true);
  });

  it("public class returns true", () => {
    assert.equal(isPythonPublicSymbol("class MyModel:"), true);
  });

  it("async def returns true", () => {
    assert.equal(isPythonPublicSymbol("async def fetch():"), true);
  });

  it("_private def returns false", () => {
    assert.equal(isPythonPublicSymbol("def _internal():"), false);
  });

  it("__dunder returns false", () => {
    assert.equal(isPythonPublicSymbol("def __init__(self):"), false);
  });

  it("non-definition returns false", () => {
    assert.equal(isPythonPublicSymbol("x = 42"), false);
  });

  it("non-string returns false", () => {
    assert.equal(isPythonPublicSymbol(null), false);
    assert.equal(isPythonPublicSymbol(undefined), false);
  });
});

// ─── caseSensitive option (Swift bug-2 closure) ──────────────────────
//
// WHY: The hook merge layer passes case-preserved queryTerms with
// { caseSensitive: true } so consumer-line variables (`let uri = URI(...)`)
// don't false-match the type query `URI`.  The CLI/MCP path keeps default
// (case-insensitive) for user-typing convenience.

describe("computeEnhancedSignals — caseSensitive option", () => {
  it("caseSensitive:true on Swift consumer line suppresses exact_symbol AND symbol_contains_query", () => {
    // `let uri = URI(...)` → extractSymbolDef returns "uri" (the variable).
    // Query "URI" is case-preserved.  Both Signal 1 (exact_symbol) and
    // Signal 4 (symbol_contains_query) must reject this — that's the whole
    // point of the fix: test-file consumer lines no longer inherit a +52%
    // boost they don't deserve.
    const hit = { score: 100, line: "    let uri = URI(scheme: .https, host: \"a\")", path: "X.swift" };
    const result = computeEnhancedSignals(hit, ["URI"], { caseSensitive: true, explainHits: true });
    assert.equal(
      result.signals.some((s) => s.includes("exact_symbol")),
      false,
      `expected NO exact_symbol signal on consumer line, got: ${JSON.stringify(result.signals)}`
    );
    assert.equal(
      result.signals.some((s) => s.includes("symbol_contains_query")),
      false,
      `expected NO symbol_contains_query signal on consumer line, got: ${JSON.stringify(result.signals)}`
    );
  });

  it("caseSensitive:false (default) still false-fires on consumer line — regression guard for CLI path", () => {
    // CLI/MCP path uses default opts (no caseSensitive).  The existing
    // case-insensitive comparisons stay in place for user-typing
    // convenience there.  This test pins that behavior so future refactors
    // don't accidentally make the CLI path strict.
    const hit = { score: 100, line: "    let uri = URI(scheme: .https, host: \"a\")", path: "X.swift" };
    const result = computeEnhancedSignals(hit, ["URI"], { explainHits: true });
    assert.equal(
      result.signals.some((s) => s.includes("exact_symbol")),
      true,
      "default-mode SHOULD fire exact_symbol (CLI back-compat)"
    );
  });

  it("caseSensitive:true on canonical Swift def line still fires exact_symbol", () => {
    // Positive evidence: when query case matches the symbol case,
    // case-sensitive mode behaves identically to the old insensitive mode
    // for the canonical def line.  The +40% boost still lands.
    const hit = { score: 100, line: "public struct URI: Codable, Sendable {", path: "X.swift" };
    const result = computeEnhancedSignals(hit, ["URI"], { caseSensitive: true, explainHits: true });
    assert.equal(
      result.signals.some((s) => s.includes("exact_symbol")),
      true,
      `expected exact_symbol signal on canonical def line, got: ${JSON.stringify(result.signals)}`
    );
  });

  it("caseSensitive:true with mismatched-case query does NOT fire exact_symbol", () => {
    // Documents the accepted tradeoff at merge-results.js:86-96 in the
    // hook path: a user typing lowercase "uri" loses the +40% boost on
    // the canonical "URI" def.  Empirically this is unmeasured (0 of 40
    // eval queries are case-mismatched); the graph-side path still finds
    // the file via SQL LOWER().
    const hit = { score: 100, line: "public struct URI: Codable {", path: "X.swift" };
    const result = computeEnhancedSignals(hit, ["uri"], { caseSensitive: true, explainHits: true });
    assert.equal(
      result.signals.some((s) => s.includes("exact_symbol")),
      false,
      "lowercase query against PascalCase symbol must NOT fire exact_symbol in case-sensitive mode"
    );
  });

  it("caseSensitive:true preserves JS canonical-case behavior (`loadDb` matches `function loadDb`)", () => {
    // JS regression guard: canonical-case JS queries still get the +40%
    // boost in the hook path.  Empirically every eval query is canonical
    // case so this is the dominant path.
    const hit = { score: 100, line: "function loadDb(root) {", path: "lib/graph.js" };
    const result = computeEnhancedSignals(hit, ["loadDb"], { caseSensitive: true, explainHits: true });
    assert.equal(
      result.signals.some((s) => s.includes("exact_symbol")),
      true,
      `expected exact_symbol on canonical-case JS def, got: ${JSON.stringify(result.signals)}`
    );
  });
});
