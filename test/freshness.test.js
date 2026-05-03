"use strict";

// Tests for lib/freshness.js -- the real-state freshness gate.
//
// Each describe block sets up a fresh temp git repo so the freshness
// signals (HEAD, status hash) have something real to anchor on.  We use
// `git init` directly rather than mocks because the production code
// shells out to git via execSync and we want to exercise that path.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const freshness = require("../lib/freshness");
const graph = require("../lib/graph");

function gitInit(dir) {
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  // Disable signing for CI environments that have it on globally.
  execSync("git config commit.gpgsign false", { cwd: dir });
}

// WHY: enqueueRescan spawns `sextant scan` via PATH lookup.  In CI / fresh
// clones (no `npm link`), there is no `sextant` on PATH and the spawn
// raises ENOENT *asynchronously* — after the test that triggered it has
// returned — which node:test reports as an unhandled async error and fails
// the whole test.  Drop a no-op shim onto PATH for the duration of the
// suite so the spawn succeeds and the test only exercises the marker
// logic it actually cares about.
let _shimDir = null;
let _origPath = null;
function installSextantShim() {
  _shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-shim-"));
  const shim = path.join(_shimDir, "sextant");
  fs.writeFileSync(shim, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  _origPath = process.env.PATH;
  process.env.PATH = `${_shimDir}${path.delimiter}${_origPath || ""}`;
}
function removeSextantShim() {
  if (_origPath != null) process.env.PATH = _origPath;
  if (_shimDir) {
    try { fs.rmSync(_shimDir, { recursive: true, force: true }); } catch {}
  }
  _shimDir = null;
  _origPath = null;
}

function gitCommitFile(dir, name, content, message = "commit") {
  fs.writeFileSync(path.join(dir, name), content);
  execSync(`git add ${name}`, { cwd: dir });
  execSync(`git commit -q -m "${message}"`, { cwd: dir });
}

function makeRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sextant-fresh-${prefix}-`));
  fs.mkdirSync(path.join(dir, ".planning", "intel"), { recursive: true });
  gitInit(dir);
  gitCommitFile(dir, "seed.js", "module.exports = 1;\n", "seed");
  return dir;
}

describe("freshness.captureCurrentState", () => {
  let dir;
  before(() => { dir = makeRepo("capture"); });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("captures head, statusHash, scannerVersion, schemaVersion", () => {
    const state = freshness.captureCurrentState(dir);
    assert.ok(state.head, "head should be a non-empty string in a real git repo");
    assert.match(state.head, /^[0-9a-f]{40}$/, "head should be a 40-char SHA");
    assert.ok(state.statusHash, "statusHash should be set even on a clean repo");
    assert.equal(state.scannerVersion, freshness.SCANNER_VERSION);
    assert.equal(state.schemaVersion, freshness.SCHEMA_VERSION);
  });

  it("returns a different statusHash after an untracked file is added", () => {
    const before = freshness.captureCurrentState(dir).statusHash;
    fs.writeFileSync(path.join(dir, "new.js"), "x");
    const after = freshness.captureCurrentState(dir).statusHash;
    assert.notEqual(after, before, "untracked file should change the status fingerprint");
    fs.unlinkSync(path.join(dir, "new.js"));
  });
});

describe("freshness.checkFreshness: no scan record means stale", () => {
  let dir;
  before(() => { dir = makeRepo("noscan"); });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("a fresh graph.db with no scanned-state meta is treated as stale", async () => {
    // loadDb creates an empty schema; we never recorded scan-state, so the
    // gate should fail-closed with reason no_scan_record.
    await graph.loadDb(dir);
    const result = await freshness.checkFreshness(dir);
    assert.equal(result.fresh, false);
    assert.equal(result.reason, "no_scan_record");
  });
});

describe("freshness.checkFreshness: recorded state matches → fresh", () => {
  let dir;
  before(() => { dir = makeRepo("fresh"); });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("returns fresh after recordScanState on an unchanged repo", async () => {
    const db = await graph.loadDb(dir);
    freshness.recordScanState(db, dir);
    await graph.persistDb(dir);

    const result = await freshness.checkFreshness(dir);
    assert.equal(result.fresh, true);
    assert.equal(result.reason, null);
  });
});

describe("freshness.checkFreshness: HEAD change → stale", () => {
  let dir;
  before(() => { dir = makeRepo("head"); });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("returns stale with reason head_changed after a new commit", async () => {
    const db = await graph.loadDb(dir);
    freshness.recordScanState(db, dir);
    await graph.persistDb(dir);

    gitCommitFile(dir, "later.js", "module.exports = 2;\n", "later");

    const result = await freshness.checkFreshness(dir);
    assert.equal(result.fresh, false);
    assert.equal(result.reason, "head_changed");
    assert.ok(result.evidence.stored !== result.evidence.current);
  });
});

describe("freshness.checkFreshness: working-tree change → stale", () => {
  let dir;
  before(() => { dir = makeRepo("status"); });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("returns stale with reason status_changed when an untracked file appears", async () => {
    const db = await graph.loadDb(dir);
    freshness.recordScanState(db, dir);
    await graph.persistDb(dir);

    fs.writeFileSync(path.join(dir, "untracked.js"), "x");

    const result = await freshness.checkFreshness(dir);
    assert.equal(result.fresh, false);
    assert.equal(result.reason, "status_changed");
  });
});

describe("freshness.checkFreshness: scanner_version mismatch → stale", () => {
  let dir;
  before(() => { dir = makeRepo("scanner"); });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("returns stale with reason scanner_version_changed when stored version is older", async () => {
    const db = await graph.loadDb(dir);
    freshness.recordScanState(db, dir);
    // Simulate an older scanner having written this graph.db.
    graph.setMetaValue(db, freshness.META_SCANNER_VERSION, "0");
    await graph.persistDb(dir);

    const result = await freshness.checkFreshness(dir);
    assert.equal(result.fresh, false);
    assert.equal(result.reason, "scanner_version_changed");
    assert.equal(result.evidence.stored, "0");
    assert.equal(result.evidence.current, freshness.SCANNER_VERSION);
  });
});

describe("freshness.enqueueRescan: atomic single-flight", () => {
  let dir;
  before(() => {
    installSextantShim();
    dir = makeRepo("rescan");
  });
  after(() => {
    if (dir) {
      // Best-effort: clean any spawned scan output before tearing down.
      try { fs.rmSync(path.join(dir, ".planning"), { recursive: true, force: true }); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    }
    removeSextantShim();
  });

  it("first call requests, second call sees pending", () => {
    const r1 = freshness.enqueueRescan(dir);
    assert.equal(r1.state, "requested", "first enqueue must request");
    assert.ok(fs.existsSync(freshness.rescanMarkerPath(dir)), "marker must exist after request");

    const r2 = freshness.enqueueRescan(dir);
    assert.equal(r2.state, "pending", "second enqueue while marker is fresh must be pending");
    assert.ok(typeof r2.since === "number", "pending should report when the prior request started");
  });

  it("a stale marker (older than RESCAN_MARKER_STALE_MS) is replaced", () => {
    // Write an artificially-old marker manually.
    const markerPath = freshness.rescanMarkerPath(dir);
    fs.writeFileSync(
      markerPath,
      JSON.stringify({ pid: 999999, startedAt: Date.now() - 10 * 60 * 1000 })
    );

    const r = freshness.enqueueRescan(dir);
    assert.equal(r.state, "requested", "stale marker must be replaced, not honored");
  });
});

describe("freshness.clearRescanMarker", () => {
  let dir;
  before(() => { dir = makeRepo("clear"); });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("removes the marker if it exists, no-op otherwise", () => {
    fs.writeFileSync(
      freshness.rescanMarkerPath(dir),
      JSON.stringify({ pid: 1, startedAt: Date.now() })
    );
    assert.ok(fs.existsSync(freshness.rescanMarkerPath(dir)));
    freshness.clearRescanMarker(dir);
    assert.equal(fs.existsSync(freshness.rescanMarkerPath(dir)), false);

    // Second call (no marker) must not throw.
    freshness.clearRescanMarker(dir);
  });
});
