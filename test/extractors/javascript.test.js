"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { extractImports, extractExports } = require("../../lib/extractors/javascript");

describe("extractImports", () => {
  it("ESM default import", () => {
    const result = extractImports('import React from "react";', "app.js");
    assert.ok(result.some((r) => r.specifier === "react" && r.kind === "import"));
  });

  it("ESM named import", () => {
    const result = extractImports('import { useState } from "react";', "app.js");
    assert.ok(result.some((r) => r.specifier === "react" && r.kind === "import"));
  });

  it("bare side-effect import", () => {
    const result = extractImports('import "side-effect";', "app.js");
    assert.ok(result.some((r) => r.specifier === "side-effect" && r.kind === "import"));
  });

  it("re-export from", () => {
    const result = extractImports('export { useState } from "./hooks";', "index.js");
    assert.ok(result.some((r) => r.specifier === "./hooks" && r.kind === "export-from"));
  });

  it("export * from", () => {
    const result = extractImports('export * from "./utils";', "index.js");
    assert.ok(result.some((r) => r.specifier === "./utils" && r.kind === "export-from"));
  });

  it("dynamic import", () => {
    const result = extractImports('const mod = import("./lazy");', "app.js");
    assert.ok(result.some((r) => r.specifier === "./lazy" && r.kind === "dynamic"));
  });

  it("require call", () => {
    const result = extractImports('const fs = require("fs");', "app.js");
    assert.ok(result.some((r) => r.specifier === "fs" && r.kind === "require"));
  });

  it("imports in block comments are ignored", () => {
    const code = '/* import React from "react"; */\nconst x = 1;';
    const result = extractImports(code, "app.js");
    assert.equal(result.length, 0);
  });

  it("imports in line comments are ignored", () => {
    const code = '// import React from "react";\nconst x = 1;';
    const result = extractImports(code, "app.js");
    assert.equal(result.length, 0);
  });

  it("multi-line imports", () => {
    const code = `import {
  useState,
  useEffect,
  useCallback
} from "react";`;
    const result = extractImports(code, "app.js");
    assert.ok(result.some((r) => r.specifier === "react"));
  });

  it("deduplication", () => {
    const code = `
import { useState } from "react";
import { useEffect } from "react";
`;
    const result = extractImports(code, "app.js");
    const reactImports = result.filter((r) => r.specifier === "react" && r.kind === "import");
    assert.equal(reactImports.length, 1);
  });

  it("empty code returns []", () => {
    assert.deepEqual(extractImports("", "a.js"), []);
  });

  it("null code returns []", () => {
    assert.deepEqual(extractImports(null, "a.js"), []);
  });

  it("TypeScript type import", () => {
    const result = extractImports('import type { Foo } from "./types";', "app.ts");
    assert.ok(result.some((r) => r.specifier === "./types" && r.kind === "import"));
  });
});

describe("extractExports", () => {
  it("export default", () => {
    const result = extractExports("export default function App() {}", "app.js");
    assert.ok(result.some((r) => r.kind === "default"));
  });

  it("named export function", () => {
    const result = extractExports("export function greet() {}", "app.js");
    assert.ok(result.some((r) => r.name === "greet" && r.kind === "named"));
  });

  it("named export const", () => {
    const result = extractExports("export const VERSION = '1.0';", "app.js");
    assert.ok(result.some((r) => r.name === "VERSION" && r.kind === "named"));
  });

  it("named export class", () => {
    const result = extractExports("export class Graph {}", "app.js");
    assert.ok(result.some((r) => r.name === "Graph" && r.kind === "named"));
  });

  it("module.exports CJS default", () => {
    const result = extractExports("module.exports = { foo: 1 };", "app.js");
    assert.ok(result.some((r) => r.kind === "cjs-default"));
  });

  it("exports.foo CJS named", () => {
    const result = extractExports("exports.resolveImport = resolveImport;", "app.js");
    assert.ok(result.some((r) => r.name === "resolveImport" && r.kind === "cjs-named"));
  });

  it("re-export with source (AST path)", () => {
    const result = extractExports('export { useState } from "./hooks";', "index.js");
    assert.ok(result.some((r) => r.name === "useState" && r.from === "./hooks"));
  });

  it("export * from (AST path)", () => {
    const result = extractExports('export * from "./utils";', "index.js");
    assert.ok(result.some((r) => r.name === "*" && r.kind === "reexport-all" && r.from === "./utils"));
  });

  it("empty code returns []", () => {
    assert.deepEqual(extractExports("", "a.js"), []);
  });

  it("null code returns []", () => {
    assert.deepEqual(extractExports(null, "a.js"), []);
  });
});
