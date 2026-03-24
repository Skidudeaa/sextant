"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { extractImports, extractExports } = require("../lib/extractor");

describe("extractor dispatcher", () => {
  it("dispatches JS imports to javascript extractor", () => {
    const result = extractImports('import React from "react";', "js");
    assert.ok(result.some((r) => r.specifier === "react"));
  });

  it("dispatches TS imports to javascript extractor", () => {
    const result = extractImports('import { Foo } from "./foo";', "ts");
    assert.ok(result.some((r) => r.specifier === "./foo"));
  });

  it("dispatches JS exports to javascript extractor", () => {
    const result = extractExports("export function greet() {}", "js");
    assert.ok(result.some((r) => r.name === "greet"));
  });

  it("unsupported type returns [] for imports", () => {
    assert.deepEqual(extractImports("fn main() {}", "rs"), []);
  });

  it("unsupported type returns [] for exports", () => {
    assert.deepEqual(extractExports("fn main() {}", "rs"), []);
  });

  it("defaults to js when no type given", () => {
    const result = extractImports('const fs = require("fs");');
    assert.ok(result.some((r) => r.specifier === "fs"));
  });
});
