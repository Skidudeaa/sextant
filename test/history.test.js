"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { recordSnapshot, getHistorySummary } = require("../lib/history");

function makeTmpRoot(suffix) {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `sextant-history-${suffix}-`)
  );
  fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
  return tmpDir;
}

function cleanup(tmpDir) {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

function historyPath(rootAbs) {
  return path.join(rootAbs, ".planning", "intel", "history.json");
}

function readHistoryRaw(rootAbs) {
  return JSON.parse(fs.readFileSync(historyPath(rootAbs), "utf8"));
}

describe("recordSnapshot — creates history.json on first call", () => {
  let tmpDir;

  after(() => cleanup(tmpDir));

  it("creates history.json when none exists", () => {
    tmpDir = makeTmpRoot("create");
    const hp = historyPath(tmpDir);
    assert.ok(!fs.existsSync(hp), "history.json should not exist yet");

    recordSnapshot(tmpDir, { resolutionPct: 95, indexedFiles: 42 });

    assert.ok(fs.existsSync(hp), "history.json should now exist");
    const data = readHistoryRaw(tmpDir);
    assert.ok(Array.isArray(data.snapshots));
    assert.equal(data.snapshots.length, 1);
  });
});

describe("recordSnapshot — rate-limit guard", () => {
  let tmpDir;

  after(() => cleanup(tmpDir));

  it("second call within MIN_INTERVAL_MS is skipped", () => {
    tmpDir = makeTmpRoot("ratelimit");

    recordSnapshot(tmpDir, { resolutionPct: 90, indexedFiles: 10 });
    recordSnapshot(tmpDir, { resolutionPct: 91, indexedFiles: 11 });

    const data = readHistoryRaw(tmpDir);
    assert.equal(
      data.snapshots.length,
      1,
      "only the first snapshot should be stored; the second was rate-limited"
    );
    assert.equal(data.snapshots[0].resolutionPct, 90);
  });
});

describe("getHistorySummary — non-existent history", () => {
  let tmpDir;

  after(() => cleanup(tmpDir));

  it("returns { snapshots: [] } shape when no history.json exists", () => {
    tmpDir = makeTmpRoot("nofile");

    const summary = getHistorySummary(tmpDir);
    assert.deepEqual(summary.resolutionTrend, []);
    assert.deepEqual(summary.filesTrend, []);
    assert.equal(summary.firstTs, null);
    assert.equal(summary.lastTs, null);
    assert.equal(summary.snapshotCount, 0);
  });
});

describe("getHistorySummary — corrupt JSON", () => {
  let tmpDir;

  after(() => cleanup(tmpDir));

  it("returns empty shape on corrupt JSON, no throw", () => {
    tmpDir = makeTmpRoot("corrupt");
    fs.writeFileSync(historyPath(tmpDir), "NOT VALID JSON {{{", "utf8");

    const summary = getHistorySummary(tmpDir);
    assert.equal(summary.snapshotCount, 0);
    assert.deepEqual(summary.resolutionTrend, []);
    assert.deepEqual(summary.filesTrend, []);
    assert.equal(summary.firstTs, null);
    assert.equal(summary.lastTs, null);
  });
});

describe("getHistorySummary — empty history", () => {
  let tmpDir;

  after(() => cleanup(tmpDir));

  it("returns expected shape with snapshotCount: 0", () => {
    tmpDir = makeTmpRoot("empty");

    const summary = getHistorySummary(tmpDir);
    assert.equal(summary.snapshotCount, 0);
    assert.deepEqual(summary.resolutionTrend, []);
    assert.deepEqual(summary.filesTrend, []);
    assert.equal(summary.firstTs, null);
    assert.equal(summary.lastTs, null);
  });
});

describe("getHistorySummary — returns last count snapshots for trend", () => {
  let tmpDir;

  after(() => cleanup(tmpDir));

  it("returns only the last `count` snapshots when count < total", () => {
    tmpDir = makeTmpRoot("trend");

    // Manually write 5 snapshots with distinct timestamps
    const snapshots = [];
    const baseTs = Date.now() - 500000;
    for (let i = 0; i < 5; i++) {
      snapshots.push({
        ts: baseTs + i * 70000,
        resolutionPct: 80 + i,
        indexedFiles: 10 + i,
        localResolved: null,
        localTotal: null,
      });
    }
    fs.writeFileSync(
      historyPath(tmpDir),
      JSON.stringify({ snapshots }, null, 2) + "\n",
      "utf8"
    );

    const summary = getHistorySummary(tmpDir, 3);
    assert.equal(summary.snapshotCount, 5, "total snapshot count is 5");
    assert.equal(summary.resolutionTrend.length, 3, "trend has last 3");
    assert.deepEqual(summary.resolutionTrend, [82, 83, 84]);
    assert.deepEqual(summary.filesTrend, [12, 13, 14]);
    assert.equal(summary.firstTs, snapshots[0].ts);
    assert.equal(summary.lastTs, snapshots[4].ts);
  });
});

describe("recordSnapshot — stores healthData fields correctly", () => {
  let tmpDir;

  after(() => cleanup(tmpDir));

  it("stores resolutionPct, indexedFiles, localResolved, localTotal", () => {
    tmpDir = makeTmpRoot("fields");

    const healthData = {
      resolutionPct: 97,
      indexedFiles: 35,
      localResolved: 120,
      localTotal: 130,
    };
    recordSnapshot(tmpDir, healthData);

    const data = readHistoryRaw(tmpDir);
    const snap = data.snapshots[0];
    assert.equal(snap.resolutionPct, 97);
    assert.equal(snap.indexedFiles, 35);
    assert.equal(snap.localResolved, 120);
    assert.equal(snap.localTotal, 130);
    assert.equal(typeof snap.ts, "number");
    assert.ok(snap.ts > 0);
  });

  it("stores null for missing healthData fields", () => {
    const tmpDir2 = makeTmpRoot("fields-null");

    recordSnapshot(tmpDir2, {});

    const data = readHistoryRaw(tmpDir2);
    const snap = data.snapshots[0];
    assert.equal(snap.resolutionPct, null);
    assert.equal(snap.indexedFiles, null);
    assert.equal(snap.localResolved, null);
    assert.equal(snap.localTotal, null);

    cleanup(tmpDir2);
  });
});

describe("recordSnapshot + getHistorySummary — round-trip", () => {
  let tmpDir;

  after(() => cleanup(tmpDir));

  it("recorded snapshots are returned by getHistorySummary with matching data", () => {
    tmpDir = makeTmpRoot("roundtrip");

    // Write multiple snapshots manually (to bypass rate limit)
    const snapshots = [];
    const baseTs = Date.now() - 300000;
    for (let i = 0; i < 3; i++) {
      snapshots.push({
        ts: baseTs + i * 70000,
        resolutionPct: 90 + i,
        indexedFiles: 20 + i,
        localResolved: null,
        localTotal: null,
      });
    }
    fs.writeFileSync(
      historyPath(tmpDir),
      JSON.stringify({ snapshots }, null, 2) + "\n",
      "utf8"
    );

    const summary = getHistorySummary(tmpDir);
    assert.equal(summary.snapshotCount, 3);
    assert.deepEqual(summary.resolutionTrend, [90, 91, 92]);
    assert.deepEqual(summary.filesTrend, [20, 21, 22]);
    assert.equal(summary.firstTs, snapshots[0].ts);
    assert.equal(summary.lastTs, snapshots[2].ts);
  });
});
