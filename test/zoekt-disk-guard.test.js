"use strict";

// DISK-FILL PREVENTION (docs/036).
//
// The 2026-07-10 incident grew a 101 GB index from a mis-adopted home dir. The
// fix shipped then was real but incomplete, and the evidence is that a 22 GiB
// home-directory index was still on disk on 2026-07-27 with a webserver started
// against it on 2026-07-19 — NINE DAYS AFTER that fix. Three gaps let it happen:
//
//   1. The index-size cap runs AFTER zoekt writes its shards. It is cleanup,
//      not prevention, and it only runs on a BUILD.
//   2. The corpus pre-check is non-git only, and nothing anywhere looked at how
//      much disk actually remained — 20 repos at the 2 GiB cap is 40 GiB of
//      fully "compliant" growth.
//   3. mcp/server.js adopts process.cwd() exactly like a hook, but never
//      consulted the root guard. An MCP session with cwd=$HOME reached
//      search() -> ensureWebserver() and started a daemon on the home index.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const scope = require("../lib/zoekt-scope");

describe("free-disk floor", () => {
  const GIB = 1024 * 1024 * 1024;

  it("reports real free space", () => {
    const free = scope.freeDiskBytes("/");
    assert.ok(typeof free === "number" && free > 0, `got ${free}`);
  });

  it("refuses to index when free space is already under the floor", () => {
    // Floor set absurdly high so the current disk is 'low' by construction.
    const v = scope.checkDiskHeadroom("/", { minFreeBytes: 1024 * GIB });
    assert.equal(v.ok, false);
    assert.equal(v.reason, "low-disk");
    assert.match(v.detail, /below the/);
    assert.match(v.detail, /falls back to rg/, "must say what happens instead");
  });

  it("refuses when THIS build's corpus would breach the floor", () => {
    // The case the per-repo byte caps cannot see: enough room right now, not
    // enough after indexing.
    const free = scope.freeDiskBytes("/");
    const v = scope.checkDiskHeadroom("/", { minFreeBytes: 5 * GIB }, free - 1 * GIB);
    assert.equal(v.ok, false);
    assert.equal(v.reason, "low-disk");
    assert.match(v.detail, /would leave under/);
  });

  it("allows a normal build", () => {
    assert.equal(scope.checkDiskHeadroom("/", { minFreeBytes: 1 }).ok, true);
  });

  it("is opt-out-able and never throws on a bad path", () => {
    assert.equal(scope.checkDiskHeadroom("/", { minFreeBytes: 0 }).ok, true);
    // statfs on a nonexistent path returns null free — must not block work.
    assert.equal(scope.freeDiskBytes("/no/such/path/xyzzy"), null);
    assert.equal(scope.checkDiskHeadroom("/no/such/path/xyzzy", { minFreeBytes: 5 * GIB }).ok, true);
  });

  it("the floor is wired into the build for BOTH git and non-git paths", () => {
    // The corpus pre-check is inside an `if (!isGit)`; this check must not be.
    const src = fs.readFileSync(path.join(__dirname, "..", "lib", "zoekt.js"), "utf8");
    const call = src.indexOf("scope.checkDiskHeadroom(root, caps, estimatedCorpusBytes)");
    const gitOnly = src.indexOf("Corpus pre-check for the non-git path only");
    const argsLine = src.indexOf("const args = isGit");
    assert.ok(call > 0, "the build must consult the disk floor");
    assert.ok(call > gitOnly, "…after the non-git corpus estimate");
    assert.ok(call < argsLine, "…and BEFORE the indexer is invoked");
  });

  it("is configurable per repo", () => {
    assert.equal(typeof scope.DEFAULT_MIN_FREE_BYTES, "number");
    assert.ok(scope.DEFAULT_MIN_FREE_BYTES >= 1024 * 1024 * 1024, "a floor under 1 GiB is not a floor");
  });
});

describe("size gate before SERVING an index", () => {
  it("ensureWebserver re-checks the cap before starting a daemon", () => {
    // Without this, an index that grew huge under older code is served forever
    // — nothing re-examines an index this code did not build.
    const src = fs.readFileSync(path.join(__dirname, "..", "lib", "zoekt.js"), "utf8");
    const fn = src.indexOf("async function ensureWebserver");
    const gate = src.indexOf("checkIndexSizeCap", fn);
    const spawnAt = src.indexOf("spawn(", fn);
    assert.ok(gate > fn, "ensureWebserver must consult the size cap");
    assert.ok(gate < spawnAt, "…before spawning the webserver");
  });
});

describe("MCP adopts cwd, so it must obey the root guard", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "mcp", "server.js"), "utf8");

  it("ensureInit refuses a root the guard rejects", () => {
    const fn = src.indexOf("async function ensureInit");
    const guard = src.indexOf("checkRoot(cwd, { requireMarker: true })", fn);
    const init = src.indexOf("intel.init(_root)", fn);
    assert.ok(guard > fn, "ensureInit must call the root guard");
    assert.ok(guard < init, "…before intel.init creates any state");
  });

  it("the guard actually rejects the home directory", () => {
    const { checkRoot } = require("../lib/root-guard");
    const v = checkRoot(require("os").homedir(), { requireMarker: true });
    assert.equal(v.ok, false);
    assert.equal(v.reason, "home-directory");
  });
});
