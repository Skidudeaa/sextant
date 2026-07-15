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

function replaceFile(file, content) {
  const swap = `${file}.swap`;
  fs.writeFileSync(swap, content);
  fs.renameSync(swap, file);
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

describe("claims — hashFile", () => {
  it("returns no hash for a generation replaced while its descriptor is read", () => {
    const dir = tmpRepo({ "m.js": "temporary B\n" });
    const file = path.join(dir, "m.js");
    const originalRead = fs.readSync;
    let restored = false;
    fs.readSync = function(fd, buffer, offset, length, position) {
      const n = originalRead.call(this, fd, buffer, offset, length, position);
      if (!restored) {
        restored = true;
        replaceFile(file, "stable A\n");
      }
      return n;
    };
    try {
      assert.equal(C.hashFile(dir, "m.js"), "");
      assert.equal(restored, true);
    } finally {
      fs.readSync = originalRead;
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
      assert.equal(c.source, "exported_symbol");
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

  it("reuses one stable path snapshot across multiple minted claims", () => {
    const dir = tmpRepo({ "m.js": "export const a = 1;\nexport const b = 2;\n" });
    const target = path.join(dir, "m.js");
    const originalOpen = fs.openSync;
    let opens = 0;
    fs.openSync = function(file, ...args) {
      if (String(file) === target) opens += 1;
      return originalOpen.call(this, file, ...args);
    };
    try {
      const claims = C.mintClaims(dir, [
        { path: "m.js", source: "exported_symbol", symbol: "a", line: 1 },
        { path: "m.js", source: "exported_symbol", symbol: "b", line: 2 },
      ]);
      assert.equal(claims.length, 2);
      assert.equal(opens, 1, "one descriptor snapshot must serve every row for the path");
      assert.equal(claims[0].fileHash, claims[1].fileHash);
    } finally {
      fs.openSync = originalOpen;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not mint a transient generation when bytes return to A during capture", () => {
    const original = "export const stable = true;\n";
    const dir = tmpRepo({ "m.js": "export const transient = true;\n" });
    const file = path.join(dir, "m.js");
    const originalRead = fs.readSync;
    let restored = false;
    fs.readSync = function(fd, buffer, offset, length, position) {
      const n = originalRead.call(this, fd, buffer, offset, length, position);
      if (!restored) {
        restored = true;
        replaceFile(file, original);
      }
      return n;
    };
    try {
      const claims = C.mintClaims(
        dir,
        [{ path: "m.js", source: "exported_symbol", symbol: "transient", line: 1 }]
      );
      assert.deepEqual(claims, []);
      assert.equal(fs.readFileSync(file, "utf8"), original);
    } finally {
      fs.readSync = originalRead;
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
      delete claims[0].source; // persisted pre-source capsule compatibility
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

  it("reuses one stable path snapshot for every claim in a diff", () => {
    const dir = tmpRepo({ "m.js": "served\n" });
    const target = path.join(dir, "m.js");
    const originalOpen = fs.openSync;
    try {
      const claims = C.mintClaims(dir, [
        { path: "m.js", source: "text_only", line: 1 },
        { path: "m.js", source: "text_only", line: 2 },
      ], { nowMs: 1 });
      fs.writeFileSync(target, "changed\n");
      let opens = 0;
      fs.openSync = function(file, ...args) {
        if (String(file) === target) opens += 1;
        return originalOpen.call(this, file, ...args);
      };
      const d = C.diffClaims(dir, claims);
      assert.equal(opens, 1, "one descriptor snapshot must serve every prior claim for the path");
      assert.equal(d.changed.length, 2);
      assert.equal(d.invalidated.length, 0);
    } finally {
      fs.openSync = originalOpen;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("temporary bytes during one diff never emit a false CHANGED after A is restored", () => {
    const original = "served A\n";
    const dir = tmpRepo({ "m.js": original });
    const file = path.join(dir, "m.js");
    const originalRead = fs.readSync;
    try {
      const claims = C.mintClaims(
        dir,
        [{ path: "m.js", source: "text_only", line: 1 }],
        { nowMs: 1 }
      );
      fs.writeFileSync(file, "temporary B\n");
      let restored = false;
      fs.readSync = function(fd, buffer, offset, length, position) {
        const n = originalRead.call(this, fd, buffer, offset, length, position);
        if (!restored) {
          restored = true;
          replaceFile(file, original);
        }
        return n;
      };
      const d = C.diffClaims(dir, claims);
      assert.equal(restored, true, "fixture must restore A during the descriptor read");
      assert.equal(d.changed.length, 0);
      assert.equal(d.invalidated.length, 0);
      assert.equal(d.unknown.length, 1);
      assert.equal(fs.readFileSync(file, "utf8"), original);
    } finally {
      fs.readSync = originalRead;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("temporary symbol removal never emits a false INVALIDATED after A is restored", () => {
    const original = "function foo() { return 1; }\n";
    const dir = tmpRepo({ "m.js": original });
    const file = path.join(dir, "m.js");
    const originalRead = fs.readSync;
    try {
      const claims = C.mintClaims(dir, rows, { nowMs: 1 });
      fs.writeFileSync(file, "function bar() { return 2; }\n");
      let restored = false;
      fs.readSync = function(fd, buffer, offset, length, position) {
        const n = originalRead.call(this, fd, buffer, offset, length, position);
        if (!restored) {
          restored = true;
          replaceFile(file, original);
        }
        return n;
      };
      const d = C.diffClaims(dir, claims);
      assert.equal(d.changed.length, 0);
      assert.equal(d.invalidated.length, 0);
      assert.equal(d.unknown.length, 1);
    } finally {
      fs.readSync = originalRead;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("revalidates an early path after later-path analysis before returning findings", () => {
    const dir = tmpRepo({ "a.js": "a served\n", "z.js": "z served\n" });
    const a = path.join(dir, "a.js");
    const originalRead = fs.readSync;
    try {
      const claims = C.mintClaims(dir, [
        { path: "a.js", source: "text_only", line: 1 },
        { path: "z.js", source: "text_only", line: 1 },
      ], { nowMs: 1 });
      fs.writeFileSync(a, "a changed\n");
      fs.writeFileSync(path.join(dir, "z.js"), "z changed\n");
      let reads = 0;
      fs.readSync = function(fd, buffer, offset, length, position) {
        const n = originalRead.call(this, fd, buffer, offset, length, position);
        reads += 1;
        if (reads === 2) {
          // a.js already completed its own snapshot. An ABA write while z.js
          // is read must be caught by the final whole-diff evidence pass.
          replaceFile(a, "a transient\n");
          replaceFile(a, "a changed\n");
        }
        return n;
      };
      const d = C.diffClaims(dir, claims);
      assert.equal(d.invalidated.length, 0);
      assert.equal(d.changed.length, 1);
      assert.equal(d.changed[0].claim.subject.path, "z.js");
      assert.equal(d.unknown.length, 1);
      assert.equal(d.unknown[0].claim.subject.path, "a.js");
    } finally {
      fs.readSync = originalRead;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("over-bound files fail closed without a changed or invalidated claim", () => {
    const dir = tmpRepo({ "m.js": "small\n" });
    try {
      const claims = C.mintClaims(
        dir,
        [{ path: "m.js", source: "text_only", line: 1 }],
        { nowMs: 1 }
      );
      fs.truncateSync(path.join(dir, "m.js"), 3 * 1024 * 1024);
      const d = C.diffClaims(dir, claims);
      assert.equal(d.changed.length, 0);
      assert.equal(d.invalidated.length, 0);
      assert.equal(d.unknown.length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a non-regular replacement fails closed without a file-removed retraction", () => {
    const dir = tmpRepo({ "m.js": "served\n" });
    const file = path.join(dir, "m.js");
    try {
      const claims = C.mintClaims(
        dir,
        [{ path: "m.js", source: "text_only", line: 1 }],
        { nowMs: 1 }
      );
      fs.rmSync(file);
      fs.mkdirSync(file);
      const d = C.diffClaims(dir, claims);
      assert.equal(d.changed.length, 0);
      assert.equal(d.invalidated.length, 0);
      assert.equal(d.unknown.length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const stillPresentForms = [
    {
      label: "Swift struct",
      rel: "Widget.swift",
      source: "swift_decl_type",
      symbol: "Widget",
      before: "struct Widget {\n}\n",
      after: "// unrelated edit\nstruct Widget {\n}\n",
    },
    {
      label: "Swift class",
      rel: "Service.swift",
      source: "swift_decl_type",
      symbol: "Service",
      before: "@MainActor public final class Service {\n}\n",
      after: "// unrelated edit\n@MainActor public final class Service {\n}\n",
    },
    {
      label: "Swift protocol",
      rel: "Runnable.swift",
      source: "swift_decl_type",
      symbol: "Runnable",
      before: "protocol Runnable {\n}\n",
      after: "// unrelated edit\nprotocol Runnable {\n}\n",
    },
    {
      label: "Swift enum",
      rel: "Mode.swift",
      source: "swift_decl_type",
      symbol: "Mode",
      before: "enum Mode {\n  case one\n}\n",
      after: "// unrelated edit\nenum Mode {\n  case one\n}\n",
    },
    {
      label: "CommonJS exports.foo",
      rel: "exports.js",
      source: "exported_symbol",
      symbol: "resolveImport",
      before: "exports.resolveImport = resolveImport;\n",
      after: "// unrelated edit\nexports.resolveImport = resolveImport;\n",
    },
    {
      label: "CommonJS module.exports.foo",
      rel: "module-exports.js",
      source: "exported_symbol",
      symbol: "resolveImport",
      before: "module.exports\n  .resolveImport = resolveImport;\n",
      after: "// unrelated edit\nmodule.exports\n  .resolveImport = resolveImport;\n",
    },
    {
      label: "TypeScript interface",
      rel: "model.ts",
      source: "exported_symbol",
      symbol: "Model",
      before: "export interface Model { id: string }\n",
      after: "// unrelated edit\nexport interface Model { id: string }\n",
    },
    {
      label: "TypeScript type alias",
      rel: "shape.ts",
      source: "exported_symbol",
      symbol: "Shape",
      before: "export type Shape = { width: number };\n",
      after: "// unrelated edit\nexport type Shape = { width: number };\n",
    },
    {
      label: "TypeScript enum",
      rel: "state.ts",
      source: "exported_symbol",
      symbol: "State",
      before: "export enum State { Ready }\n",
      after: "// unrelated edit\nexport enum State { Ready }\n",
    },
  ];

  for (const tc of stillPresentForms) {
    it(`${tc.label} still present after an unrelated edit is never INVALIDATED`, () => {
      const dir = tmpRepo({ [tc.rel]: tc.before });
      try {
        const claims = C.mintClaims(
          dir,
          [{ path: tc.rel, source: tc.source, symbol: tc.symbol, line: 1 }],
          { nowMs: 1 }
        );
        fs.writeFileSync(path.join(dir, tc.rel), tc.after);
        const d = C.diffClaims(dir, claims);
        assert.equal(d.invalidated.length, 0);
        assert.equal(d.changed.length, 1);
        assert.equal(d.changed[0].to, "L2");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("an extractor-confirmed re-export degrades to CHANGED when its span is unavailable", () => {
    const dir = tmpRepo({ "barrel.ts": 'export { Widget } from "./widget";\n' });
    try {
      const claims = C.mintClaims(
        dir,
        [{ path: "barrel.ts", source: "reexport_chain", symbol: "Widget", line: 1 }],
        { nowMs: 1 }
      );
      fs.writeFileSync(path.join(dir, "barrel.ts"), '// unrelated edit\nexport { Widget } from "./widget";\n');
      const d = C.diffClaims(dir, claims);
      assert.equal(d.invalidated.length, 0);
      assert.equal(d.changed.length, 1);
      assert.equal(d.changed[0].reason, "span_unresolved");
      assert.equal(d.changed[0].to, "present (span unavailable)");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an unowned symbol form degrades to CHANGED rather than false INVALIDATED", () => {
    const dir = tmpRepo({ "model.rb": "class Widget\nend\n" });
    try {
      const claims = C.mintClaims(
        dir,
        [{ path: "model.rb", source: "exported_symbol", symbol: "Widget", line: 1 }],
        { nowMs: 1 }
      );
      fs.writeFileSync(path.join(dir, "model.rb"), "# unrelated edit\nclass Widget\nend\n");
      const d = C.diffClaims(dir, claims);
      assert.equal(d.invalidated.length, 0);
      assert.equal(d.changed.length, 1);
      assert.equal(d.changed[0].reason, "span_unresolved");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const removedForms = [
    {
      label: "Swift declaration",
      rel: "Widget.swift",
      source: "swift_decl_type",
      symbol: "Widget",
      before: "struct Widget {}\n",
      after: "struct Other {}\n",
    },
    {
      label: "CommonJS named export",
      rel: "exports.js",
      source: "exported_symbol",
      symbol: "resolveImport",
      before: "module.exports.resolveImport = resolveImport;\n",
      after: "module.exports.other = other;\n",
    },
    {
      label: "TypeScript type",
      rel: "model.ts",
      source: "exported_symbol",
      symbol: "Model",
      before: "export interface Model {}\n",
      after: "export interface Other {}\n",
    },
  ];

  for (const tc of removedForms) {
    it(`${tc.label} removal still INVALIDATES the claim`, () => {
      const dir = tmpRepo({ [tc.rel]: tc.before });
      try {
        const claims = C.mintClaims(
          dir,
          [{ path: tc.rel, source: tc.source, symbol: tc.symbol, line: 1 }],
          { nowMs: 1 }
        );
        fs.writeFileSync(path.join(dir, tc.rel), tc.after);
        const d = C.diffClaims(dir, claims);
        assert.equal(d.invalidated.length, 1);
        assert.equal(d.invalidated[0].reason, "symbol_removed");
        assert.equal(d.changed.length, 0);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("claims — locateSymbolRegion", () => {
  it("finds function / class / const / def plus Swift, CommonJS, and TS def-forms", () => {
    const dir = tmpRepo({
      "a.js": "const x = 1;\nfunction alpha() {\n  return 1;\n}\n",
      "b.js": "export const beta = () => {\n  return 2;\n};\n",
      "c.py": "def gamma():\n    return 3\n",
      "d.swift": "public struct Delta {}\n",
      "e.cjs": "module.exports.echo = echo;\n",
      "f.ts": "export interface Foxtrot {}\nexport type Golf = string;\nexport enum Hotel { One }\n",
    });
    try {
      assert.equal(C.locateSymbolRegion(dir, "a.js", "alpha").name, "alpha");
      assert.equal(C.locateSymbolRegion(dir, "b.js", "beta").name, "beta");
      // python resolves via allowSpawn:false → returns a minimal def-line span
      const g = C.locateSymbolRegion(dir, "c.py", "gamma");
      assert.ok(g && g.startLine === 1);
      assert.equal(C.locateSymbolRegion(dir, "d.swift", "Delta").startLine, 1);
      assert.equal(C.locateSymbolRegion(dir, "e.cjs", "echo").startLine, 1);
      assert.equal(C.locateSymbolRegion(dir, "f.ts", "Foxtrot").startLine, 1);
      assert.equal(C.locateSymbolRegion(dir, "f.ts", "Golf").startLine, 2);
      assert.equal(C.locateSymbolRegion(dir, "f.ts", "Hotel").startLine, 3);
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
