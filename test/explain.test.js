"use strict";

// CLI `sextant explain <file|dir/>` (docs/021 form c) — end-to-end through
// bin/intel.js: dir aggregate (text + --json), file mode, and the explicit
// not-indexed failure (exit 1, never an empty aggregate).

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const graph = require("../lib/graph");

const BIN = path.resolve(__dirname, "..", "bin", "intel.js");

function runExplain(root, args) {
  return spawnSync(process.execPath, [BIN, "explain", ...args, "--root", root], {
    encoding: "utf8",
    timeout: 20000,
  });
}

describe("sextant explain — CLI end-to-end", () => {
  let dir;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-explain-cli-"));
    fs.mkdirSync(path.join(dir, ".planning", "intel"), { recursive: true });
    const db = await graph.loadDb(dir);
    for (const [rel, type] of [
      ["lib/core.js", "js"], ["lib/util.js", "js"],
      ["commands/a.js", "js"], ["test/t.js", "js"],
    ]) {
      graph.upsertFile(db, { relPath: rel, type, sizeBytes: 10, mtimeMs: 1 });
    }
    graph.replaceImports(db, "lib/util.js", [{ specifier: "./core", toPath: "lib/core.js", kind: "relative" }]);
    graph.replaceImports(db, "commands/a.js", [{ specifier: "../lib/core", toPath: "lib/core.js", kind: "relative" }]);
    graph.replaceImports(db, "test/t.js", [{ specifier: "../lib/util", toPath: "lib/util.js", kind: "relative" }]);
    graph.replaceExports(db, "lib/core.js", [{ name: "boot", kind: "named" }]);
    await graph.persistDb(dir);
  });

  after(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("dir mode renders the aggregate view", () => {
    const res = runExplain(dir, ["lib/"]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^lib\/ {2}2 files \(js 2\)/m);
    assert.match(res.stdout, /hotspots \(fan-in\): core\.js 2, util\.js 1/);
    assert.match(res.stdout, /inbound: {2}2 imports from commands\/ \(1\), test\/ \(1\)/);
    assert.match(res.stdout, /internal: 1 edges/);
  });

  it("dir mode --json returns the explainDir shape", () => {
    const res = runExplain(dir, ["lib/", "--json"]);
    assert.equal(res.status, 0, res.stderr);
    const data = JSON.parse(res.stdout);
    assert.equal(data.dir, "lib/");
    assert.equal(data.files, 2);
    assert.equal(data.inbound.total, 2);
    assert.equal(data.hotspots[0].path, "lib/core.js");
  });

  it("file mode renders fan-in/fan-out and exports", () => {
    const res = runExplain(dir, ["lib/core.js"]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /lib\/core\.js {2}\(js\)/);
    assert.match(res.stdout, /fan-in: 2, fan-out: 0/);
    assert.match(res.stdout, /exports: boot/);
  });

  it("unknown target exits 1 with an explicit not-indexed message", () => {
    const res = runExplain(dir, ["nope/"]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /not in index: nope\//);
  });
});
