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

const intel = require("../lib/intel");
const graph = require("../lib/graph");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sextant-scan-"));
}

function writeFile(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
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
});
