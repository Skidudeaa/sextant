"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const registry = require("../../lib/extractors/index");

describe("extractor registry", () => {
  it("forExtension('js') returns javascript extractor", () => {
    const ext = registry.forExtension("js");
    assert.ok(ext !== null);
    assert.ok(typeof ext.extractImports === "function");
    assert.ok(typeof ext.extractExports === "function");
  });

  it("forExtension('ts') returns javascript extractor", () => {
    const ext = registry.forExtension("ts");
    assert.ok(ext !== null);
    assert.ok(typeof ext.extractImports === "function");
  });

  it("forExtension('tsx') returns javascript extractor", () => {
    const ext = registry.forExtension("tsx");
    assert.ok(ext !== null);
  });

  it("forExtension('jsx') returns javascript extractor", () => {
    const ext = registry.forExtension("jsx");
    assert.ok(ext !== null);
  });

  it("forExtension('mjs') returns javascript extractor", () => {
    const ext = registry.forExtension("mjs");
    assert.ok(ext !== null);
  });

  it("forExtension('cjs') returns javascript extractor", () => {
    const ext = registry.forExtension("cjs");
    assert.ok(ext !== null);
  });

  it("forExtension('py') returns python extractor", () => {
    const ext = registry.forExtension("py");
    assert.ok(ext !== null);
    assert.ok(typeof ext.extractImports === "function");
    assert.ok(typeof ext.extractExports === "function");
  });

  it("JS and Python extractors are different modules", () => {
    const js = registry.forExtension("js");
    const py = registry.forExtension("py");
    assert.notEqual(js, py);
  });

  it("forExtension('go') returns null", () => {
    assert.equal(registry.forExtension("go"), null);
  });

  it("forExtension('') returns null", () => {
    assert.equal(registry.forExtension(""), null);
  });

  it("forExtension('.js') with leading dot normalizes correctly", () => {
    const ext = registry.forExtension(".js");
    assert.ok(ext !== null);
  });

  it("forExtension('JS') is case-insensitive", () => {
    const ext = registry.forExtension("JS");
    assert.ok(ext !== null);
  });
});
