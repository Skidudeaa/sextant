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

// WHY: enqueueRescan() spawns `sextant scan` via PATH lookup. On a fresh clone
// with no `npm link`, the spawn fails ENOENT *asynchronously*, after the
// triggering test has already returned — node:test then reports it as an
// unhandled error and fails the whole suite. A no-op `sextant` on PATH makes
// the spawn resolve and exit 0 deterministically, regardless of environment.
function installSextantShim() {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-shim-"));
  fs.writeFileSync(path.join(shimDir, "sextant"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(shimDir, "sextant"), 0o755);
  const prevPath = process.env.PATH;
  process.env.PATH = shimDir + path.delimiter + prevPath;
  return () => {
    process.env.PATH = prevPath;
    try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch {}
  };
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

describe("freshness.checkFreshness: pre-NodeNext resolver scans → stale", () => {
  let dir;
  before(() => { dir = makeRepo("nodenext-version"); });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("treats scanner version 1 records as stale under the current resolver semantics", async () => {
    const db = await graph.loadDb(dir);
    freshness.recordScanState(db, dir);
    // Version 1 predates the NodeNext .js -> .ts resolver rewrite. Old graphs
    // can contain unresolved edges that current code would now resolve, so they
    // must be invalidated instead of treated as fresh.
    graph.setMetaValue(db, freshness.META_SCANNER_VERSION, "1");
    await graph.persistDb(dir);

    const result = await freshness.checkFreshness(dir);
    assert.equal(result.fresh, false);
    assert.equal(result.reason, "scanner_version_changed");
    assert.equal(result.evidence.stored, "1");
    assert.equal(result.evidence.current, freshness.SCANNER_VERSION);
  });
});

// ─── contentChanged matrix (T1.2 follow-up) ─────────────────────────────────
//
// checkFreshness now returns a REASON-INDEPENDENT `contentChanged` boolean.  The
// load-bearing case is the last one: a scanner_version mismatch that COINCIDES
// with a moved HEAD must still report contentChanged=true even though `reason`
// (single-valued, version-first) stays "scanner_version_changed".  That is what
// stops a routine sextant upgrade from masking a checkout's content move.
describe("freshness.checkFreshness: contentChanged (T1.2 follow-up)", () => {
  let dir;
  before(() => { dir = makeRepo("contentchanged"); });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("fresh repo → contentChanged false", async () => {
    const db = await graph.loadDb(dir);
    freshness.recordScanState(db, dir);
    await graph.persistDb(dir);

    const result = await freshness.checkFreshness(dir);
    assert.equal(result.fresh, true);
    assert.equal(result.contentChanged, false);
  });

  it("HEAD moved → contentChanged true (reason head_changed)", async () => {
    const db = await graph.loadDb(dir);
    freshness.recordScanState(db, dir);
    await graph.persistDb(dir);

    gitCommitFile(dir, "moved.js", "module.exports = 9;\n", "moved");

    const result = await freshness.checkFreshness(dir);
    assert.equal(result.fresh, false);
    assert.equal(result.reason, "head_changed");
    assert.equal(result.contentChanged, true);
  });

  it("dirty working tree (untracked file) → contentChanged true (reason status_changed)", async () => {
    const db = await graph.loadDb(dir);
    freshness.recordScanState(db, dir);
    await graph.persistDb(dir);

    fs.writeFileSync(path.join(dir, "dirty.js"), "x");

    const result = await freshness.checkFreshness(dir);
    assert.equal(result.fresh, false);
    assert.equal(result.reason, "status_changed");
    assert.equal(result.contentChanged, true);

    fs.unlinkSync(path.join(dir, "dirty.js"));
  });

  it("scanner_version mismatch + HEAD SAME → contentChanged false (cried-wolf preserved)", async () => {
    const db = await graph.loadDb(dir);
    freshness.recordScanState(db, dir);
    // Pure version bump: stored scanner_version differs, but HEAD/status match.
    graph.setMetaValue(db, freshness.META_SCANNER_VERSION, "0");
    await graph.persistDb(dir);

    const result = await freshness.checkFreshness(dir);
    assert.equal(result.fresh, false);
    assert.equal(result.reason, "scanner_version_changed");
    // KEY: a pure version bump did NOT touch files → contentChanged must be
    // false so the suppressive path stays off (the cried-wolf guard).
    assert.equal(result.contentChanged, false);
  });

  it("scanner_version mismatch + HEAD MOVED → contentChanged TRUE, reason still scanner_version_changed (masking closed)", async () => {
    const db = await graph.loadDb(dir);
    freshness.recordScanState(db, dir);
    // Simulate the coincidence the gap describes: an older scanner wrote this
    // graph.db (version mismatch) AND the repo has since been checked out to a
    // new HEAD (content move).  `reason` is single-valued and version-first, so
    // it reports scanner_version_changed — but contentChanged must surface the
    // real content move so hook-refresh can still suppress + drop phantoms.
    graph.setMetaValue(db, freshness.META_SCANNER_VERSION, "0");
    await graph.persistDb(dir);

    gitCommitFile(dir, "coincident.js", "module.exports = 42;\n", "coincident");

    const result = await freshness.checkFreshness(dir);
    assert.equal(result.fresh, false);
    // Reason ordering is UNCHANGED — version still wins (cli.js depends on it).
    assert.equal(result.reason, "scanner_version_changed");
    // THE KEY new assertion: the API no longer masks the content change.
    assert.equal(result.contentChanged, true);
  });

  it("no_scan_record and db_load_failed paths report contentChanged true (degrade-don't-guess)", async () => {
    // A fresh graph.db with no recorded scan-state can't be verified against a
    // baseline → conservative contentChanged true.
    const noScanDir = makeRepo("contentchanged-noscan");
    try {
      await graph.loadDb(noScanDir);
      const r = await freshness.checkFreshness(noScanDir);
      assert.equal(r.reason, "no_scan_record");
      assert.equal(r.contentChanged, true);
    } finally {
      fs.rmSync(noScanDir, { recursive: true, force: true });
    }
  });

  it("db_load_failed (unreadable graph.db) reports contentChanged true — guards the T1.2 corrupt-db path", async () => {
    // The branch the test above NAMED but never exercised. Force graph.loadDb to
    // throw by replacing graph.db with a DIRECTORY (readFileSync → EISDIR). The
    // contract is load-bearing: on a corrupt db the hook's content-stale path
    // must engage (contentChanged true → structural suppression), not silently
    // treat the turn as fresh and trust an unverifiable graph.
    const dir = makeRepo("contentchanged-dbfail");
    try {
      const dbPath = graph.graphDbPath(dir);
      fs.mkdirSync(dbPath, { recursive: true }); // a directory where a file is expected
      const r = await freshness.checkFreshness(dir);
      assert.equal(r.reason, "db_load_failed");
      assert.equal(r.fresh, false);
      assert.equal(r.contentChanged, true); // FAIL-pre if this branch drops contentChanged
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("freshness.enqueueRescan: atomic single-flight", () => {
  let dir;
  let restoreShim;
  before(() => { restoreShim = installSextantShim(); dir = makeRepo("rescan"); });
  after(() => {
    if (restoreShim) restoreShim();
    if (dir) {
      // Best-effort: clean any spawned scan output before tearing down.
      try { fs.rmSync(path.join(dir, ".planning"), { recursive: true, force: true }); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

describe("freshness scan-in-progress marker (cooperative watcher pause)", () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-scanmarker-"));
    fs.mkdirSync(path.join(dir, ".planning", "intel"), { recursive: true });
  });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("isScanInProgress: false with no marker, true after mark, false after clear", () => {
    assert.equal(freshness.isScanInProgress(dir), false);
    freshness.markScanInProgress(dir);
    assert.equal(freshness.isScanInProgress(dir), true);
    freshness.clearScanMarker(dir);
    assert.equal(freshness.isScanInProgress(dir), false);
  });

  it("treats a marker older than SCAN_MARKER_STALE_MS as not-in-progress (crashed scan recovers)", () => {
    freshness.markScanInProgress(dir);
    const p = freshness.scanMarkerPath(dir);
    // Backdate the marker past the stale window — simulates a scan that crashed
    // without clearing it. The watcher must resume rather than freeze forever.
    const staleSec = (Date.now() - freshness.SCAN_MARKER_STALE_MS - 5000) / 1000;
    fs.utimesSync(p, staleSec, staleSec);
    assert.equal(freshness.isScanInProgress(dir), false);
    // A fresh re-mark flips it back true (refresh-during-scan keeps it alive).
    freshness.markScanInProgress(dir);
    assert.equal(freshness.isScanInProgress(dir), true);
    freshness.clearScanMarker(dir);
  });

  it("clearScanMarker is a no-op when no marker exists", () => {
    assert.equal(fs.existsSync(freshness.scanMarkerPath(dir)), false);
    freshness.clearScanMarker(dir); // must not throw
    assert.equal(freshness.isScanInProgress(dir), false);
  });

  it("clearScanMarker leaves a marker owned by a different live pid (two concurrent scans)", () => {
    // Simulate scan B's marker, then scan A (this process) calling clear in its
    // finally — it must NOT unlink B's claim, or the watcher would resume while
    // B is still writing. A non-matching pid is preserved; ownerless/our-pid
    // markers are cleared.
    const p = freshness.scanMarkerPath(dir);
    const otherPid = process.pid + 1; // a different (here, not-running) pid stands in for scan B
    fs.writeFileSync(p, JSON.stringify({ pid: otherPid, at: new Date().toISOString() }) + "\n");
    freshness.clearScanMarker(dir);
    assert.equal(fs.existsSync(p), true, "must not clear another scan's marker");

    // Our own marker clears normally.
    freshness.markScanInProgress(dir); // rewrites with this process's pid
    freshness.clearScanMarker(dir);
    assert.equal(fs.existsSync(p), false, "must clear our own marker");
  });
});
