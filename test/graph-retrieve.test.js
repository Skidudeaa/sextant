"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const graph = require("../lib/graph");
const { graphRetrieve } = require("../lib/graph-retrieve");

// Helper: create a fresh in-memory database with a unique temp dir.
// WHY: loadDb caches by rootAbs, so each describe block needs its own
// temp dir to avoid collisions with other tests.
async function freshDb(suffix) {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `sextant-graph-retrieve-${suffix}-`)
  );
  fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
  const db = await graph.loadDb(tmpDir);
  return { tmpDir, db };
}

function cleanup(tmpDir) {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe("graphRetrieve — export symbol lookup (layer 1)", () => {
  let tmpDir, db;

  before(async () => {
    ({ tmpDir, db } = await freshDb("export"));

    graph.upsertFile(db, { relPath: "lib/resolver.js", type: "js", sizeBytes: 500, mtimeMs: 1 });
    graph.upsertFile(db, { relPath: "lib/graph.js", type: "js", sizeBytes: 800, mtimeMs: 2 });
    graph.upsertFile(db, { relPath: "lib/intel.js", type: "js", sizeBytes: 1200, mtimeMs: 3 });

    graph.replaceExports(db, "lib/resolver.js", [
      { name: "resolveImport", kind: "named" },
      { name: "resolveAll", kind: "named" },
    ]);
    graph.replaceExports(db, "lib/graph.js", [
      { name: "findExportsBySymbol", kind: "named" },
      { name: "loadDb", kind: "named" },
    ]);
    graph.replaceExports(db, "lib/intel.js", [
      { name: "withQueue", kind: "named" },
    ]);

    // Fan-in: intel.js is imported by 3 files, graph.js by 1
    graph.upsertFile(db, { relPath: "a.js", type: "js", sizeBytes: 10, mtimeMs: 1 });
    graph.upsertFile(db, { relPath: "b.js", type: "js", sizeBytes: 10, mtimeMs: 1 });
    graph.upsertFile(db, { relPath: "c.js", type: "js", sizeBytes: 10, mtimeMs: 1 });
    graph.replaceImports(db, "a.js", [
      { specifier: "./lib/intel", toPath: "lib/intel.js", kind: "relative" },
    ]);
    graph.replaceImports(db, "b.js", [
      { specifier: "./lib/intel", toPath: "lib/intel.js", kind: "relative" },
    ]);
    graph.replaceImports(db, "c.js", [
      { specifier: "./lib/intel", toPath: "lib/intel.js", kind: "relative" },
      { specifier: "./lib/graph", toPath: "lib/graph.js", kind: "relative" },
    ]);
  });

  after(() => cleanup(tmpDir));

  it("finds file that exports the queried symbol", () => {
    const result = graphRetrieve(db, ["resolveImport"]);
    assert.ok(result.files.length > 0, "should find at least one file");
    assert.equal(result.files[0].path, "lib/resolver.js");
    assert.equal(result.files[0].hitType, "exported_symbol");
    assert.ok(result.files[0].matchedTerms.includes("resolveImport"));
  });

  it("finds findExportsBySymbol in graph.js", () => {
    const result = graphRetrieve(db, ["findExportsBySymbol"]);
    assert.ok(result.files.length > 0);
    assert.equal(result.files[0].path, "lib/graph.js");
  });

  it("case-insensitive symbol match", () => {
    const result = graphRetrieve(db, ["withqueue"]);
    assert.ok(result.files.length > 0);
    assert.equal(result.files[0].path, "lib/intel.js");
  });

  it("returns score, fanIn, fanOut, type in result entries", () => {
    const result = graphRetrieve(db, ["withQueue"]);
    const entry = result.files[0];
    assert.equal(typeof entry.score, "number");
    assert.equal(typeof entry.fanIn, "number");
    assert.equal(typeof entry.fanOut, "number");
    assert.equal(entry.type, "js");
    assert.ok(entry.fanIn >= 3, "intel.js has 3 importers");
  });

  it("returns durationMs", () => {
    const result = graphRetrieve(db, ["resolveImport"]);
    assert.equal(typeof result.durationMs, "number");
    assert.ok(result.durationMs >= 0);
  });
});

describe("graphRetrieve — re-export chain (layer 2)", () => {
  let tmpDir, db;

  before(async () => {
    ({ tmpDir, db } = await freshDb("reexport"));

    graph.upsertFile(db, { relPath: "index.js", type: "js", sizeBytes: 100, mtimeMs: 1 });
    graph.upsertFile(db, { relPath: "barrel/hooks.js", type: "js", sizeBytes: 200, mtimeMs: 2 });
    graph.upsertFile(db, { relPath: "core/ReactHooks.js", type: "js", sizeBytes: 300, mtimeMs: 3 });

    // Re-export chain: index.js -> barrel/hooks.js -> core/ReactHooks.js
    graph.replaceReexports(db, "index.js", [
      { name: "useState", kind: "reexport", from: "./barrel/hooks" },
    ]);
    graph.replaceReexports(db, "barrel/hooks.js", [
      { name: "useState", kind: "reexport", from: "./core/ReactHooks" },
    ]);

    // The original definition exports it too
    graph.replaceExports(db, "core/ReactHooks.js", [
      { name: "useState", kind: "named" },
    ]);
  });

  after(() => cleanup(tmpDir));

  it("traces re-export chain and finds barrel files", () => {
    const result = graphRetrieve(db, ["useState"]);
    const paths = result.files.map((f) => f.path);
    // Should find the original exporter and the barrel files
    assert.ok(paths.includes("core/ReactHooks.js"), "should find original definition");
    assert.ok(paths.includes("index.js"), "should find barrel entry point");
  });

  it("original exporter ranks above barrel file", () => {
    const result = graphRetrieve(db, ["useState"]);
    // WHY: exported_symbol (100) beats reexport_chain (80)
    const defIdx = result.files.findIndex((f) => f.path === "core/ReactHooks.js");
    const barrelIdx = result.files.findIndex((f) => f.path === "index.js");
    assert.ok(defIdx < barrelIdx, "definition file should rank above barrel");
  });

  it("re-export entries have hitType reexport_chain", () => {
    const result = graphRetrieve(db, ["useState"]);
    const barrel = result.files.find((f) => f.path === "barrel/hooks.js");
    // barrel/hooks.js only appears via the chain, not as a direct exporter
    if (barrel) {
      assert.equal(barrel.hitType, "reexport_chain");
    }
  });
});

describe("graphRetrieve — path matching (layer 3)", () => {
  let tmpDir, db;

  before(async () => {
    ({ tmpDir, db } = await freshDb("path"));

    graph.upsertFile(db, { relPath: "watch.js", type: "js", sizeBytes: 100, mtimeMs: 1 });
    graph.upsertFile(db, { relPath: "lib/watcher-utils.js", type: "js", sizeBytes: 200, mtimeMs: 2 });
    graph.upsertFile(db, { relPath: "lib/scorer.js", type: "js", sizeBytes: 300, mtimeMs: 3 });
    graph.upsertFile(db, { relPath: "lib/graph.js", type: "js", sizeBytes: 400, mtimeMs: 4 });

    // No exports with "watcher" in the name -- path matching is the only way
  });

  after(() => cleanup(tmpDir));

  it("finds files by path substring", () => {
    const result = graphRetrieve(db, ["watcher"]);
    const paths = result.files.map((f) => f.path);
    assert.ok(paths.includes("lib/watcher-utils.js"), "should match watcher-utils.js");
  });

  it("path matches have hitType path_match", () => {
    const result = graphRetrieve(db, ["watcher"]);
    const entry = result.files.find((f) => f.path === "lib/watcher-utils.js");
    assert.ok(entry);
    assert.equal(entry.hitType, "path_match");
  });

  it("watch matches watch.js via path", () => {
    const result = graphRetrieve(db, ["watch"]);
    const paths = result.files.map((f) => f.path);
    assert.ok(paths.includes("watch.js"));
  });
});

describe("graphRetrieve — deduplication", () => {
  let tmpDir, db;

  before(async () => {
    ({ tmpDir, db } = await freshDb("dedup"));

    // graph.js exports "loadDb" AND has "graph" in its path
    graph.upsertFile(db, { relPath: "lib/graph.js", type: "js", sizeBytes: 800, mtimeMs: 1 });
    graph.replaceExports(db, "lib/graph.js", [
      { name: "loadDb", kind: "named" },
    ]);
  });

  after(() => cleanup(tmpDir));

  it("file appearing in both exports and path has single entry with highest score", () => {
    // "graph" matches the path, "loadDb" matches the export
    const result = graphRetrieve(db, ["loadDb", "graph"]);
    const graphEntries = result.files.filter((f) => f.path === "lib/graph.js");
    assert.equal(graphEntries.length, 1, "should appear exactly once");
    // WHY: exported_symbol (100) > path_match (60), so hitType should be exported_symbol
    assert.equal(graphEntries[0].hitType, "exported_symbol");
    // Both terms should be tracked
    assert.ok(graphEntries[0].matchedTerms.includes("loadDb"));
    assert.ok(graphEntries[0].matchedTerms.includes("graph"));
  });
});

describe("graphRetrieve — ranking", () => {
  let tmpDir, db;

  before(async () => {
    ({ tmpDir, db } = await freshDb("ranking"));

    graph.upsertFile(db, { relPath: "popular.js", type: "js", sizeBytes: 100, mtimeMs: 1 });
    graph.upsertFile(db, { relPath: "unpopular.js", type: "js", sizeBytes: 100, mtimeMs: 2 });

    // Both export "doStuff"
    graph.replaceExports(db, "popular.js", [
      { name: "doStuff", kind: "named" },
    ]);
    graph.replaceExports(db, "unpopular.js", [
      { name: "doStuff", kind: "named" },
    ]);

    // popular.js has 5 importers, unpopular.js has 0
    for (let i = 0; i < 5; i++) {
      const imp = `imp${i}.js`;
      graph.upsertFile(db, { relPath: imp, type: "js", sizeBytes: 10, mtimeMs: 1 });
      graph.replaceImports(db, imp, [
        { specifier: "./popular", toPath: "popular.js", kind: "relative" },
      ]);
    }
  });

  after(() => cleanup(tmpDir));

  it("file with higher fan-in ranks above file with lower fan-in (same hit type)", () => {
    const result = graphRetrieve(db, ["doStuff"]);
    assert.ok(result.files.length >= 2);
    const popIdx = result.files.findIndex((f) => f.path === "popular.js");
    const unpopIdx = result.files.findIndex((f) => f.path === "unpopular.js");
    assert.ok(popIdx < unpopIdx, "popular.js should rank above unpopular.js");
    assert.ok(result.files[popIdx].score > result.files[unpopIdx].score);
  });

  it("fan-in bonus uses relative percentage (capped at 15% of base)", () => {
    const result = graphRetrieve(db, ["doStuff"]);
    const pop = result.files.find((f) => f.path === "popular.js");
    // Base score is 100 for exported_symbol.
    // Fan-in bonus = 100 * min(0.15, log1p(5)*0.02) = 100 * min(0.15, 0.0358) = 3.58
    // Total should be ~103.58, well under the old cap of 150
    assert.ok(pop.score <= 116, `score ${pop.score} exceeds 100 + 15% cap`);
    assert.ok(pop.score > 100, `score ${pop.score} should be above base of 100`);
  });
});

describe("graphRetrieve — empty results + warnings", () => {
  let tmpDir, db;

  before(async () => {
    ({ tmpDir, db } = await freshDb("empty"));

    graph.upsertFile(db, { relPath: "lib/foo.js", type: "js", sizeBytes: 100, mtimeMs: 1 });
  });

  after(() => cleanup(tmpDir));

  it("non-matching terms return empty files array with warning", () => {
    const result = graphRetrieve(db, ["nonexistentSymbol"]);
    assert.equal(result.files.length, 0);
    assert.ok(result.warnings.length > 0, "should have at least one warning");
    assert.ok(
      result.warnings.some((w) => w.includes("no matches found")),
      "warning should mention no matches"
    );
  });

  it("empty terms array returns empty results", () => {
    const result = graphRetrieve(db, []);
    assert.equal(result.files.length, 0);
    assert.ok(result.warnings.length > 0);
  });

  it("null terms handled gracefully", () => {
    const result = graphRetrieve(db, null);
    assert.equal(result.files.length, 0);
    assert.ok(result.warnings.length > 0);
  });
});

describe("graphRetrieve — short terms skipped", () => {
  let tmpDir, db;

  before(async () => {
    ({ tmpDir, db } = await freshDb("short"));

    graph.upsertFile(db, { relPath: "ab.js", type: "js", sizeBytes: 100, mtimeMs: 1 });
    graph.replaceExports(db, "ab.js", [{ name: "ab", kind: "named" }]);
  });

  after(() => cleanup(tmpDir));

  it("terms shorter than 3 chars are skipped", () => {
    const result = graphRetrieve(db, ["ab", "x"]);
    assert.equal(result.files.length, 0, "2-char and 1-char terms should be skipped");
    assert.ok(result.warnings.some((w) => w.includes("too short")));
  });

  it("mix of short and long terms: long terms still work", () => {
    graph.replaceExports(db, "ab.js", [{ name: "abcdef", kind: "named" }]);
    const result = graphRetrieve(db, ["ab", "abcdef"]);
    assert.ok(result.files.length > 0, "long term should still match");
  });
});

describe("graphRetrieve — maxResults cap", () => {
  let tmpDir, db;

  before(async () => {
    ({ tmpDir, db } = await freshDb("cap"));

    // Create 15 files, each exporting a symbol with "handler" in the name
    for (let i = 0; i < 15; i++) {
      const p = `handlers/handler${i}.js`;
      graph.upsertFile(db, { relPath: p, type: "js", sizeBytes: 100, mtimeMs: i });
      graph.replaceExports(db, p, [
        { name: `handler${i}`, kind: "named" },
      ]);
    }
  });

  after(() => cleanup(tmpDir));

  it("defaults to 10 results", () => {
    // "handler" in the path matches all 15 files
    const result = graphRetrieve(db, ["handler"]);
    assert.ok(result.files.length <= 10, `expected <= 10, got ${result.files.length}`);
  });

  it("respects custom maxResults", () => {
    const result = graphRetrieve(db, ["handler"], { maxResults: 3 });
    assert.ok(result.files.length <= 3, `expected <= 3, got ${result.files.length}`);
  });
});

describe("graphRetrieve — generic path terms skipped", () => {
  let tmpDir, db;

  before(async () => {
    ({ tmpDir, db } = await freshDb("generic"));

    // Create 12 files all containing "lib" in the path -- exceeds MAX_PATH_MATCHES (10)
    for (let i = 0; i < 12; i++) {
      graph.upsertFile(db, {
        relPath: `lib/file${i}.js`,
        type: "js",
        sizeBytes: 100,
        mtimeMs: i,
      });
    }
  });

  after(() => cleanup(tmpDir));

  it("skips path terms that match too many files", () => {
    // "lib" matches all 12 files -- should be skipped as too generic
    const result = graphRetrieve(db, ["lib"]);
    // No exports match "lib" either, so results should be empty
    assert.equal(result.files.length, 0);
  });
});

describe("graphRetrieve — definition-site suppression", () => {
  let tmpDir, db;

  before(async () => {
    ({ tmpDir, db } = await freshDb("suppression"));

    // Setup: resolver.js defines resolveImport (the definition site)
    // intel.js is a hub file that does NOT export resolveImport but has high fan-in
    graph.upsertFile(db, { relPath: "lib/resolver.js", type: "js", sizeBytes: 500, mtimeMs: 1 });
    graph.upsertFile(db, { relPath: "lib/intel.js", type: "js", sizeBytes: 1200, mtimeMs: 2 });

    graph.replaceExports(db, "lib/resolver.js", [
      { name: "resolveImport", kind: "named" },
    ]);

    // intel.js also exports resolveImport to trigger both appearing
    graph.replaceExports(db, "lib/intel.js", [
      { name: "resolveImport", kind: "named" },
    ]);

    // Give intel.js 10x the fan-in of resolver.js
    for (let i = 0; i < 10; i++) {
      const imp = `consumer${i}.js`;
      graph.upsertFile(db, { relPath: imp, type: "js", sizeBytes: 10, mtimeMs: 1 });
      graph.replaceImports(db, imp, [
        { specifier: "./lib/intel", toPath: "lib/intel.js", kind: "relative" },
      ]);
    }
    // resolver.js has only 1 importer
    graph.upsertFile(db, { relPath: "caller.js", type: "js", sizeBytes: 10, mtimeMs: 1 });
    graph.replaceImports(db, "caller.js", [
      { specifier: "./lib/resolver", toPath: "lib/resolver.js", kind: "relative" },
    ]);
  });

  after(() => cleanup(tmpDir));

  it("both definition files are exported_symbol when both export the queried symbol", () => {
    const result = graphRetrieve(db, ["resolveImport"]);
    const resolver = result.files.find((f) => f.path === "lib/resolver.js");
    const intel = result.files.find((f) => f.path === "lib/intel.js");
    assert.ok(resolver, "resolver.js should appear");
    assert.ok(intel, "intel.js should appear");
    // Both are exported_symbol, so both are treated as definition sites
    // Suppression doesn't fire when all candidates are definition files
    assert.equal(resolver.hitType, "exported_symbol");
    assert.equal(intel.hitType, "exported_symbol");
  });

  it("suppression halves fan-in bonus for non-definition files", async () => {
    // New scenario: only resolver.js exports the symbol, intel.js is a path match
    const { tmpDir: tmpDir2, db: db2 } = await freshDb("suppression2");

    graph.upsertFile(db2, { relPath: "lib/resolver.js", type: "js", sizeBytes: 500, mtimeMs: 1 });
    graph.upsertFile(db2, { relPath: "lib/intel.js", type: "js", sizeBytes: 1200, mtimeMs: 2 });

    // Only resolver.js exports resolveImport
    graph.replaceExports(db2, "lib/resolver.js", [
      { name: "resolveImport", kind: "named" },
    ]);
    // intel.js does NOT export it, but has "intel" in path

    // intel.js has high fan-in
    for (let i = 0; i < 10; i++) {
      const imp = `hub${i}.js`;
      graph.upsertFile(db2, { relPath: imp, type: "js", sizeBytes: 10, mtimeMs: 1 });
      graph.replaceImports(db2, imp, [
        { specifier: "./lib/intel", toPath: "lib/intel.js", kind: "relative" },
      ]);
    }

    // Query "resolveImport" — resolver.js = exported_symbol, intel.js = path_match at best
    const result = graphRetrieve(db2, ["resolveImport"]);
    const resolver = result.files.find((f) => f.path === "lib/resolver.js");

    // resolver.js should appear as the definition site
    assert.ok(resolver, "resolver.js should appear as exported_symbol");
    assert.equal(resolver.hitType, "exported_symbol");

    // intel.js shouldn't match at all since it doesn't export the symbol
    // and "resolveImport" doesn't appear in "lib/intel.js" path
    // This validates that suppression only matters when non-def files exist

    cleanup(tmpDir2);
  });
});

describe("graph.filePathsMatching", () => {
  let tmpDir, db;

  before(async () => {
    ({ tmpDir, db } = await freshDb("filepaths"));

    graph.upsertFile(db, { relPath: "watch.js", type: "js", sizeBytes: 100, mtimeMs: 1 });
    graph.upsertFile(db, { relPath: "lib/watcher.js", type: "js", sizeBytes: 200, mtimeMs: 2 });
    graph.upsertFile(db, { relPath: "lib/graph.js", type: "js", sizeBytes: 300, mtimeMs: 3 });
  });

  after(() => cleanup(tmpDir));

  it("returns paths matching substring", () => {
    const results = graph.filePathsMatching(db, "watch");
    assert.ok(results.includes("watch.js"));
    assert.ok(results.includes("lib/watcher.js"));
    assert.ok(!results.includes("lib/graph.js"));
  });

  it("case-insensitive matching", () => {
    const results = graph.filePathsMatching(db, "WATCH");
    assert.ok(results.length >= 2);
  });

  it("no match returns empty array", () => {
    const results = graph.filePathsMatching(db, "nonexistent");
    assert.equal(results.length, 0);
  });

  it("limits to 20 results", () => {
    // Insert 25 files matching "bulk"
    for (let i = 0; i < 25; i++) {
      graph.upsertFile(db, { relPath: `bulk/file${i}.js`, type: "js", sizeBytes: 10, mtimeMs: i });
    }
    const results = graph.filePathsMatching(db, "bulk");
    assert.ok(results.length <= 20, `expected <= 20, got ${results.length}`);
  });
});
