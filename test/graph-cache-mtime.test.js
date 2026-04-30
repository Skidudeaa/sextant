"use strict";

// Tests for the mtime-gated loadDb cache.
//
// Background: graph.loadDb() caches an in-memory SQL.Database keyed by
// rootAbs.  Before the mtime gate, that cache was process-global and never
// invalidated -- so two Claude Code sessions running concurrently in the
// same project (each with its own MCP server process) would silently
// diverge: one session's MCP would serve a snapshot from session start
// while the watcher updated graph.db on disk for everyone else.
//
// These tests cover the three guarantees of the gate:
//   1. External writers (someone else mutates graph.db) trigger reload.
//   2. In-process mutations to the cached db are NOT lost to spurious
//      reloads -- the cache is only evicted when disk is strictly newer.
//   3. Our own persistDb does not self-invalidate on the next loadDb.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const graph = require("../lib/graph");

// Helper: bump a file's mtime by N seconds in the future (synchronous).
// Some filesystems round mtime to 1s -- nudging by 2s is enough to be
// strictly greater than any same-second write the test just performed.
function bumpMtime(p, secondsAhead = 2) {
  const future = new Date(Date.now() + secondsAhead * 1000);
  fs.utimesSync(p, future, future);
}

describe("loadDb mtime gate: external-write invalidation", () => {
  let tmpDirA, tmpDirB;

  before(() => {
    // Two separate temp dirs simulate two repos so we can build a "new"
    // graph.db in tmpDirB and copy it over tmpDirA's, mimicking another
    // process having written to the same on-disk file.
    tmpDirA = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-mtime-extwrite-A-"));
    tmpDirB = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-mtime-extwrite-B-"));
    fs.mkdirSync(path.join(tmpDirA, ".planning", "intel"), { recursive: true });
    fs.mkdirSync(path.join(tmpDirB, ".planning", "intel"), { recursive: true });
  });

  after(() => {
    if (tmpDirA) fs.rmSync(tmpDirA, { recursive: true, force: true });
    if (tmpDirB) fs.rmSync(tmpDirB, { recursive: true, force: true });
  });

  it("evicts and reloads when graph.db is overwritten by another process", async () => {
    // Build "version 1" in tmpDirA: one file.
    const dbV1 = await graph.loadDb(tmpDirA);
    graph.upsertFile(dbV1, { relPath: "v1.js", type: "js", sizeBytes: 1, mtimeMs: 1 });
    await graph.persistDb(tmpDirA);
    assert.equal(graph.countFiles(dbV1), 1, "V1 has one file before the swap");

    // Build a different "version 2" graph in tmpDirB with two files,
    // persist it to disk, then copy that file over tmpDirA's graph.db
    // to simulate an external process having written it.
    const dbV2 = await graph.loadDb(tmpDirB);
    graph.upsertFile(dbV2, { relPath: "v2-a.js", type: "js", sizeBytes: 1, mtimeMs: 1 });
    graph.upsertFile(dbV2, { relPath: "v2-b.js", type: "js", sizeBytes: 1, mtimeMs: 1 });
    await graph.persistDb(tmpDirB);

    const aPath = graph.graphDbPath(tmpDirA);
    const bPath = graph.graphDbPath(tmpDirB);
    fs.copyFileSync(bPath, aPath);
    bumpMtime(aPath); // ensure mtime strictly newer than tmpDirA's cached value

    // Next loadDb on tmpDirA must return a reloaded db reflecting V2's two files.
    const reloaded = await graph.loadDb(tmpDirA);
    assert.notStrictEqual(reloaded, dbV1, "loadDb must return a fresh handle, not the cached V1");
    assert.equal(graph.countFiles(reloaded), 2, "reloaded db must reflect on-disk V2 contents");
  });
});

describe("loadDb mtime gate: no spurious reload on cache hit", () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-mtime-noreload-"));
    fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the same in-memory db across calls when disk hasn't changed", async () => {
    const db1 = await graph.loadDb(tmpDir);
    graph.upsertFile(db1, { relPath: "a.js", type: "js", sizeBytes: 1, mtimeMs: 1 });

    // No disk write between the two loadDb calls.  The second call must
    // return the exact same handle, with the in-memory mutation visible.
    const db2 = await graph.loadDb(tmpDir);
    assert.strictEqual(db2, db1, "cached db handle must be reused");
    assert.equal(graph.countFiles(db2), 1, "in-memory mutation must be visible on the cached handle");
  });
});

describe("loadDb mtime gate: persist does not self-invalidate", () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-mtime-persist-"));
    fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loadDb after persistDb returns the same handle, not a reload", async () => {
    const db1 = await graph.loadDb(tmpDir);
    graph.upsertFile(db1, { relPath: "before.js", type: "js", sizeBytes: 1, mtimeMs: 1 });
    await graph.persistDb(tmpDir);

    // Critical: persistDb just wrote to disk, so the disk mtime is
    // strictly newer than the value we had at loadDb time.  Without the
    // writer-side mtime bump in persistDb, the next loadDb would see
    // "disk newer than cache" and evict our in-memory db -- discarding
    // any subsequent unsaved mutations.  With the bump, the cache and
    // disk are in sync after persist.
    const db2 = await graph.loadDb(tmpDir);
    assert.strictEqual(db2, db1, "persistDb must update cached mtime so loadDb does not self-evict");

    // Mutate again WITHOUT persisting -- this models the watcher's normal
    // flow, where multiple file events accumulate in-memory between flushes.
    graph.upsertFile(db1, { relPath: "after.js", type: "js", sizeBytes: 1, mtimeMs: 1 });
    const db3 = await graph.loadDb(tmpDir);
    assert.strictEqual(db3, db1, "post-persist mutations must remain on the cached handle");
    assert.equal(graph.countFiles(db3), 2, "mutations after persist must be visible");
  });
});

describe("loadDb mtime gate: file deleted after cache populated", () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-mtime-deleted-"));
    fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns cached db when graph.db has been removed from disk", async () => {
    const db1 = await graph.loadDb(tmpDir);
    graph.upsertFile(db1, { relPath: "x.js", type: "js", sizeBytes: 1, mtimeMs: 1 });
    await graph.persistDb(tmpDir);

    // Manual cleanup of graph.db while we still hold a cached handle.
    // The cached in-memory state is still a valid working copy; we don't
    // want loadDb to crash or rebuild from scratch in this scenario --
    // the next persistDb call will recreate the file.
    fs.unlinkSync(graph.graphDbPath(tmpDir));

    const db2 = await graph.loadDb(tmpDir);
    assert.strictEqual(db2, db1, "cached db must survive deletion of the underlying file");
    assert.equal(graph.countFiles(db2), 1, "cached state must still be queryable");
  });
});
