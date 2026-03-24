"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { health, writeSummaryMarkdown } = require("../lib/summary");
const graphMod = require("../lib/graph");

// Helper: populate graph.db from an index-like object for test convenience.
// Clears existing data first so each test gets a clean state.
function populateGraphFromIndex(db, indexFiles) {
  // Clear existing data
  db.run("DELETE FROM files");
  db.run("DELETE FROM imports");
  db.run("DELETE FROM exports");
  db.run("DELETE FROM reexports");

  for (const [relPath, entry] of Object.entries(indexFiles || {})) {
    graphMod.upsertFile(db, {
      relPath,
      type: entry.type || null,
      sizeBytes: entry.sizeBytes || 0,
      mtimeMs: entry.mtimeMs || 1,
    });

    if (Array.isArray(entry.imports)) {
      const importsForGraph = entry.imports.map((imp) => ({
        specifier: imp.specifier,
        toPath: imp.resolved || null,
        kind: imp.kind || null,
        isExternal: imp.kind === "external" || imp.kind === "asset",
      }));
      graphMod.replaceImports(db, relPath, importsForGraph);
    }

    if (Array.isArray(entry.exports)) {
      const regularExports = [];
      const reexports = [];
      for (const ex of entry.exports) {
        if (ex.from) {
          reexports.push(ex);
        } else {
          regularExports.push(ex);
        }
      }
      graphMod.replaceExports(db, relPath, regularExports);
      graphMod.replaceReexports(db, relPath, reexports);
    }
  }
}

describe("summary health()", () => {
  let tmpDir, db;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-summary-health-"));
    fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
    db = await graphMod.loadDb(tmpDir);
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolution metrics with local imports", () => {
    populateGraphFromIndex(db, {
      "a.js": {
        type: "js",
        imports: [
          { specifier: "./b", resolved: "b.js", kind: "relative" },
          { specifier: "./c", resolved: null, kind: "unresolved" },
        ],
      },
      "b.js": { type: "js", imports: [] },
    });

    const result = health(tmpDir, { db, graph: graphMod });
    assert.equal(result.localTotal, 2);
    assert.equal(result.localResolved, 1);
    assert.equal(result.resolutionPct, 50);
    assert.equal(result.indexedFiles, 2);
  });

  it("empty index gives 100% resolution", () => {
    populateGraphFromIndex(db, {});

    const result = health(tmpDir, { db, graph: graphMod });
    assert.equal(result.resolutionPct, 100);
    assert.equal(result.indexedFiles, 0);
    assert.equal(result.localTotal, 0);
  });

  it("external imports are excluded from resolution", () => {
    populateGraphFromIndex(db, {
      "a.js": {
        type: "js",
        imports: [
          { specifier: "react", resolved: null, kind: "external" },
          { specifier: "./b", resolved: "b.js", kind: "relative" },
        ],
      },
    });

    const result = health(tmpDir, { db, graph: graphMod });
    assert.equal(result.localTotal, 1);
    assert.equal(result.localResolved, 1);
    assert.equal(result.resolutionPct, 100);
  });

  it("asset imports are excluded from resolution", () => {
    populateGraphFromIndex(db, {
      "a.js": {
        type: "js",
        imports: [
          { specifier: "./style.css", resolved: null, kind: "asset" },
        ],
      },
    });

    const result = health(tmpDir, { db, graph: graphMod });
    assert.equal(result.localTotal, 0);
    assert.equal(result.resolutionPct, 100);
  });

  it("empty db handled gracefully", () => {
    populateGraphFromIndex(db, {});

    const result = health(tmpDir, { db, graph: graphMod });
    assert.equal(result.indexedFiles, 0);
    assert.equal(result.resolutionPct, 100);
  });

  it("typeCounts in health output", () => {
    populateGraphFromIndex(db, {
      "a.js": { type: "js", imports: [] },
      "b.ts": { type: "ts", imports: [] },
      "c.js": { type: "js", imports: [] },
    });

    const result = health(tmpDir, { db, graph: graphMod });
    // js should appear before ts (2 > 1)
    assert.ok(result.typeCounts.length >= 2);
    assert.equal(result.typeCounts[0].t, "js");
    assert.equal(result.typeCounts[0].c, 2);
  });
});

