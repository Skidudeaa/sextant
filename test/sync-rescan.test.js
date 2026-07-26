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
const graph = require("../lib/graph");

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

  // RECENCY WINDOW + OUTLIER TRIM (docs/033 Tier 2 #4). The pool used to be
  // every scan ever recorded, which read history instead of reality; a naive
  // recency window alone made things WORSE, because load-spike outliers are a
  // large fraction of a short window. Measured on the dogfood repo: all-time
  // p95 2202ms / last-50 raw 3609ms / last-50 trimmed 2182ms.
  it("ignores history beyond the recency window", () => {
    const root = mkRoot();
    // 60 slow scans then 50 fast ones: only the fast tail may count.
    seedScanDurations(root, [
      ...Array.from({ length: 60 }, () => 9000),
      ...Array.from({ length: 50 }, () => 1000),
    ]);
    const d = freshness.shouldSyncRescan(root);
    assert.equal(d.sync, true, "an old slow era must not veto a now-fast repo");
    assert.equal(d.p95, 1000);
    assert.equal(d.windowed, freshness.SYNC_RESCAN_WINDOW);
  });

  // docs/033 Tier 3 note: shouldSyncRescan now ingests `.old` BEFORE the current
  // file so the tail of its pool really is the most recent scans. There is
  // deliberately no behavioural test for that, because the fix is currently
  // UNOBSERVABLE through the decision: the `.old` branch only runs when the
  // current file holds < SYNC_RESCAN_MIN_SAMPLES (5) rows, so at most 4 rows can
  // ever be misordered, and the trim discards 5. The change makes the code match
  // its own documented recency claim and protects against a future edit to
  // SYNC_RESCAN_TRIM_FRACTION / SYNC_RESCAN_MIN_SAMPLES; asserting a decision
  // difference here would be asserting something the constants cannot produce.

  it("labels an env-forced sync as its own telemetry arm, not as stats", () => {
    const root = mkRoot();
    process.env.SEXTANT_SYNC_RESCAN = "1";
    const d = freshness.shouldSyncRescan(root);
    assert.equal(d.sync, true);
    assert.equal(
      d.reason,
      "env_forced",
      "a forced sync consults no statistics and must not be logged as gate:stats"
    );
  });

  it("trims load-spike outliers instead of letting them veto the lane", () => {
    const root = mkRoot();
    // 46 fast scans + 4 spikes: raw p95 would exceed the 2500ms ceiling,
    // trimmed p95 does not. This is the 2026-07-18 full-suite-load shape.
    seedScanDurations(root, [
      ...Array.from({ length: 46 }, () => 1800),
      18831, 10394, 4016, 3111,
    ]);
    const d = freshness.shouldSyncRescan(root);
    assert.equal(d.sync, true);
    assert.equal(d.trimmed, 5, "the slowest tenth of the window is set aside");
    assert.ok(d.p95 <= freshness.SYNC_RESCAN_MAX_P95_MS, `p95 ${d.p95} must clear the ceiling`);
  });

  it("still refuses a repo that is genuinely slow throughout", () => {
    const root = mkRoot();
    // Trimming must not rescue a repo where the TYPICAL scan is slow — only
    // the tail is treated as noise.
    seedScanDurations(root, Array.from({ length: 50 }, () => 9000));
    const d = freshness.shouldSyncRescan(root);
    assert.equal(d.sync, false);
    assert.equal(d.reason, "p95_too_slow");
  });
});

