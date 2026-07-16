"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const M = require("../lib/coherence-metrics");

function claim(path, symbol, id) {
  return { id, subject: { path, symbol } };
}

function result(overrides = {}) {
  return {
    taskId: "provider/task/contains-sensitive-id",
    currentAgentKey: "parent_opaque",
    snapshotCount: 3,
    agents: [
      { agentKey: "child_b" },
      { agentKey: "parent_opaque" },
      { agentKey: "child_a" },
    ],
    agentClaims: [
      {
        agentKey: "parent_opaque",
        unchanged: [],
        changed: [{ claim: claim("local.js", "local", "local-1"), from: "L1", to: "L2" }],
        invalidated: [],
        unknown: [],
      },
      {
        agentKey: "child_b",
        unchanged: [claim("steady.js", "steady", "steady-1")],
        changed: [{ claim: claim("b.js", "build", "claim-b"), from: "L1", to: "L8" }],
        invalidated: [],
        unknown: [{ claim: claim("racy.js", "race", "claim-racy"), reason: "file_unstable" }],
      },
      {
        agentKey: "child_a",
        unchanged: [claim("stable.js", "stable", "steady-2")],
        changed: [],
        invalidated: [{ claim: claim("gone.js", "gone", "claim-gone"), reason: "symbol_removed" }],
        unknown: [],
      },
    ],
    overlaps: [
      {
        agentA: "parent_opaque",
        agentB: "child_a",
        sharedPaths: ["z.js", "a.js"],
        sharedRegions: ["a.js#run"],
        sharedPathTotal: 4,
        sharedRegionTotal: 2,
      },
    ],
    overlapPairTotal: 1,
    totals: { unchanged: 2, changed: 2, invalidated: 1, unknown: 1 },
    ...overrides,
  };
}

function assertFlat(payload) {
  for (const [key, value] of Object.entries(payload)) {
    assert.ok(
      value == null || ["string", "number", "boolean"].includes(typeof value),
      `${key} must be a flat scalar, got ${typeof value}`
    );
  }
}

