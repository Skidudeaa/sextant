"use strict";

// Focused Phase-F overlap experiment integration. These tests cross the real
// hook process boundary so they prove rendering policy, telemetry joins, and
// the per-session outcome window are wired together rather than merely testing
// the experiment state helper in isolation.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const coherence = require("../lib/coherence");
const experiment = require("../lib/coherence-experiment");
const fileMutex = require("../lib/file-mutex");
const claims = require("../lib/claims");
const telemetry = require("../lib/telemetry");

const BIN = path.resolve(__dirname, "..", "bin", "intel.js");

function hookEnv(extra = {}) {
  return {
    ...process.env,
    SEXTANT_CAPSULE: "1",
    SEXTANT_COHERENCE: "1",
    SEXTANT_COHERENCE_HOLDBACK_PCT: "0",
    SEXTANT_COHERENCE_HOLDBACK_FORCE: "",
    SEXTANT_HOLDBACK_PCT: "0",
    SEXTANT_HOLDBACK_FORCE: "",
    SEXTANT_SYNC_RESCAN: "0",
    ...extra,
  };
}

function runHook(root, name, payload, extraEnv = {}) {
  return spawnSync(process.execPath, [BIN, "hook", name], {
    cwd: root,
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 20_000,
    env: hookEnv(extraEnv),
  });
}

function emptyWorkset(sharedPath) {
  return {
    primary: [{ path: sharedPath }],
    support: [],
    witnesses: [],
    hazards: [],
    unknowns: [],
  };
}

