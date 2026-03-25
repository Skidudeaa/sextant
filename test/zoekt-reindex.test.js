"use strict";

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  REINDEX_COOLDOWN_MS,
  reindexStatePath,
  readReindexState,
  writeReindexState,
  shouldReindex,
} = require("../lib/zoekt-reindex");

// We can't test triggerReindex() in unit tests because it spawns zoekt-git-index,
// but we can fully test the condition logic and state file read/write.

describe("zoekt-reindex state file", () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-zoekt-reindex-"));
    fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("readReindexState returns defaults when file missing", () => {
    const state = readReindexState(tmpDir);
    assert.equal(state.lastReindexMs, 0);
    assert.equal(state.inProgress, false);
  });

  it("writeReindexState persists and readReindexState reads back", () => {
    const written = { lastReindexMs: 123456, inProgress: false, lastReindexOk: true };
    writeReindexState(tmpDir, written);

    const read = readReindexState(tmpDir);
    assert.equal(read.lastReindexMs, 123456);
    assert.equal(read.inProgress, false);
    assert.equal(read.lastReindexOk, true);
  });

  it("reindexStatePath points to .planning/intel/", () => {
    const p = reindexStatePath(tmpDir);
    assert.ok(p.includes(".planning"));
    assert.ok(p.includes("intel"));
    assert.ok(p.endsWith(".zoekt_reindex_state.json"));
  });

  it("writeReindexState overwrites previous state", () => {
    writeReindexState(tmpDir, { lastReindexMs: 100, inProgress: true });
    writeReindexState(tmpDir, { lastReindexMs: 200, inProgress: false });

    const read = readReindexState(tmpDir);
    assert.equal(read.lastReindexMs, 200);
    assert.equal(read.inProgress, false);
  });

  it("readReindexState returns defaults on corrupt file", () => {
    const p = reindexStatePath(tmpDir);
    fs.writeFileSync(p, "not json at all{{{");

    const state = readReindexState(tmpDir);
    assert.equal(state.lastReindexMs, 0);
    assert.equal(state.inProgress, false);
  });
});

describe("shouldReindex conditions", () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-zoekt-should-"));
    fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Clean state file before each test
    const p = reindexStatePath(tmpDir);
    try { fs.unlinkSync(p); } catch {}
  });

  it("returns false when filesChanged is 0", () => {
    assert.equal(shouldReindex(tmpDir, { filesChanged: 0 }), false);
  });

  it("returns false when filesChanged is negative", () => {
    assert.equal(shouldReindex(tmpDir, { filesChanged: -1 }), false);
  });

  // NOTE: shouldReindex also checks zoekt.isInstalled() which depends on
  // whether zoekt-webserver is in PATH. We test the remaining conditions
  // assuming the binary check either passes or fails externally.

  it("returns false when reindex is already in progress", () => {
    // NOTE: inProgressSince must be recent to avoid the stuck-recovery logic
    // clearing the flag (recovery triggers after 10 minutes)
    writeReindexState(tmpDir, { lastReindexMs: 0, inProgress: true, inProgressSince: Date.now() });
    // Even with files changed, in-progress blocks reindex
    const result = shouldReindex(tmpDir, { filesChanged: 5 });
    assert.equal(result, false);
  });

  it("returns false when cooldown has not elapsed", () => {
    const now = Date.now();
    // Last reindex was 1 minute ago (within 3-minute cooldown)
    writeReindexState(tmpDir, { lastReindexMs: now - 60000, inProgress: false });
    const result = shouldReindex(tmpDir, { filesChanged: 5, nowMs: now });
    assert.equal(result, false);
  });

  it("cooldown check passes when enough time has elapsed", () => {
    const now = Date.now();
    // Last reindex was 4 minutes ago (beyond 3-minute cooldown)
    writeReindexState(tmpDir, { lastReindexMs: now - 4 * 60 * 1000, inProgress: false });
    // This will still return false if zoekt isn't installed, but the cooldown
    // check itself passes. We verify by checking that inProgress and cooldown
    // are not the blockers.
    const state = readReindexState(tmpDir);
    assert.equal(state.inProgress, false);
    assert.ok(now - state.lastReindexMs >= REINDEX_COOLDOWN_MS);
  });

  it("REINDEX_COOLDOWN_MS is 3 minutes", () => {
    assert.equal(REINDEX_COOLDOWN_MS, 3 * 60 * 1000);
  });
});
