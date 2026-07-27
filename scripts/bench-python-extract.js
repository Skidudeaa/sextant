#!/usr/bin/env node
"use strict";

// COMMITTED PERF GATE for the Python batch extractor (docs/035 #9).
//
// docs/035 marked `extractBatch` "INERT UNTIL A FIXTURE EXISTS": the perf claim
// (8.8-14.2x) was measured against /root/jan25, an uncommitted external repo,
// which collides with CLAUDE.md's own rule that a win claim needs a committed
// fixture. `fixtures/python-eval` is 9 files (~0.45s) — far too small to show a
// per-spawn saving, because the thing being measured IS the spawn count.
//
// A generator rather than N committed files, deliberately: 200+ .py files would
// bloat the repo, and every one of them would be indexed by sextant's own scan,
// polluting the self-eval corpus this project measures itself on. The corpus is
// DETERMINISTIC (no RNG, no Date) so two runs on the same machine are
// comparable and CI can gate on the ratio.
//
//   node scripts/bench-python-extract.js            # 200 files, human output
//   node scripts/bench-python-extract.js --json     # machine-readable
//   node scripts/bench-python-extract.js --files 500
//
// Reports the per-file vs batch wall-clock ratio AND asserts byte-identical
// output, because a speedup that changes results is not a speedup.

const path = require("path");
const os = require("os");
const fs = require("fs");
const assert = require("assert");

const python = require("../lib/extractors/python");

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const FILE_COUNT = parseInt(arg("files", "200"), 10);
const JSON_OUT = process.argv.includes("--json");

// Deterministic pseudo-source. Shape matters more than size: each file carries
// a mix of absolute/relative imports, `from X import Y as Z`, classes,
// functions, an annotated module constant (the AnnAssign path py-penalty-001
// depends on) and an __all__ barrel, so the benchmark exercises the same
// extractor branches a real repo does.
function makeSource(i) {
  const mod = `pkg.mod_${i % 17}`;
  const rel = ".".repeat((i % 3) + 1);
  return `"""Module ${i} — generated benchmark fixture."""
import os
import sys
import ${mod}
from ${rel}sibling_${i % 11} import helper_${i % 7} as aliased
from typing import Dict, List, Optional

CONFIG_${i}: Dict[str, bool] = {"enabled": True, "index": ${i}}
THRESHOLD_${i} = ${i * 3}

class Widget${i}:
    """A generated class."""

    def __init__(self, name: str) -> None:
        self.name = name

    def render(self) -> str:
        return f"{self.name}-${i}"

    @property
    def label(self) -> str:
        return self.name.upper()

def build_${i}(items: List[str]) -> Optional[str]:
    if not items:
        return None
    return ",".join(items)

def _private_${i}():
    return ${i}

__all__ = ["Widget${i}", "build_${i}", "CONFIG_${i}"]
`;
}

function buildCorpus(n) {
  const items = [];
  for (let i = 0; i < n; i++) {
    items.push({ relPath: `pkg/generated/mod_${i}.py`, content: makeSource(i) });
  }
  return items;
}

function main() {
  const items = buildCorpus(FILE_COUNT);
  const bytes = items.reduce((a, it) => a + it.content.length, 0);

  // Per-file arm: one python3 spawn per file, which is what production does
  // today. Fresh content per arm so the AST cache cannot serve the second run.
  const perFileItems = items.map((it) => ({ ...it, content: it.content + "\n# arm=perfile\n" }));
  const t0 = process.hrtime.bigint();
  // The production per-file path is extractImports + extractExports, which is
  // exactly the pair intel.js calls back-to-back on every .py file.
  const perFile = perFileItems.map((it) => ({
    imports: python.extractImports(it.content, it.relPath),
    exports: python.extractExports(it.content, it.relPath),
  }));
  const t1 = process.hrtime.bigint();

  const batchItems = items.map((it) => ({ ...it, content: it.content + "\n# arm=batch\n" }));
  const t2 = process.hrtime.bigint();
  const batch = python.extractBatch(batchItems);
  const t3 = process.hrtime.bigint();

  const perFileMs = Number(t1 - t0) / 1e6;
  const batchMs = Number(t3 - t2) / 1e6;
  const ratio = batchMs > 0 ? perFileMs / batchMs : null;

  // EQUIVALENCE. A speedup that changes output is not a speedup. The two arms
  // differ only by a trailing comment, which affects no import or export, so
  // the extracted results must be deep-equal.
  let equivalent = true;
  let mismatch = null;
  for (let i = 0; i < items.length; i++) {
    try {
      assert.deepStrictEqual(
        { imports: batch[i].imports, exports: batch[i].exports },
        { imports: perFile[i].imports, exports: perFile[i].exports }
      );
    } catch (e) {
      equivalent = false;
      mismatch = { index: i, relPath: items[i].relPath };
      break;
    }
  }

  const report = {
    files: FILE_COUNT,
    corpusBytes: bytes,
    perFileMs: +perFileMs.toFixed(1),
    batchMs: +batchMs.toFixed(1),
    speedup: ratio == null ? null : +ratio.toFixed(2),
    equivalent,
    mismatch,
  };

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    const kb = (bytes / 1024).toFixed(0);
    process.stdout.write(
      `python batch extraction — ${FILE_COUNT} generated files (${kb} KiB)\n` +
      `  per-file : ${report.perFileMs} ms   (${FILE_COUNT} python3 spawns)\n` +
      `  batch    : ${report.batchMs} ms\n` +
      `  speedup  : ${report.speedup}x\n` +
      `  output   : ${equivalent ? "byte-identical" : "MISMATCH at " + JSON.stringify(mismatch)}\n`
    );
  }
  if (!equivalent) process.exit(1);
}

main();