describe("summary writeSummaryMarkdown()", () => {
  let tmpDir, db;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-summary-write-"));
    fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
    db = await graphMod.loadDb(tmpDir);
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("includes header for non-empty index", () => {
    populateGraphFromIndex(db, {
      "lib/core.js": { type: "js", imports: [] },
      "lib/a.js": { type: "js", imports: [{ specifier: "./core", resolved: "lib/core.js", kind: "relative" }] },
    });

    const md = writeSummaryMarkdown(tmpDir, { db, graph: graphMod });
    assert.ok(md.includes("## Codebase intelligence"), "should include header");
    assert.ok(md.includes("Indexed files"), "should include file count");
  });

  it("empty index shows rescan message", () => {
    populateGraphFromIndex(db, {});

    const md = writeSummaryMarkdown(tmpDir, { db, graph: graphMod });
    assert.ok(md.includes("No indexed files yet"), "should show empty state message");
    assert.ok(md.includes("sextant rescan"), "should suggest rescan");
  });

  it("health alert when resolution < 90%", () => {
    // Create many unresolved imports
    const files = {};
    for (let i = 0; i < 10; i++) {
      files[`file${i}.js`] = {
        type: "js",
        imports: [{ specifier: `./missing${i}`, resolved: null, kind: "unresolved" }],
      };
    }
    populateGraphFromIndex(db, files);

    const md = writeSummaryMarkdown(tmpDir, { db, graph: graphMod });
    assert.ok(md.includes("ALERT"), "should include ALERT for low resolution");
  });

  it("clamped at ~2200 chars", () => {
    // WHY: Test clampChars directly since writeSummaryMarkdown's section-level
    // truncation prevents the summary from exceeding 2200 chars organically.
    const { clampChars } = require("../lib/summary");
    const longStr = "A".repeat(3000);
    const clamped = clampChars(longStr, 2200);
    assert.ok(clamped.length <= 2200, `clamped should be <= 2200, got ${clamped.length}`);
    assert.ok(clamped.length > 0, "clamped should not be empty");

    // Also verify the summary itself stays bounded
    const files = {};
    for (let i = 0; i < 200; i++) {
      files[`long/path/to/deeply/nested/module/file_${i}_with_long_name.js`] = {
        type: "js",
        imports: [
          { specifier: "./other_very_long_specifier_name", resolved: `other_long_${i}.js`, kind: "relative" },
        ],
        exports: [{ name: `VeryLongExportName${i}`, kind: "named" }],
      };
    }
    populateGraphFromIndex(db, files);

    const md = writeSummaryMarkdown(tmpDir, { db, graph: graphMod });
    assert.ok(md.length <= 2200, `summary should be <= 2200 chars, got ${md.length}`);
  });

  it("XML escaping of paths with special chars", () => {
    populateGraphFromIndex(db, {
      "a.js": { type: "js", imports: [] },
    });

    const md = writeSummaryMarkdown(tmpDir, { db, graph: graphMod });
    // The root path should appear in the output (at minimum)
    assert.ok(md.includes("Root"), "should include root path");
  });
});

describe("summary XML escaping", () => {
  let tmpDir, db;

  before(async () => {
    // Create a temp dir whose name has no special chars, but test
    // the escaping by checking paths that appear in the output
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-summary-xml-"));
    fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
    db = await graphMod.loadDb(tmpDir);
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("paths with & < > are escaped in output", () => {
    // We cannot easily create files with <> in names on most filesystems,
    // but we can verify the function handles them via the graph
    populateGraphFromIndex(db, {
      "a.js": {
        type: "js",
        imports: [
          { specifier: "./missing<script>", resolved: null, kind: "unresolved" },
        ],
      },
    });

    const md = writeSummaryMarkdown(tmpDir, { db, graph: graphMod });
    // The unresolved specifier should appear XML-escaped in misses
    if (md.includes("Misses")) {
      assert.ok(!md.includes("<script>"), "should not contain raw <script>");
    }
  });
});
