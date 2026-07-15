"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, execFileSync } = require("child_process");
const { promisify } = require("util");

const C = require("../lib/coherence");
const claims = require("../lib/claims");

const execFileAsync = promisify(execFile);
const COHERENCE_MODULE = path.resolve(__dirname, "..", "lib", "coherence.js");
const DAY_MS = 24 * 60 * 60 * 1000;

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sx-coherence-"));
}

function emptyWorkset() {
  return { primary: [], support: [], witnesses: [], hazards: [], unknowns: [] };
}

function snapshot(overrides = {}) {
  return C.buildSnapshot({
    taskId: "task_1",
    agentKey: "parent_default",
    parentAgentKey: null,
    spawnToolUseId: null,
    kind: "parent",
    agentType: null,
    state: "served",
    createdAt: 1000,
    repo: { root: "/repo", head: "abc" },
    intent: { text: "test" },
    workset: emptyWorkset(),
    servedClaims: [],
    blockHash: "h1",
    ...overrides,
  });
}

function snapshotFiles(root) {
  const dir = path.join(root, ".planning", "intel");
  try {
    return fs.readdirSync(dir).filter((name) => name.startsWith(".agent-capsule.") && name.endsWith(".json"));
  } catch {
    return [];
  }
}

function contentionFiles(root, agentKey) {
  const dir = path.join(root, ".planning", "intel");
  try {
    return fs.readdirSync(dir).filter((name) =>
      name.startsWith(`.agent-capsule-contention.${agentKey}.`) && name.endsWith(".json")
    );
  } catch {
    return [];
  }
}

