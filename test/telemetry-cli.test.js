"use strict";

// Tests for `sextant telemetry`'s summarize() and percentile() helpers.
// We don't shell out to the CLI here -- the run() orchestration is just
// I/O glue; the load-bearing logic is the aggregation, which is what we
// test against synthetic event sets.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const {
  summarize,
  percentile,
  printSummary,
  coherenceScorecard,
  printCoherenceScorecard,
  wilsonLowerBound,
  coherenceExperimentScorecard,
} = require("../commands/telemetry");
const telemetry = require("../lib/telemetry");

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

describe("summarize: Phase F multi-agent coherence", () => {
  it("counts serve/return/report boundaries and delivered findings", () => {
    const sum = summarize([
      { ts: 1, name: "coherence.agent_registered", kind: "parent" },
      { ts: 2, name: "coherence.agent_registered", kind: "child" },
      { ts: 3, name: "coherence.agent_returned" },
      { ts: 4, name: "coherence.report_eligible", overlaps: 2 },
      { ts: 5, name: "coherence.delta_delivered", overlaps: 2, changed: 3, invalidated: 1 },
      { ts: 6, name: "coherence.skipped", reason: "no_spawn_id" },
    ]);
    assert.equal(sum.multiAgentCoherence.agentsRegistered, 2);
    assert.equal(sum.multiAgentCoherence.agentReturns, 1);
    assert.equal(sum.multiAgentCoherence.reportsEligible, 1);
    assert.equal(sum.multiAgentCoherence.reportsDelivered, 1);
    assert.equal(sum.multiAgentCoherence.overlapPairsDelivered, 2);
    assert.equal(sum.multiAgentCoherence.claimsChangedDelivered, 3);
    assert.equal(sum.multiAgentCoherence.claimsInvalidatedDelivered, 1);
    assert.equal(sum.multiAgentCoherence.skipped, 1);
    assert.deepEqual(sum.multiAgentCoherence.skippedByReason, { no_spawn_id: 1 });
    assert.equal(sum.multiAgentCoherence.scorecard.status, "DORMANT");
    const text = printSummary("/x", sum);
    assert.match(text, /Multi-agent coherence/);
    assert.match(text, /recorded observation only/);
    assert.doesNotMatch(text, /coordination lock/i);
    assert.match(text, /recorded capsule generations: 2/);
    assert.match(text, /reports: 1\/1 delivered/);
  });
});