describe("coherence metrics identity", () => {
  it("canonicalizes object keys deterministically and hashes raw task ids opaquely", () => {
    assert.equal(
      M.stableCanonicalize({ z: 1, a: { d: 4, b: 2 } }),
      M.stableCanonicalize({ a: { b: 2, d: 4 }, z: 1 })
    );
    const raw = "provider/task/contains-sensitive-id";
    const key = M.opaqueTaskKey(raw);
    assert.equal(key, M.opaqueTaskKey(raw));
    assert.notEqual(key, M.opaqueTaskKey("provider_task_contains-sensitive-id"));
    assert.match(key, /^ctask_[a-f0-9]{24}$/);
    assert.doesNotMatch(key, /provider|sensitive/);
    assert.equal(M.opaqueTaskKey(""), null);
  });

  it("creates random, telemetry-safe boundary ids", () => {
    const first = M.randomBoundaryId();
    const second = M.randomBoundaryId();
    assert.match(first, /^cboundary_[a-f0-9]{32}$/);
    assert.match(second, /^cboundary_[a-f0-9]{32}$/);
    assert.notEqual(first, second);
  });

  it("uses one canonical incident id across surfaces and input ordering", () => {
    const base = result();
    const reversed = result({
      agents: [...base.agents].reverse(),
      agentClaims: [...base.agentClaims].reverse().map((group) => ({ ...group })),
      overlaps: base.overlaps.map((overlap) => ({
        ...overlap,
        agentA: overlap.agentB,
        agentB: overlap.agentA,
        sharedPaths: [...overlap.sharedPaths].reverse(),
      })),
    });
    const analysis = M.buildAnalysisPayload(base, { surface: "parent_prompt" });
    const delivery = M.buildDeliveryPayload(reversed, {
      changed: 1,
      invalidated: 1,
      overlapPairs: 1,
    }, { surface: "tool_return" });
    assert.match(analysis.incidentId, /^cincident_[a-f0-9]{24}$/);
    assert.equal(analysis.incidentId, delivery.incidentId);
    assert.equal(analysis.taskKey, delivery.taskKey);
    assert.notEqual(analysis.surface, delivery.surface);
  });

  it("changes the incident id for a distinct report finding set", () => {
    const base = result();
    const changed = result({
      agentClaims: base.agentClaims.map((group) => group.agentKey === "child_b"
        ? {
            ...group,
            changed: [{ claim: claim("different.js", "build", "claim-b"), from: "L1", to: "L8" }],
          }
        : group),
    });
    assert.notEqual(M.reportIncidentId(base), M.reportIncidentId(changed));
  });

  it("keeps content fingerprints as evidence without putting them in incident identity", () => {
    const fingerprinted = (servedFileHash, observedFileHash, observedKind, from = "L1") => {
      const base = result();
      return result({
        agentClaims: base.agentClaims.map((group) => group.agentKey === "child_b"
          ? {
              ...group,
              changed: group.changed.map((item) => ({
                ...item,
                from,
                claim: { ...item.claim, fileHash: servedFileHash },
                observedFileHash,
                observedKind,
              })),
            }
          : group),
      });
    };
    const first = fingerprinted("served-a", "observed-a", "file");
    const hashOnlyChange = fingerprinted("served-b", "observed-b", "symbol");
    const semanticChange = fingerprinted("served-b", "observed-b", "symbol", "L2");
    assert.equal(M.reportIncidentId(first), M.reportIncidentId(hashOnlyChange));
    assert.notEqual(M.reportIncidentId(first), M.reportIncidentId(semanticChange));
    assert.match(M.boundedFactualSample(first).findingSample, /served-a/);
    assert.match(M.boundedFactualSample(first).findingSample, /observed-a/);
  });

  it("filters current-agent claim changes from cross-agent incident identity", () => {
    const base = result();
    const differentLocalFinding = result({
      agentClaims: base.agentClaims.map((group) => group.agentKey === "parent_opaque"
        ? {
            ...group,
            changed: [{ claim: claim("another-local.js", "mine", "local-2"), from: "L9", to: "L20" }],
          }
        : group),
    });
    assert.equal(M.reportIncidentId(base), M.reportIncidentId(differentLocalFinding));
    assert.doesNotMatch(M.boundedFactualSample(base).findingSample, /local\.js/);
  });
});

describe("coherence metrics analysis", () => {
  it("builds a flat failed-attempt denominator without inventing findings", () => {
    const payload = M.buildFailedAnalysisPayload({
      taskId: "provider/private-task",
      boundaryId: "cboundary_test",
      surface: "tool_return",
    });
    assertFlat(payload);
    assert.match(payload.taskKey, /^ctask_[a-f0-9]{24}$/);
    assert.equal(payload.boundaryId, "cboundary_test");
    assert.equal(payload.surface, "tool_return");
    assert.equal(payload.reportFindings, 0);
    assert.equal(payload.incidentId, null);
    assert.equal(payload.findingSample, "[]");
  });

  it("counts cross-agent claim outcomes, unknowns, and overlap totals", () => {
    assert.deepEqual(M.analysisCounts(result()), {
      snapshots: 3,
      agents: 3,
      crossAgents: 2,
      unchanged: 2,
      changed: 1,
      invalidated: 1,
      unknown: 1,
      overlapPairs: 1,
      overlapPairsObserved: 1,
      sharedPaths: 4,
      sharedRegions: 2,
      reportFindings: 3,
    });
  });

  it("falls back to top-level totals when detailed agent groups are absent", () => {
    assert.deepEqual(
      M.analysisCounts({
        snapshotCount: 4,
        totals: { unchanged: 7, changed: 3, invalidated: 2, unknown: 5 },
        overlapPairTotal: 9,
      }),
      {
        snapshots: 4,
        agents: 0,
        crossAgents: 0,
        unchanged: 7,
        changed: 3,
        invalidated: 2,
        unknown: 5,
        overlapPairs: 9,
        overlapPairsObserved: 0,
        sharedPaths: 0,
        sharedRegions: 0,
        reportFindings: 14,
      }
    );
  });

  it("bounds the factual sample by both item count and encoded characters", () => {
    const many = result({
      currentAgentKey: "parent_opaque",
      agentClaims: [{
        agentKey: "child_a",
        unchanged: [],
        invalidated: [],
        unknown: [],
        changed: Array.from({ length: 20 }, (_, i) => ({
          claim: claim(`src/${String(i).padStart(2, "0")}-${"x".repeat(40)}.js`, `fn${i}`, `id-${i}`),
          from: "L1",
          to: "L2",
        })),
      }],
      overlaps: [],
      overlapPairTotal: 0,
    });
    const byItems = M.boundedFactualSample(many, { maxItems: 3, maxChars: 2000 });
    assert.equal(byItems.findingSampleCount, 3);
    assert.equal(JSON.parse(byItems.findingSample).length, 3);
    assert.equal(byItems.findingSampleTruncated, true);

    const byChars = M.boundedFactualSample(many, { maxItems: 20, maxChars: 300 });
    assert.ok(byChars.findingSample.length <= 300);
    assert.ok(byChars.findingSampleCount < 20);
    assert.equal(byChars.findingSampleTruncated, true);
    assert.equal(
      byChars.findingSample,
      M.boundedFactualSample(many, { maxItems: 20, maxChars: 300 }).findingSample,
      "sample must be deterministic"
    );
  });
});