function initGitRoot(root) {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  fs.writeFileSync(path.join(root, "seed.js"), "module.exports = 1;\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd: root });
}

describe("coherence agent identity", () => {
  it("is independently default-off and still requires Task Capsule mode", () => {
    assert.equal(C.coherenceEnabled("/nonexistent", {}), false);
    assert.equal(C.coherenceEnabled("/nonexistent", { SEXTANT_COHERENCE: "1" }), false);
    assert.equal(
      C.coherenceEnabled("/nonexistent", { SEXTANT_CAPSULE: "1", SEXTANT_COHERENCE: "1" }),
      true
    );
    assert.equal(
      C.coherenceEnabled("/nonexistent", { SEXTANT_CAPSULE: "1", SEXTANT_COHERENCE: "0" }),
      false
    );
  });

  it("hashes raw parent ids before filename sanitization could collide", () => {
    const slash = C.parentAgentKey("session/a");
    const underscore = C.parentAgentKey("session_a");
    assert.ok(slash);
    assert.notEqual(slash, underscore);
    assert.equal(C.parentAgentKey("session/a"), slash, "same raw id must be stable");
    assert.match(slash, /^[A-Za-z0-9_-]+$/);
    assert.equal(C.parentAgentKey(""), null);
  });

  it("keys children by parent + raw tool-use id and has no guessed fallback", () => {
    const parent = C.parentAgentKey("session/a");
    const first = C.childAgentKey(parent, "tool/a");
    assert.ok(first);
    assert.equal(C.childAgentKey(parent, "tool/a"), first);
    assert.notEqual(first, C.childAgentKey(parent, "tool_a"));
    assert.notEqual(first, C.childAgentKey(C.parentAgentKey("other"), "tool/a"));
    assert.equal(C.childAgentKey(parent, ""), null);
    assert.equal(C.childAgentKey(parent, null), null);
    assert.equal(C.childAgentKey(null, "tool/a"), null);
  });

  it("builds a JSON-detached parent/child snapshot envelope", () => {
    const workset = { ...emptyWorkset(), primary: [{ path: "lib/a.js" }] };
    const child = snapshot({
      agentKey: "child_1",
      parentAgentKey: "parent_1",
      spawnToolUseId: "tool-1",
      kind: "child",
      agentType: "Explore",
      state: "spawn_prepared",
      workset,
    });
    workset.primary[0].path = "mutated-after-build.js";
    assert.equal(child.kind, "child");
    assert.equal(child.parentAgentKey, "parent_1");
    assert.equal(child.spawnToolUseId, "tool-1");
    assert.equal(child.agentType, "Explore");
    assert.equal(child.workset.primary[0].path, "lib/a.js");
  });
});

describe("coherence immutable snapshot storage", () => {
  it("returns the newest live generation per agent and ignores expired/malformed data", () => {
    const root = tempRoot();
    const now = 2_000_000_000;
    try {
      assert.ok(C.writeSnapshot(root, snapshot({ agentKey: "parent_a", createdAt: now - 500, blockHash: "old" })));
      assert.ok(C.writeSnapshot(root, snapshot({ agentKey: "parent_a", createdAt: now - 100, blockHash: "new" })));
      assert.ok(C.writeSnapshot(root, snapshot({ agentKey: "child_b", kind: "child", createdAt: now - 200 })));
      assert.ok(C.writeSnapshot(root, snapshot({ agentKey: "expired_c", createdAt: now - DAY_MS - 1 })));
      assert.ok(C.writeSnapshot(root, snapshot({ agentKey: "future_e", createdAt: now + 1 })));
      assert.ok(C.writeSnapshot(root, snapshot({ taskId: "other", agentKey: "other_d", createdAt: now - 50 })));

      const dir = path.join(root, ".planning", "intel");
      fs.writeFileSync(
        path.join(dir, `.agent-capsule.malformed_x.${now - 10}.bad.json`),
        "{not json"
      );
      fs.writeFileSync(
        path.join(dir, `.agent-capsule.filename_y.${now - 20}.bad.json`),
        JSON.stringify(snapshot({ agentKey: "different_key", createdAt: now - 20 }))
      );

      const listed = C.listSnapshots(root, { taskId: "task_1", nowMs: now });
      assert.deepEqual(listed.map((s) => s.agentKey), ["parent_a", "child_b"]);
      assert.equal(listed.find((s) => s.agentKey === "parent_a").blockHash, "new");
      assert.ok(!listed.some((s) => s.agentKey === "expired_c"));
      assert.ok(!listed.some((s) => s.agentKey === "future_e"));
      assert.ok(!listed.some((s) => s.agentKey === "malformed_x"));
      assert.equal(C.readAgentSnapshot(root, "parent_a", { nowMs: now }).blockHash, "new");
      assert.equal(C.readAgentSnapshot(root, "parent_a", { taskId: "other", nowMs: now }), null);
      assert.equal(C.readAgentSnapshot(root, "expired_c", { nowMs: now }), null);
      assert.equal(C.readAgentSnapshot(root, "future_e", { nowMs: now }), null);
      assert.equal(C.readAgentSnapshot(root, "malformed_x", { nowMs: now }), null);
      assert.equal(C.readAgentSnapshot(root, "filename_y", { nowMs: now }), null);
      assert.equal(C.readAgentSnapshot(root, "bad/key", { nowMs: now }), null);
      assert.deepEqual(
        C.listSnapshots(root, { taskId: "other", nowMs: now }).map((s) => s.agentKey),
        ["other_d"]
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("orders same-millisecond lifecycle snapshots by explicit generation", () => {
    const root = tempRoot();
    const now = 2_500_000_000;
    try {
      assert.ok(C.writeSnapshot(root, snapshot({
        agentKey: "child_same_tick",
        kind: "child",
        state: "spawn_prepared",
        generation: 1,
        createdAt: now,
      })));
      assert.ok(C.writeSnapshot(root, snapshot({
        agentKey: "child_same_tick",
        kind: "child",
        state: "tool_returned",
        generation: 2,
        createdAt: now,
      })));

      const exact = C.readAgentSnapshot(root, "child_same_tick", { nowMs: now });
      assert.equal(exact.state, "tool_returned");
      assert.equal(exact.generation, 2);
      const listed = C.listSnapshots(root, { taskId: "task_1", nowMs: now });
      assert.equal(listed[0].state, "tool_returned");
      assert.equal(listed[0].generation, 2);
      C.pruneSnapshots(root, { nowMs: now, maxStored: 1 });
      assert.equal(snapshotFiles(root).length, 1);
      assert.equal(
        C.readAgentSnapshot(root, "child_same_tick", { nowMs: now }).state,
        "tool_returned",
        "GC must use explicit generation when timestamps tie"
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("hard-caps the newest-per-agent result at 64", () => {
    const root = tempRoot();
    const now = 3_000_000_000;
    try {
      for (let i = 0; i < 70; i++) {
        const key = `agent_${String(i).padStart(2, "0")}`;
        assert.ok(C.writeSnapshot(root, snapshot({ agentKey: key, createdAt: now - i })));
      }
      const listed = C.listSnapshots(root, { taskId: "task_1", nowMs: now, max: 1000 });
      assert.equal(listed.length, 64);
      assert.equal(listed[0].agentKey, "agent_00");
      assert.ok(!listed.some((s) => s.agentKey === "agent_69"));
      assert.equal(
        C.readAgentSnapshot(root, "agent_69", { taskId: "task_1", nowMs: now }).agentKey,
        "agent_69",
        "an exact lifecycle join must not inherit the cross-agent reporting cap"
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps concurrent writes as separate immutable generations", async () => {
    const root = tempRoot();
    const snap = snapshot({ agentKey: "parallel_agent", createdAt: 4_000_000_000 });
    const script = [
      `const C = require(${JSON.stringify(COHERENCE_MODULE)});`,
      `const snapshot = ${JSON.stringify(snap)};`,
      `if (!C.writeSnapshot(${JSON.stringify(root)}, snapshot)) process.exit(2);`,
    ].join("\n");
    try {
      await Promise.all(
        Array.from({ length: 8 }, () =>
          execFileAsync(process.execPath, ["-e", script], { timeout: 30000 })
        )
      );
      assert.equal(snapshotFiles(root).length, 8, "no serve generation may overwrite another");
      const latest = C.listSnapshots(root, { nowMs: 4_000_000_001 });
      assert.equal(latest.length, 1, "readers select one newest generation per agent");
      assert.equal(latest[0].agentKey, "parallel_agent");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("terminally rejects divergent concurrent registrations and returns", async () => {
    const root = tempRoot();
    try {
      initGitRoot(root);
      const repo = require("../lib/freshness").captureCurrentState(root);
      const now = Date.now();
      const base = snapshot({
        agentKey: "child_atomic",
        kind: "child",
        state: "spawn_prepared",
        createdAt: now,
        repo,
        blockHash: "payload_a",
      });
      const divergent = snapshot({
        ...base,
        createdAt: now,
        blockHash: "payload_b",
      });
      const registerScript = (candidate) => [
        `const C = require(${JSON.stringify(COHERENCE_MODULE)});`,
        `const result = C.registerSpawnSnapshot(${JSON.stringify(root)}, ${JSON.stringify(candidate)});`,
        `if (!["written", "ambiguous", "withheld"].includes(result.status)) process.exit(2);`,
      ].join("\n");

      await Promise.all([
        execFileAsync(process.execPath, ["-e", registerScript(base)], { timeout: 30000 }),
        execFileAsync(process.execPath, ["-e", registerScript(divergent)], { timeout: 30000 }),
      ]);
      let exact = C.readAgentSnapshot(root, "child_atomic");
      assert.ok(!C.listSnapshots(root).some((entry) => entry.agentKey === "child_atomic"));
      if (contentionFiles(root, "child_atomic").length > 0) {
        assert.equal(exact, null, "contention poison must hide the older preparation");
        assert.equal(C.registerReturnSnapshot(root, "child_atomic").status, "withheld");
      } else {
        assert.equal(exact.state, "identity_ambiguous");
        assert.deepEqual(exact.servedClaims, []);
        assert.equal(C.registerReturnSnapshot(root, "child_atomic").status, "ambiguous");
        exact = C.readAgentSnapshot(root, "child_atomic");
        assert.equal(exact.state, "identity_ambiguous", "a return may not revive a rejected identity");
      }

      const racingBase = snapshot({
        ...base,
        agentKey: "child_return_race",
        blockHash: "race_a",
        createdAt: Date.now(),
      });
      assert.equal(C.registerSpawnSnapshot(root, racingBase).status, "written");
      const racingDivergent = snapshot({ ...racingBase, blockHash: "race_b" });
      const divergentScript = [
        `const C = require(${JSON.stringify(COHERENCE_MODULE)});`,
        `const result = C.registerSpawnSnapshot(${JSON.stringify(root)}, ${JSON.stringify(racingDivergent)});`,
        `if (!["ambiguous", "withheld"].includes(result.status)) process.exit(2);`,
      ].join("\n");
      const racingReturnScript = [
        `const C = require(${JSON.stringify(COHERENCE_MODULE)});`,
        `const result = C.registerReturnSnapshot(${JSON.stringify(root)}, "child_return_race");`,
        `if (!["written", "ambiguous", "withheld", "failed"].includes(result.status)) process.exit(2);`,
      ].join("\n");
      await Promise.all([
        execFileAsync(process.execPath, ["-e", divergentScript], { timeout: 30000 }),
        execFileAsync(process.execPath, ["-e", racingReturnScript], { timeout: 30000 }),
      ]);
      exact = C.readAgentSnapshot(root, "child_return_race");
      if (contentionFiles(root, "child_return_race").length > 0) {
        assert.equal(exact, null, "timed-out divergent registration must poison the older lifecycle");
      } else {
        assert.equal(
          exact.state,
          "identity_ambiguous",
          "a serialized divergent registration must leave a terminal ambiguity tombstone"
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("poisons older preparations when registration or suppression cannot acquire the state lock", async () => {
    const root = tempRoot();
    const registrationKey = "child_registration_contended";
    const suppressionKey = "child_suppression_contended";
    try {
      initGitRoot(root);
      const createdAt = Date.now();
      for (const agentKey of [registrationKey, suppressionKey]) {
        assert.ok(C.writeSnapshot(root, snapshot({
          agentKey,
          kind: "child",
          state: "spawn_prepared",
          createdAt,
          blockHash: `prepared_${agentKey}`,
        })));
      }

      const repo = require("../lib/freshness").captureCurrentState(root);
      const divergent = snapshot({
        agentKey: registrationKey,
        kind: "child",
        state: "spawn_prepared",
        createdAt: Date.now(),
        repo,
        blockHash: "divergent_registration",
      });
      const dir = path.join(root, ".planning", "intel");
      const registrationLock = path.join(dir, `.agent-capsule-state-lock.${registrationKey}`);
      const suppressionLock = path.join(dir, `.agent-capsule-state-lock.${suppressionKey}`);
      fs.writeFileSync(registrationLock, "held by deterministic test");
      fs.writeFileSync(suppressionLock, "held by deterministic test");

      const registrationScript = [
        `const C = require(${JSON.stringify(COHERENCE_MODULE)});`,
        `const result = C.registerSpawnSnapshot(${JSON.stringify(root)}, ${JSON.stringify(divergent)});`,
        `if (result.status !== "withheld") process.exit(2);`,
      ].join("\n");
      const suppressionScript = [
        `const C = require(${JSON.stringify(COHERENCE_MODULE)});`,
        `const result = C.suppressSpawnSnapshot(${JSON.stringify(root)}, ${JSON.stringify(suppressionKey)}, ${JSON.stringify(`prepared_${suppressionKey}`)});`,
        `if (result.status !== "withheld") process.exit(2);`,
      ].join("\n");

      await Promise.all([
        execFileAsync(process.execPath, ["-e", registrationScript], { timeout: 30000 }),
        execFileAsync(process.execPath, ["-e", suppressionScript], { timeout: 30000 }),
      ]);
      fs.rmSync(registrationLock, { force: true });
      fs.rmSync(suppressionLock, { force: true });

      for (const agentKey of [registrationKey, suppressionKey]) {
        assert.equal(contentionFiles(root, agentKey).length, 1);
        assert.equal(
          C.readAgentSnapshot(root, agentKey),
          null,
          "a poisoned older preparation must not remain directly joinable"
        );
        assert.ok(!C.listSnapshots(root).some((entry) => entry.agentKey === agentKey));
        assert.equal(
          C.registerReturnSnapshot(root, agentKey).status,
          "withheld",
          "a later return must consult contention poison"
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("prunes expired generations and enforces a hard storage cap", () => {
    const root = tempRoot();
    const now = 4_500_000_000;
    try {
      for (let i = 0; i < 5; i++) {
        assert.ok(C.writeSnapshot(root, snapshot({
          agentKey: `retained_${i}`,
          createdAt: now - i,
        })));
      }
      assert.ok(C.writeSnapshot(root, snapshot({
        agentKey: "expired",
        createdAt: now - DAY_MS - 1,
      })));
      const pruned = C.pruneSnapshots(root, { nowMs: now, maxStored: 3 });
      assert.equal(pruned.retained, 3);
      assert.ok(pruned.removed >= 3);
      const files = snapshotFiles(root);
      assert.equal(files.length, 3);
      assert.ok(files.every((name) => !name.includes(".expired.")));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("protects each agent's newest joinable generation before pruning history", () => {
    const root = tempRoot();
    const now = 4_600_000_000;
    try {
      assert.ok(C.writeSnapshot(root, snapshot({
        agentKey: "older_child",
        kind: "child",
        state: "spawn_prepared",
        createdAt: now - 100,
      })));
      for (let i = 0; i < 5; i++) {
        assert.ok(C.writeSnapshot(root, snapshot({
          agentKey: "busy_parent",
          createdAt: now - i,
          generation: i + 1,
        })));
      }
      C.pruneSnapshots(root, { nowMs: now, maxStored: 3 });
      assert.equal(snapshotFiles(root).length, 3);
      assert.equal(
        C.readAgentSnapshot(root, "older_child", { nowMs: now }).state,
        "spawn_prepared",
        "newer history from one peer must not evict another agent's only lifecycle join"
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("coherence per-agent claim analysis", () => {
  it("keeps identical claim ids isolated by agent and serve-time file hash", () => {
    const root = tempRoot();
    const now = 5_000_000_000;
    const file = path.join(root, "m.js");
    try {
      fs.writeFileSync(file, "first\n");
      const row = [{ path: "m.js", source: "text_only", line: 1 }];
      const oldClaims = claims.mintClaims(root, row, { nowMs: now - 300 });
      assert.ok(C.writeSnapshot(root, snapshot({
        agentKey: "agent_old_a", createdAt: now - 300, servedClaims: oldClaims,
      })));
      assert.ok(C.writeSnapshot(root, snapshot({
        agentKey: "agent_old_b", createdAt: now - 200, servedClaims: oldClaims,
      })));

      fs.writeFileSync(file, "second\n");
      const newClaims = claims.mintClaims(root, row, { nowMs: now - 100 });
      assert.equal(newClaims[0].id, oldClaims[0].id, "claim id deliberately stays the same");
      assert.notEqual(newClaims[0].fileHash, oldClaims[0].fileHash);
      assert.ok(C.writeSnapshot(root, snapshot({
        agentKey: "agent_new", createdAt: now - 100, servedClaims: newClaims,
      })));

      const result = C.analyzeCoherence(root, { taskId: "task_1", currentAgentKey: "agent_new", nowMs: now });
      const byAgent = new Map(result.agentClaims.map((entry) => [entry.agentKey, entry]));
      assert.equal(byAgent.get("agent_old_a").changed.length, 1);
      assert.equal(byAgent.get("agent_old_b").changed.length, 1);
      assert.equal(byAgent.get("agent_new").unchanged.length, 1);
      assert.equal(result.totals.changed, 2, "same claim id must not be globally de-duplicated");
      assert.equal(result.totals.unchanged, 1);
      assert.equal(byAgent.get("agent_new").isCurrent, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("coherence workset overlap", () => {
  it("restricts parent metadata to rendered rows and models child context as paths only", () => {
    const parent = C.visibleRoleWorkset({
      primary: [
        { path: "lib/shown.js", region: { id: "lib/shown.js#run", name: "run" } },
        { path: "lib/truncated.js", region: { id: "lib/truncated.js#hidden", name: "hidden" } },
      ],
      support: [{ path: "lib/support.js" }],
      witnesses: [], hazards: [], unknowns: [],
    }, [{ path: "lib/shown.js" }]);
    assert.deepEqual(parent.primary.map((entry) => entry.path), ["lib/shown.js"]);
    assert.deepEqual(parent.support, []);
    assert.equal(parent.primary[0].region.name, "run");

    const child = C.contextPathWorkset([
      { path: "lib/shown.js", source: "exported_symbol", region: { name: "hidden" } },
      { path: "lib/shown.js" },
    ]);
    assert.deepEqual(child.context, [{ path: "lib/shown.js" }]);
    assert.deepEqual(child.primary, []);
    const overlap = C.worksetOverlap(parent, child);
    assert.deepEqual(overlap.sharedPaths, ["lib/shown.js"]);
    assert.deepEqual(overlap.sharedRegions, [], "child path context must not invent a region");
  });

  it("uses primary/support/witness paths, exact region identity, and deterministic order", () => {
    const left = snapshot({
      workset: {
        primary: [
          { path: "src/b.js", region: { name: "beta", kind: "function" } },
          { path: "./src/a.js" },
        ],
        support: [{ path: "src/a.js" }],
        witnesses: [{ path: "test/x.test.js" }],
        hazards: ["src/hazard.js high fan-in (50)"],
        unknowns: ["src/unknown.js"],
      },
    });
    const right = snapshot({
      agentKey: "child_right",
      workset: {
        primary: [{ path: "src/a.js" }],
        support: [
          { path: "src/b.js", region: { name: "beta", kind: "scope" } },
          { path: "src/only-right.js" },
        ],
        witnesses: [{ path: "test/x.test.js" }],
        hazards: ["src/hazard.js high fan-in (50)"],
        unknowns: ["src/unknown.js"],
      },
    });

    assert.deepEqual(C.worksetOverlap(left, right), {
      sharedPaths: ["src/a.js", "src/b.js", "test/x.test.js"],
      sharedRegions: ["src/b.js#beta"],
      sharedPathTotal: 3,
      sharedRegionTotal: 1,
    });
  });

  it("caps large overlap lists without losing the true totals", () => {
    const entries = Array.from({ length: 60 }, (_, i) => ({
      path: `src/p${String(i).padStart(2, "0")}.js`,
      region: { name: `r${String(i).padStart(2, "0")}` },
    }));
    const overlap = C.worksetOverlap(
      { primary: [...entries], support: [], witnesses: [] },
      { primary: [], support: [...entries].reverse(), witnesses: [] }
    );
    assert.equal(overlap.sharedPathTotal, 60);
    assert.equal(overlap.sharedRegionTotal, 60);
    assert.equal(overlap.sharedPaths.length, 50);
    assert.equal(overlap.sharedRegions.length, 50);
    assert.equal(overlap.sharedPaths[0], "src/p00.js");
    assert.equal(overlap.sharedPaths[49], "src/p49.js");
  });

  it("sorts and caps pairwise overlap reports deterministically", () => {
    const root = tempRoot();
    const now = 6_000_000_000;
    try {
      for (let i = 0; i < 12; i++) {
        const agentKey = `agent_${String(i).padStart(2, "0")}`;
        assert.ok(C.writeSnapshot(root, snapshot({
          agentKey,
          createdAt: now - i,
          workset: { ...emptyWorkset(), primary: [{ path: "shared.js" }] },
        })));
      }
      const result = C.analyzeCoherence(root, { taskId: "task_1", currentAgentKey: "agent_00", nowMs: now });
      assert.equal(result.overlapPairTotal, 66);
      assert.equal(result.overlaps.length, 64);
      assert.deepEqual(
        [result.overlaps[0].agentA, result.overlaps[0].agentB],
        ["agent_00", "agent_01"]
      );
      assert.equal(result.overlaps[0].involvesCurrent, true);
      assert.deepEqual(result.overlaps[0].sharedPaths, ["shared.js"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("coherence factual rendering", () => {
  const result = {
    snapshotCount: 2,
    currentAgentKey: "parent_a",
    agentClaims: [
      {
        agentKey: "parent_a",
        invalidated: [{ claim: { subject: { path: "current.js" } }, reason: "file_removed" }],
        changed: [],
      },
      {
        agentKey: "child_b",
        invalidated: [{ claim: { subject: { path: "gone.js", symbol: "gone" } }, reason: "symbol_removed" }],
        changed: [{ claim: { subject: { path: "moved.js", symbol: "move" } }, from: "L1-3", to: "L4-6" }],
      },
    ],
    overlaps: [{
      agentA: "parent_a",
      agentB: "child_b",
      sharedPaths: ["lib/shared.js"],
      sharedRegions: ["lib/shared.js#build"],
    }],
  };

  it("states recorded overlap and invalidation without control or authorship language", () => {
    const text = C.renderCoherence(result, { maxChars: 2000 });
    assert.match(text, /Recorded agent capsules: 2/);
    assert.match(text, /Claim served no longer holds for child_b: gone\.js#gone/);
    assert.match(text, /Claim served changed for child_b: moved\.js#move/);
    assert.doesNotMatch(text, /current\.js/, "the current agent's local delta belongs to Phase C");
    assert.match(text, /Recorded worksets share files/);
    assert.match(text, /Recorded worksets share regions/);
    assert.doesNotMatch(text, /\b(active|conflict|locks?|locking|ownership|attribut(?:e|ed|ion))\b/i);
  });

  it("does not call a child claim served before or after its tool returns", () => {
    const prepared = {
      snapshotCount: 1,
      currentAgentKey: "parent",
      agentClaims: [{
        agentKey: "child",
        kind: "child",
        state: "spawn_prepared",
        invalidated: [{ claim: { subject: { path: "gone.js" } }, reason: "file_removed" }],
        changed: [],
      }],
      overlaps: [],
    };
    const text = C.renderCoherence(prepared, { maxChars: 1000 });
    assert.match(text, /Claim prepared for recorded spawn no longer holds/);
    assert.doesNotMatch(text, /Claim served/);
    prepared.agentClaims[0].state = "tool_returned";
    const returned = C.renderCoherence(prepared, { maxChars: 1000 });
    assert.match(returned, /Claim prepared for recorded spawn no longer holds/);
    assert.doesNotMatch(returned, /Claim served/);
  });

  it("distinguishes a bare snapshot count from an actionable finding", () => {
    assert.equal(C.hasFindings({ agentClaims: [], overlapPairTotal: 0 }), false);
    assert.equal(C.hasFindings({
      currentAgentKey: "parent",
      agentClaims: [{ agentKey: "parent", changed: [{}], invalidated: [] }],
      overlapPairTotal: 0,
    }), false, "the current agent's delta stays in the Phase C block");
    assert.equal(C.hasFindings({
      currentAgentKey: "parent",
      agentClaims: [{ agentKey: "child", changed: [{}], invalidated: [] }],
      overlapPairTotal: 0,
    }), true);
    assert.equal(C.hasFindings({ agentClaims: [], overlapPairTotal: 1 }), true);
  });

  it("is deterministic and respects maxChars by dropping whole lines", () => {
    const a = C.renderCoherence(result, { maxChars: 2000 });
    const b = C.renderCoherence(result, { maxChars: 2000 });
    assert.equal(a, b);

    const tight = C.renderCoherence(result, { maxChars: 40 });
    assert.equal(tight, "", "a header without a whole finding is not a report");
    assert.ok(tight.length <= 40);
  });

  it("reports only the findings that actually fit in the rendered payload", () => {
    const detailed = C.renderCoherenceDetailed(result, { maxChars: 130 });
    assert.ok(detailed.text.length <= 130);
    assert.deepEqual(detailed.delivered, { changed: 0, invalidated: 1, overlapPairs: 0 });
    assert.doesNotMatch(detailed.text, /Recorded worksets share/);
  });
});
