"use strict";

// Tests for the rename-sticky file-identity loadDb cache.
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
//      reloads while the persisted path identity is unchanged.
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

describe("loadDb identity gate: external-write invalidation", () => {
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

describe("loadDb identity gate: restored-mtime atomic replacement", () => {
  let targetRoot, replacementRoot;

  before(() => {
    targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-identity-restored-A-"));
    replacementRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-identity-restored-B-"));
    fs.mkdirSync(path.join(targetRoot, ".planning", "intel"), { recursive: true });
    fs.mkdirSync(path.join(replacementRoot, ".planning", "intel"), { recursive: true });
  });

  after(() => {
    if (targetRoot) fs.rmSync(targetRoot, { recursive: true, force: true });
    if (replacementRoot) fs.rmSync(replacementRoot, { recursive: true, force: true });
  });

  it("reloads an atomic replacement even when its mtime is restored below H0", async () => {
    const h0 = await graph.loadDb(targetRoot);
    graph.upsertFile(h0, { relPath: "h0.js", type: "js", sizeBytes: 1, mtimeMs: 1 });
    await graph.persistDb(targetRoot);
    const targetPath = graph.graphDbPath(targetRoot);
    const h0Stat = fs.statSync(targetPath);

    const h1 = await graph.loadDb(replacementRoot);
    graph.upsertFile(h1, { relPath: "h1-a.js", type: "js", sizeBytes: 1, mtimeMs: 1 });
    graph.upsertFile(h1, { relPath: "h1-b.js", type: "js", sizeBytes: 1, mtimeMs: 1 });
    await graph.persistDb(replacementRoot);

    const swap = `${targetPath}.external-swap`;
    fs.copyFileSync(graph.graphDbPath(replacementRoot), swap);
    fs.renameSync(swap, targetPath);
    const restored = new Date(Math.floor(h0Stat.mtimeMs));
    fs.utimesSync(targetPath, restored, restored);
    assert.ok(
      fs.statSync(targetPath).mtimeMs <= h0Stat.mtimeMs,
      "the legacy newer-mtime gate would incorrectly retain H0"
    );

    const reloaded = await graph.loadDb(targetRoot);
    assert.notStrictEqual(reloaded, h0);
    assert.deepEqual(graph.allFilePaths(reloaded), ["h1-a.js", "h1-b.js"]);
  });
});

describe("loadDb descriptor/path fence: replacement during read", () => {
  let targetRoot, h0Root, h1Root;

  before(() => {
    targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-identity-read-target-"));
    h0Root = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-identity-read-h0-"));
    h1Root = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-identity-read-h1-"));
    for (const root of [targetRoot, h0Root, h1Root]) {
      fs.mkdirSync(path.join(root, ".planning", "intel"), { recursive: true });
    }
  });

  after(() => {
    for (const root of [targetRoot, h0Root, h1Root]) {
      if (root) fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("retries from H1 when graph.db is renamed after the H0 descriptor read", async () => {
    const h0 = await graph.loadDb(h0Root);
    graph.upsertFile(h0, { relPath: "h0.js", type: "js", sizeBytes: 1, mtimeMs: 1 });
    await graph.persistDb(h0Root);
    const h1 = await graph.loadDb(h1Root);
    graph.upsertFile(h1, { relPath: "h1.js", type: "js", sizeBytes: 1, mtimeMs: 1 });
    await graph.persistDb(h1Root);

    const targetPath = graph.graphDbPath(targetRoot);
    fs.copyFileSync(graph.graphDbPath(h0Root), targetPath);
    const h0Identity = fs.statSync(targetPath, { bigint: true });
    const originalRead = fs.readSync;
    let swapped = false;
    fs.readSync = (fd, ...args) => {
      const count = originalRead(fd, ...args);
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!swapped && opened.dev === h0Identity.dev && opened.ino === h0Identity.ino) {
        swapped = true;
        const swap = `${targetPath}.during-read`;
        fs.copyFileSync(graph.graphDbPath(h1Root), swap);
        fs.renameSync(swap, targetPath);
      }
      return count;
    };
    try {
      const loaded = await graph.loadDb(targetRoot);
      assert.equal(swapped, true, "test must replace the path during descriptor read");
      assert.deepEqual(graph.allFilePaths(loaded), ["h1.js"]);
    } finally {
      fs.readSync = originalRead;
    }
  });
});

describe("persisted graph binding cache", () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-persisted-binding-"));
    fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("never exposes meta mutations that have not reached graph.db", async () => {
    const db = await graph.loadDb(tmpDir);
    graph.setMetaValue(db, "graph_generation", "persisted-h0");
    graph.setMetaValue(db, "scanned_head", "head-h0");
    graph.setMetaValue(db, "scanned_status_hash", "status-h0");
    await graph.persistDb(tmpDir);
    assert.deepEqual(await graph.readPersistedGraphBinding(tmpDir), {
      graphGeneration: "persisted-h0",
      head: "head-h0",
      statusHash: "status-h0",
    });

    graph.setMetaValue(db, "graph_generation", "unpersisted-h1");
    graph.setMetaValue(db, "scanned_head", "head-h1");
    graph.setMetaValue(db, "scanned_status_hash", "status-h1");
    assert.deepEqual(
      await graph.readPersistedGraphBinding(tmpDir),
      {
        graphGeneration: "persisted-h0",
        head: "head-h0",
        statusHash: "status-h0",
      },
      "identity-keyed hot cache must contain disk-derived meta, not mutable db meta"
    );
  });

  it("binds the exported generation when the live db mutates during the write await", async () => {
    const db = await graph.loadDb(tmpDir);
    graph.setMetaValue(db, "graph_generation", "persisted-await-h1");
    graph.setMetaValue(db, "scanned_head", "head-await-h1");
    graph.setMetaValue(db, "scanned_status_hash", "status-await-h1");

    const targetTmp = `${graph.graphDbPath(tmpDir)}.tmp`;
    const originalWriteFile = fs.promises.writeFile;
    let mutated = false;
    fs.promises.writeFile = async function(target, ...args) {
      const result = await originalWriteFile.call(this, target, ...args);
      if (!mutated && path.resolve(String(target)) === path.resolve(targetTmp)) {
        mutated = true;
        graph.setMetaValue(db, "graph_generation", "unpersisted-await-h2");
        graph.setMetaValue(db, "scanned_head", "head-await-h2");
        graph.setMetaValue(db, "scanned_status_hash", "status-await-h2");
      }
      return result;
    };
    try {
      await graph.persistDb(tmpDir);
    } finally {
      fs.promises.writeFile = originalWriteFile;
    }
    assert.equal(mutated, true, "fixture must mutate the live handle after H1 bytes are staged");

    const expected = {
      graphGeneration: "persisted-await-h1",
      head: "head-await-h1",
      statusHash: "status-await-h1",
    };
    assert.deepEqual(
      await graph.readPersistedGraphBinding(tmpDir),
      expected,
      "the identity-keyed hot cache must describe the exported H1 bytes"
    );

    const freshRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-persisted-binding-copy-"));
    try {
      fs.mkdirSync(path.join(freshRoot, ".planning", "intel"), { recursive: true });
      fs.copyFileSync(graph.graphDbPath(tmpDir), graph.graphDbPath(freshRoot));
      assert.deepEqual(
        await graph.readPersistedGraphBinding(freshRoot),
        expected,
        "a cache-miss parse of disk must agree with the same-process hot cache"
      );
    } finally {
      fs.rmSync(freshRoot, { recursive: true, force: true });
    }
  });
});

describe("loadDb identity gate: no spurious reload on cache hit", () => {
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

describe("loadDb identity gate: persist does not self-invalidate", () => {
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

    // Critical: persistDb just atomically replaced the inode. Without the
    // writer-side identity update, the next loadDb would treat our own rename
    // as an external publication and evict the in-memory db, discarding any
    // subsequent unsaved mutations.
    const db2 = await graph.loadDb(tmpDir);
    assert.strictEqual(db2, db1, "persistDb must update cached identity so loadDb does not self-evict");

    // Mutate again WITHOUT persisting -- this models the watcher's normal
    // flow, where multiple file events accumulate in-memory between flushes.
    graph.upsertFile(db1, { relPath: "after.js", type: "js", sizeBytes: 1, mtimeMs: 1 });
    const db3 = await graph.loadDb(tmpDir);
    assert.strictEqual(db3, db1, "post-persist mutations must remain on the cached handle");
    assert.equal(graph.countFiles(db3), 2, "mutations after persist must be visible");
  });
});

describe("loadDb identity gate: file deleted after cache populated", () => {
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
