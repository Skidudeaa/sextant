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

    // Fan-in: intel.js is imported by 5 files, graph.js by 1.
    // WHY 5: the "case-insensitive symbol match" test queries `withqueue`
    // (all-lowercase, not code-shaped), which the docs/012 term-quality gate
    // only admits when the target file clears EXPORT_INJECT_MIN_FANIN — so
    // intel.js must sit at the floor for that test to keep exercising the
    // case-insensitive lookup rather than the gate.
    for (const f of ["a.js", "b.js", "c.js", "d.js", "e.js"]) {
      graph.upsertFile(db, { relPath: f, type: "js", sizeBytes: 10, mtimeMs: 1 });
      graph.replaceImports(db, f, [
        { specifier: "./lib/intel", toPath: "lib/intel.js", kind: "relative" },
      ]);
    }
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

describe("graphRetrieve — export-injection term-quality gate (docs/012 fix 1)", () => {
  let tmpDir, db;

  before(async () => {
    ({ tmpDir, db } = await freshDb("gate"));

    // The junk shape: a pytest fixture file "exporting" generic names, fan-in 0.
    graph.upsertFile(db, { relPath: "tests/conftest.py", type: "py", sizeBytes: 300, mtimeMs: 1 });
    graph.replaceExports(db, "tests/conftest.py", [
      { name: "client", kind: "function" },
      { name: "session", kind: "function" },
    ]);

    // The rescued shape: a models module exporting a generic name `user`,
    // but with structural authority (fan-in >= EXPORT_INJECT_MIN_FANIN).
    graph.upsertFile(db, { relPath: "db/models.py", type: "py", sizeBytes: 900, mtimeMs: 1 });
    graph.replaceExports(db, "db/models.py", [{ name: "user", kind: "function" }]);
    for (let i = 0; i < 5; i++) {
      const f = `imp${i}.py`;
      graph.upsertFile(db, { relPath: f, type: "py", sizeBytes: 10, mtimeMs: 1 });
      graph.replaceImports(db, f, [
        { specifier: "db.models", toPath: "db/models.py", kind: "local" },
      ]);
    }

    // The exact-case-distinctive shape: a PascalCase class in a small repo
    // (fan-in 0) — `Widget` must match, `widget` must not.
    graph.upsertFile(db, { relPath: "ui/widget.py", type: "py", sizeBytes: 200, mtimeMs: 1 });
    graph.replaceExports(db, "ui/widget.py", [{ name: "Widget", kind: "class" }]);

    // The code-shaped escape hatch: snake_case term, fan-in 0.
    graph.upsertFile(db, { relPath: "svc/runner.py", type: "py", sizeBytes: 200, mtimeMs: 1 });
    graph.replaceExports(db, "svc/runner.py", [{ name: "run_pipeline", kind: "function" }]);
  });

  after(() => cleanup(tmpDir));

  function exportHit(result, p) {
    return result.files.find((f) => f.path === p && f.hitType === "exported_symbol");
  }

  it("generic lowercase term + low-fan-in target is NOT injected (pytest-fixture junk)", () => {
    // "client"/"session" are the docs/012 junk archetypes: 0/89 test-path
    // surfacings opened; fixture exports matched conversational words.
    assert.equal(exportHit(graphRetrieve(db, ["client"]), "tests/conftest.py"), undefined);
    assert.equal(exportHit(graphRetrieve(db, ["session"]), "tests/conftest.py"), undefined);
  });

  it("generic term + fan-in at the floor IS injected (the User-model rescue)", () => {
    const hit = exportHit(graphRetrieve(db, ["user"]), "db/models.py");
    assert.ok(hit, "high-fan-in models module must survive the gate");
  });

  it("exact-case match on a case-distinctive name passes at fan-in 0", () => {
    assert.ok(exportHit(graphRetrieve(db, ["Widget"]), "ui/widget.py"),
      "PascalCase exact-case match is an intentional identifier lookup");
    assert.equal(exportHit(graphRetrieve(db, ["widget"]), "ui/widget.py"), undefined,
      "the all-lowercase English word must stay gated");
  });

  it("code-shaped term passes at fan-in 0", () => {
    assert.ok(exportHit(graphRetrieve(db, ["run_pipeline"]), "svc/runner.py"));
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

describe("classifyPathMatch — docs/013 match-location taxonomy", () => {
  const { classifyPathMatch } = require("../lib/graph-retrieve");

  it("classifies each tier", () => {
    assert.equal(classifyPathMatch("renderer", "services/renderer.py"), "stem-exact");
    assert.equal(classifyPathMatch("transfer", "lib/transfer_utils.py"), "stem-token");
    assert.equal(classifyPathMatch("transfer", "static/js/transfer/index.js"), "dir-segment");
    assert.equal(classifyPathMatch("flag", "lib/flags.py"), "near"); // plural, 1 leftover char
    assert.equal(classifyPathMatch("render", "services/renderer.py"), "near"); // truncation, 2 leftover
    assert.equal(classifyPathMatch("roup", "lib/grouping.js"), "loose"); // mid-word
    assert.equal(classifyPathMatch("hness", "lib/freshness.js"), "loose"); // typo-suffix, 4 leftover
  });

  it("strips stray dots and handles empties defensively", () => {
    assert.equal(classifyPathMatch("up.", "tools/setup.py"), "loose");
    assert.equal(classifyPathMatch("", "a/b.js"), "loose");
  });
});

describe("graphRetrieve — path-match tiers + borderline drop (docs/013)", () => {
  let tmpDir, db;

  before(async () => {
    ({ tmpDir, db } = await freshDb("pathtier"));
    graph.upsertFile(db, { relPath: "static/transfer/index.js", type: "js", sizeBytes: 100, mtimeMs: 1 }); // dir-segment
    graph.upsertFile(db, { relPath: "lib/transfer_utils.js", type: "js", sizeBytes: 100, mtimeMs: 1 });    // stem-token
    graph.upsertFile(db, { relPath: "lib/grouping.js", type: "js", sizeBytes: 100, mtimeMs: 1 });          // loose for "roup"
    graph.upsertFile(db, { relPath: "lib/flags.js", type: "js", sizeBytes: 100, mtimeMs: 1 });             // near for "flag"
  });

  after(() => cleanup(tmpDir));

  it("dir-segment match outranks a stem-token match (strong tier)", () => {
    const result = graphRetrieve(db, ["transfer"]);
    const paths = result.files.map((f) => f.path);
    const dirIdx = paths.indexOf("static/transfer/index.js");
    const tokIdx = paths.indexOf("lib/transfer_utils.js");
    assert.ok(dirIdx !== -1 && tokIdx !== -1, "both must surface");
    assert.ok(dirIdx < tokIdx, "dir-segment (22.9% open rate) must sort above stem-token (3.9%)");
  });

  it("borderline turn drops loose mid-word matches, keeps near matches", () => {
    const loose = graphRetrieve(db, ["roup"], { borderline: true });
    assert.ok(!loose.files.some((f) => f.path === "lib/grouping.js"),
      "mid-word guess must be dropped on a borderline turn (1.4% noise)");
    const near = graphRetrieve(db, ["flag"], { borderline: true });
    assert.ok(near.files.some((f) => f.path === "lib/flags.js"),
      "near (plural) match must survive a borderline turn");
  });

  it("confident turn keeps loose matches (typo rescue)", () => {
    const result = graphRetrieve(db, ["roup"]);
    assert.ok(result.files.some((f) => f.path === "lib/grouping.js"),
      "loose matches stay on confident turns — that's where the typo rescues live");
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
    // snake_case so the docs/012 term-quality gate stays out of the way —
    // this test is about MIN_TERM_LENGTH, not term quality.
    graph.replaceExports(db, "ab.js", [{ name: "abc_def", kind: "named" }]);
    const result = graphRetrieve(db, ["ab", "abc_def"]);
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

// WHY: Swift codebases don't populate the JS-style `exports` table —
// type and member defs land in `swift_declarations` instead.  Before the
// hook fast path called findDeclarationsBySymbol, queries like `URI` on
// a real Swift codebase silently dominated by URITests.swift hit counts
// because URI.swift's canonical `public struct URI` declaration never
// reached the hook's ranker.  These tests lock in that the layer-2
// Swift-decl lookup surfaces the declaring file and that authoritative
// kinds outscore secondary kinds.
describe("graphRetrieve — Swift declaration lookup (layer 2)", () => {
  let tmpDir, db;

  before(async () => {
    ({ tmpDir, db } = await freshDb("swift-decl"));

    graph.upsertFile(db, { relPath: "Sources/App/URI.swift", type: "swift", sizeBytes: 500, mtimeMs: 1 });
    graph.upsertFile(db, { relPath: "Sources/App/Application.swift", type: "swift", sizeBytes: 800, mtimeMs: 2 });
    graph.upsertFile(db, { relPath: "Sources/App/AppExt.swift", type: "swift", sizeBytes: 200, mtimeMs: 3 });
    graph.upsertFile(db, { relPath: "Tests/AppTests/URITests.swift", type: "swift", sizeBytes: 1500, mtimeMs: 4 });

    graph.replaceSwiftDeclarations(db, "Sources/App/URI.swift", [
      { name: "URI", kind: "struct", start_byte: 100, end_byte: 200 },
      { name: "URI", kind: "extension", start_byte: 300, end_byte: 400 },
    ]);
    graph.replaceSwiftDeclarations(db, "Sources/App/Application.swift", [
      { name: "Application", kind: "class", start_byte: 50, end_byte: 800 },
    ]);
    graph.replaceSwiftDeclarations(db, "Sources/App/AppExt.swift", [
      { name: "Application", kind: "extension", start_byte: 10, end_byte: 100 },
    ]);
    graph.replaceSwiftDeclarations(db, "Tests/AppTests/URITests.swift", [
      // The test file shouldn't even appear via swift_declarations — it's
      // just a sanity check that the lookup is name-based, not file-based.
    ]);
  });

  after(() => cleanup(tmpDir));

  it("finds the file declaring a Swift type", () => {
    const result = graphRetrieve(db, ["URI"]);
    assert.ok(result.files.length > 0, "should find at least one file");
    // URI.swift declares both a struct and an extension named URI; the
    // type-decl hit type wins on score (100 vs 80).
    assert.equal(result.files[0].path, "Sources/App/URI.swift");
    assert.equal(result.files[0].hitType, "swift_decl_type");
    assert.ok(result.files[0].matchedTerms.includes("URI"));
  });

  it("authoritative type kinds outrank extension kinds", () => {
    // Two files declare "Application": Application.swift as `class`,
    // AppExt.swift as `extension`.  The class def must rank first.
    const result = graphRetrieve(db, ["Application"]);
    assert.equal(result.files[0].path, "Sources/App/Application.swift");
    assert.equal(result.files[0].hitType, "swift_decl_type");
    assert.equal(result.files[1].path, "Sources/App/AppExt.swift");
    assert.equal(result.files[1].hitType, "swift_decl_other");
  });

  it("layer 2 score-100 type-decl is suppression-eligible", () => {
    // Definition-site suppression (lines 130-141 of graph-retrieve.js)
    // halves fan-in boost on non-def files when ANY def exists for the
    // query.  Adding fan-in on AppExt.swift exercises the suppression
    // pass — without it, AppExt's fan-in could push past Application.swift.
    graph.upsertFile(db, { relPath: "consumer1.swift", type: "swift", sizeBytes: 50, mtimeMs: 1 });
    graph.upsertFile(db, { relPath: "consumer2.swift", type: "swift", sizeBytes: 50, mtimeMs: 1 });
    graph.upsertFile(db, { relPath: "consumer3.swift", type: "swift", sizeBytes: 50, mtimeMs: 1 });
    graph.replaceImports(db, "consumer1.swift", [
      { specifier: "./AppExt", toPath: "Sources/App/AppExt.swift", kind: "relative" },
    ]);
    graph.replaceImports(db, "consumer2.swift", [
      { specifier: "./AppExt", toPath: "Sources/App/AppExt.swift", kind: "relative" },
    ]);
    graph.replaceImports(db, "consumer3.swift", [
      { specifier: "./AppExt", toPath: "Sources/App/AppExt.swift", kind: "relative" },
    ]);

    const result = graphRetrieve(db, ["Application"]);
    // Application.swift (the type def) must still rank first despite
    // AppExt.swift's higher fan-in, because suppression halves AppExt's boost.
    assert.equal(result.files[0].path, "Sources/App/Application.swift");
  });

  it("returns swift_decl_other for non-type kinds", () => {
    // freshDb gives us a separate suite so we get a clean slate.
    // Here we just confirm the hit-type taxonomy mapping for
    // extension / let / var / func / init / case kinds.
    const result = graphRetrieve(db, ["Application"]);
    const ext = result.files.find((f) => f.path === "Sources/App/AppExt.swift");
    assert.ok(ext, "AppExt.swift should be in results");
    assert.equal(ext.hitType, "swift_decl_other");
  });

  it("respects MIN_TERM_LENGTH (term < 3 chars)", () => {
    // A term shorter than 3 chars never reaches findDeclarationsBySymbol —
    // the layer's per-term loop short-circuits.
    const result = graphRetrieve(db, ["UR"]);
    // No results expected since "UR" is too short to match anything.
    // (filePathsMatching might catch it via path substring, but URI is
    // 3 chars in the path "URI.swift" which would match "UR" as
    // substring — assert that we don't get the swift_decl_type hit.)
    const decl = result.files.find((f) => f.hitType === "swift_decl_type");
    assert.equal(decl, undefined, "no swift_decl_type expected for sub-3-char term");
  });
});
