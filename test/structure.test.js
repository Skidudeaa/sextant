"use strict";

// Tests for lib/structure.js — the summary Structure section (docs/021).
// Locks the five design decisions the 020 recon made load-bearing:
//   D1 junk-filtered expansion (the live fixtures/ false-expansion)
//   D2 no `.` pseudo-dir in rows or flows
//   D3 no test-SOURCED flows
//   D4 expansion guard triplet (junk-hint / nested-git / >=1 indexed file)
//   D5 omission rule (<2 non-root dirs -> null; caller falls back)

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const graphMod = require("../lib/graph");
const { computeStructure, renderStructureSection } = require("../lib/structure");

function mkTmp(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sextant-struct-${tag}-`));
  fs.mkdirSync(path.join(dir, ".planning", "intel"), { recursive: true });
  return dir;
}

// Populate the files (+ optional imports) tables. files: {relPath: type},
// imports: [[from, to], ...].
function populate(db, files, imports = []) {
  db.run("DELETE FROM files");
  db.run("DELETE FROM imports");
  for (const [relPath, type] of Object.entries(files)) {
    graphMod.upsertFile(db, { relPath, type, sizeBytes: 1, mtimeMs: 1 });
  }
  const byFrom = new Map();
  for (const [from, to] of imports) {
    if (!byFrom.has(from)) byFrom.set(from, []);
    byFrom.get(from).push({ specifier: "./" + to, toPath: to, kind: "relative" });
  }
  for (const [from, list] of byFrom) graphMod.replaceImports(db, from, list);
}

describe("computeStructure — rows (D2, D5)", () => {
  let dir, db;
  before(async () => { dir = mkTmp("rows"); db = await graphMod.loadDb(dir); });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("aggregates per top-level dir, sorted by file count desc, dominant type", () => {
    populate(db, {
      "lib/a.js": "js", "lib/b.js": "js", "lib/c.ts": "ts",
      "commands/x.js": "js",
      "root.js": "js", // root-level: counted nowhere (D2)
    });
    const s = computeStructure(db, dir);
    assert.equal(s.rows.length, 2);
    assert.equal(s.rows[0].dir, "lib/");
    assert.equal(s.rows[0].files, 3);
    assert.equal(s.rows[0].domType, "js");
    assert.equal(s.rows[1].dir, "commands/");
    assert.equal(s.hiddenDirCount, 0);
  });

  it("omission rule: <2 non-root dirs returns null (root files don't count)", () => {
    populate(db, { "lib/a.js": "js", "root1.js": "js", "root2.js": "js" });
    assert.equal(computeStructure(db, dir), null);
    populate(db, { "a.js": "js", "b.js": "js" });
    assert.equal(computeStructure(db, dir), null);
  });

  it("caps at 7 rows and counts the hidden remainder", () => {
    const files = {};
    for (let i = 0; i < 10; i++) {
      for (let j = 0; j <= i; j++) files[`dir${i}/f${j}.js`] = "js";
    }
    const s = computeStructure(db, dir);
    populate(db, files);
    const s2 = computeStructure(db, dir);
    assert.equal(s2.rows.length, 7);
    assert.equal(s2.hiddenDirCount, 3);
    assert.equal(s2.rows[0].dir, "dir9/"); // most files first
    void s;
  });
});

describe("computeStructure — monorepo expansion (D1, D4)", () => {
  let dir, db;
  before(async () => { dir = mkTmp("expand"); db = await graphMod.loadDb(dir); });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  function mkPkg(parent, name, { manifest = true, nestedGit = false } = {}) {
    const abs = path.join(dir, parent, name);
    fs.mkdirSync(abs, { recursive: true });
    if (manifest) fs.writeFileSync(path.join(abs, "package.json"), "{}");
    if (nestedGit) fs.mkdirSync(path.join(abs, ".git"), { recursive: true });
  }

  it("expands a parent with >=3 guard-passing manifest subdirs into one compressed row", () => {
    for (const p of ["alpha", "beta", "gamma", "delta"]) mkPkg("packages", p);
    populate(db, {
      "packages/alpha/a.ts": "ts", "packages/alpha/b.ts": "ts", "packages/alpha/c.ts": "ts",
      "packages/beta/a.ts": "ts", "packages/beta/b.ts": "ts",
      "packages/gamma/a.ts": "ts",
      "packages/delta/a.ts": "ts",
      "scripts/run.js": "js",
    });
    const s = computeStructure(db, dir);
    const row = s.rows.find((r) => r.dir === "packages/");
    assert.equal(row.kind, "expanded");
    assert.equal(row.pkgCount, 4);
    assert.equal(row.pkgs[0].name, "alpha"); // most files first
    assert.equal(row.pkgs[0].files, 3);
    assert.deepEqual(s.expandedParents, ["packages/"]);
    const rendered = renderStructureSection(s);
    assert.match(rendered, /- `packages\/` \(4 pkgs\): alpha 3, beta 2, delta 1, gamma 1/);
  });

  it("D1: a junk-hint parent (fixtures/) never expands, even with manifest subdirs", () => {
    for (const p of ["one", "two", "three"]) mkPkg("fixtures", p);
    populate(db, {
      "fixtures/one/a.ts": "ts", "fixtures/two/a.ts": "ts", "fixtures/three/a.ts": "ts",
      "lib/x.js": "js",
    });
    const s = computeStructure(db, dir);
    const row = s.rows.find((r) => r.dir === "fixtures/");
    assert.equal(row.kind, "dir", "fixtures/ must stay a plain dir row");
    assert.deepEqual(s.expandedParents, []);
  });

  it("D4: nested-git and zero-indexed-file subdirs don't count toward the >=3", () => {
    // 2 clean pkgs + 1 nested-git + 1 manifest-but-unindexed -> no expansion
    for (const p of ["p1", "p2"]) mkPkg("mono", p);
    mkPkg("mono", "vendored", { nestedGit: true });
    mkPkg("mono", "empty"); // manifest but no indexed files
    populate(db, {
      "mono/p1/a.js": "js", "mono/p2/a.js": "js", "mono/vendored/a.js": "js",
      "lib/x.js": "js",
    });
    const s = computeStructure(db, dir);
    assert.deepEqual(s.expandedParents, [], "2 qualifying subdirs < 3 -> plain row");
  });
});

describe("computeStructure — flows (D2, D3)", () => {
  let dir, db;
  before(async () => { dir = mkTmp("flows"); db = await graphMod.loadDb(dir); });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("keeps directed source->source pairs, drops '.'-endpoint, test-sourced, and mushy pairs", () => {
    populate(db, {
      "commands/a.js": "js", "commands/b.js": "js",
      "lib/x.js": "js", "lib/y.js": "js",
      "tests/t1.js": "js", "tests/t2.js": "js",
      "root.js": "js",
      "mush1/m.js": "js", "mush2/m.js": "js",
    }, [
      // directed: commands -> lib (3:0)
      ["commands/a.js", "lib/x.js"], ["commands/a.js", "lib/y.js"], ["commands/b.js", "lib/x.js"],
      // test-sourced (D3): tests -> lib, high mass, must be dropped
      ["tests/t1.js", "lib/x.js"], ["tests/t1.js", "lib/y.js"],
      ["tests/t2.js", "lib/x.js"], ["tests/t2.js", "lib/y.js"],
      // '.' endpoint (D2): root.js -> lib must be dropped
      ["root.js", "lib/x.js"],
      // mushy (asym 0): mush1 <-> mush2
      ["mush1/m.js", "mush2/m.js"], ["mush2/m.js", "mush1/m.js"],
    ]);
    const s = computeStructure(db, dir);
    assert.deepEqual(s.flows, [{ from: "commands/", to: "lib/", mass: 3 }]);
    const rendered = renderStructureSection(s);
    assert.match(rendered, /- Flow: commands\/ → lib\//);
    assert.doesNotMatch(rendered, /tests\/ →/);
  });

  it("drops flows whose endpoint isn't a shown row", () => {
    const files = {};
    // 8 dirs so the smallest falls off the 7-row cap
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j <= i; j++) files[`d${i}/f${j}.js`] = "js";
    }
    populate(db, files, [
      ["d7/f0.js", "d0/f0.js"], // d0 is the hidden dir -> flow must drop
      ["d7/f1.js", "d6/f0.js"],
    ]);
    const s = computeStructure(db, dir);
    assert.ok(!s.rows.find((r) => r.dir === "d0/"), "d0 must be the hidden row");
    assert.deepEqual(s.flows, [{ from: "d7/", to: "d6/", mass: 1 }]);
  });
});

describe("renderStructureSection — grammar, budget, escaping", () => {
  let dir, db;
  before(async () => { dir = mkTmp("render"); db = await graphMod.loadDb(dir); });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("singular '1 file' and hidden-dirs tail", () => {
    const files = {};
    for (let i = 0; i < 9; i++) files[`dir${i}/only.js`] = "js";
    populate(db, files);
    const out = renderStructureSection(computeStructure(db, dir));
    assert.match(out, /— 1 file \(js\)/);
    assert.doesNotMatch(out, /1 files/);
    assert.match(out, /- …\+2 more dirs/);
  });

  it("stays under the byte cap by shedding rows, then the flow line", () => {
    const files = {};
    const long = "a-really-quite-long-directory-name-segment";
    for (let i = 0; i < 7; i++) {
      files[`${long}-${i}/f1.js`] = "js";
      files[`${long}-${i}/f2.js`] = "js";
    }
    populate(db, files, [
      [`${long}-0/f1.js`, `${long}-1/f1.js`],
      [`${long}-0/f2.js`, `${long}-1/f2.js`],
    ]);
    const s = computeStructure(db, dir);
    const out = renderStructureSection(s);
    assert.ok(Buffer.byteLength(out, "utf8") <= 320, `expected <=320B, got ${Buffer.byteLength(out, "utf8")}`);
    assert.match(out, /more dirs/, "shed rows must be accounted in the tail");
    const tight = renderStructureSection(s, { maxBytes: 150 });
    assert.ok(Buffer.byteLength(tight, "utf8") <= 150, `expected <=150B, got ${Buffer.byteLength(tight, "utf8")}`);
    assert.doesNotMatch(tight, /- Flow:/, "flow line is shed under a tight budget");
  });

  it("escapes markup-significant characters in dir names", () => {
    populate(db, { "a&b/x.js": "js", "c_d/y.js": "js" });
    const out = renderStructureSection(computeStructure(db, dir));
    assert.match(out, /a&amp;b\//);
    assert.match(out, /c\\_d\//);
  });

  it("returns null for null structure (omission rule pass-through)", () => {
    assert.equal(renderStructureSection(null), null);
  });
});