describe("Phase F decision-grade scorecard", () => {
  function matureEvents() {
    const now = Date.now();
    const start = now - 8 * 24 * 60 * 60 * 1000;
    const events = [];
    for (let i = 0; i < 100; i++) {
      const taskKey = `ctask_${String(i % 30).padStart(24, "0")}`;
      const agentKey = `child_${i}`;
      events.push({
        ts: start + i,
        name: "coherence.lifecycle",
        schemaVersion: 1,
        taskKey,
        agentKey,
        stage: "child_spawn",
        outcome: "written",
        durationMs: 20,
      });
      events.push({
        ts: start + 1000 + i,
        name: "coherence.lifecycle",
        schemaVersion: 1,
        taskKey,
        agentKey,
        stage: "tool_return",
        outcome: "written",
        durationMs: 24,
      });
    }
    for (let i = 0; i < 50; i++) {
      const incidentId = `cincident_${String(i).padStart(24, "0")}`;
      const boundaryId = `cboundary_${String(i).padStart(32, "0")}`;
      const taskKey = `ctask_${String(i % 30).padStart(24, "0")}`;
      events.push({
        ts: start + 2000 + i,
        name: "coherence.report",
        schemaVersion: 1,
        stage: "analysis",
        outcome: "eligible",
        incidentId,
        boundaryId,
        taskKey,
        surface: "parent_prompt",
        agents: 2,
        unchanged: 3,
        changed: 1,
        invalidated: 0,
        unknown: 0,
        overlapPairs: 1,
        reportFindings: 2,
        findingSample: `[{"kind":"changed","path":"src/${i}.js"}]`,
      });
      events.push({
        ts: start + 3000 + i,
        name: "coherence.report",
        schemaVersion: 1,
        stage: "delivery",
        outcome: "delivered",
        incidentId,
        boundaryId,
        taskKey,
        surface: "parent_prompt",
        deliveredChanged: 1,
        deliveredInvalidated: 0,
        deliveredOverlapPairs: 1,
      });
      events.push({
        ts: start + 4000 + i,
        name: "coherence.feedback",
        schemaVersion: 1,
        incidentId,
        verdict: "accurate_useful",
        reviewedFindings: 1,
      });
    }
    events.push({
      ts: now,
      name: "coherence.lifecycle",
      schemaVersion: 1,
      taskKey: "ctask_000000000000000000000000",
      agentKey: "parent_0",
      stage: "parent_serve",
      outcome: "written",
      durationMs: 10,
    });
    return events;
  }

  // docs/033 Tier 3 item 9 — the split. ACCRUING and the heading "Accrual
  // gaps" asserted that elapsed time closes every unmet floor. On the dogfood
  // repo four of five were false by one to two orders of magnitude and two were
  // false at rate exactly zero, so the card promised a verdict that could never
  // arrive. A floor now reports its own ETA and ACCRUING has to be earned.
  it("refuses to call a floor ACCRUING when the observed rate cannot reach it", () => {
    const now = Date.now();
    const start = now - 10 * 24 * 3600 * 1000; // 10-day window
    const events = [
      { ts: start, name: "coherence.lifecycle", schemaVersion: 1, taskKey: "t1",
        agentKey: "parent_0", stage: "parent_serve", outcome: "written", durationMs: 10 },
      { ts: start + 1000, name: "coherence.lifecycle", schemaVersion: 1, taskKey: "t1",
        agentKey: "child_0", parentAgentKey: "parent_0", stage: "child_spawn",
        outcome: "written", durationMs: 10 },
      { ts: now, name: "coherence.lifecycle", schemaVersion: 1, taskKey: "t1",
        agentKey: "child_0", parentAgentKey: "parent_0", stage: "tool_return",
        outcome: "written", durationMs: 10 },
    ];
    const card = coherenceScorecard(events);
    assert.equal(card.status, "UNREACHABLE_AT_OBSERVED_RATE");
    assert.ok(
      card.gaps.some((g) => /ETA \d+d at the observed rate/.test(g)),
      `every unmet floor must carry an ETA, got: ${JSON.stringify(card.gaps)}`
    );
    const text = printCoherenceScorecard("/repo", card);
    assert.match(text, /Unmet floors/);
    assert.doesNotMatch(text, /Accrual gaps/);
  });

  it("reports lifecycle integrity as an event-level verdict, outside every volume gate", () => {
    const now = Date.now();
    const events = [
      { ts: now - 5000, name: "coherence.lifecycle", schemaVersion: 1, taskKey: "t1",
        agentKey: "parent_0", stage: "parent_serve", outcome: "written", durationMs: 5 },
      // A return with no spawn-side row at all: the real 2026-07-16 shape.
      { ts: now, name: "coherence.lifecycle", schemaVersion: 1, taskKey: "t1",
        agentKey: "child_orphan", parentAgentKey: "parent_0", stage: "tool_return",
        outcome: "missing", reason: "no_spawn_snapshot", durationMs: 5 },
    ];
    const card = coherenceScorecard(events);
    assert.equal(card.lifecycleVerdict, "DEFECT_OPEN");
    const row = card.lifecycleDefects.find((d) => d.reason === "no_spawn_snapshot");
    assert.ok(row, "the defect must be itemised");
    assert.equal(row.explained, false);
    assert.equal(row.count, 1);
    // It must be readable without clearing any accrual floor.
    const text = printCoherenceScorecard("/repo", card);
    assert.match(text, /Lifecycle integrity: DEFECT_OPEN/);
    assert.match(text, /UNEXPLAINED/);
  });

  it("marks a return miss EXPLAINED when its spawn side recorded a withhold", () => {
    // After the pretask fix, a withheld spawn leaves a matching row, so the
    // return-side miss is attributable and needs no investigation.
    const now = Date.now();
    const events = [
      { ts: now - 5000, name: "coherence.lifecycle", schemaVersion: 1, taskKey: "t1",
        agentKey: "child_1", parentAgentKey: "parent_0", stage: "child_spawn",
        outcome: "withheld", reason: "orientation_unavailable", durationMs: 5 },
      { ts: now, name: "coherence.lifecycle", schemaVersion: 1, taskKey: "t1",
        agentKey: "child_1", parentAgentKey: "parent_0", stage: "tool_return",
        outcome: "missing", reason: "no_spawn_snapshot", durationMs: 5 },
    ];
    const card = coherenceScorecard(events);
    const row = card.lifecycleDefects.find((d) => d.stage === "tool_return");
    assert.ok(row);
    assert.equal(row.explained, true, "a recorded spawn-side withhold explains the miss");
  });

  it("uses Wilson lower bounds and never calls operational health behavioral benefit", () => {
    assert.ok(wilsonLowerBound(100, 100) > 0.95);
    const card = coherenceScorecard(matureEvents());
    assert.equal(card.status, "OPERATIONALLY_READY");
    assert.equal(card.behavioralBenefit, "NOT_MEASURED");
    assert.equal(card.lifecycle.multiAgentTasks, 30);
    assert.equal(card.lifecycle.childSpawnAttempts, 100);
    assert.equal(card.lifecycle.returnAttempts, 100);
    assert.equal(card.reports.uniqueEligibleIncidents, 50);
    assert.equal(card.reports.uniqueDeliveredIncidents, 50);
    assert.equal(card.reports.findingDeliveryRate, 1);
    assert.equal(card.safetyReview.reviewedFindings, 50);
    assert.match(printCoherenceScorecard("/repo", card), /Behavioral benefit: NOT_MEASURED/);
  });

  it("collapses retry rows by child identity and reports only prepared returns", () => {
    const base = {
      name: "coherence.lifecycle",
      schemaVersion: 1,
      taskKey: "task_join",
      durationMs: 2,
    };
    const events = [
      { ...base, ts: 1, stage: "child_spawn", agentKey: "child_a", outcome: "written" },
      { ...base, ts: 2, stage: "child_spawn", agentKey: "child_a", outcome: "retry" },
      { ...base, ts: 3, stage: "child_spawn", agentKey: "child_b", outcome: "written" },
      { ...base, ts: 4, stage: "tool_return", agentKey: "child_a", outcome: "written" },
      { ...base, ts: 5, stage: "tool_return", agentKey: "child_a", outcome: "retry" },
      { ...base, ts: 6, stage: "tool_return", agentKey: "orphan", outcome: "written" },
    ];
    const card = coherenceScorecard(events);
    assert.equal(card.lifecycle.childSpawnRows, 3);
    assert.equal(card.lifecycle.childSpawnAttempts, 2);
    assert.equal(card.lifecycle.childSpawnDuplicateRowsCollapsed, 1);
    assert.equal(card.lifecycle.returnRows, 3);
    assert.equal(card.lifecycle.returnAttempts, 2);
    assert.equal(card.lifecycle.returnDuplicateRowsCollapsed, 1);
    assert.equal(card.lifecycle.uniqueChildrenPrepared, 2);
    assert.equal(card.lifecycle.uniqueChildrenReturned, 2);
    assert.equal(card.lifecycle.observedChildrenReturned, 1);
    assert.equal(card.lifecycle.observedReturnRate, 0.5);
    assert.equal(card.lifecycle.orphanReturns, 1);
  });

  it("keeps task-scoped child cohorts distinct and never erases a hard failure with a retry", () => {
    const base = {
      name: "coherence.lifecycle",
      schemaVersion: 1,
      agentKey: "reused_child_key",
      durationMs: 2,
    };
    const card = coherenceScorecard([
      { ...base, ts: 1, taskKey: "task_one", stage: "child_spawn", outcome: "failed" },
      { ...base, ts: 2, taskKey: "task_one", stage: "child_spawn", outcome: "retry" },
      { ...base, ts: 3, taskKey: "task_two", stage: "child_spawn", outcome: "written" },
      { ...base, ts: 4, taskKey: "task_one", stage: "tool_return", outcome: "written" },
    ]);
    assert.equal(card.lifecycle.childSpawnAttempts, 2);
    assert.equal(card.lifecycle.childSpawnSuccesses, 2);
    assert.equal(card.lifecycle.uniqueChildrenPrepared, 2);
    assert.equal(card.lifecycle.observedChildrenReturned, 1);
    assert.equal(card.lifecycle.observedReturnRate, 0.5);
    assert.equal(card.lifecycle.hardFailures, 1);
    assert.equal(card.status, "INVESTIGATE");
  });

  it("does not let an earlier success erase a later terminal ambiguity", () => {
    const base = {
      name: "coherence.lifecycle",
      schemaVersion: 1,
      taskKey: "task_terminal",
      agentKey: "child_terminal",
      stage: "child_spawn",
      durationMs: 2,
    };
    const card = coherenceScorecard([
      { ...base, ts: 1, outcome: "written" },
      { ...base, ts: 2, outcome: "ambiguous", reason: "spawn_identity_ambiguous" },
    ]);
    assert.equal(card.lifecycle.childSpawnAttempts, 1);
    assert.equal(card.lifecycle.childSpawnSuccesses, 0);
    assert.equal(card.lifecycle.safeWithholds, 1);
    assert.equal(card.lifecycle.outcomesByStage.child_spawn.ambiguous, 1);
  });

  it("treats a failed report-analysis denominator as an integrity stop", () => {
    const card = coherenceScorecard([{
      ts: 1,
      name: "coherence.report",
      schemaVersion: 1,
      stage: "analysis",
      surface: "parent_prompt",
      outcome: "failed",
      reason: "analysis_exception",
      boundaryId: "boundary-failed",
      taskKey: "task-failed",
      durationMs: 3,
      reportFindings: 0,
    }]);
    assert.equal(card.status, "INVESTIGATE");
    assert.equal(card.reports.analysisFailures, 1);
    assert.equal(card.reports.analysisFailureReasons.analysis_exception, 1);
    assert.match(printCoherenceScorecard("/repo", card), /failed analysis attempts: 1/);
  });

  it("gates each instrumented latency lane without claiming full-hook cost", () => {
    const events = matureEvents();
    const slowAnalysis = events.find(
      (event) => event.name === "coherence.report" && event.stage === "analysis"
    );
    slowAnalysis.durationMs = 1000;
    const card = coherenceScorecard(events);
    assert.equal(card.lifecycle.duration.p95, 24);
    assert.equal(card.reports.analysisDuration.p95, 1000);
    assert.equal(card.status, "HOLD");
    assert.ok(card.latency.failures.some((failure) => /reportAnalysis/.test(failure)));
    assert.match(card.latency.measurementBoundary, /excludes telemetry append and total hook runtime/);
    assert.equal(card.latency.measuredOperations, undefined);
    const text = printCoherenceScorecard("/repo", card);
    assert.match(text, /Latency measurement boundary/);
    assert.doesNotMatch(text, /Measured Phase-F operation cost/);
  });

  it("prints a neutral factual-review command without preselecting a verdict", () => {
    const events = matureEvents().filter((event) => event.name !== "coherence.feedback");
    const text = printCoherenceScorecard("/repo", coherenceScorecard(events));
    assert.match(text, /--verdict <verdict> --reviewed-findings 1/);
    assert.doesNotMatch(text, /--verdict accurate_useful/);
  });

  it("does not let unclear reviews satisfy the factual-adjudication floor", () => {
    const events = matureEvents();
    for (const event of events) {
      if (event.name === "coherence.feedback") event.verdict = "unclear";
    }
    const card = coherenceScorecard(events);
    assert.equal(card.status, "REVIEW_REQUIRED");
    assert.equal(card.safetyReview.reviewedFindings, 0);
    assert.equal(card.safetyReview.reviewedIncidents, 0);
    assert.equal(card.safetyReview.adjudicatedFindings, 0);
    assert.equal(card.safetyReview.unclearIncidents, 50);
    assert.equal(card.safetyReview.verdicts.unclear, 50);
    assert.equal(card.safetyReview.unreviewedClaimIncidents, 50);
    assert.match(printCoherenceScorecard("/repo", card), /adjudicated: 0 finding units/);
  });

  it("dedupes repeated incident ids and a confirmed false fact forces INVESTIGATE", () => {
    const events = matureEvents();
    const duplicate = { ...events.find((event) => event.stage === "analysis"), ts: Date.now() - 10 };
    events.push(duplicate);
    const before = coherenceScorecard(events);
    assert.equal(before.reports.uniqueEligibleIncidents, 50);
    events.push({
      ts: Date.now(),
      name: "coherence.feedback",
      schemaVersion: 1,
      incidentId: duplicate.incidentId,
      verdict: "false_fact",
      reviewedFindings: 1,
    });
    const after = coherenceScorecard(events);
    assert.equal(after.status, "INVESTIGATE");
    assert.equal(after.safetyReview.falseFacts, 1);
    events.push({
      ts: Date.now() + 1,
      name: "coherence.feedback",
      schemaVersion: 1,
      incidentId: duplicate.incidentId,
      verdict: "accurate_useful",
      reviewedFindings: 1,
    });
    const sticky = coherenceScorecard(events);
    assert.equal(sticky.status, "INVESTIGATE");
    assert.equal(sticky.safetyReview.falseFacts, 1);
  });

  it("is explicitly DORMANT before versioned events arrive", () => {
    const card = coherenceScorecard([{ ts: Date.now(), name: "coherence.agent_registered" }]);
    assert.equal(card.status, "DORMANT");
    assert.match(printCoherenceScorecard("/repo", card), /measurement lane has not observed traffic/);
  });

  it("can reach PARK_CANDIDATE after the headroom sample without 50 incidents", () => {
    const events = matureEvents().filter(
      (event) => event.name === "coherence.lifecycle"
    );
    const start = Date.now() - 8 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 100; i++) {
      events.push({
        ts: start + 10_000 + i,
        name: "coherence.report",
        schemaVersion: 1,
        stage: "analysis",
        boundaryId: `cboundary_park_${i}`,
        taskKey: `ctask_${String(i % 30).padStart(24, "0")}`,
        surface: "parent_prompt",
        agents: 2,
        unchanged: 2,
        changed: 0,
        invalidated: 0,
        unknown: 0,
        overlapPairs: 0,
      });
    }
    const card = coherenceScorecard(events);
    assert.equal(card.reports.peerAnalyses, 100);
    assert.equal(card.reports.uniqueEligibleIncidents, 0);
    assert.equal(card.status, "PARK_CANDIDATE");
    assert.equal(card.gaps.some((gap) => /eligible incidents/.test(gap)), false);
  });

  it("never parks a low-headroom cohort whose lifecycle reliability failed", () => {
    const events = [];
    const start = Date.now() - 8 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 100; i++) {
      const taskKey = `ctask_${String(i % 30).padStart(24, "0")}`;
      events.push({
        ts: start + i,
        name: "coherence.lifecycle",
        schemaVersion: 1,
        stage: "child_spawn",
        outcome: "missing",
        taskKey,
        agentKey: `child_${i}`,
        durationMs: 2,
      });
      events.push({
        ts: start + 1000 + i,
        name: "coherence.lifecycle",
        schemaVersion: 1,
        stage: "tool_return",
        outcome: "missing",
        taskKey,
        agentKey: `child_${i}`,
        durationMs: 2,
      });
      events.push({
        ts: start + 2000 + i,
        name: "coherence.report",
        schemaVersion: 1,
        stage: "analysis",
        boundaryId: `boundary_${i}`,
        taskKey,
        agents: 2,
        unchanged: 2,
      });
    }
    events.push({
      ts: Date.now(),
      name: "coherence.lifecycle",
      schemaVersion: 1,
      stage: "parent_serve",
      outcome: "written",
      taskKey: "ctask_000000000000000000000000",
      agentKey: "parent",
      durationMs: 2,
    });
    const card = coherenceScorecard(events);
    assert.equal(card.reports.findingIncidence, 0);
    assert.equal(card.status, "HOLD");
    assert.match(card.reasons[0], /lifecycle-reliability/);
  });

  it("separates raw delivery from intentional overlap-holdback resolution", () => {
    const base = {
      ts: Date.now(),
      name: "coherence.report",
      schemaVersion: 1,
      incidentId: "cincident_holdback",
      boundaryId: "cboundary_holdback",
      taskKey: "ctask_000000000000000000000001",
      surface: "parent_prompt",
    };
    const card = coherenceScorecard([
      {
        ...base,
        stage: "analysis",
        agents: 2,
        changed: 1,
        invalidated: 0,
        overlapPairs: 1,
      },
      {
        ...base,
        stage: "delivery",
        deliveredChanged: 1,
        deliveredInvalidated: 0,
        deliveredOverlapPairs: 0,
        experimentArm: "holdback",
      },
      {
        ...base,
        stage: "holdback",
        heldbackOverlapPairs: 1,
        heldbackChanged: 0,
        heldbackInvalidated: 0,
        experimentArm: "holdback",
      },
    ]);
    assert.equal(card.reports.deliveredFindings, 1);
    assert.equal(card.reports.findingDeliveryRate, 0.5);
    assert.equal(card.reports.intentionallyHeldbackFindings, 1);
    assert.equal(card.reports.resolvedFindings, 2);
    assert.equal(card.reports.findingResolutionRate, 1);
    assert.equal(card.reports.incidentResolutionRate, 1);
    assert.equal(card.reports.boundaryResolutionRate, 1);
  });

  it("does not hide repeated boundary loss behind canonical incident deduplication", () => {
    const common = {
      name: "coherence.report",
      schemaVersion: 1,
      incidentId: "cincident_repeat",
      taskKey: "ctask_repeat",
      surface: "parent_prompt",
      agents: 2,
      changed: 1,
      invalidated: 0,
      overlapPairs: 0,
    };
    const card = coherenceScorecard([
      { ...common, ts: 1, stage: "analysis", boundaryId: "boundary_ok" },
      { ...common, ts: 2, stage: "delivery", boundaryId: "boundary_ok", deliveredChanged: 1 },
      { ...common, ts: 3, stage: "analysis", boundaryId: "boundary_lost" },
    ]);
    assert.equal(card.reports.uniqueEligibleIncidents, 1);
    assert.equal(card.reports.incidentResolutionRate, 1);
    assert.equal(card.reports.eligibleBoundaries, 2);
    assert.equal(card.reports.resolvedBoundaries, 1);
    assert.equal(card.reports.boundaryResolutionRate, 0.5);
  });

  it("requires every finding in an incident before calling the incident resolved", () => {
    const common = {
      ts: 1,
      name: "coherence.report",
      schemaVersion: 1,
      incidentId: "cincident_partial",
      boundaryId: "boundary_partial",
      taskKey: "ctask_partial",
      surface: "tool_return",
    };
    const card = coherenceScorecard([
      { ...common, stage: "analysis", agents: 2, changed: 2, invalidated: 0, overlapPairs: 0 },
      { ...common, stage: "delivery", deliveredChanged: 1, deliveredInvalidated: 0, deliveredOverlapPairs: 0 },
    ]);
    assert.equal(card.reports.findingResolutionRate, 0.5);
    assert.equal(card.reports.uniqueResolvedIncidents, 0);
    assert.equal(card.reports.incidentResolutionRate, 0);
    assert.equal(card.reports.resolvedBoundaries, 0);
  });

  function addExperimentWindow(events, options) {
    const {
      arm,
      taskKey,
      opportunityId,
      assignmentMode = "randomized",
      assigned = true,
      close = true,
      targetRead = arm === "armed",
      blindTargetMutation = arm === "holdback",
    } = options;
    const common = { schemaVersion: 1, taskKey, arm, assignmentMode };
    if (assigned) {
      events.push({
        ...common,
        ts: events.length + 1,
        name: "coherence.experiment.assigned",
      });
    }
    events.push(
      {
        ...common,
        ts: events.length + 1,
        name: "coherence.overlap.opportunity",
        opportunityId,
      },
      {
        ...common,
        ts: events.length + 2,
        name: "coherence.experiment.window_opened",
        opportunityId,
      },
      {
        ...common,
        ts: events.length + 3,
        name: arm === "armed" ? "coherence.overlap.exposed" : "coherence.overlap.withheld",
        opportunityId,
      }
    );
    if (close) {
      events.push({
        ...common,
        ts: events.length + 4,
        name: "coherence.experiment.window_closed",
        opportunityId,
        targetRead,
        targetMutation: true,
        blindTargetMutation,
        firstTargetRank: 1,
        totalTouches: 2,
      });
    }
  }

  it("uses each task's first registered opportunity for the randomized outcome", () => {
    const events = [];
    for (const arm of ["armed", "holdback"]) {
      for (let i = 0; i < 150; i++) {
        const taskKey = `ctask_${arm === "armed" ? "a" : "b"}${String(i).padStart(23, "0")}`;
        const opportunityId = `op_${arm}_${i}`;
        addExperimentWindow(events, {
          arm,
          opportunityId,
          taskKey,
        });
        // A later protocol-duplicate opportunity has the opposite outcome. It
        // remains visible in protocol/attrition counts but must not overwrite
        // the task's pre-registered first-opportunity outcome.
        if (i === 0) {
          addExperimentWindow(events, {
            arm,
            taskKey,
            opportunityId: `${opportunityId}_second`,
            assigned: false,
            targetRead: arm !== "armed",
            blindTargetMutation: arm !== "holdback",
          });
        }
      }
    }
    const experiment = coherenceExperimentScorecard(events);
    assert.equal(experiment.status, "INVESTIGATE");
    assert.equal(experiment.interpretation, "EXPERIMENT_INTEGRITY_FAILURE");
    assert.equal(experiment.arms.armed.tasks, 150);
    assert.equal(experiment.arms.holdback.tasks, 150);
    assert.equal(experiment.protocol.tasksWithMultipleOpportunities, 2);
    assert.equal(experiment.protocol.duplicateOpportunityUnits, 2);
    assert.equal(experiment.blindTargetMutationDeltaHoldbackMinusArmed, 1);
    assert.equal(experiment.interpretation, "EXPERIMENT_INTEGRITY_FAILURE");
    assert.match(experiment.outcomeBoundary, /conflicts, task success, and user value are not measured/);
  });

  it("holds when exact-window attrition is hidden by one closure per task", () => {
    const events = [];
    for (const arm of ["armed", "holdback"]) {
      for (let task = 0; task < 40; task++) {
        const taskKey = `task_${arm}_${task}`;
        for (let window = 0; window < 10; window++) {
          addExperimentWindow(events, {
            arm,
            taskKey,
            opportunityId: `op_${arm}_${task}_${window}`,
            assigned: window === 0,
            close: window === 0,
          });
        }
      }
    }
    const experiment = coherenceExperimentScorecard(events);
    assert.equal(experiment.arms.armed.tasks, 40);
    assert.equal(experiment.arms.armed.registeredOpportunities, 400);
    assert.equal(experiment.arms.armed.closedWindows, 40);
    assert.equal(experiment.arms.armed.windowClosureRate, 0.1);
    assert.equal(experiment.arms.holdback.windowClosureRate, 0.1);
    assert.equal(experiment.protocol.duplicateOpportunityUnits, 720);
    assert.equal(experiment.status, "INVESTIGATE");
    assert.ok(experiment.attritionFailures.some((failure) => /window-closure/.test(failure)));
  });

  it("excludes forced and missing-assignment-mode rows from causal results", () => {
    const events = [];
    addExperimentWindow(events, {
      arm: "armed",
      taskKey: "forced_armed",
      opportunityId: "forced_a",
      assignmentMode: "forced",
    });
    addExperimentWindow(events, {
      arm: "holdback",
      taskKey: "forced_holdback",
      opportunityId: "forced_b",
      assignmentMode: "forced",
    });
    events.push({
      ts: 100,
      name: "coherence.overlap.opportunity",
      schemaVersion: 1,
      taskKey: "legacy_missing_mode",
      opportunityId: "legacy",
      arm: "armed",
    });
    const experiment = coherenceExperimentScorecard(events);
    assert.equal(experiment.status, "DORMANT");
    assert.equal(experiment.opportunities, 0);
    assert.equal(experiment.controlLeaks, 0);
    assert.equal(experiment.forcedTasksExcluded, 2);
    assert.equal(experiment.missingAssignmentModeEvents, 1);
  });

  it("forces an experiment integrity stop on arm flips or control leakage", () => {
    const taskKey = "ctask_000000000000000000000099";
    const events = [
      {
        ts: 1,
        name: "coherence.experiment.assigned",
        schemaVersion: 1,
        taskKey,
        arm: "armed",
        assignmentMode: "randomized",
      },
      {
        ts: 2,
        name: "coherence.experiment.assigned",
        schemaVersion: 1,
        taskKey,
        arm: "holdback",
        assignmentMode: "randomized",
      },
      {
        ts: 3,
        name: "coherence.overlap.exposed",
        schemaVersion: 1,
        taskKey,
        arm: "holdback",
        opportunityId: "leak",
        assignmentMode: "randomized",
      },
    ];
    const experiment = coherenceExperimentScorecard(events);
    assert.equal(experiment.status, "INVESTIGATE");
    assert.equal(experiment.armFlips, 1);
    assert.equal(experiment.controlLeaks, 1);
    const card = coherenceScorecard(events);
    assert.equal(card.status, "INVESTIGATE");
  });

  it("forces investigation when an active-window file touch was not observed", () => {
    const events = matureEvents();
    events.push({
      ts: Date.now(),
      name: "coherence.experiment.observation_failed",
      schemaVersion: 1,
      operation: "score_touch",
      reason: "lock_unavailable",
      activeWindowCount: 0,
    });
    const card = coherenceScorecard(events);
    assert.equal(card.status, "INVESTIGATE");
    assert.equal(card.experiment.status, "INVESTIGATE");
    assert.equal(card.experiment.observationFailures, 1);
    assert.equal(card.experiment.observationFailureReasons.lock_unavailable, 1);
    assert.match(printCoherenceScorecard("/repo", card), /observation failures 1/);
  });
});

