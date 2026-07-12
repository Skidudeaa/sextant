"use strict";

// Option-5 adaptive SYNC rescan (lib/freshness.js + lib/cli.js gate wiring).
//
// The decision is evidence-based per repo: sync only when the repo's OWN
// recorded scan history (telemetry scan.completed durations) proves rescans
// are fast. These tests lock:
//   - shouldSyncRescan: env kill/force switches, config opt-out, sample
//     floor, p95 threshold, failure cooldown
//   - syncRescan: single-flight (pending under a live marker), marker
//     cleared in finally, end-to-end completed scan via SEXTANT_BIN
//   - applyFreshnessGate: a stale read on a fast-history repo returns the
//     FRESH body (rescue) with stale_hit{rescanState:"sync"} and NO
//     blackout_turn; recheck-still-stale falls through to blackout

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const freshness = require("../lib/freshness");

const BIN = path.resolve(__dirname, "..", "bin", "intel.js");

function mkRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-syncrescan-"));
  fs.mkdirSync(path.join(dir, ".planning", "intel"), { recursive: true });
  return dir;
}

function seedScanDurations(root, durations, extraEvents = []) {
  const lines = durations.map((d) =>
    JSON.stringify({ ts: Date.now() - 1000, name: "scan.completed", durationMs: d, success: true, trigger: "manual" })
  );
  for (const e of extraEvents) lines.push(JSON.stringify(e));
  fs.writeFileSync(
    path.join(root, ".planning", "intel", "telemetry.jsonl"),
    lines.join("\n") + "\n"
  );
}

// env save/restore — these tests mutate process.env in-process.
let savedEnv;
before(() => {
  savedEnv = {
    SEXTANT_SYNC_RESCAN: process.env.SEXTANT_SYNC_RESCAN,
    SEXTANT_BIN: process.env.SEXTANT_BIN,
  };
});
after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(() => {
  delete process.env.SEXTANT_SYNC_RESCAN;
  delete process.env.SEXTANT_BIN;
});

describe("shouldSyncRescan — evidence-based decision", () => {
  it("env kill switch (0/false) disables regardless of history", () => {
    const root = mkRoot();
    seedScanDurations(root, [100, 100, 100, 100, 100]);
    process.env.SEXTANT_SYNC_RESCAN = "0";
    assert.deepEqual(freshness.shouldSyncRescan(root), { sync: false, reason: "env_disabled" });
  });

  it("env force (1) bypasses the stats gate", () => {
    const root = mkRoot(); // no telemetry at all
    process.env.SEXTANT_SYNC_RESCAN = "1";
    const d = freshness.shouldSyncRescan(root);
    assert.equal(d.sync, true);
    assert.ok(d.timeoutMs > 0);
  });

  it("config syncRescan:false disables per-repo", () => {
    const root = mkRoot();
    fs.writeFileSync(path.join(root, ".codebase-intel.json"), JSON.stringify({ syncRescan: false }));
    seedScanDurations(root, [100, 100, 100, 100, 100]);
    assert.deepEqual(freshness.shouldSyncRescan(root), { sync: false, reason: "config_disabled" });
  });

  it("refuses below the sample floor (no history = no sync — degrade, don't guess)", () => {
    const root = mkRoot();
    seedScanDurations(root, [100, 100]); // 2 < SYNC_RESCAN_MIN_SAMPLES
    assert.equal(freshness.shouldSyncRescan(root).reason, "insufficient_samples");
  });

  it("syncs on a fast-history repo, with timeout clamped to the floor", () => {
    const root = mkRoot();
    seedScanDurations(root, [800, 900, 1000, 1100, 1200]);
    const d = freshness.shouldSyncRescan(root);
    assert.equal(d.sync, true);
    assert.equal(d.samples, 5);
    assert.equal(d.p95, 1200);
    assert.equal(d.timeoutMs, 3600); // 3 * 1200
  });

  it("refuses when the repo's p95 exceeds the ceiling", () => {
    const root = mkRoot();
    seedScanDurations(root, [1000, 1000, 1000, 1000, 9000]);
    const d = freshness.shouldSyncRescan(root);
    assert.equal(d.sync, false);
    assert.equal(d.reason, "p95_too_slow");
  });

  it("failure cooldown: a recent failed sync attempt suppresses retries", () => {
    const root = mkRoot();
    seedScanDurations(root, [100, 100, 100, 100, 100], [
      { ts: Date.now() - 60_000, name: "freshness.sync_rescan", ok: false, state: "failed" },
    ]);
    assert.equal(freshness.shouldSyncRescan(root).reason, "failure_cooldown");
  });

  it("an OLD failure (past cooldown) does not suppress", () => {
    const root = mkRoot();
    seedScanDurations(root, [100, 100, 100, 100, 100], [
      { ts: Date.now() - 20 * 60_000, name: "freshness.sync_rescan", ok: false, state: "failed" },
    ]);
    assert.equal(freshness.shouldSyncRescan(root).sync, true);
  });

  it("a recent SUCCESSFUL sync attempt does not suppress", () => {
    const root = mkRoot();
    seedScanDurations(root, [100, 100, 100, 100, 100], [
      { ts: Date.now() - 60_000, name: "freshness.sync_rescan", ok: true, state: "completed" },
    ]);
    assert.equal(freshness.shouldSyncRescan(root).sync, true);
  });
});

