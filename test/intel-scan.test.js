"use strict";

// Integration-ish tests for intel.scan's prune-missing behavior.
// These test the actual glob+filesystem interaction because the bug they
// prevent (prefix-based prune silently no-opping on "**/*.js" globs)
// only surfaces when a real fast-glob run meets a real db with ghost entries.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync, spawnSync } = require("child_process");

const intel = require("../lib/intel");
const graph = require("../lib/graph");
const freshness = require("../lib/freshness");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sextant-scan-"));
}

function writeFile(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function initGit(root) {
  execSync("git init -q", { cwd: root });
  execSync('git config user.email "test@example.com"', { cwd: root });
  execSync('git config user.name "Test"', { cwd: root });
  execSync("git add -A && git commit -qm base", { cwd: root });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFresh(root, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  let checked = null;
  while (Date.now() < deadline) {
    checked = await freshness.checkFreshness(root);
    if (checked.fresh) return checked;
    await sleep(100);
  }
  return checked;
}

async function waitForManifestGeneration(root, generation, timeoutMs = 4000) {
  const target = path.join(root, ".planning", "intel", ".summary-manifest.json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const manifest = JSON.parse(fs.readFileSync(target, "utf8"));
      if (manifest.graphGeneration === generation) return manifest;
    } catch {}
    await sleep(100);
  }
  return null;
}

describe("intel.scan — prune-missing with wildcard-prefix globs", () => {
  let root;

  before(() => {
    root = mkTmp();
    writeFile(root, "lib/a.js", "module.exports = 1;");
    writeFile(root, "lib/b.js", "module.exports = 2;");
    writeFile(root, "src/c.js", "module.exports = 3;");
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("pruneMissing: true removes db entries whose source file was deleted", async () => {
    // Initial scan — all three files present.
    await intel.scan(root, ["**/*.js"]);
    let db = await graph.loadDb(root);
    let paths = graph.allFilePaths(db);
    assert.equal(paths.length, 3, "initial scan indexed all files");

    // Delete one file from the filesystem.
    fs.unlinkSync(path.join(root, "src/c.js"));

    // Rescan with pruneMissing — deleted file must be removed from db.
    await intel.scan(root, ["**/*.js"], { pruneMissing: true });
    db = await graph.loadDb(root);
    paths = graph.allFilePaths(db);
    assert.equal(paths.length, 2, "pruneMissing removed the deleted file");
    assert.ok(!paths.includes("src/c.js"), "src/c.js no longer in db");
  });

  it("pruneMissing: false leaves ghost entries alone", async () => {
    // Seed: create a fresh root, scan, delete a file, rescan without pruneMissing.
    const root2 = mkTmp();
    try {
      writeFile(root2, "a.js", "module.exports = 1;");
      writeFile(root2, "b.js", "module.exports = 2;");
      await intel.scan(root2, ["**/*.js"]);
      fs.unlinkSync(path.join(root2, "b.js"));

      await intel.scan(root2, ["**/*.js"]); // no pruneMissing
      const db = await graph.loadDb(root2);
      const paths = graph.allFilePaths(db);
      assert.ok(paths.includes("b.js"), "ghost entry preserved without pruneMissing");
    } finally {
      fs.rmSync(root2, { recursive: true, force: true });
    }
  });

  it("reports ghostCount in done progress callback when pruneMissing: false", async () => {
    const root3 = mkTmp();
    try {
      writeFile(root3, "a.js", "x");
      writeFile(root3, "b.js", "y");
      await intel.scan(root3, ["**/*.js"]);
      fs.unlinkSync(path.join(root3, "b.js"));

      let capturedDone = null;
      await intel.scan(root3, ["**/*.js"], {
        onProgress: (ev) => { if (ev.phase === "done") capturedDone = ev; },
      });
      assert.equal(capturedDone?.ghostCount, 1, "ghost count surfaced to caller");
    } finally {
      fs.rmSync(root3, { recursive: true, force: true });
    }
  });

  it("pruneMissing: true reports ghostCount as 0 (ghosts already cleaned)", async () => {
    const root4 = mkTmp();
    try {
      writeFile(root4, "a.js", "x");
      writeFile(root4, "b.js", "y");
      await intel.scan(root4, ["**/*.js"]);
      fs.unlinkSync(path.join(root4, "b.js"));

      let capturedDone = null;
      await intel.scan(root4, ["**/*.js"], {
        pruneMissing: true,
        onProgress: (ev) => { if (ev.phase === "done") capturedDone = ev; },
      });
      assert.equal(capturedDone?.ghostCount, 0, "pruneMissing cleaned ghosts, count is 0");
    } finally {
      fs.rmSync(root4, { recursive: true, force: true });
    }
  });

  it("does not stamp old extraction facts current when the repo moves mid-scan", async () => {
    const root5 = mkTmp();
    try {
      writeFile(root5, "lib/api.js", "exports.oldName = () => 1;\n");
      initGit(root5);

      let moved = false;
      await intel.scan(root5, ["**/*.js"], {
        force: true,
        onProgress: (event) => {
          if (!moved && event.phase === "indexing" && event.file === "lib/api.js") {
            moved = true;
            writeFile(root5, "lib/api.js", "exports.newName = () => 2;\n");
          }
        },
      });

      const db = await graph.loadDb(root5);
      assert.ok(
        graph.queryExports(db, "lib/api.js").some((entry) => entry.name === "oldName"),
        "fixture must leave the graph with the pre-move extraction"
      );
      const checked = await freshness.checkFreshness(root5);
      assert.equal(checked.fresh, false);
      assert.equal(checked.reason, "status_changed");
      assert.equal(
        graph.getMetaValue(db, freshness.META_STATUS_HASH),
        "",
        "mixed scan must carry an explicit invalid freshness anchor"
      );
    } finally {
      fs.rmSync(root5, { recursive: true, force: true });
    }
  });

  it("keeps deliberate non-git scans usable but structural freshness fail-closed", async () => {
    const root6 = mkTmp();
    try {
      writeFile(root6, "api.js", "exports.nonGit = true;\n");
      await intel.scan(root6, ["**/*.js"], { force: true });
      const db = await graph.loadDb(root6);
      assert.ok(graph.queryExports(db, "api.js").some((entry) => entry.name === "nonGit"));
      assert.equal(graph.getMetaValue(db, freshness.META_STATUS_HASH), "");
      assert.match(graph.getMetaValue(db, freshness.META_GRAPH_GENERATION), /^[0-9a-f]{32}$/);
      const checked = await freshness.checkFreshness(root6);
      // The invariant this test exists for is UNCHANGED: a non-git scan stays
      // usable (exports above) while structural freshness fails closed.
      assert.equal(checked.fresh, false);
      // The REASON changed (docs/035 #2). It used to be "head_changed", which
      // named a HEAD move in a directory that has no HEAD — a fabricated fact,
      // and one that could never clear, so the gate also enqueued a futile
      // rescan on every read. "git_absent" says the true thing: there is no
      // anchor here, and rescanning cannot create one.
      assert.equal(checked.reason, "git_absent");
      assert.equal(checked.rescanUseless, true);
    } finally {
      fs.rmSync(root6, { recursive: true, force: true });
    }
  });

  it("makes A→B extraction→A restoration sticky instead of blessing B facts", async () => {
    const root7 = mkTmp();
    try {
      writeFile(root7, "api.js", "exports.stateA = true;\n");
      initGit(root7);
      await intel.scan(root7, ["**/*.js"], { force: true });

      let phase = 0;
      await intel.scan(root7, ["**/*.js"], {
        force: true,
        coverageDiagnostics: false,
        cochange: false,
        onProgress: (event) => {
          if (event.phase === "start" && phase === 0) {
            phase = 1;
            writeFile(root7, "api.js", "exports.transientB = true;\n");
          } else if (event.phase === "indexing" && event.file === "api.js" && phase === 1) {
            phase = 2;
            writeFile(root7, "api.js", "exports.stateA = true;\n");
          }
        },
      });

      const db = await graph.loadDb(root7);
      assert.ok(
        graph.queryExports(db, "api.js").some((entry) => entry.name === "transientB"),
        "fixture must prove transient B was the extracted source"
      );
      assert.equal(graph.getMetaValue(db, freshness.META_STATUS_HASH), "");
      assert.equal((await freshness.checkFreshness(root7)).fresh, false);
    } finally {
      fs.rmSync(root7, { recursive: true, force: true });
    }
  });

  it("ordinary scan reindexes clean importers when a new resolver target appears", async () => {
    const root7b = mkTmp();
    try {
      writeFile(root7b, "importer.js", "const target = require('./target');\nexports.target = target;\n");
      initGit(root7b);
      await intel.scan(root7b, ["**/*.js"], { force: true });
      let db = await graph.loadDb(root7b);
      assert.equal(graph.queryImports(db, "importer.js")[0]?.toPath, null);

      writeFile(root7b, "target.js", "exports.arrived = true;\n");
      await intel.scan(root7b, ["**/*.js"]); // deliberately no --force

      db = await graph.loadDb(root7b);
      assert.equal(graph.queryImports(db, "importer.js")[0]?.toPath, "target.js");
      assert.equal((await freshness.checkFreshness(root7b)).fresh, true);
    } finally {
      fs.rmSync(root7b, { recursive: true, force: true });
    }
  });

  it("ordinary scan reindexes clean sources when resolver control content changes", async () => {
    const root7c = mkTmp();
    try {
      writeFile(root7c, "src/main.ts", "import { util } from '@lib/util';\nexport { util };\n");
      writeFile(root7c, "lib/util.ts", "export const util = 1;\n");
      writeFile(root7c, "tsconfig.json", JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@other/*": ["other/*"] } },
      }));
      initGit(root7c);
      await intel.scan(root7c, ["**/*.ts"], { force: true });
      let db = await graph.loadDb(root7c);
      assert.equal(graph.queryImports(db, "src/main.ts")[0]?.toPath, null);

      await sleep(20);
      writeFile(root7c, "tsconfig.json", JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["lib/*"] } },
      }));
      await intel.scan(root7c, ["**/*.ts"]); // deliberately no --force

      db = await graph.loadDb(root7c);
      assert.equal(graph.queryImports(db, "src/main.ts")[0]?.toPath, "lib/util.ts");
      assert.equal((await freshness.checkFreshness(root7c)).fresh, true);
    } finally {
      fs.rmSync(root7c, { recursive: true, force: true });
    }
  });

  it("reconciles a second edit that lands after watcher extraction but before debounce persist", async () => {
    const root8 = mkTmp();
    try {
      writeFile(root8, "api.js", "exports.initial = true;\n");
      initGit(root8);
      await intel.scan(root8, ["**/*.js"], { force: true });

      writeFile(root8, "api.js", "exports.firstEvent = true;\n");
      await intel.updateFile(root8, "api.js");
      // No second updateFile call: this is precisely the extraction→stamp gap.
      writeFile(root8, "api.js", "exports.latestBytes = true;\n");

      const checked = await waitForFresh(root8);
      assert.equal(checked?.fresh, true, `watcher did not converge: ${checked?.reason}`);
      const db = await graph.loadDb(root8);
      const names = graph.queryExports(db, "api.js").map((entry) => entry.name);
      assert.ok(names.includes("latestBytes"));
      assert.ok(!names.includes("firstEvent"));

      const manifest = await waitForManifestGeneration(root8, checked.graphGeneration);
      assert.ok(manifest, "summary manifest must catch up to the persisted graph generation");
    } finally {
      fs.rmSync(root8, { recursive: true, force: true });
    }
  });

  it("removes stale graph facts and invalidates when an indexed file becomes a symlink", {
    skip: process.platform === "win32",
  }, async () => {
    const root9 = mkTmp();
    try {
      writeFile(root9, "api.js", "exports.regularFile = true;\n");
      initGit(root9);
      await intel.scan(root9, ["**/*.js"], { force: true });
      let db = await graph.loadDb(root9);
      const initialGeneration = graph.getMetaValue(db, freshness.META_GRAPH_GENERATION);

      fs.unlinkSync(path.join(root9, "api.js"));
      fs.symlinkSync("target.txt", path.join(root9, "api.js"));
      writeFile(root9, "target.txt", "not JavaScript\n");
      await intel.updateFile(root9, "api.js");

      for (let i = 0; i < 40; i++) {
        db = await graph.loadDb(root9);
        if (
          graph.getFileMeta(db, "api.js") === null &&
          graph.getMetaValue(db, freshness.META_GRAPH_GENERATION) !== initialGeneration &&
          graph.getMetaValue(db, freshness.META_STATUS_HASH) === ""
        ) break;
        await sleep(100);
      }
      assert.equal(graph.getFileMeta(db, "api.js"), null);
      assert.deepEqual(graph.queryExports(db, "api.js"), []);
      const checked = await freshness.checkFreshness(root9);
      assert.equal(checked.fresh, false, "type change requires importer-wide bulk healing");
      assert.equal(graph.getMetaValue(db, freshness.META_STATUS_HASH), "");
      assert.equal(
        await waitForManifestGeneration(root9, checked.graphGeneration, 300),
        null,
        "an invalid graph generation must never receive a summary manifest"
      );
    } finally {
      fs.rmSync(root9, { recursive: true, force: true });
    }
  });

  it("does not pull status-only source files outside a narrow watcher scope into the graph", async () => {
    const root10 = mkTmp();
    try {
      writeFile(root10, "src/in.js", "exports.inScope = true;\n");
      writeFile(root10, "other/out.js", "exports.outOfScope = true;\n");
      initGit(root10);
      await intel.scan(root10, ["src/**/*.js"], { force: true });

      writeFile(root10, "other/out.js", "exports.changedOutside = true;\n");
      writeFile(root10, "src/in.js", "exports.changedInside = true;\n");
      await intel.updateFile(root10, "src/in.js");
      await sleep(1100);

      const db = await graph.loadDb(root10);
      assert.equal(graph.getFileMeta(db, "other/out.js"), null);
      assert.ok(graph.queryExports(db, "src/in.js").some((entry) => entry.name === "changedInside"));
      assert.equal((await freshness.checkFreshness(root10)).fresh, false);
      const generation = graph.getMetaValue(db, freshness.META_GRAPH_GENERATION);
      assert.equal(
        await waitForManifestGeneration(root10, generation, 300),
        null,
        "an invalid graph generation must never receive a summary manifest"
      );
    } finally {
      fs.rmSync(root10, { recursive: true, force: true });
    }
  });
});
