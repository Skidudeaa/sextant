"use strict";

// REGION SUBSTRATE (docs/025 Phase A) — locks lib/regions.js: line→region
// resolution, edit-line derivation (structuredPatch + string-locate fallback),
// and the containment/name scoring that powers region_hit vs region_miss (the
// "right file, wrong region" headroom signal).

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const R = require("../lib/regions");

const JS = [
  "function alpha() {", //1
  "  return 1;", //2
  "}", //3
  "function beta() {", //4
  "  const x = 2;", //5
  "  return x;", //6
  "}", //7
  "class Gamma {", //8
  "  method() {", //9
  "    return 3;", //10
  "  }", //11
  "}", //12
].join("\n");

describe("regions — resolveRegionInContent", () => {
  it("resolves the enclosing function for a JS line", () => {
    const r = R.resolveRegionInContent("lib/x.js", JS, 5, { allowSpawn: false });
    assert.equal(r.name, "beta");
    assert.equal(r.startLine, 4);
    assert.equal(r.endLine, 7);
    assert.equal(r.id, "lib/x.js#beta");
  });

  it("returns null for an unsupported extension (e.g. Swift, markdown)", () => {
    assert.equal(R.resolveRegionInContent("A.swift", JS, 5, { allowSpawn: false }), null);
    assert.equal(R.resolveRegionInContent("README.md", "# hi", 1, { allowSpawn: false }), null);
  });

  it("returns null on a bad line / empty content (never throws)", () => {
    assert.equal(R.resolveRegionInContent("lib/x.js", JS, 0, { allowSpawn: false }), null);
    assert.equal(R.resolveRegionInContent("lib/x.js", "", 3, { allowSpawn: false }), null);
    assert.equal(R.resolveRegionInContent("lib/x.js", null, 3, { allowSpawn: false }), null);
  });

  it("gates the python3-spawning path off when allowSpawn:false", () => {
    // A python line resolves to null with allowSpawn:false (no child process on
    // a hot path), independent of whether python3 is installed.
    const py = "def foo():\n    return 1\n";
    assert.equal(R.resolveRegionInContent("x.py", py, 2, { allowSpawn: false }), null);
  });
});

describe("regions — lineInRegion", () => {
  const region = { startLine: 4, endLine: 7 };
  it("true inside, false outside", () => {
    assert.equal(R.lineInRegion(region, 4), true);
    assert.equal(R.lineInRegion(region, 7), true);
    assert.equal(R.lineInRegion(region, 3), false);
    assert.equal(R.lineInRegion(region, 8), false);
  });
  it("false on nullish", () => {
    assert.equal(R.lineInRegion(null, 5), false);
    assert.equal(R.lineInRegion(region, null), false);
  });
});

describe("regions — deriveEditedLines", () => {
  it("prefers structuredPatch newStart(s)", () => {
    const lines = R.deriveEditedLines(
      { old_string: "const x = 2;" },
      { structuredPatch: [{ newStart: 5, newLines: 2 }, { newStart: 9, newLines: 1 }] },
      JS
    );
    assert.deepEqual(lines.sort((a, b) => a - b), [5, 9]);
  });

  it("falls back to string-locating old_string in content", () => {
    const lines = R.deriveEditedLines({ old_string: "const x = 2;" }, {}, JS);
    assert.deepEqual(lines, [5]);
  });

  it("handles MultiEdit edits[] in the fallback", () => {
    const lines = R.deriveEditedLines(
      { edits: [{ old_string: "return 1;" }, { old_string: "return 3;" }] },
      {},
      JS
    );
    assert.deepEqual(lines.sort((a, b) => a - b), [2, 10]);
  });

  it("returns [] when nothing is locatable", () => {
    assert.deepEqual(R.deriveEditedLines({ old_string: "NOPE" }, {}, JS), []);
    assert.deepEqual(R.deriveEditedLines({}, {}, JS), []);
  });
});

describe("regions — scoreEditedRegion (hit / miss / unscoreable)", () => {
  const edited = R.editedRegions("lib/x.js", JS, [5], { allowSpawn: false }); // region beta L4-7

  it("HIT when the surfaced line is inside the edited region", () => {
    assert.deepEqual(R.scoreEditedRegion(5, null, edited), { hit: true, regionKind: "function" });
    // surfaced line anywhere in beta's span still hits
    assert.equal(R.scoreEditedRegion(6, null, edited).hit, true);
  });

  it("MISS when the surfaced line is a DIFFERENT region (the headroom signal)", () => {
    assert.deepEqual(R.scoreEditedRegion(1, null, edited), { hit: false, regionKind: "function" });
  });

  it("HIT by symbol name even without a line (export/decl rows)", () => {
    assert.equal(R.scoreEditedRegion(null, "beta", edited).hit, true);
  });

  it("MISS by symbol when the name doesn't match the edited region", () => {
    assert.equal(R.scoreEditedRegion(null, "alpha", edited).hit, false);
  });

  it("null (unscoreable) with no breadcrumb, or no resolved region", () => {
    assert.equal(R.scoreEditedRegion(null, null, edited), null);
    assert.equal(R.scoreEditedRegion(5, "beta", []), null);
  });
});

describe("regions — editedRegions dedups by id", () => {
  it("two lines in the same function yield one region", () => {
    const regions = R.editedRegions("lib/x.js", JS, [5, 6], { allowSpawn: false });
    assert.equal(regions.length, 1);
    assert.equal(regions[0].name, "beta");
  });
});