// VERSION-ONLY BYPASS (docs/033 Tier 2 #5). scanner_version_changed was 76.2%
// of stale reads on the dogfood repo — blackouts we inflict on ourselves by
// shipping. Content is unchanged in that case, so the rescan cannot race the
// working tree and the post-scan re-verify has nothing to catch.
describe("shouldSyncRescan — version-only bypass (docs/033)", () => {
  it("syncs with no scan history at all when only the version moved", () => {
    const root = mkRoot();
    seedScanDurations(root, [100, 100]); // below the sample floor
    assert.equal(freshness.shouldSyncRescan(root).reason, "insufficient_samples");
    const d = freshness.shouldSyncRescan(root, { versionOnly: true });
    assert.equal(d.sync, true);
    assert.equal(d.reason, "version_only");
    assert.equal(d.timeoutMs, 8000, "version-only takes the maximum timeout");
  });

  it("syncs past a slow p95 when only the version moved", () => {
    const root = mkRoot();
    seedScanDurations(root, Array.from({ length: 50 }, () => 9000));
    assert.equal(freshness.shouldSyncRescan(root).sync, false);
    assert.equal(freshness.shouldSyncRescan(root, { versionOnly: true }).sync, true);
  });

  it("still honours the explicit env kill switch", () => {
    const root = mkRoot();
    const prev = process.env.SEXTANT_SYNC_RESCAN;
    process.env.SEXTANT_SYNC_RESCAN = "0";
    try {
      const d = freshness.shouldSyncRescan(root, { versionOnly: true });
      assert.equal(d.sync, false);
      assert.equal(d.reason, "env_disabled");
    } finally {
      if (prev === undefined) delete process.env.SEXTANT_SYNC_RESCAN;
      else process.env.SEXTANT_SYNC_RESCAN = prev;
    }
  });

  it("still honours the per-repo config opt-out", () => {
    const root = mkRoot();
    fs.writeFileSync(path.join(root, ".codebase-intel.json"), JSON.stringify({ syncRescan: false }));
    const d = freshness.shouldSyncRescan(root, { versionOnly: true });
    assert.equal(d.sync, false);
    assert.equal(d.reason, "config_disabled");
  });

  it("still backs off after a recent failed sync attempt", () => {
    const root = mkRoot();
    seedScanDurations(root, [100, 100, 100, 100, 100], [
      { ts: Date.now() - 60_000, name: "freshness.sync_rescan", ok: false, state: "failed" },
    ]);
    const d = freshness.shouldSyncRescan(root, { versionOnly: true });
    assert.equal(d.sync, false);
    assert.equal(d.reason, "failure_cooldown");
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

  it("gate-triggered healing prunes a file deleted without a watcher event", async () => {
    const root = mkRoot();
    fs.writeFileSync(path.join(root, "a.js"), "module.exports = require('./gone');\n");
    fs.writeFileSync(path.join(root, "gone.js"), "exports.ghost = true;\n");
    execSync("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init", { cwd: root });
    execSync(`node ${BIN} scan --root ${root} --force`, { stdio: "ignore" });
    let db = await graph.loadDb(root);
    assert.ok(graph.getFileMeta(db, "gone.js"));

    fs.unlinkSync(path.join(root, "gone.js")); // deliberately no updateFile/watcher
    process.env.SEXTANT_BIN = BIN;
    const result = freshness.syncRescan(root, 30000);
    assert.equal(result.state, "completed", JSON.stringify(result));

    db = await graph.loadDb(root);
    assert.equal(graph.getFileMeta(db, "gone.js"), null, "recovery rescan must prune the ghost row");
    assert.equal((await freshness.checkFreshness(root)).fresh, true);
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
    // Fast recorded history so the stats gate WOULD independently choose sync
    // (a realistic ~2s p95 — a cold `sextant` scan is dominated by node +
    // sql.js WASM + zoekt startup, not a fictional 500ms). The gate decision
    // itself is locked by the "shouldSyncRescan — evidence-based decision"
    // subtest; here we exercise the end-to-end RESCUE.
    seedScanDurations(root, [2000, 2000, 2000, 2000, 2000]);
    // Force the max (8s) kill window rather than the history-DERIVED one. This
    // subtest spawns a REAL `sextant rescan`; inside the full parallel suite,
    // CPU saturation stretches even a 3-file scan to 2.5-5.9s (measured), so a
    // derived window racing the child was a load-dependent flake. env=1 gives a
    // deterministic 8000ms window (> observed worst case) without altering the
    // production timeout bounds; the seed above keeps the repo fast-shaped so
    // the forced path matches what the stats gate would pick anyway.
    process.env.SEXTANT_SYNC_RESCAN = "1";
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

  // VERSION-ONLY RESCUE (docs/033 Tier 2 #5). The sharp form: give the repo NO
  // usable scan history, so the stats gate would refuse outright. Only the
  // version-only bypass can rescue this turn — which is exactly the case that
  // produced 76.2% of the dogfood repo's blackouts.
  it("rescues a version-only stale read even with no scan history", async () => {
    const root = mkRoot();
    fs.writeFileSync(path.join(root, "a.js"), "const x = require('./b');\n");
    fs.writeFileSync(path.join(root, "b.js"), "module.exports = 1;\n");
    gitInitAndScan(root);

    // Age the graph's scanner stamp WITHOUT touching a single file: this is
    // "we shipped a new sextant", not "the user changed the repo".
    const db = await graph.loadDb(root);
    graph.setMetaValue(db, "scanner_version", "0.0.0-ancient");
    await graph.persistDb(root);

    const check = await freshness.checkFreshness(root);
    assert.equal(check.fresh, false);
    assert.equal(check.reason, "scanner_version_changed");
    assert.equal(check.contentChanged, false, "content must be untouched for this case");

    // No seeded durations at all — the stats arm cannot authorise this.
    delete process.env.SEXTANT_SYNC_RESCAN;
    process.env.SEXTANT_BIN = BIN;
    assert.equal(freshness.shouldSyncRescan(root).sync, false, "stats arm must refuse here");

    const out = await cli.applyFreshnessGate(FAKE_RAW, root);

    assert.doesNotMatch(out, /Structural claims unavailable/, "must not blackout");
    assert.match(out, /Indexed files/, "must carry the fresh structural body");
    const events = fs
      .readFileSync(path.join(root, ".planning", "intel", "telemetry.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const sync = events.filter((e) => e.name === "freshness.sync_rescan");
    assert.equal(sync.length, 1);
    assert.equal(sync[0].ok, true);
    assert.equal(sync[0].gate, "version_only", "the bypass must be attributable in telemetry");
    assert.equal(events.filter((e) => e.name === "freshness.blackout_turn").length, 0);
  });

  it("does NOT take the version-only bypass when content also moved", async () => {
    const root = mkRoot();
    fs.writeFileSync(path.join(root, "a.js"), "module.exports = 1;\n");
    gitInitAndScan(root);

    // Version bump AND a real content move in the same turn. contentChanged is
    // computed independently of the single-valued reason race, so the coincidence
    // must not be mistaken for a safe version-only rescan.
    const db = await graph.loadDb(root);
    graph.setMetaValue(db, "scanner_version", "0.0.0-ancient");
    await graph.persistDb(root);
    fs.writeFileSync(path.join(root, "c.js"), "module.exports = 2;\n");
    execSync("git add -A && git -c user.email=t@t -c user.name=t commit -qm change", { cwd: root });

    const check = await freshness.checkFreshness(root);
    assert.equal(check.reason, "scanner_version_changed");
    assert.equal(check.contentChanged, true, "the checkout must still register");

    delete process.env.SEXTANT_SYNC_RESCAN;
    process.env.SEXTANT_BIN = BIN;
    const out = await cli.applyFreshnessGate(FAKE_RAW, root);

    // No history + content moved ⇒ stats arm refuses, bypass does not apply.
    assert.match(out, /Structural claims unavailable/);
    const events = fs
      .readFileSync(path.join(root, ".planning", "intel", "telemetry.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(events.filter((e) => e.name === "freshness.sync_rescan").length, 0);
    assert.equal(events.filter((e) => e.name === "freshness.blackout_turn").length, 1);
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
