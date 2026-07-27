"use strict";

// PYTHON BATCH EXTRACTION — the failure paths (docs/035 #9).
//
// `extractBatch` has existed since 918fde8 (2026-03-24), shipped explicitly as
// "callers opt in", and no caller ever opted in — so its fallback machinery has
// never been exercised by a test. docs/035 named that the blocker on wiring it,
// because every failure mode here is a PERFORMANCE cliff with correct output:
// the batch silently degrades to per-file and the speedup disappears on exactly
// the large repos it exists for. Nothing would fail; it would just get slow.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const python = require("../lib/extractors/python");

const SRC = (i) => `import os
from .sib import helper as aliased

CONFIG_${i}: dict = {"on": True}

class Widget${i}:
    def render(self): return "${i}"

def build_${i}(): return None

__all__ = ["Widget${i}", "build_${i}", "CONFIG_${i}"]
`;

describe("extractBatch — equivalence with the per-file path", () => {
  it("produces byte-identical imports and exports", () => {
    // The property the whole optimization rests on. If this ever diverges, the
    // batch path is not an optimization, it is a second extractor.
    const items = [0, 1, 2, 3, 4].map((i) => ({
      relPath: `pkg/mod_${i}.py`,
      content: SRC(i) + `\n# unique-${i}\n`,
    }));
    const batch = python.extractBatch(items);
    for (let i = 0; i < items.length; i++) {
      const imports = python.extractImports(items[i].content, items[i].relPath);
      const exports = python.extractExports(items[i].content, items[i].relPath);
      assert.deepStrictEqual(batch[i].imports, imports, `imports differ for ${items[i].relPath}`);
      assert.deepStrictEqual(batch[i].exports, exports, `exports differ for ${items[i].relPath}`);
    }
  });

  it("captures the annotated module constant py-penalty-001 depends on", () => {
    // AnnAssign capture (`X: T = {...}`) is what makes FLAG_REGISTRY a floorable
    // `const` export. If batch mode lost it, the def-over-barrel guard would
    // regress only on repos large enough to batch — the worst possible shape.
    const [r] = python.extractBatch([{ relPath: "a.py", content: SRC(99) }]);
    assert.ok(r.exports.some((e) => e.name === "CONFIG_99"), JSON.stringify(r.exports));
  });

  it("is total on empty and degenerate input", () => {
    assert.deepStrictEqual(python.extractBatch([]), []);
    assert.deepStrictEqual(python.extractBatch(null), []);
    const [r] = python.extractBatch([{ relPath: "empty.py", content: "" }]);
    assert.deepStrictEqual(r.imports, []);
    assert.deepStrictEqual(r.exports, []);
  });
});

describe("extractBatch — a malformed file must not cost the chunk", () => {
  it("a SYNTAX-broken file degrades to empty and its neighbours still extract", () => {
    // NOTE ON WHAT THIS DOES AND DOES NOT PROVE: a syntax error is caught by
    // extract() itself, so this exercises the ORDINARY path, not the per-item
    // isolation added in python_ast.py. It is still the case that matters most
    // in practice — malformed source is common — and it locks batch/per-file
    // parity for it. The isolation proper is unreachable from here and is
    // tested at the Python layer instead (see below).
    const items = [
      { relPath: "good_a.py", content: SRC(1) },
      { relPath: "broken.py", content: "def (((( totally not python\n" },
      { relPath: "good_b.py", content: SRC(2) },
    ];
    const out = python.extractBatch(items);
    assert.equal(out.length, 3);
    assert.ok(out[0].exports.some((e) => e.name === "Widget1"), "neighbour before the bad file");
    assert.deepStrictEqual(out[1].exports, [], "the bad file degrades to empty, as single-file does");
    assert.deepStrictEqual(out[1].imports, []);
    assert.ok(out[2].exports.some((e) => e.name === "Widget2"), "neighbour after the bad file");
  });

  it("a broken file yields the SAME result batched as it does per-file", () => {
    // The degradation must be identical in both modes, or batching changes what
    // sextant believes about a malformed file.
    const bad = "def (((( totally not python\n";
    const [b] = python.extractBatch([{ relPath: "broken.py", content: bad }]);
    assert.deepStrictEqual(b.imports, python.extractImports(bad, "broken.py"));
    assert.deepStrictEqual(b.exports, python.extractExports(bad, "broken.py"));
  });
});