function buildFixture(suffix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sx-coherence-exp-${suffix}-`));
  fs.mkdirSync(path.join(root, ".planning", "intel"), { recursive: true });
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });

  const sessionId = `experiment-session-${suffix}`;
  const taskId = `task_experiment_${suffix}`;
  const toolUseId = `tool-experiment-${suffix}`;
  const sharedPath = "lib/shared.js";
  const changedPath = "lib/changed.js";
  fs.writeFileSync(path.join(root, sharedPath), "module.exports = 'shared';\n");
  fs.writeFileSync(path.join(root, changedPath), "module.exports = 'before';\n");

  const servedClaims = claims.mintClaims(root, [{
    path: changedPath,
    source: "text_only",
    line: 1,
  }]);
  assert.equal(servedClaims.length, 1, "fixture must mint one historical claim");
  fs.writeFileSync(path.join(root, changedPath), "module.exports = 'after';\n");

  const parentKey = coherence.parentAgentKey(sessionId);
  const childKey = coherence.childAgentKey(parentKey, toolUseId);
  const now = Date.now();
  assert.ok(coherence.writeSnapshot(root, coherence.buildSnapshot({
    taskId,
    agentKey: parentKey,
    kind: "parent",
    state: "served",
    createdAt: now - 20,
    repo: {},
    intent: { text: "parent work" },
    workset: emptyWorkset(sharedPath),
    servedClaims: [],
    blockHash: `parent-${suffix}`,
  })));
  assert.ok(coherence.writeSnapshot(root, coherence.buildSnapshot({
    taskId,
    agentKey: childKey,
    parentAgentKey: parentKey,
    spawnToolUseId: toolUseId,
    kind: "child",
    agentType: "Explore",
    state: "spawn_prepared",
    createdAt: now - 10,
    repo: {},
    intent: { text: "child work" },
    workset: emptyWorkset(sharedPath),
    servedClaims,
    blockHash: `child-${suffix}`,
  })));

  return { root, sessionId, taskId, toolUseId, sharedPath, changedPath };
}

function runReturn(fixture, arm, extraEnv = {}) {
  return runHook(fixture.root, "posttooluse", {
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: fixture.toolUseId,
    tool_input: { prompt: "child work", subagent_type: "Explore" },
    session_id: fixture.sessionId,
    _coherenceHoldbackForce: arm,
  }, extraEnv);
}

function additionalContext(result) {
  assert.equal(result.status, 0, result.stderr || "hook must exit zero");
  assert.ok(result.stdout, "expected a structured PostToolUse response");
  return JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
}

function eventOf(events, name, predicate = () => true) {
  return events.find((event) => event.name === name && predicate(event));
}

function assertJoinedTelemetry(events, arm) {
  const analysis = eventOf(events, "coherence.report", (event) =>
    event.schemaVersion === 1 && event.stage === "analysis" && event.surface === "tool_return"
  );
  const assigned = eventOf(events, "coherence.experiment.assigned", (event) => event.arm === arm);
  const opportunity = eventOf(events, "coherence.overlap.opportunity", (event) => event.arm === arm);
  const opened = eventOf(events, "coherence.experiment.window_opened", (event) => event.arm === arm);
  assert.ok(analysis, "schema-v1 report analysis is the experiment denominator");
  assert.ok(assigned, "sticky arm assignment must be observable");
  assert.ok(opportunity, "eligible overlap opportunity must be observable");
  assert.ok(opened, "the bounded outcome window must open");
  assert.equal(analysis.taskKey, assigned.taskKey);
  assert.equal(analysis.taskKey, opportunity.taskKey);
  assert.equal(analysis.taskKey, opened.taskKey);
  assert.equal(opportunity.opportunityId, opened.opportunityId);
  assert.equal(opportunity.incidentId, analysis.incidentId);
  return { analysis, assigned, opportunity, opened };
}

describe("Phase-F overlap-only hook experiment", () => {
  it("forced holdback suppresses only overlap, preserves a changed claim, and opens a control window", () => {
    const fixture = buildFixture("holdback");
    try {
      const result = runReturn(fixture, "holdback");
      const context = additionalContext(result);
      assert.match(context, /Claim prepared for recorded spawn changed/);
      assert.match(context, /lib\/changed\.js/);
      assert.doesNotMatch(context, /Recorded worksets share files/);
      assert.doesNotMatch(context, /lib\/shared\.js/);

      const events = telemetry.readEvents(fixture.root);
      const { analysis, opportunity } = assertJoinedTelemetry(events, "holdback");
      const withheld = eventOf(events, "coherence.overlap.withheld");
      const holdback = eventOf(events, "coherence.report", (event) => event.stage === "holdback");
      const delivery = eventOf(events, "coherence.report", (event) => event.stage === "delivery");
      assert.ok(withheld, "control exposure must be explicitly labeled withheld");
      assert.ok(holdback, "intentional overlap holdback must resolve the delivery denominator");
      assert.equal(withheld.opportunityId, opportunity.opportunityId);
      assert.equal(holdback.schemaVersion, 1);
      assert.equal(holdback.incidentId, analysis.incidentId);
      assert.equal(holdback.heldbackOverlapPairs, 1);
      assert.equal(holdback.heldbackChanged, 0);
      assert.equal(holdback.heldbackInvalidated, 0);
      assert.equal(delivery.deliveredChanged, 1, "claim retraction still crossed the output boundary");
      assert.equal(delivery.deliveredOverlapPairs, 0, "only overlap rows are withheld");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps the original holdback sealed when the same task opportunity is deduped", () => {
    const fixture = buildFixture("holdback-dedupe");
    try {
      const first = additionalContext(runReturn(fixture, "holdback"));
      assert.doesNotMatch(first, /Recorded worksets share files/);

      const retry = additionalContext(runReturn(fixture, "holdback"));
      assert.doesNotMatch(
        retry,
        /Recorded worksets share files/,
        "a deduped retry must not leak control context while the original window is active"
      );
      const events = telemetry.readEvents(fixture.root);
      const deduped = eventOf(events, "coherence.experiment.window_deduped");
      assert.ok(deduped);
      assert.equal(deduped.dedupeReason, "exact_opportunity");
      assert.equal(
        events.filter((event) => event.name === "coherence.overlap.opportunity").length,
        1
      );
      assert.equal(
        events.filter((event) => event.name === "coherence.overlap.withheld").length,
        1
      );
      assert.equal(
        events.filter((event) =>
          event.name === "coherence.report" && event.stage === "holdback"
        ).length,
        2,
        "each suppressed output boundary is resolved without duplicating experiment compliance"
      );
      assert.equal(deduped.activeWindow, true);
      assert.equal(deduped.activeArm, "holdback");
      assert.ok(deduped.enrolledOpportunityId);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("forced armed emits overlap, records exposure after delivery, and scores a blind target mutation", () => {
    const fixture = buildFixture("armed");
    try {
      const result = runReturn(fixture, "armed");
      const context = additionalContext(result);
      assert.match(context, /Claim prepared for recorded spawn changed/);
      assert.match(context, /Recorded worksets share files/);
      assert.match(context, /lib\/shared\.js/);

      let events = telemetry.readEvents(fixture.root);
      const { analysis, opportunity } = assertJoinedTelemetry(events, "armed");
      const exposed = eventOf(events, "coherence.overlap.exposed");
      const deliveryIndex = events.findIndex((event) =>
        event.name === "coherence.report" && event.stage === "delivery" &&
        event.incidentId === analysis.incidentId
      );
      const exposedIndex = events.findIndex((event) =>
        event.name === "coherence.overlap.exposed" &&
        event.opportunityId === opportunity.opportunityId
      );
      const openedIndex = events.findIndex((event) =>
        event.name === "coherence.experiment.window_opened" &&
        event.opportunityId === opportunity.opportunityId
      );
      const opportunityIndex = events.findIndex((event) =>
        event.name === "coherence.overlap.opportunity" &&
        event.opportunityId === opportunity.opportunityId
      );
      assert.ok(exposed, "armed overlap must be labeled exposed");
      assert.equal(exposed.taskKey, analysis.taskKey);
      assert.ok(deliveryIndex >= 0 && exposedIndex > deliveryIndex,
        "exposure telemetry must follow the delivered report boundary");
      assert.ok(openedIndex > opportunityIndex && openedIndex < deliveryIndex,
        "both arms must enroll at analysis time, before output can select the cohort");

      const mutation = runHook(fixture.root, "posttooluse", {
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: {
          file_path: path.join(fixture.root, fixture.sharedPath),
          old_string: "shared",
          new_string: "changed",
        },
        session_id: fixture.sessionId,
      });
      assert.equal(mutation.status, 0, mutation.stderr);
      events = telemetry.readEvents(fixture.root);
      assert.equal(
        events.some((event) => event.name === "coherence.experiment.touch_scored"),
        false,
        "intermediate touches stay in bounded state instead of consuming telemetry retention"
      );
      const state = JSON.parse(fs.readFileSync(
        experiment.experimentStatePath(fixture.root, fixture.sessionId),
        "utf8"
      ));
      const active = state.windows.find(
        (window) => window.opportunityId === opportunity.opportunityId
      );
      assert.ok(active, "the exact-path touch must update the active outcome window");
      assert.equal(active.taskKey, analysis.taskKey);
      assert.equal(active.targetMutation, true);
      assert.equal(active.targetRead, false);
      assert.equal(active.blindTargetMutation, true);
      assert.equal(active.firstTargetRank, 1);
      assert.equal(active.totalTouches, 1);

      // The next UserPromptSubmit is the pre-registered end of the bounded
      // outcome window. A PATH shim prevents the fixture's no-scan-record
      // freshness path from launching a real detached rescan.
      const shim = fs.mkdtempSync(path.join(os.tmpdir(), "sx-coherence-exp-shim-"));
      try {
        const executable = path.join(shim, "sextant");
        fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n");
        fs.chmodSync(executable, 0o755);
        const prompt = runHook(fixture.root, "refresh", {
          hook_event_name: "UserPromptSubmit",
          prompt: "continue",
          session_id: fixture.sessionId,
        }, { PATH: shim + path.delimiter + process.env.PATH });
        assert.equal(prompt.status, 0, prompt.stderr);
      } finally {
        fs.rmSync(shim, { recursive: true, force: true });
      }
      events = telemetry.readEvents(fixture.root);
      const closed = eventOf(events, "coherence.experiment.window_closed", (event) =>
        event.opportunityId === opportunity.opportunityId
      );
      assert.ok(closed, "next prompt must close the prior outcome window");
      assert.equal(closed.closeReason, "next_prompt");
      assert.equal(closed.blindTargetMutation, true);
      assert.equal(closed.totalTouches, 1);
      assert.equal(closed.taskKey, analysis.taskKey);
      assert.equal(experiment.hasActiveExposure(fixture.root, fixture.sessionId), false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("persists an integrity stop when an active file-touch window cannot be locked", () => {
    const fixture = buildFixture("touch-lock-failure");
    let lock = null;
    try {
      additionalContext(runReturn(fixture, "armed"));
      lock = fileMutex.acquireFileMutex(
        experiment.experimentLockPath(fixture.root, fixture.sessionId),
        { attempts: 25, waitMs: 2, staleMs: 60_000 }
      );
      assert.ok(lock);

      const mutation = runHook(fixture.root, "posttooluse", {
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: {
          file_path: path.join(fixture.root, fixture.sharedPath),
          old_string: "shared",
          new_string: "changed",
        },
        session_id: fixture.sessionId,
      });
      assert.equal(mutation.status, 0, mutation.stderr);

      const failure = eventOf(
        telemetry.readEvents(fixture.root),
        experiment.EVENT_OBSERVATION_FAILED
      );
      assert.ok(failure, "the hook must persist observation loss instead of a negative outcome");
      assert.equal(failure.reason, "lock_unavailable");
      assert.equal(failure.operation, "score_touch");
      assert.ok(Number.isFinite(failure.durationMs));
    } finally {
      fileMutex.releaseFileMutex(lock);
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("records failed report-analysis attempts on both parent-visible surfaces", () => {
    const fixture = buildFixture("analysis-failure");
    const preloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "sx-coherence-analysis-failure-"));
    const shim = fs.mkdtempSync(path.join(os.tmpdir(), "sx-coherence-analysis-shim-"));
    try {
      const preload = path.join(preloadDir, "throw-analysis.js");
      const coherencePath = path.resolve(__dirname, "..", "lib", "coherence.js");
      fs.writeFileSync(
        preload,
        [
          `const coherence = require(${JSON.stringify(coherencePath)});`,
          `coherence.analyzeCoherence = () => { throw new Error("synthetic analysis failure"); };`,
        ].join("\n")
      );
      const executable = path.join(shim, "sextant");
      fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(executable, 0o755);
      const env = {
        NODE_OPTIONS: `--require=${preload}`,
        PATH: shim + path.delimiter + process.env.PATH,
      };

      const prompt = runHook(fixture.root, "refresh", {
        hook_event_name: "UserPromptSubmit",
        prompt: "continue",
        session_id: fixture.sessionId,
      }, env);
      assert.equal(prompt.status, 0, prompt.stderr);

      const returned = runReturn(fixture, "armed", env);
      assert.equal(returned.status, 0, returned.stderr);

      const failures = telemetry.readEvents(fixture.root).filter((event) =>
        event.name === "coherence.report" && event.stage === "analysis" &&
        event.outcome === "failed"
      );
      assert.deepEqual(
        [...new Set(failures.map((event) => event.surface))].sort(),
        ["parent_prompt", "tool_return"]
      );
      for (const failure of failures) {
        assert.equal(failure.schemaVersion, 1);
        assert.equal(failure.reason, "analysis_exception");
        assert.match(failure.boundaryId, /^cboundary_[a-f0-9]{32}$/);
        assert.match(failure.taskKey, /^ctask_[a-f0-9]{24}$/);
        assert.equal(failure.findingSample, "[]");
      }
    } finally {
      fs.rmSync(preloadDir, { recursive: true, force: true });
      fs.rmSync(shim, { recursive: true, force: true });
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
