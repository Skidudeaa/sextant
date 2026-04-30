"use strict";

// Tests for `sextant telemetry`'s summarize() and percentile() helpers.
// We don't shell out to the CLI here -- the run() orchestration is just
// I/O glue; the load-bearing logic is the aggregation, which is what we
// test against synthetic event sets.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { summarize, percentile } = require("../commands/telemetry");

describe("percentile", () => {
  it("returns null on empty input", () => {
    assert.equal(percentile([], 0.5), null);
  });

  it("returns the only value for a singleton", () => {
    assert.equal(percentile([42], 0.5), 42);
    assert.equal(percentile([42], 0.99), 42);
  });

  it("p50 of [1..9] is 5 (linear interp)", () => {
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9], 0.5), 5);
  });

  it("p95 of [1..100] is around 95", () => {
    const arr = Array.from({ length: 100 }, (_, i) => i + 1);
    const p95 = percentile(arr, 0.95);
    // With linear interp on rank (n-1)*p, p95 of 100 elements is at index 94.05
    assert.ok(p95 >= 95 && p95 <= 96, `expected p95 ≈ 95, got ${p95}`);
  });
});

describe("summarize: empty input", () => {
  it("handles zero events without dividing by zero", () => {
    const sum = summarize([]);
    assert.equal(sum.eventCount, 0);
    assert.equal(sum.firstTs, null);
    assert.equal(sum.freshness.totalReads, 0);
    assert.equal(sum.freshness.staleRate, null);
    assert.equal(sum.scans.total, 0);
    assert.equal(sum.scans.duration, null);
  });
});

describe("summarize: freshness counts and stale rate", () => {
  it("computes stale rate from fresh + stale hits", () => {
    const events = [
      { ts: 1, name: "freshness.fresh_hit" },
      { ts: 2, name: "freshness.fresh_hit" },
      { ts: 3, name: "freshness.fresh_hit" },
      { ts: 4, name: "freshness.stale_hit", reason: "head_changed" },
      { ts: 5, name: "freshness.blackout_turn", reason: "head_changed" },
    ];
    const sum = summarize(events);
    assert.equal(sum.freshness.freshHits, 3);
    assert.equal(sum.freshness.staleHits, 1);
    assert.equal(sum.freshness.blackoutTurns, 1);
    assert.equal(sum.freshness.totalReads, 4);
    assert.equal(sum.freshness.staleRate, 0.25);
    assert.equal(sum.freshness.reasons.head_changed, 1);
  });

  it("aggregates multiple stale reasons", () => {
    const events = [
      { ts: 1, name: "freshness.stale_hit", reason: "head_changed" },
      { ts: 2, name: "freshness.stale_hit", reason: "head_changed" },
      { ts: 3, name: "freshness.stale_hit", reason: "status_changed" },
      { ts: 4, name: "freshness.stale_hit", reason: "no_scan_record" },
    ];
    const sum = summarize(events);
    assert.equal(sum.freshness.staleHits, 4);
    assert.equal(sum.freshness.reasons.head_changed, 2);
    assert.equal(sum.freshness.reasons.status_changed, 1);
    assert.equal(sum.freshness.reasons.no_scan_record, 1);
  });
});

describe("summarize: scan duration percentiles by trigger", () => {
  it("splits stats per trigger and reports overall percentiles", () => {
    const events = [
      // 10 freshness-gate scans, fast (~50ms)
      ...Array.from({ length: 10 }, (_, i) => ({
        ts: 1000 + i,
        name: "scan.completed",
        durationMs: 40 + i,
        success: true,
        trigger: "freshness_gate",
      })),
      // 4 manual scans, slow (~500ms)
      ...Array.from({ length: 4 }, (_, i) => ({
        ts: 2000 + i,
        name: "scan.completed",
        durationMs: 480 + i * 10,
        success: true,
        trigger: "manual",
      })),
      // 1 failure
      {
        ts: 3000,
        name: "scan.completed",
        durationMs: 60,
        success: false,
        trigger: "freshness_gate",
        error: "spawn_failed",
      },
    ];
    const sum = summarize(events);
    assert.equal(sum.scans.total, 15);
    assert.equal(sum.scans.successes, 14);
    assert.equal(sum.scans.failures, 1);
    assert.ok(sum.scans.successRate > 0.9 && sum.scans.successRate < 1.0);

    assert.ok(sum.scans.byTrigger.freshness_gate);
    assert.equal(sum.scans.byTrigger.freshness_gate.count, 11);
    assert.ok(sum.scans.byTrigger.manual);
    assert.equal(sum.scans.byTrigger.manual.count, 4);

    // freshness_gate p50 should sit in the 40-60ms range (10 fast + 1 fast failure)
    const fgP50 = sum.scans.byTrigger.freshness_gate.p50;
    assert.ok(fgP50 >= 40 && fgP50 <= 60, `freshness_gate p50 should be ~50ms, got ${fgP50}`);

    // manual p95 should be near the slow end (~510ms)
    const mP95 = sum.scans.byTrigger.manual.p95;
    assert.ok(mP95 >= 480 && mP95 <= 520, `manual p95 should be ~510ms, got ${mP95}`);
  });
});

describe("summarize: timestamp window", () => {
  it("reports first/last/span across all events", () => {
    const events = [
      { ts: 1000, name: "x" },
      { ts: 5000, name: "y" },
      { ts: 3000, name: "z" }, // out of order on purpose
    ];
    const sum = summarize(events);
    assert.equal(sum.firstTs, 1000);
    assert.equal(sum.lastTs, 5000);
    assert.equal(sum.spanMs, 4000);
  });
});