describe("extractBatch — bounded chunking", () => {
  it("handles a batch larger than one chunk, in order", () => {
    // BATCH_MAX_FILES is 250; 260 items must cross a chunk boundary and still
    // come back aligned 1:1 with the input.
    const items = [];
    for (let i = 0; i < 260; i++) {
      items.push({ relPath: `pkg/c_${i}.py`, content: SRC(i) + `\n# c${i}\n` });
    }
    const out = python.extractBatch(items);
    assert.equal(out.length, 260);
    // Spot-check across the boundary: alignment is the thing chunking can break.
    for (const i of [0, 1, 249, 250, 251, 259]) {
      assert.ok(
        out[i].exports.some((e) => e.name === `Widget${i}`),
        `result ${i} is misaligned: ${JSON.stringify(out[i].exports)}`
      );
    }
  });

  it("serves repeat content from the AST cache", () => {
    const content = SRC(7) + "\n# cached\n";
    const first = python.extractBatch([{ relPath: "x.py", content }]);
    const second = python.extractBatch([{ relPath: "x.py", content }]);
    assert.deepStrictEqual(second[0], first[0]);
  });
});

describe("python_ast.py batch mode — per-item isolation (tested where it is reachable)", () => {
  // HONEST SCOPE. The isolation added in python_ast.py guards against an
  // exception that extract() does NOT catch (it catches only SyntaxError).
  // It is NOT reachable through extractBatch: the JS side hashes `content` with
  // crypto before spawning, so a non-string throws in Node first, and no SOURCE
  // string I could construct reaches it either — docs/035 named RecursionError,
  // which CPython 3.12 turns into a caught SyntaxError ("too many nested
  // parentheses"), and huge int literals, NUL bytes and deep nesting are all
  // SyntaxError too.
  //
  // So this drives the Python entry point directly, where a malformed ITEM is
  // reachable, and asserts the property the isolation exists for: one bad item
  // must not abort its chunk. Testing it at the JS layer would be theatre.
  const { spawnSync } = require("child_process");
  const pathMod = require("path");
  const SCRIPT = pathMod.join(__dirname, "..", "lib", "extractors", "python_ast.py");

  function runBatch(items) {
    return spawnSync("python3", [SCRIPT], {
      input: JSON.stringify({ mode: "batch_extract", items }),
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
  }

  it("survives an item whose content is not a string", () => {
    // ast.parse(5) raises TypeError, which extract() does not catch. Before the
    // isolation this exited non-zero and the JS caller re-extracted the WHOLE
    // chunk one file at a time — correct output, lost speedup, no test.
    const r = runBatch([
      { path: "good_a.py", content: "import os\ndef f(): pass\n__all__ = ['f']\n" },
      { path: "bad.py", content: 5 },
      { path: "good_b.py", content: "import sys\ndef g(): pass\n__all__ = ['g']\n" },
    ]);
    assert.equal(r.status, 0, `chunk must not abort; stderr: ${(r.stderr || "").slice(0, 300)}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.results.length, 3);
    assert.ok(out.results[0].exports.functions.includes("f"), "neighbour before survives");
    assert.deepStrictEqual(out.results[1].imports, [], "the bad item degrades to empty");
    assert.deepStrictEqual(out.results[1].exports.functions, []);
    assert.ok(out.results[2].exports.functions.includes("g"), "neighbour after survives");
  });

  it("the degraded shape matches what single-file mode returns", () => {
    // Batch and per-file must agree on failure too, or batching changes what
    // sextant believes about a file it could not parse.
    const r = runBatch([{ path: "bad.py", content: 5 }]);
    const out = JSON.parse(r.stdout).results[0];
    assert.deepStrictEqual(out.imports, []);
    assert.deepStrictEqual(out.exports, {
      functions: [],
      classes: [],
      assignments: [],
      all: null,
    });
  });
});
