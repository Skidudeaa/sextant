"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { extractExportsAST } = require("../../lib/extractors/js_ast_exports");

describe("extractExportsAST", () => {
  it("re-export with source: export { X } from './mod'", () => {
    const result = extractExportsAST('export { useState } from "./hooks";', "index.js");
    assert.ok(result !== null, "AST should not return null for valid code");
    const match = result.find((r) => r.name === "useState");
    assert.ok(match, "should find useState export");
    assert.equal(match.kind, "reexport");
    assert.equal(match.from, "./hooks");
  });

  it("re-export with rename: export { X as Y } from './mod'", () => {
    const result = extractExportsAST('export { foo as bar } from "./mod";', "index.js");
    assert.ok(result !== null);
    const match = result.find((r) => r.name === "bar");
    assert.ok(match, "should find renamed export bar");
    assert.equal(match.kind, "reexport");
    assert.equal(match.from, "./mod");
  });

  it("export * from gives reexport-all", () => {
    const result = extractExportsAST('export * from "./utils";', "index.js");
    assert.ok(result !== null);
    const match = result.find((r) => r.kind === "reexport-all");
    assert.ok(match, "should find reexport-all");
    assert.equal(match.name, "*");
    assert.equal(match.from, "./utils");
  });

  it("export * as ns from gives reexport-namespace", () => {
    const result = extractExportsAST('export * as utils from "./utils";', "index.js");
    assert.ok(result !== null);
    const match = result.find((r) => r.kind === "reexport-namespace");
    assert.ok(match, "should find reexport-namespace");
    assert.equal(match.name, "utils");
    assert.equal(match.from, "./utils");
  });

  it("named function declaration", () => {
    const result = extractExportsAST("export function resolve(x) { return x; }", "lib.js");
    assert.ok(result !== null);
    assert.ok(result.some((r) => r.name === "resolve" && r.kind === "named"));
  });

  it("named const declaration", () => {
    const result = extractExportsAST("export const VERSION = '1.0';", "lib.js");
    assert.ok(result !== null);
    assert.ok(result.some((r) => r.name === "VERSION" && r.kind === "named"));
  });

  it("named class declaration", () => {
    const result = extractExportsAST("export class Graph {}", "lib.js");
    assert.ok(result !== null);
    assert.ok(result.some((r) => r.name === "Graph" && r.kind === "named"));
  });

  it("export default function", () => {
    const result = extractExportsAST("export default function main() {}", "lib.js");
    assert.ok(result !== null);
    assert.ok(result.some((r) => r.name === "main" && r.kind === "default"));
  });

  it("export default anonymous", () => {
    const result = extractExportsAST("export default 42;", "lib.js");
    assert.ok(result !== null);
    assert.ok(result.some((r) => r.name === "default" && r.kind === "default"));
  });

  it("CJS module.exports = value", () => {
    const result = extractExportsAST("module.exports = { a: 1, b: 2 };", "lib.js");
    assert.ok(result !== null);
    assert.ok(result.some((r) => r.name === "default" && r.kind === "cjs-default"));
    // Also emits per-property cjs-named for object literal
    assert.ok(result.some((r) => r.name === "a" && r.kind === "cjs-named"));
    assert.ok(result.some((r) => r.name === "b" && r.kind === "cjs-named"));
  });

  it("CJS exports.foo = ...", () => {
    const result = extractExportsAST("exports.resolve = resolve;", "lib.js");
    assert.ok(result !== null);
    assert.ok(result.some((r) => r.name === "resolve" && r.kind === "cjs-named"));
  });

  it("local export { a, b }", () => {
    const code = `
const a = 1;
const b = 2;
export { a, b };
`;
    const result = extractExportsAST(code, "lib.js");
    assert.ok(result !== null);
    assert.ok(result.some((r) => r.name === "a" && r.kind === "named"));
    assert.ok(result.some((r) => r.name === "b" && r.kind === "named"));
  });

  it("deduplication of repeated exports", () => {
    const code = `
export function foo() {}
export { foo };
`;
    const result = extractExportsAST(code, "lib.js");
    assert.ok(result !== null);
    const foos = result.filter((r) => r.name === "foo" && r.kind === "named");
    assert.equal(foos.length, 1, "foo should appear once after dedup");
  });

  it("empty code returns []", () => {
    const result = extractExportsAST("", "lib.js");
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 0);
  });

  it("null code returns []", () => {
    const result = extractExportsAST(null, "lib.js");
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 0);
  });

  it("TypeScript interface export", () => {
    const result = extractExportsAST("export interface Config { key: string; }", "lib.ts");
    assert.ok(result !== null);
    assert.ok(result.some((r) => r.name === "Config" && r.kind === "type"));
  });

  it("TypeScript type alias export", () => {
    const result = extractExportsAST("export type ID = string | number;", "lib.ts");
    assert.ok(result !== null);
    assert.ok(result.some((r) => r.name === "ID" && r.kind === "type"));
  });

  it("type re-export: export type { Foo } from './types'", () => {
    const result = extractExportsAST('export type { Foo } from "./types";', "index.ts");
    assert.ok(result !== null);
    const match = result.find((r) => r.name === "Foo");
    assert.ok(match, "should find Foo");
    assert.equal(match.kind, "type-reexport");
    assert.equal(match.from, "./types");
  });
});
