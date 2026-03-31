"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Absolute paths for cache manipulation
const jsExtractorPath = require.resolve("../../lib/extractors/javascript");
const astModPath = require.resolve("../../lib/extractors/js_ast_exports");

// ── Helpers: load javascript.js with a stubbed AST extractor ──

// WHY: javascript.js destructures extractExportsAST at require-time, so mutating
// the module's export after the fact does nothing.  We must evict both modules
// from require.cache, install our stub, then re-require javascript.js so it
// picks up the stub during its top-level `require("./js_ast_exports")`.

function loadWithASTStub(stubFn) {
  // Save original cached modules
  const savedJS = require.cache[jsExtractorPath];
  const savedAST = require.cache[astModPath];

  // Evict both from cache
  delete require.cache[jsExtractorPath];
  delete require.cache[astModPath];

  // Install stub as the cached module for js_ast_exports
  require.cache[astModPath] = {
    id: astModPath,
    filename: astModPath,
    loaded: true,
    exports: { extractExportsAST: stubFn },
  };

  // Now require javascript.js — it will pick up our stub
  const mod = require(jsExtractorPath);

  // Restore originals so other tests are unaffected
  delete require.cache[jsExtractorPath];
  delete require.cache[astModPath];
  if (savedJS) require.cache[jsExtractorPath] = savedJS;
  if (savedAST) require.cache[astModPath] = savedAST;

  return mod;
}

// ── Tests: AST returns null → regex fallback ──

describe("extractExports: AST→regex fallback", () => {
  let extractExports;

  beforeEach(() => {
    // Stub AST extractor to always return null (simulates parse failure)
    const mod = loadWithASTStub(() => null);
    extractExports = mod.extractExports;
  });

  it("fallback finds `export function greet()`", () => {
    const result = extractExports("export function greet(name) { return name; }", "lib.js");
    const match = result.find((r) => r.name === "greet");
    assert.ok(match, "should find greet export via regex fallback");
    assert.equal(match.kind, "named");
  });

  it("fallback finds `export const FOO = ...`", () => {
    const result = extractExports("export const FOO = 42;", "lib.js");
    const match = result.find((r) => r.name === "FOO");
    assert.ok(match, "should find FOO export via regex fallback");
    assert.equal(match.kind, "named");
  });

  it("fallback finds `module.exports = ...`", () => {
    const result = extractExports("module.exports = { run };", "lib.js");
    const match = result.find((r) => r.name === "default" && r.kind === "cjs-default");
    assert.ok(match, "should find cjs-default export via regex fallback");
  });

  it("fallback does NOT capture re-exports — regex skips `export { X } from`", () => {
    // WHY: extractExportsRegex explicitly uses (?!\s*from) on the `export { }` regex,
    // so `export { X } from './y'` produces no export entries at all.  The AST path
    // is the only way to get re-exports with the `from` field.  This is a known
    // limitation of the regex fallback — re-exports are invisible to it.
    const result = extractExports('export { useState } from "./hooks";', "index.js");
    const match = result.find((r) => r.name === "useState");
    assert.equal(match, undefined, "regex fallback should not capture re-exports");
  });
});

// ── Test: AST returns [] (empty array, not null) → no fallback ──

describe("extractExports: AST returns empty array", () => {
  it("returns [] without calling regex fallback", () => {
    let regexCalled = false;

    // Stub returns empty array — a valid "no exports" result, not a parse failure
    const mod = loadWithASTStub(() => []);
    const result = mod.extractExports("module.exports = { run };", "lib.js");

    // If regex ran, it would find cjs-default.  Empty result proves regex was skipped.
    assert.ok(Array.isArray(result), "should return an array");
    assert.equal(result.length, 0, "should be empty — AST said no exports, regex not consulted");
  });
});

// ── Test: Normal operation (no stub) — AST path produces `from` on re-exports ──

describe("extractExports: normal AST path (no stub)", () => {
  // Use the real, unmodified module
  const { extractExports: realExtractExports } = require("../../lib/extractors/javascript");

  it("AST path produces re-exports with `from` field", () => {
    const result = realExtractExports('export { useState } from "./hooks";', "index.js");
    assert.ok(result !== null, "should not be null");
    const match = result.find((r) => r.name === "useState");
    assert.ok(match, "should find useState");
    assert.equal(match.kind, "reexport");
    assert.equal(match.from, "./hooks", "AST path preserves the source specifier");
  });

  it("AST path finds named exports", () => {
    const result = realExtractExports("export function greet() {}", "lib.js");
    assert.ok(result !== null);
    const match = result.find((r) => r.name === "greet");
    assert.ok(match, "should find greet");
    assert.equal(match.kind, "named");
  });
});
