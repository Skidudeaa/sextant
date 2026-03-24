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
