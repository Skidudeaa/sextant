"use strict";

// Tests for the rejections table (docs/003 — rejected-approaches memory).
// CRUD, file-path matching, status filtering, and staleness auto-detection.

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const graph = require("../lib/graph");

let tmpDir, db;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-rejections-"));
  fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
  db = await graph.loadDb(tmpDir);
});

after(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Clean up all rejections between tests so they don't leak across describe blocks.
function clearAllRejections() {
  for (const r of graph.findAllRejections(db)) {
    graph.deleteRejection(db, r.id);
  }
}

describe("rejections CRUD", () => {
  beforeEach(() => clearAllRejections());

  it("inserts and finds a rejection by file path", () => {
    const id = graph.insertRejection(db, {
      description: "Shared SQLite connection pool",
      reason: "WAL + concurrent writes = SQLITE_BUSY",
      files: ["lib/graph.js", "lib/intel.js"],
      source: "manual",
    });
    assert.ok(id > 0);

    const found = graph.findRejectionsForFiles(db, ["lib/graph.js"]);
    assert.equal(found.length, 1);
    assert.equal(found[0].description, "Shared SQLite connection pool");
    assert.equal(found[0].reason, "WAL + concurrent writes = SQLITE_BUSY");
  });

  it("does not match on unrelated file paths", () => {
    graph.insertRejection(db, {
      description: "graph-specific rejection",
      reason: "test",
      files: ["lib/graph.js"],
    });
    const found = graph.findRejectionsForFiles(db, ["lib/other.js"]);
    assert.equal(found.length, 0);
  });

  it("repo-wide rejection (no files) matches any query", () => {
    graph.insertRejection(db, {
      description: "Never use embeddings for code search",
      reason: "Reindexes forever and fills the disk",
      files: [],
    });
    graph.insertRejection(db, {
      description: "file-specific",
      reason: "test",
      files: ["lib/graph.js"],
    });
    const found = graph.findRejectionsForFiles(db, ["anything/here.js"]);
    // Only the repo-wide one should match
    assert.equal(found.length, 1);
    assert.equal(found[0].description, "Never use embeddings for code search");
  });

  it("findAllRejections returns all rows", () => {
    graph.insertRejection(db, { description: "a", reason: "r", files: ["a.js"] });
    graph.insertRejection(db, { description: "b", reason: "r", files: ["b.js"] });
    const all = graph.findAllRejections(db);
    assert.equal(all.length, 2);
  });

  it("deleteRejection removes a rejection", () => {
    const id = graph.insertRejection(db, {
      description: "temp rejection",
      reason: "testing delete",
      files: ["lib/temp.js"],
    });
    const before = graph.findRejectionsForFiles(db, ["lib/temp.js"]);
    assert.equal(before.length, 1);
    graph.deleteRejection(db, id);
    const after = graph.findRejectionsForFiles(db, ["lib/temp.js"]);
    assert.equal(after.length, 0);
  });
});

describe("rejections status filtering", () => {
  beforeEach(() => clearAllRejections());

  it("only returns active rejections (stale excluded)", () => {
    const id = graph.insertRejection(db, {
      description: "stale rejection",
      reason: "file was deleted",
      files: ["lib/gone.js"],
    });
    graph.updateRejectionStatus(db, id, "stale");
    const found = graph.findRejectionsForFiles(db, ["lib/gone.js"]);
    assert.equal(found.length, 0);
  });
});

describe("rejections staleness auto-detection", () => {
  beforeEach(() => clearAllRejections());

  it("marks rejections stale when referenced file is missing from graph", () => {
    // Add a file to the graph
    graph.upsertFile(db, { relPath: "lib/exists.js", type: "js", sizeBytes: 100 });

    // Insert a rejection for a file that IS in the graph
    const idActive = graph.insertRejection(db, {
      description: "active rejection",
      reason: "still relevant",
      files: ["lib/exists.js"],
    });

    // Insert a rejection for a file that is NOT in the graph
    const idStale = graph.insertRejection(db, {
      description: "will go stale",
      reason: "file deleted",
      files: ["lib/deleted.js"],
    });

    const nStaled = graph.staleRejectionsWithMissingFiles(db);
    assert.ok(nStaled >= 1, `expected at least 1 rejection staled, got ${nStaled}`);

    // The active one should still be active
    const activeFound = graph.findRejectionsForFiles(db, ["lib/exists.js"]);
    assert.ok(activeFound.some((r) => r.description === "active rejection"));

    // The stale one should no longer match
    const staleFound = graph.findRejectionsForFiles(db, ["lib/deleted.js"]);
    assert.equal(staleFound.length, 0);

    // Cleanup
    graph.deleteRejection(db, idActive);
    graph.deleteRejection(db, idStale);
  });
});
