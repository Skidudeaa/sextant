"use strict";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");

const { extractImports, extractExports, extractBatch } = require("../../lib/extractors/python");

// Guard: skip all tests if python3 is unavailable
let pythonAvailable = false;

describe("python extractor", () => {
  before(() => {
    const r = spawnSync("python3", ["--version"], { encoding: "utf8", timeout: 5000 });
    pythonAvailable = r.status === 0;
  });

  describe("extractImports", () => {
    it("import os", { skip: !pythonAvailable && "python3 not available" }, () => {
      const result = extractImports("import os\nimport sys\n", "app.py");
      assert.ok(result.some((r) => r.specifier === "os" && r.kind === "import"));
      assert.ok(result.some((r) => r.specifier === "sys" && r.kind === "import"));
    });

    it("from pkg import x", { skip: !pythonAvailable && "python3 not available" }, () => {
      const result = extractImports("from collections import OrderedDict\n", "app.py");
      assert.ok(result.some((r) => r.specifier === "collections" && r.kind === "from"));
    });

    it("relative imports", { skip: !pythonAvailable && "python3 not available" }, () => {
      const result = extractImports("from .utils import helper\n", "pkg/main.py");
      assert.ok(result.some((r) => r.specifier === ".utils" && r.kind === "relative"));
    });

    it("double-dot relative import", { skip: !pythonAvailable && "python3 not available" }, () => {
      const result = extractImports("from ..core import base\n", "pkg/sub/main.py");
      assert.ok(result.some((r) => r.specifier === "..core" && r.kind === "relative"));
    });

    it("empty code returns []", () => {
      assert.deepEqual(extractImports("", "a.py"), []);
    });

    it("null code returns []", () => {
      assert.deepEqual(extractImports(null, "a.py"), []);
    });
  });

  describe("extractExports", () => {
    it("functions and classes", { skip: !pythonAvailable && "python3 not available" }, () => {
      const code = `
def greet(name):
    pass

class MyModel:
    pass
`;
      const result = extractExports(code, "app.py");
      assert.ok(result.some((r) => r.name === "greet" && r.kind === "function"));
      assert.ok(result.some((r) => r.name === "MyModel" && r.kind === "class"));
    });

    it("__all__ list overrides defaults", { skip: !pythonAvailable && "python3 not available" }, () => {
      const code = `
__all__ = ["greet"]

def greet():
    pass

def _internal():
    pass
`;
      const result = extractExports(code, "app.py");
      assert.equal(result.length, 1);
      assert.equal(result[0].name, "greet");
      assert.equal(result[0].kind, "explicit");
    });

    it("empty code returns []", () => {
      assert.deepEqual(extractExports("", "a.py"), []);
    });
  });

  describe("extractBatch", () => {
    it("two files in one call", { skip: !pythonAvailable && "python3 not available" }, () => {
      const items = [
        { relPath: "a.py", content: "import os\ndef foo(): pass\n" },
        { relPath: "b.py", content: "from sys import argv\nclass Bar: pass\n" },
      ];
      const results = extractBatch(items);
      assert.equal(results.length, 2);

      // First file
      assert.ok(results[0].imports.some((r) => r.specifier === "os"));
      assert.ok(results[0].exports.some((r) => r.name === "foo"));

      // Second file
      assert.ok(results[1].imports.some((r) => r.specifier === "sys"));
      assert.ok(results[1].exports.some((r) => r.name === "Bar"));
    });

    it("cache hits on repeat content", { skip: !pythonAvailable && "python3 not available" }, () => {
      const items = [
        { relPath: "c.py", content: "import json\ndef load(): pass\n" },
      ];
      // First call populates cache
      const first = extractBatch(items);
      // Second call should hit cache
      const second = extractBatch(items);
      assert.deepEqual(first, second);
    });

    it("empty array returns []", () => {
      assert.deepEqual(extractBatch([]), []);
    });

    it("null returns []", () => {
      assert.deepEqual(extractBatch(null), []);
    });
  });
});