describe("syncRescan — single-flight + marker lifecycle", () => {
  it("returns pending under a live rescan marker (another rescan in flight)", () => {
    const root = mkRoot();
    fs.writeFileSync(
      freshness.rescanMarkerPath(root),
      JSON.stringify({ pid: 99999, startedAt: Date.now() })
    );
    const r = freshness.syncRescan(root, 3000);
    assert.equal(r.state, "pending");
    // the foreign marker must survive (we didn't claim it, we must not clear it)
    assert.ok(fs.existsSync(freshness.rescanMarkerPath(root)));
  });

  it("end-to-end: completed scan via SEXTANT_BIN, marker cleared after", () => {
    const root = mkRoot();
    fs.writeFileSync(path.join(root, "a.js"), "const x = require('./b');\n");
    fs.writeFileSync(path.join(root, "b.js"), "module.exports = 1;\n");
    execSync("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init", { cwd: root });
    process.env.SEXTANT_BIN = BIN;
    const r = freshness.syncRescan(root, 30000);
    assert.equal(r.state, "completed", JSON.stringify(r));
    assert.ok(r.durationMs >= 0);
    assert.ok(!fs.existsSync(freshness.rescanMarkerPath(root)), "marker must be cleared");
    assert.ok(fs.existsSync(path.join(root, ".planning", "intel", "graph.db")));
  });
});

describe("applyFreshnessGate — sync rescue end-to-end", () => {
  const cli = require("../lib/cli");
  const FAKE_RAW = [
    "## Codebase intelligence",
    "",
    "- **Indexed files**: 999",
    "- **Generated**: 2020-01-01T00:00:00.000Z",
  ].join("\n");

  function gitInitAndScan(root) {
    execSync("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init", { cwd: root });
    execSync(`node ${BIN} scan --root ${root} --force`, { stdio: "ignore" });
  }

  it("rescues a stale read: fresh body, stale_hit{sync}, no blackout_turn", async () => {
    const root = mkRoot();
    fs.writeFileSync(path.join(root, "a.js"), "const x = require('./b');\n");
    fs.writeFileSync(path.join(root, "b.js"), "module.exports = 1;\n");
    gitInitAndScan(root);
    // make it stale: new commit moves HEAD past the recorded scan state
    fs.writeFileSync(path.join(root, "c.js"), "module.exports = 2;\n");
    execSync("git add -A && git -c user.email=t@t -c user.name=t commit -qm change", { cwd: root });
    // fast recorded history so the stats gate opens (overwrites the real
    // scan.completed the init scan recorded — deterministic decision)
    seedScanDurations(root, [500, 500, 500, 500, 500]);
    process.env.SEXTANT_BIN = BIN;

    const out = await cli.applyFreshnessGate(FAKE_RAW, root);

    assert.doesNotMatch(out, /Structural claims unavailable/, "must not blackout");
    assert.match(out, /Indexed files/, "must carry the fresh structural body");
    const events = fs
      .readFileSync(path.join(root, ".planning", "intel", "telemetry.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const sync = events.filter((e) => e.name === "freshness.sync_rescan");
    assert.equal(sync.length, 1);
    assert.equal(sync[0].ok, true);
    const stale = events.filter((e) => e.name === "freshness.stale_hit");
    assert.equal(stale.length, 1);
    assert.equal(stale[0].rescanState, "sync");
    assert.equal(events.filter((e) => e.name === "freshness.blackout_turn").length, 0);
  });

  it("falls through to blackout when the sync arm is disabled", async () => {
    const root = mkRoot();
    fs.writeFileSync(path.join(root, "a.js"), "module.exports = 1;\n");
    gitInitAndScan(root);
    fs.writeFileSync(path.join(root, "c.js"), "module.exports = 2;\n");
    execSync("git add -A && git -c user.email=t@t -c user.name=t commit -qm change", { cwd: root });
    seedScanDurations(root, [500, 500, 500, 500, 500]);
    process.env.SEXTANT_SYNC_RESCAN = "0";
    process.env.SEXTANT_BIN = BIN;

    const out = await cli.applyFreshnessGate(FAKE_RAW, root);

    assert.match(out, /Structural claims unavailable/);
    const events = fs
      .readFileSync(path.join(root, ".planning", "intel", "telemetry.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(events.filter((e) => e.name === "freshness.sync_rescan").length, 0);
    assert.equal(events.filter((e) => e.name === "freshness.blackout_turn").length, 1);
  });
});
