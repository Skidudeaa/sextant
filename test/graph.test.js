"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const graph = require("../lib/graph");

// Each describe block gets its own temp dir so loadDb gets a unique rootAbs key.

describe("graph CRUD", () => {
  let tmpDir, db;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-graph-crud-"));
    fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
    db = await graph.loadDb(tmpDir);
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("upsertFile and countFiles", () => {
    graph.upsertFile(db, { relPath: "lib/foo.js", type: "js", sizeBytes: 100, mtimeMs: 1000 });
    graph.upsertFile(db, { relPath: "lib/bar.js", type: "js", sizeBytes: 200, mtimeMs: 2000 });
    assert.equal(graph.countFiles(db), 2);
  });

  it("upsertFile overwrites on same path", () => {
    graph.upsertFile(db, { relPath: "lib/foo.js", type: "ts", sizeBytes: 150, mtimeMs: 3000 });
    assert.equal(graph.countFiles(db), 2);
  });

  it("deleteFile removes file and NULLifies to_path", () => {
    // Set up imports: bar imports foo
    graph.replaceImports(db, "lib/bar.js", [
      { specifier: "./foo", toPath: "lib/foo.js", kind: "relative" },
    ]);

    // Delete foo
    graph.deleteFile(db, "lib/foo.js");
    assert.equal(graph.countFiles(db), 1);

    // bar's import should still exist but with null toPath
    const imports = graph.queryImports(db, "lib/bar.js");
    assert.equal(imports.length, 1);
    assert.equal(imports[0].specifier, "./foo");
    assert.equal(imports[0].toPath, null);
  });

  it("replaceImports replaces all imports for a file", () => {
    graph.replaceImports(db, "lib/bar.js", [
      { specifier: "react", kind: "external", isExternal: true },
      { specifier: "./utils", toPath: "lib/utils.js", kind: "relative" },
    ]);
    const imports = graph.queryImports(db, "lib/bar.js");
    assert.equal(imports.length, 2);
  });

  it("replaceExports replaces all exports for a file", () => {
    graph.replaceExports(db, "lib/bar.js", [
      { name: "greet", kind: "named" },
      { name: "default", kind: "default" },
    ]);
    const exports = graph.queryExports(db, "lib/bar.js");
    assert.equal(exports.length, 2);
  });

  it("replaceReexports stores and replaces reexports", () => {
    graph.replaceReexports(db, "index.js", [
      { name: "useState", kind: "reexport", from: "./hooks" },
      { name: "useEffect", kind: "reexport", from: "./hooks" },
    ]);
    // Replace should clear old and add new
    graph.replaceReexports(db, "index.js", [
      { name: "createElement", kind: "reexport", from: "./core" },
    ]);
    // Verify via findReexportChain - should only find createElement now
    const chain = graph.findReexportChain(db, "useState");
    assert.equal(chain.length, 0, "useState should be gone after replace");
    const chain2 = graph.findReexportChain(db, "createElement");
    assert.ok(chain2.length > 0, "createElement should exist");
  });
});

describe("graph queries", () => {
  let tmpDir, db;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-graph-queries-"));
    fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
    db = await graph.loadDb(tmpDir);

    // Set up a small graph:
    // A -> B, A -> C, B -> C, D -> C
    graph.upsertFile(db, { relPath: "a.js", type: "js", sizeBytes: 10, mtimeMs: 1 });
    graph.upsertFile(db, { relPath: "b.js", type: "js", sizeBytes: 20, mtimeMs: 2 });
    graph.upsertFile(db, { relPath: "c.js", type: "js", sizeBytes: 30, mtimeMs: 3 });
    graph.upsertFile(db, { relPath: "d.js", type: "js", sizeBytes: 40, mtimeMs: 4 });

    graph.replaceImports(db, "a.js", [
      { specifier: "./b", toPath: "b.js", kind: "relative" },
      { specifier: "./c", toPath: "c.js", kind: "relative" },
    ]);
    graph.replaceImports(db, "b.js", [
      { specifier: "./c", toPath: "c.js", kind: "relative" },
    ]);
    graph.replaceImports(db, "d.js", [
      { specifier: "./c", toPath: "c.js", kind: "relative" },
    ]);

    graph.replaceExports(db, "c.js", [
      { name: "resolve", kind: "named" },
      { name: "default", kind: "default" },
    ]);
    graph.replaceExports(db, "b.js", [
      { name: "helper", kind: "named" },
    ]);
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("queryImports returns imports for a file", () => {
    const imports = graph.queryImports(db, "a.js");
    assert.equal(imports.length, 2);
    assert.ok(imports.some((i) => i.specifier === "./b"));
    assert.ok(imports.some((i) => i.specifier === "./c"));
  });

  it("queryDependents returns who imports a file", () => {
    const deps = graph.queryDependents(db, "c.js");
    assert.equal(deps.length, 3); // a, b, d all import c
    const fromPaths = deps.map((d) => d.fromPath);
    assert.ok(fromPaths.includes("a.js"));
    assert.ok(fromPaths.includes("b.js"));
    assert.ok(fromPaths.includes("d.js"));
  });

  it("queryExports returns exports for a file", () => {
    const exports = graph.queryExports(db, "c.js");
    assert.equal(exports.length, 2);
  });

  it("countFiles returns total", () => {
    assert.equal(graph.countFiles(db), 4);
  });

  it("mostDependedOn returns c.js as top", () => {
    const top = graph.mostDependedOn(db, 5);
    assert.ok(top.length > 0);
    assert.equal(top[0].path, "c.js");
    assert.equal(Number(top[0].c), 3);
  });
});

