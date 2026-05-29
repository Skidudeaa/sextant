"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");

const { extractImports, extractExports, extractBatch } = require("../../lib/extractors/python");

// Guard: skip all tests if python3 is unavailable.
// WHY: node:test evaluates the `skip` option at registration time (while the
// describe() body runs), BEFORE any before() hook fires. Probing inside a
// before() hook left pythonAvailable=false at the moment skip was captured, so
// these 8 tests were silently skipped on every machine — even with python3
// present. The probe must run synchronously at module load.
const pythonAvailable =
  spawnSync("python3", ["--version"], { encoding: "utf8", timeout: 5000 }).status === 0;

describe("python extractor", () => {
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

    it("__all__ scopes exports but preserves the construct kind of locally-defined names", { skip: !pythonAvailable && "python3 not available" }, () => {
      // WHY: __all__ is the authoritative export LIST (internal names excluded),
      // but a name listed there is either locally DEFINED or merely re-exported.
      // normalizeExports cross-references __all__ against the local defs so a
      // locally-defined name keeps its construct kind (function/class/const) and
      // only a name with no local definition (a barrel re-export) gets "explicit".
      // This distinction is load-bearing: graph-retrieve uses "explicit" to mean
      // "re-export" and withholds the canonical-def floor from it (B3 edge fix).
      const code = `
from app.other import ReExported

__all__ = ["greet", "Model", "CONST", "ReExported"]

def greet():
    pass

class Model:
    pass

CONST = 42

def _internal():
    pass
`;
      const result = extractExports(code, "app.py");
      const byName = Object.fromEntries(result.map((r) => [r.name, r.kind]));
      // Internal (_internal) excluded; only __all__ names exported.
      assert.equal(result.length, 4);
      // Locally-defined names keep their construct kind.
      assert.equal(byName.greet, "function");
      assert.equal(byName.Model, "class");
      assert.equal(byName.CONST, "const");
      // Re-exported (imported, not defined here) → explicit.
      assert.equal(byName.ReExported, "explicit");
    });

    it("captures annotated ALLCAPS module constants (ast.AnnAssign)", { skip: !pythonAvailable && "python3 not available" }, () => {
      // WHY: a typed module constant `FLAG_REGISTRY: Dict[str, bool] = {...}` is
      // an ast.AnnAssign, not ast.Assign — the extractor missed it, leaving the
      // constant with NO export signal so a barrel re-exporting it outranked the
      // real def (B3 constant edge). Annotated ALLCAPS constants WITH a value are
      // now exported as kind "const"; a bare annotation (no value) is a
      // declaration, not a definition, and is excluded.
      const code = `
from typing import Dict

FLAG_REGISTRY: Dict[str, bool] = {"a": True}
DECLARED_ONLY: int
lower_annotated: int = 5
`;
      const result = extractExports(code, "config.py");
      const byName = Object.fromEntries(result.map((r) => [r.name, r.kind]));
      assert.equal(byName.FLAG_REGISTRY, "const");
      assert.ok(!("DECLARED_ONLY" in byName), "bare annotation (no value) is not an export");
      assert.ok(!("lower_annotated" in byName), "non-ALLCAPS annotated assignment is not a constant export");
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