describe("coherence metrics flat event payloads", () => {
  it("builds flat analysis and delivery payloads with explicit coverage", () => {
    const analysis = M.buildAnalysisPayload(result(), {
      boundaryId: "cboundary_known",
      surface: "parent_prompt",
      maxItems: 2,
    });
    const delivery = M.buildDeliveryPayload(result(), {
      changed: 1,
      invalidated: 0,
      unknown: 0,
      overlapPairs: 1,
    }, {
      boundaryId: "cboundary_known",
      surface: "tool_return",
      maxItems: 2,
    });
    assertFlat(analysis);
    assertFlat(delivery);
    assert.equal(analysis.schemaVersion, 1);
    assert.equal(delivery.deliveredFindings, 2);
    assert.equal(delivery.deliveryComplete, false);
    assert.equal(delivery.incidentId, analysis.incidentId);
    assert.ok(!Object.hasOwn(analysis, "taskId"));
    assert.ok(!Object.hasOwn(delivery, "holdback"));
  });

  it("does not trust a raw value passed through the taskKey option", () => {
    const raw = "raw-task-key-that-must-not-leak";
    const payload = M.buildAnalysisPayload(result(), { taskKey: raw });
    assert.match(payload.taskKey, /^ctask_[a-f0-9]{24}$/);
    assert.doesNotMatch(JSON.stringify(payload), new RegExp(raw));
  });

  it("builds a flat lifecycle payload without retaining a raw task id", () => {
    const rawTaskId = "private runtime task id";
    const payload = M.buildLifecyclePayload({
      taskId: rawTaskId,
      boundaryId: "cboundary_shared",
      agentKey: "child_opaque",
      parentAgentKey: "parent_opaque",
      stage: "child_spawn",
      kind: "child",
      state: "spawn_prepared",
      outcome: "registered",
      reason: "ok",
      generation: 7,
      claims: 4,
      worksetPaths: 6,
      durationMs: 12,
    });
    assertFlat(payload);
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.boundaryId, "cboundary_shared");
    assert.equal(payload.agentKey, "child_opaque");
    assert.equal(payload.stage, "child_spawn");
    assert.equal(payload.generation, 7);
    assert.equal(payload.claims, 4);
    assert.equal(payload.worksetPaths, 6);
    assert.equal(payload.durationMs, 12);
    assert.ok(!Object.hasOwn(payload, "taskId"));
    assert.doesNotMatch(JSON.stringify(payload), new RegExp(rawTaskId));
    assert.ok(!Object.hasOwn(payload, "arm"));
  });
});