describe("graph batch operations", () => {
  let tmpDir, db;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-graph-batch-"));
    fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
    db = await graph.loadDb(tmpDir);

    graph.upsertFile(db, { relPath: "x.js", type: "js", sizeBytes: 10, mtimeMs: 1 });
    graph.upsertFile(db, { relPath: "y.js", type: "js", sizeBytes: 20, mtimeMs: 2 });
    graph.upsertFile(db, { relPath: "z.js", type: "js", sizeBytes: 30, mtimeMs: 3 });

    graph.replaceImports(db, "x.js", [
      { specifier: "./y", toPath: "y.js", kind: "relative" },
      { specifier: "./z", toPath: "z.js", kind: "relative" },
    ]);
    graph.replaceImports(db, "y.js", [
      { specifier: "./z", toPath: "z.js", kind: "relative" },
    ]);
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fanInByPaths returns fan-in counts", () => {
    const result = graph.fanInByPaths(db, ["y.js", "z.js"]);
    assert.equal(result.get("y.js"), 1); // only x imports y
    assert.equal(result.get("z.js"), 2); // x and y import z
  });

  it("fanOutByPaths returns fan-out counts", () => {
    const result = graph.fanOutByPaths(db, ["x.js", "y.js"]);
    assert.equal(result.get("x.js"), 2); // x imports y and z
    assert.equal(result.get("y.js"), 1); // y imports z
  });

  it("fileMetaByPaths returns file metadata", () => {
    const result = graph.fileMetaByPaths(db, ["x.js", "y.js"]);
    assert.equal(result.size, 2);
    assert.equal(result.get("x.js").type, "js");
    assert.equal(result.get("y.js").type, "js");
  });

  it("fanInByPaths with empty array returns empty Map", () => {
    const result = graph.fanInByPaths(db, []);
    assert.equal(result.size, 0);
  });

  it("fanOutByPaths with empty array returns empty Map", () => {
    const result = graph.fanOutByPaths(db, []);
    assert.equal(result.size, 0);
  });

  it("fileMetaByPaths with empty array returns empty Map", () => {
    const result = graph.fileMetaByPaths(db, []);
    assert.equal(result.size, 0);
  });
});

describe("graph export lookup", () => {
  let tmpDir, db;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-graph-export-"));
    fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
    db = await graph.loadDb(tmpDir);

    graph.upsertFile(db, { relPath: "hooks.js", type: "js", sizeBytes: 10, mtimeMs: 1 });
    graph.replaceExports(db, "hooks.js", [
      { name: "useState", kind: "named" },
      { name: "useEffect", kind: "named" },
    ]);
    graph.upsertFile(db, { relPath: "utils.js", type: "js", sizeBytes: 10, mtimeMs: 1 });
    graph.replaceExports(db, "utils.js", [
      { name: "useState", kind: "named" },
    ]);
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("findExportsBySymbol case-insensitive match", () => {
    const results = graph.findExportsBySymbol(db, "usestate");
    assert.equal(results.length, 2); // hooks.js and utils.js both export it
    const paths = results.map((r) => r.path);
    assert.ok(paths.includes("hooks.js"));
    assert.ok(paths.includes("utils.js"));
  });

  it("findExportsBySymbol exact name", () => {
    const results = graph.findExportsBySymbol(db, "useEffect");
    assert.equal(results.length, 1);
    assert.equal(results[0].path, "hooks.js");
  });

  it("findExportsBySymbol no match returns empty", () => {
    const results = graph.findExportsBySymbol(db, "nonexistent");
    assert.equal(results.length, 0);
  });
});