describe("telemetry CLI: Phase F gate-off retention boundary", () => {
  it("omits retained coherence events from text, JSON, and raw tail when disabled", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sx-telemetry-gate-"));
    const bin = path.resolve(__dirname, "..", "bin", "intel.js");
    try {
      fs.writeFileSync(
        path.join(root, ".codebase-intel.json"),
        JSON.stringify({ taskCapsule: true, coherence: false })
      );
      telemetry.recordEvent(root, "coherence.agent_registered", { kind: "child" });
      telemetry.recordEvent(root, "freshness.fresh_hit", {});
      const run = (...args) => spawnSync(process.execPath, [bin, "telemetry", "--root", root, ...args], {
        cwd: root,
        encoding: "utf8",
        timeout: 30000,
        env: { ...process.env, SEXTANT_CAPSULE: "0", SEXTANT_COHERENCE: "0" },
      });

      const textResult = run();
      assert.equal(textResult.status, 0, textResult.stderr);
      assert.doesNotMatch(textResult.stdout, /coherence\.|Multi-agent coherence/);
      assert.match(textResult.stdout, /freshness\.fresh_hit/);

      const jsonResult = run("--json");
      assert.equal(jsonResult.status, 0, jsonResult.stderr);
      const parsed = JSON.parse(jsonResult.stdout);
      assert.equal(parsed.eventCount, 1);
      assert.equal(parsed.byName["coherence.agent_registered"], undefined);

      const tailResult = run("--tail", "20");
      assert.equal(tailResult.status, 0, tailResult.stderr);
      assert.doesNotMatch(tailResult.stdout, /coherence\./);
      assert.match(tailResult.stdout, /freshness\.fresh_hit/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("telemetry CLI: Phase F factual review", () => {
  it("records only known, bounded changed/invalidated claim reviews", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sx-telemetry-review-"));
    const bin = path.resolve(__dirname, "..", "bin", "intel.js");
    const incidentId = "cincident_000000000000000000000123";
    try {
      fs.writeFileSync(
        path.join(root, ".codebase-intel.json"),
        JSON.stringify({ capsule: true, coherence: true })
      );
      // A repeated incident may first appear on a boundary whose bounded sample
      // contains no claim rows. Review capacity must use the best retained
      // evidence across all joined analyses, not whichever row appears first.
      telemetry.recordEvent(root, "coherence.report", {
        schemaVersion: 1,
        stage: "analysis",
        incidentId,
        taskKey: "ctask_000000000000000000000123",
        changed: 1,
        invalidated: 1,
        overlapPairs: 3,
        findingSample: JSON.stringify([{ kind: "overlap", path: "src/c.js" }]),
      });
      telemetry.recordEvent(root, "coherence.report", {
        schemaVersion: 1,
        stage: "analysis",
        incidentId,
        taskKey: "ctask_000000000000000000000123",
        changed: 1,
        invalidated: 1,
        overlapPairs: 3,
        findingSample: JSON.stringify([
          { kind: "changed", path: "src/a.js" },
          { kind: "invalidated", path: "src/b.js" },
          { kind: "overlap", path: "src/c.js" },
        ]),
      });
      const run = (...args) => spawnSync(
        process.execPath,
        [bin, "telemetry", "--root", root, ...args],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 30000,
          env: { ...process.env, SEXTANT_CAPSULE: "1", SEXTANT_COHERENCE: "1" },
        }
      );
      const accepted = run(
        "--review", incidentId,
        "--verdict", "accurate_useful",
        "--reviewed-findings", "2"
      );
      assert.equal(accepted.status, 0, accepted.stderr);
      const feedback = telemetry.readEvents(root).find(
        (event) => event.name === "coherence.feedback"
      );
      assert.equal(feedback.incidentId, incidentId);
      assert.equal(feedback.reviewedFindings, 2);

      const inflated = run(
        "--review", incidentId,
        "--verdict", "accurate_useful",
        "--reviewed-findings", "3"
      );
      assert.notEqual(inflated.status, 0);
      assert.match(inflated.stderr, /exceeds the 2 changed\/invalidated/);
      assert.equal(
        telemetry.readEvents(root).filter((event) => event.name === "coherence.feedback").length,
        1
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// TURN-LEVEL OUTCOME METRIC (docs/033 Tier 1 #1 and #3)
//
// openPrecision divides by every file touched after an injection, so it tracks
// SESSION SHAPE, not retrieval quality: it fell 34.4% -> 1.6% while the
// surfaced-set size stayed flat and opens/turn rose 3.4 -> 28.4. The turn-level
// rate must be invariant to that. These tests lock the invariance and the
// randomization-unit gate.
// ---------------------------------------------------------------------------

// ts is required by printSummary's observation-window header; turn is the
// injected-set identity the hook stamps.
let _seq = 0;
const hit = (turn, arm = "armed") => ({ name: "retrieval.path_hit", source: "text_only", tool: "Read", arm, turn, ts: 1_700_000_000_000 + _seq++ });
const miss = (turn, arm = "armed") => ({ name: "retrieval.path_miss", tool: "Read", arm, turn, ts: 1_700_000_000_000 + _seq++ });

describe("summarize: turn-level outcome (docs/033)", () => {
  it("turn hit-rate is invariant to opens-per-turn; open-precision is not", () => {
    // Same OUTCOME both ways: 2 turns, each with exactly one surfaced-file open.
    // Only the volume of unrelated opens differs.
    const lean = [hit(1), miss(1), hit(2), miss(2)];
    const heavy = [hit(1), ...Array.from({ length: 27 }, () => miss(1)),
                   hit(2), ...Array.from({ length: 27 }, () => miss(2))];

    const a = summarize(lean).retrieval;
    const b = summarize(heavy).retrieval;

    assert.equal(a.turnsScored, 2);
    assert.equal(b.turnsScored, 2);
    assert.equal(a.turnHitRate, 1);
    assert.equal(b.turnHitRate, 1, "turn hit-rate must not move with session shape");

    // The metric this replaces collapses on the same data.
    assert.equal(a.openPrecision, 0.5);
    assert.ok(b.openPrecision < 0.04, `open-precision collapsed to ${b.openPrecision}`);
  });

  it("counts a turn as a hit once, however many surfaced files it opened", () => {
    const r = summarize([hit(1), hit(1), hit(1), miss(2)]).retrieval;
    assert.equal(r.turnsScored, 2);
    assert.equal(r.turnsWithHit, 1);
    assert.equal(r.turnHitRate, 0.5);
  });

  it("median first-touch rank is the position of the first hit within the turn", () => {
    // turn 1: miss, miss, hit -> rank 3.   turn 2: hit -> rank 1.   median of [1,3] = 1
    const r = summarize([miss(1), miss(1), hit(1), hit(2)]).retrieval;
    assert.equal(r.medianFirstTouchRank, 1);
    // turn 3 pushes the median up to 3
    const r2 = summarize([miss(1), miss(1), hit(1), hit(2), miss(3), miss(3), hit(3)]).retrieval;
    assert.equal(r2.medianFirstTouchRank, 3);
  });

  it("excludes pre-stamp events from the turn rate instead of folding them in", () => {
    const legacy = [{ name: "retrieval.path_hit", source: "text_only", tool: "Read", arm: "armed" },
                    { name: "retrieval.path_miss", tool: "Read", arm: "armed" }];
    const r = summarize([...legacy, hit(7), miss(7)]).retrieval;
    assert.equal(r.turnUnscoredOpens, 2);
    assert.equal(r.turnsScored, 1, "legacy opens must not invent a turn bucket");
    assert.equal(r.turnHitRate, 1);
    // The per-open view still counts everything, so the two views stay reconcilable.
    assert.equal(r.pathHits + r.pathMisses, 4);
  });

  it("computes the benefit delta per TURN — the unit the arm randomizes at", () => {
    // armed: 2 of 2 turns hit.  holdback: 0 of 2 turns hit.  delta = +1.0
    const r = summarize([
      hit(1, "armed"), miss(1, "armed"),
      hit(2, "armed"), miss(2, "armed"),
      miss(3, "holdback"), miss(3, "holdback"),
      miss(4, "holdback"),
    ]).retrieval;
    assert.equal(r.turnCountsByArm.armed.turns, 2);
    assert.equal(r.turnCountsByArm.holdback.turns, 2);
    assert.equal(r.turnHitRateByArm.armed, 1);
    assert.equal(r.turnHitRateByArm.holdback, 0);
    assert.equal(r.turnBenefitDelta, 1);
  });

  it("keeps the turn delta DORMANT until both arms clear the turn floor", () => {
    // 40 armed turns vs 2 holdback turns: the per-OPEN gate would pass on volume
    // alone, but only 2 turns were ever randomized into holdback.
    const events = [];
    for (let t = 1; t <= 40; t++) events.push(hit(t, "armed"), miss(t, "armed"));
    events.push(miss(1001, "holdback"), miss(1002, "holdback"));
    const sum = summarize(events);
    assert.equal(sum.retrieval.turnCountsByArm.holdback.turns, 2);
    const text = printSummary("/tmp/x", sum);
    assert.match(text, /turn benefit delta: DORMANT/);
    assert.doesNotMatch(text, /TURN BENEFIT DELTA/);
  });

  it("renders the turn delta as a claim once both arms clear the floor", () => {
    const events = [];
    for (let t = 1; t <= 30; t++) events.push(hit(t, "armed"), miss(t, "armed"));
    for (let t = 101; t <= 130; t++) events.push(miss(t, "holdback"));
    const text = printSummary("/tmp/x", summarize(events));
    assert.match(text, /TURN BENEFIT DELTA \(armed − holdback\): 100\.0 pts/);
  });

  it("leads the rendered outcome section with the turn rate", () => {
    const text = printSummary("/tmp/x", summarize([hit(1), miss(1)]));
    const turnAt = text.indexOf("turn hit-rate:");
    const openAt = text.indexOf("open-precision:");
    assert.ok(turnAt > -1 && openAt > turnAt, "turn hit-rate must precede open-precision");
    assert.match(text, /session-shape sensitive/);
  });

  // docs/033 Tier 3 — three defects found auditing what Tier 1 shipped.

  it("never graduates the per-OPEN delta on opens alone (turns are the unit)", () => {
    // Exactly ONE randomized turn per arm, but 40 correlated opens in each.
    // The opens floor (30) clears; the turn floor (30) does not. Before this
    // gate the surface printed a DORMANT turn line and an ALL-CAPS causal
    // per-open claim two lines apart — the very error docs/033 §4 named.
    const events = [];
    for (let i = 0; i < 20; i++) events.push(hit(1, "armed"));
    for (let i = 0; i < 20; i++) events.push(miss(1, "armed"));
    for (let i = 0; i < 40; i++) events.push(miss(2, "holdback"));
    const sum = summarize(events);
    assert.equal(sum.retrieval.armCounts.armed.scored, 40);
    assert.equal(sum.retrieval.armCounts.holdback.scored, 40);
    assert.equal(sum.retrieval.turnCountsByArm.armed.turns, 1);
    const text = printSummary("/tmp/x", sum);
    assert.doesNotMatch(
      text,
      /BENEFIT DELTA \(armed − holdback\)/,
      "a causal claim must not graduate on 1 randomized turn per arm"
    );
    assert.match(text, /turns are the randomization unit/);
  });

  it("shows the correct-unit accrual at zero rather than suppressing it", () => {
    // The live-repo shape: armed turns are stamped, but every holdback open
    // predates the stamp, so holdbackTurns === 0. Suppressing the turn-arm
    // block here left only the per-OPEN line ("holdback n=40 ... need >=30"),
    // which reads as most-of-the-way-there while the canonical unit is at 0.
    const events = [];
    for (let t = 1; t <= 5; t++) events.push(hit(t, "armed"), miss(t, "armed"));
    for (let i = 0; i < 40; i++) {
      events.push({ name: "retrieval.path_miss", tool: "Read", arm: "holdback", ts: 1_700_000_100_000 + i });
    }
    const sum = summarize(events);
    assert.equal((sum.retrieval.turnCountsByArm.holdback || {}).turns, undefined);
    const text = printSummary("/tmp/x", sum);
    assert.match(text, /at the randomization unit/, "the turn-arm block must render");
    assert.match(text, /holdback\s+turn hit-rate n\/a\s+\(0\/0 turns\)/);
    assert.match(text, /turn benefit delta: DORMANT \(accruing\) — holdback 0 turns/);
  });

  it("stays silent about arms on a holdback-disabled install", () => {
    const text = printSummary("/tmp/x", summarize([hit(1), miss(1), hit(2)]));
    assert.doesNotMatch(text, /at the randomization unit/);
  });

  it("refuses to call a delta causal when its 95% CI spans zero", () => {
    // 30 turns per arm — the accrual floor — at 18 vs 12 hit turns. The point
    // estimate is +20 pts, which reads like a win; the interval is roughly
    // [-5, +42], spanning both zero and harm. HOLDBACK_MIN_TURNS is an accrual
    // floor, not statistical power: at n=30/arm only effects near +33 pts are
    // resolvable, so a bare point estimate here would be the same overclaim
    // docs/033 §4 killed at the open level.
    const events = [];
    for (let t = 1; t <= 18; t++) events.push(hit(t, "armed"));
    for (let t = 19; t <= 30; t++) events.push(miss(t, "armed"));
    for (let t = 101; t <= 112; t++) events.push(hit(t, "holdback"));
    for (let t = 113; t <= 130; t++) events.push(miss(t, "holdback"));
    const sum = summarize(events);
    assert.equal(sum.retrieval.turnCountsByArm.armed.turns, 30);
    assert.equal(sum.retrieval.turnCountsByArm.holdback.turns, 30);
    const text = printSummary("/tmp/x", sum);
    assert.match(text, /SPANS ZERO, directional only/);
    assert.doesNotMatch(
      text,
      /TURN BENEFIT DELTA/,
      "an interval that spans zero must not be printed as the causal lift"
    );
  });

  it("prints the causal turn delta with its interval when the CI excludes zero", () => {
    const events = [];
    for (let t = 1; t <= 30; t++) events.push(hit(t, "armed"));
    for (let t = 101; t <= 130; t++) events.push(miss(t, "holdback"));
    const text = printSummary("/tmp/x", summarize(events));
    assert.match(text, /TURN BENEFIT DELTA \(armed − holdback\): 100\.0 pts, 95% CI \[/);
    assert.doesNotMatch(text, /SPANS ZERO/);
  });
});
