"use strict";

// CLAIM LEDGER (docs/028 Phase C) — locks minting, invalidation, symbol
// re-location, and the context-delta rendering. Uses real temp files (diffClaims
// is disk-based by design). Deterministic, no spawn.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const C = require("../lib/claims");

function tmpRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sx-claims-"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

describe("claims — provenance taxonomy (epistemic firewall)", () => {
  it("types authority by surfacing signal", () => {
    assert.equal(C.provenanceOf("exported_symbol"), "direct");
    assert.equal(C.provenanceOf("swift_decl_type"), "direct");
    assert.equal(C.provenanceOf("reexport_chain"), "direct");
    assert.equal(C.provenanceOf("path_match"), "heuristic");
    assert.equal(C.provenanceOf("text_only"), "live_text");
    assert.equal(C.provenanceOf(undefined), "live_text");
  });
});

describe("claims — mintClaims", () => {
  it("mints a typed claim with a serve-time file hash", () => {
    const dir = tmpRepo({ "m.js": "function foo() {\n  return 1;\n}\n" });
    try {
      const rows = [{ path: "m.js", source: "exported_symbol", symbol: "foo", line: 1, region: { name: "foo", kind: "function", startLine: 1, endLine: 3 } }];
      const claims = C.mintClaims(dir, rows, { nowMs: 1000 });
      assert.equal(claims.length, 1);
      const c = claims[0];
      assert.equal(c.subject.path, "m.js");
      assert.equal(c.subject.symbol, "foo");
      assert.equal(c.predicate, "defines");
      assert.equal(c.provenance, "direct");
      assert.ok(c.fileHash && c.fileHash.length > 0, "carries the serve-time file hash");
      assert.equal(c.servedAt, 1000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("predicate is 'relevant' for a symbol-less row", () => {
    const dir = tmpRepo({ "m.js": "x\n" });
    try {
      const claims = C.mintClaims(dir, [{ path: "m.js", source: "text_only", line: 1 }], { nowMs: 1 });
      assert.equal(claims[0].predicate, "relevant");
      assert.equal(claims[0].provenance, "live_text");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("claims — diffClaims (invalidation)", () => {
  const rows = [{ path: "m.js", source: "exported_symbol", symbol: "foo", line: 1, region: { name: "foo", kind: "function", startLine: 1, endLine: 3 } }];

  it("unchanged file → no delta", () => {
    const dir = tmpRepo({ "m.js": "function foo() {\n  return 1;\n}\nfunction bar(){return 2;}\n" });
    try {
      const claims = C.mintClaims(dir, rows, { nowMs: 1 });
      const d = C.diffClaims(dir, claims);
      assert.equal(d.unchanged.length, 1);
      assert.equal(d.changed.length, 0);
      assert.equal(d.invalidated.length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("moved symbol → CHANGED with re-derived span", () => {
    const dir = tmpRepo({ "m.js": "function foo() {\n  return 1;\n}\n" });
    try {
      const claims = C.mintClaims(dir, rows, { nowMs: 1 });
      fs.writeFileSync(path.join(dir, "m.js"), "// a\n// b\nfunction foo() {\n  return 1;\n}\n");
      const d = C.diffClaims(dir, claims);
      assert.equal(d.changed.length, 1);
      assert.equal(d.changed[0].from, "L1–3");
      assert.equal(d.changed[0].to, "L3–5");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removed symbol → INVALIDATED (symbol_removed)", () => {
    const dir = tmpRepo({ "m.js": "function foo() {\n  return 1;\n}\n" });
    try {
      const claims = C.mintClaims(dir, rows, { nowMs: 1 });
      fs.writeFileSync(path.join(dir, "m.js"), "function bar(){ return 2; }\n");
      const d = C.diffClaims(dir, claims);
      assert.equal(d.invalidated.length, 1);
      assert.equal(d.invalidated[0].reason, "symbol_removed");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removed file → INVALIDATED (file_removed)", () => {
    const dir = tmpRepo({ "m.js": "function foo() {\n  return 1;\n}\n" });
    try {
      const claims = C.mintClaims(dir, rows, { nowMs: 1 });
      fs.rmSync(path.join(dir, "m.js"));
      const d = C.diffClaims(dir, claims);
      assert.equal(d.invalidated.length, 1);
      assert.equal(d.invalidated[0].reason, "file_removed");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("symbol-less claim on a changed file → CHANGED (coarse)", () => {
    const dir = tmpRepo({ "m.js": "aaa\n" });
    try {
      const claims = C.mintClaims(dir, [{ path: "m.js", source: "text_only", line: 1 }], { nowMs: 1 });
      fs.writeFileSync(path.join(dir, "m.js"), "bbb\n");
      const d = C.diffClaims(dir, claims);
      assert.equal(d.changed.length, 1);
      assert.equal(d.changed[0].claim.subject.symbol, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("claims — locateSymbolRegion", () => {
  it("finds function / class / const / def def-forms", () => {
    const dir = tmpRepo({
      "a.js": "const x = 1;\nfunction alpha() {\n  return 1;\n}\n",
      "b.js": "export const beta = () => {\n  return 2;\n};\n",
      "c.py": "def gamma():\n    return 3\n",
    });
    try {
      assert.equal(C.locateSymbolRegion(dir, "a.js", "alpha").name, "alpha");
      assert.equal(C.locateSymbolRegion(dir, "b.js", "beta").name, "beta");
      // python resolves via allowSpawn:false → returns a minimal def-line span
      const g = C.locateSymbolRegion(dir, "c.py", "gamma");
      assert.ok(g && g.startLine === 1);
      assert.equal(C.locateSymbolRegion(dir, "a.js", "nope"), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("claims — renderContextDelta", () => {
  it("empty when nothing changed", () => {
    assert.equal(C.renderContextDelta({ unchanged: [1], changed: [], invalidated: [] }), "");
    assert.equal(C.renderContextDelta(null), "");
  });

  it("renders INVALIDATED and CHANGED sections, facts only (no imperatives)", () => {
    const diff = {
      unchanged: [],
      changed: [{ claim: { subject: { path: "lib/o.js", symbol: "build" } }, from: "L44–142", to: "L47–158" }],
      invalidated: [{ claim: { subject: { path: "lib/g.js", symbol: "gone" } }, reason: "symbol_removed" }],
    };
    const text = C.renderContextDelta(diff);
    assert.ok(text.includes("INVALIDATED"));
    assert.ok(text.includes("lib/g.js: gone — definition no longer found"));
    assert.ok(text.includes("CHANGED"));
    assert.ok(text.includes("lib/o.js: build span L44–142 → L47–158"));
    // no imperative verbs — the orient/subagent discipline
    assert.ok(!/\b(call|run|use|open|check|please)\b/i.test(text));
  });
});