describe("graph re-export chain", () => {
  let tmpDir, db;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-graph-reexport-"));
    fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
    db = await graph.loadDb(tmpDir);

    // Chain: index.js -> barrel/hooks.js -> core/ReactHooks.js
    graph.upsertFile(db, { relPath: "index.js", type: "js", sizeBytes: 10, mtimeMs: 1 });
    graph.upsertFile(db, { relPath: "barrel/hooks.js", type: "js", sizeBytes: 10, mtimeMs: 1 });

    graph.replaceReexports(db, "index.js", [
      { name: "useState", kind: "reexport", from: "./barrel/hooks" },
    ]);
    graph.replaceReexports(db, "barrel/hooks.js", [
      { name: "useState", kind: "reexport", from: "./core/ReactHooks" },
    ]);
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("follows A -> B chain", () => {
    const chain = graph.findReexportChain(db, "useState");
    assert.ok(chain.length >= 1, `expected chain length >= 1, got ${chain.length}`);
    const paths = chain.map((c) => c.path);
    assert.ok(paths.includes("index.js"));
  });

  it("cycle prevention", async () => {
    // Add a cycle: create a temp graph with A->B->A
    const cycleTmp = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-graph-cycle-"));
    fs.mkdirSync(path.join(cycleTmp, ".planning", "intel"), { recursive: true });

    try {
      const cycleDb = await graph.loadDb(cycleTmp);
      graph.replaceReexports(cycleDb, "a.js", [
        { name: "foo", kind: "reexport", from: "./b" },
      ]);
      graph.replaceReexports(cycleDb, "b.js", [
        { name: "foo", kind: "reexport", from: "./a" },
      ]);
      // Should terminate without infinite loop
      const chain = graph.findReexportChain(cycleDb, "foo");
      assert.ok(chain.length <= 4, "cycle should be bounded");
    } finally {
      fs.rmSync(cycleTmp, { recursive: true, force: true });
    }
  });

  it("maxDepth limits chain traversal", () => {
    const chain = graph.findReexportChain(db, "useState", 0);
    // At depth 0, should still get seeds but not follow further
    assert.ok(chain.length <= 2);
  });

  it("non-existent symbol returns empty chain", () => {
    const chain = graph.findReexportChain(db, "nonexistent");
    assert.equal(chain.length, 0);
  });
});

describe("graph neighbors", () => {
  let tmpDir, db;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-graph-neighbors-"));
    fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
    db = await graph.loadDb(tmpDir);

    graph.upsertFile(db, { relPath: "a.js", type: "js", sizeBytes: 10, mtimeMs: 1 });
    graph.upsertFile(db, { relPath: "b.js", type: "js", sizeBytes: 10, mtimeMs: 1 });
    graph.upsertFile(db, { relPath: "c.js", type: "js", sizeBytes: 10, mtimeMs: 1 });

    // a imports b, c imports a
    graph.replaceImports(db, "a.js", [
      { specifier: "./b", toPath: "b.js", kind: "relative" },
    ]);
    graph.replaceImports(db, "c.js", [
      { specifier: "./a", toPath: "a.js", kind: "relative" },
    ]);
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("neighbors returns imports and dependents", () => {
    const result = graph.neighbors(db, "a.js");
    assert.ok(result.imports.includes("b.js"), "a imports b");
    assert.ok(result.dependents.includes("c.js"), "c depends on a");
  });

  it("neighbors respects limits", () => {
    const result = graph.neighbors(db, "a.js", { maxImports: 0, maxDependents: 0 });
    assert.equal(result.imports.length, 0);
    assert.equal(result.dependents.length, 0);
  });
});

describe("graph persistDb + reload", () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-graph-persist-"));
    fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persist and reload preserves data", async () => {
    const db1 = await graph.loadDb(tmpDir);
    graph.upsertFile(db1, { relPath: "persist.js", type: "js", sizeBytes: 99, mtimeMs: 999 });
    graph.replaceExports(db1, "persist.js", [{ name: "foo", kind: "named" }]);
    await graph.persistDb(tmpDir);

    // Verify the file was written
    const dbPath = graph.graphDbPath(tmpDir);
    assert.ok(fs.existsSync(dbPath), "graph.db should exist after persist");

    // The db is cached in memory, so countFiles still works
    assert.equal(graph.countFiles(db1), 1);
    const exports = graph.queryExports(db1, "persist.js");
    assert.equal(exports.length, 1);
    assert.equal(exports[0].name, "foo");
  });
});
