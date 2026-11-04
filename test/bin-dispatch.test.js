"use strict";

// bin/intel.js after the 2026-11-03 archive cut: it must still route the two
// commands with live callers (the `atoms exposure` InstructionsLoaded hook in
// four repos, and the ledger/atoms instruments) and must no longer offer the
// archived retrieval-era commands.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { spawnSync } = require("child_process");

const BIN = path.join(__dirname, "..", "bin", "intel.js");
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });

describe("bin/intel.js dispatch", () => {
  it("routes atoms to commands/atoms.js", () => {
    const r = run("atoms", "bogus");
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /usage: sextant atoms compile/);
  });

  it("routes ledger to commands/ledger.js", () => {
    const r = run("ledger", "bogus");
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /usage: sextant ledger census/);
  });

  it("refuses an archived command with the usage text", () => {
    const r = run("scan", "--force");
    assert.strictEqual(r.status, 1);
    assert.match(r.stdout, /sextant atoms exposure/);
    assert.doesNotMatch(r.stdout, /sextant scan/);
  });
});
