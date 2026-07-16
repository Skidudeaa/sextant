"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const experiment = require("../lib/coherence-experiment");
const fileMutex = require("../lib/file-mutex");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sx-coherence-experiment-"));
}

function readState(root, session = "session/raw") {
  return JSON.parse(fs.readFileSync(experiment.experimentStatePath(root, session), "utf8"));
}

function forced(taskId = "opaque/task", arm = "armed") {
  return experiment.assignArm(taskId, { env: {}, force: arm });
}

function exposure(overrides = {}) {
  const assignment = forced();
  return {
    opportunityId: "report_1",
    taskKey: assignment.taskKey,
    arm: assignment.arm,
    assignmentMode: assignment.assignmentMode,
    surface: "parent_prompt",
    paths: ["lib/a.js", "lib/b.js"],
    nowMs: 1_000,
    ...overrides,
  };
}

function flat(event) {
  return Object.values(event).every(
    (value) => value == null || ["string", "number", "boolean"].includes(typeof value)
  );
}

const waitCell = new Int32Array(new SharedArrayBuffer(4));

function waitUntil(check, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    Atomics.wait(waitCell, 0, 0, 2);
  }
  throw new Error(message);
}

function spawnGc(root, options) {
  const modulePath = path.resolve(__dirname, "..", "lib", "coherence-experiment.js");
  const source = [
    `const experiment = require(${JSON.stringify(modulePath)});`,
    `const result = experiment.gcExperimentStates(process.argv[1], JSON.parse(process.argv[2]));`,
    `process.stdout.write(JSON.stringify(result));`,
  ].join("\n");
  const child = spawn(process.execPath, ["-e", source, root, JSON.stringify(options)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`GC worker exited ${code}: ${stderr}`));
        return;
      }
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  });
  return { child, done };
}

describe("coherence experiment assignment", () => {
  it("is default-off while preserving normal armed behavior", () => {
    const assignment = experiment.assignArm("opaque/task", { env: {} });
    assert.equal(assignment.enabled, false);
    assert.equal(assignment.arm, "armed");
    assert.equal(assignment.holdbackPct, 0);
    assert.equal(assignment.assignmentMode, "off");
    assert.match(assignment.taskKey, /^ctask_[a-f0-9]{24}$/);
    assert.deepEqual(
      experiment.assignArm("", { env: {} }),
      {
        enabled: false,
        arm: "armed",
        taskKey: null,
        holdbackPct: 0,
        assignmentMode: "off",
      }
    );
  });

  it("uses a sticky balanced split only when exactly 50 is enabled", () => {
    const seen = new Map();
    for (let i = 0; i < 200; i++) {
      const taskId = `task-${i}`;
      const first = experiment.assignArm(taskId, {
        env: { SEXTANT_COHERENCE_HOLDBACK_PCT: "50" },
      });
      const second = experiment.assignArm(taskId, {
        env: { SEXTANT_COHERENCE_HOLDBACK_PCT: "50" },
      });
      assert.deepEqual(second, first);
      assert.equal(first.enabled, true);
      assert.equal(first.assignmentMode, "randomized");
      seen.set(first.arm, (seen.get(first.arm) || 0) + 1);
    }
    assert.ok(seen.get("armed") > 60, `unexpected armed count: ${seen.get("armed")}`);
    assert.ok(seen.get("holdback") > 60, `unexpected holdback count: ${seen.get("holdback")}`);

    for (const value of [0, 20, 49, 51, 100, "bad"]) {
      const off = experiment.assignArm("task", {
        env: { SEXTANT_COHERENCE_HOLDBACK_PCT: String(value) },
      });
      assert.equal(off.enabled, false, `pct ${value} must not silently change the design`);
      assert.equal(off.arm, "armed");
    }
  });

  it("accepts explicit config, lets an explicit env zero disable it, and supports forced arms", () => {
    assert.equal(
      experiment.assignArm("task", {
        env: {},
        config: { coherenceExperiment: { holdbackPct: 50 } },
      }).enabled,
      true
    );
    assert.equal(
      experiment.assignArm("task", {
        env: { SEXTANT_COHERENCE_HOLDBACK_PCT: "0" },
        config: { coherenceHoldbackPct: 50 },
      }).enabled,
      false
    );
    assert.equal(forced("task", "armed").arm, "armed");
    assert.equal(forced("task", "holdback").arm, "holdback");
    assert.equal(forced("task", "holdback").assignmentMode, "forced");
    assert.equal(
      experiment.assignArm("task", {
        env: { SEXTANT_COHERENCE_HOLDBACK_FORCE: "holdback" },
      }).enabled,
      true
    );
    assert.notEqual(
      experiment.assignArm("session/a", { env: {} }).taskKey,
      experiment.assignArm("session_a", { env: {} }).taskKey,
      "task keys hash raw opaque identity before any filename sanitization"
    );
  });
});

describe("coherence experiment eligible paths", () => {
  it("derives a stable opaque opportunity key from incident and surface", () => {
    const first = experiment.opportunityKey("cincident_sensitive", "parent_prompt");
    assert.match(first, /^copportunity_[a-f0-9]{24}$/);
    assert.equal(first, experiment.opportunityKey("cincident_sensitive", "parent_prompt"));
    assert.notEqual(first, experiment.opportunityKey("cincident_sensitive", "tool_return"));
    assert.doesNotMatch(first, /sensitive|parent/);
    assert.equal(experiment.opportunityKey("", "parent_prompt"), null);
  });

  it("extracts deterministic exact overlap paths and rejects traversal/absolute aliases", () => {
    const paths = experiment.eligiblePaths({
      overlaps: [
        {
          sharedPaths: [
            "lib/b.js",
            "./lib/a.js",
            "lib/b.js",
            "../escape.js",
            "lib/../alias.js",
            "/absolute.js",
            "C:\\absolute.js",
            "bad\0path.js",
          ],
          sharedRegions: ["lib/not-a-path.js#symbol"],
        },
      ],
    });
    assert.deepEqual(paths, ["lib/a.js", "lib/b.js"]);
  });

  it("hard-caps an eligible opportunity at 50 paths", () => {
    const paths = experiment.eligiblePaths({
      overlaps: [{ sharedPaths: Array.from({ length: 80 }, (_, i) => `lib/f${i}.js`) }],
    });
    assert.equal(paths.length, experiment.MAX_PATHS);
    assert.deepEqual(paths, [...paths].sort((a, b) => a.localeCompare(b)));
    assert.equal(new Set(paths).size, paths.length);
    assert.deepEqual(experiment.eligiblePaths(null), []);
  });
});

describe("coherence experiment exposure state", () => {
  it("atomically opens a bounded per-session window and returns a flat schema-v1 event", () => {
    const root = tempRoot();
    try {
      const manyPaths = Array.from({ length: 80 }, (_, i) => `lib/f${i}.js`);
      const events = experiment.openExposure(root, "session/raw", exposure({ paths: manyPaths }));
      assert.equal(events.length, 1);
      assert.equal(events[0].name, experiment.EVENT_OPENED);
      assert.equal(events[0].schemaVersion, 1);
      assert.equal(events[0].targetPathCount, experiment.MAX_PATHS);
      assert.equal(events[0].touchLimit, 8);
      assert.ok(flat(events[0]), "telemetry payload must remain flat");

      const statePath = experiment.experimentStatePath(root, "session/raw");
      assert.ok(statePath);
      assert.ok(!path.basename(statePath).includes("session"), "raw session id must not enter filename");
      const state = readState(root);
      assert.equal(state.schemaVersion, 1);
      assert.equal(state.windows.length, 1);
      assert.equal(state.windows[0].paths.length, experiment.MAX_PATHS);
      assert.equal(state.seen[0].taskKey, state.windows[0].taskKey);
      const activePath = experiment.experimentActivePath(root, "session/raw");
      assert.ok(activePath);
      assert.equal(fs.existsSync(activePath), true);
      assert.equal(fs.statSync(activePath).mode & 0o777, 0o600);
      const names = fs.readdirSync(path.dirname(statePath));
      assert.deepEqual(names.filter((name) => name.endsWith(".tmp")), []);
      assert.equal(fs.existsSync(experiment.experimentLockPath(root, "session/raw")), false);
      assert.equal(experiment.hasActiveExposure(root, "session/raw"), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("dedupes an identical opportunity id without extending or duplicating its window", () => {
    const root = tempRoot();
    try {
      experiment.openExposure(root, "s", exposure({ opportunityId: "same", nowMs: 100 }));
      const events = experiment.openExposure(root, "s", exposure({
        opportunityId: "same",
        paths: ["other.js"],
        nowMs: 200,
      }));
      assert.equal(events.length, 1);
      assert.equal(events[0].name, experiment.EVENT_DEDUPED);
      assert.equal(events[0].dedupeReason, "exact_opportunity");
      const state = readState(root, "s");
      assert.equal(state.windows.length, 1);
      assert.deepEqual(state.windows[0].paths, ["lib/a.js", "lib/b.js"]);
      assert.equal(state.windows[0].openedAt, 100);
      assert.equal(state.seen.length, 1);
      assert.equal(state.seen[0].taskKey, state.windows[0].taskKey);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the marker as the active fast path and audits a stale-marker observation", () => {
    const root = tempRoot();
    try {
      const marker = experiment.experimentActivePath(root, "stale");
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, "1\n", { mode: 0o600 });
      assert.equal(experiment.hasActiveExposure(root, "stale"), true);
      assert.equal(fs.existsSync(experiment.experimentStatePath(root, "stale")), false);

      const events = experiment.scoreTouch(root, "stale", {
        path: "lib/a.js",
        action: "read",
        nowMs: 100,
      });
      assert.equal(events.length, 1);
      assert.equal(events[0].name, experiment.EVENT_OBSERVATION_FAILED);
      assert.equal(events[0].reason, "active_state_missing");
      assert.ok(flat(events[0]));
      assert.equal(experiment.hasActiveExposure(root, "stale"), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("turns active-window lock loss into an auditable observation failure", () => {
    const root = tempRoot();
    let lock = null;
    try {
      experiment.openExposure(root, "score-locked", exposure({ nowMs: 100 }));
      lock = fileMutex.acquireFileMutex(
        experiment.experimentLockPath(root, "score-locked"),
        { attempts: 25, waitMs: 2, staleMs: 60_000 }
      );
      assert.ok(lock);
      const events = experiment.scoreTouch(root, "score-locked", {
        path: "lib/a.js",
        action: "mutation",
        nowMs: 200,
      });
      assert.equal(events.length, 1);
      assert.equal(events[0].name, experiment.EVENT_OBSERVATION_FAILED);
      assert.equal(events[0].reason, "lock_unavailable");
      assert.equal(readState(root, "score-locked").windows[0].totalTouches, 0);
    } finally {
      fileMutex.releaseFileMutex(lock);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("enrolls only the first overlap opportunity for a task", () => {
    const root = tempRoot();
    try {
      experiment.openExposure(root, "s", exposure({ opportunityId: "first", nowMs: 100 }));
      const activeDedupe = experiment.openExposure(root, "s", exposure({
        opportunityId: "second",
        nowMs: 200,
      }));
      assert.equal(activeDedupe.length, 1);
      assert.equal(activeDedupe[0].name, experiment.EVENT_DEDUPED);
      assert.equal(activeDedupe[0].dedupeReason, "task_already_enrolled");
      assert.equal(activeDedupe[0].activeWindow, true);
      assert.equal(activeDedupe[0].enrolledOpportunityId, "first");
      assert.equal(activeDedupe[0].activeArm, "armed");
      assert.deepEqual(readState(root, "s").windows.map((window) => window.opportunityId), ["first"]);

      experiment.closeExposure(root, "s", { nowMs: 300 });
      assert.equal(experiment.hasActiveExposure(root, "s"), false);
      const historicalDedupe = experiment.openExposure(root, "s", exposure({
        opportunityId: "third",
        nowMs: 400,
      }));
      assert.equal(historicalDedupe.length, 1);
      assert.equal(historicalDedupe[0].name, experiment.EVENT_DEDUPED);
      assert.equal(historicalDedupe[0].dedupeReason, "task_already_enrolled");
      assert.equal(historicalDedupe[0].activeWindow, false);
      assert.equal(historicalDedupe[0].enrolledOpportunityId, null);
      assert.equal(historicalDedupe[0].activeArm, null);
      assert.equal(readState(root, "s").windows.length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps sessions isolated and honors an explicit disabled call", () => {
    const root = tempRoot();
    try {
      assert.deepEqual(
        experiment.openExposure(root, "disabled", exposure({ enabled: false })),
        []
      );
      experiment.openExposure(root, "s1", exposure({ opportunityId: "one" }));
      experiment.openExposure(root, "s2", exposure({ opportunityId: "two" }));
      assert.notEqual(
        experiment.experimentStatePath(root, "s1"),
        experiment.experimentStatePath(root, "s2")
      );
      assert.equal(readState(root, "s1").windows[0].opportunityId, "one");
      assert.equal(readState(root, "s2").windows[0].opportunityId, "two");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds per-session retention while protecting live and current state", () => {
    const root = tempRoot();
    const now = Date.now();
    const open = (session, task, opportunityId) => experiment.openExposure(
      root,
      session,
      exposure({
        opportunityId,
        taskKey: forced(task).taskKey,
        nowMs: now,
      })
    );
    const close = (session) => experiment.closeExposure(root, session, { nowMs: now + 1 });
    try {
      for (const session of ["gc-a", "gc-b", "gc-c", "gc-expired", "gc-current"]) {
        open(session, `task-${session}`, `op-${session}`);
        close(session);
      }
      open("gc-active", "task-gc-active", "op-gc-active");

      const expired = experiment.experimentStatePath(root, "gc-expired");
      const current = experiment.experimentStatePath(root, "gc-current");
      const active = experiment.experimentStatePath(root, "gc-active");
      const expiredAt = new Date(now - experiment.STATE_TTL_MS - 1_000);
      fs.utimesSync(expired, expiredAt, expiredAt);
      fs.utimesSync(current, expiredAt, expiredAt);
      for (const session of ["gc-a", "gc-b", "gc-c"]) {
        const file = experiment.experimentStatePath(root, session);
        const old = new Date(now - 60_000);
        fs.utimesSync(file, old, old);
      }

      const gc = experiment.gcExperimentStates(root, {
        nowMs: now + 100,
        ttlMs: experiment.STATE_TTL_MS,
        maxFiles: 2,
        currentFile: current,
      });
      assert.ok(gc.scanned >= 6);
      assert.ok(gc.removed >= 4);
      assert.equal(fs.existsSync(expired), false, "expired inactive state is pruned");
      assert.equal(fs.existsSync(current), true, "the caller's current state is protected");
      assert.equal(fs.existsSync(active), true, "a live outcome window is protected");
      const retained = fs.readdirSync(path.dirname(active)).filter((name) =>
        /^\.coherence-experiment\.[a-f0-9]{24}\.json$/.test(name)
      );
      assert.equal(retained.length, 2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("owns a candidate session lock before GC can delete its state", () => {
    const root = tempRoot();
    const now = Date.now();
    try {
      experiment.openExposure(root, "gc-locked", exposure({ nowMs: now }));
      experiment.closeExposure(root, "gc-locked", { nowMs: now + 1 });
      const state = experiment.experimentStatePath(root, "gc-locked");
      const old = new Date(now - experiment.STATE_TTL_MS - 1_000);
      fs.utimesSync(state, old, old);
      const lock = fileMutex.acquireFileMutex(
        experiment.experimentLockPath(root, "gc-locked"),
        { attempts: 25, waitMs: 2, staleMs: 60_000 }
      );
      assert.ok(lock);
      const blocked = experiment.gcExperimentStates(root, {
        nowMs: now,
        ttlMs: experiment.STATE_TTL_MS,
        maxFiles: 1,
      });
      assert.equal(blocked.removed, 0);
      assert.equal(fs.existsSync(state), true);
      fileMutex.releaseFileMutex(lock);

      const collected = experiment.gcExperimentStates(root, {
        nowMs: now,
        ttlMs: experiment.STATE_TTL_MS,
        maxFiles: 1,
      });
      assert.equal(collected.removed, 1);
      assert.equal(fs.existsSync(state), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not apply an expired pre-lock snapshot to a refreshed state generation", async () => {
    const root = tempRoot();
    const now = Date.now();
    let lock = null;
    let worker = null;
    try {
      experiment.openExposure(root, "gc-refreshed", exposure({ nowMs: now }));
      experiment.closeExposure(root, "gc-refreshed", { nowMs: now + 1 });
      const state = experiment.experimentStatePath(root, "gc-refreshed");
      const lockBase = experiment.experimentLockPath(root, "gc-refreshed");
      const old = new Date(now - experiment.STATE_TTL_MS - 1_000);
      fs.utimesSync(state, old, old);
      lock = fileMutex.acquireFileMutex(lockBase, {
        attempts: 25, waitMs: 2, staleMs: 60_000,
      });
      assert.ok(lock);

      worker = spawnGc(root, {
        nowMs: now,
        ttlMs: experiment.STATE_TTL_MS,
        maxFiles: 1,
      });
      const prefix = `${path.basename(lockBase)}.candidate.`;
      waitUntil(
        () => fs.readdirSync(path.dirname(lockBase)).filter((name) => name.startsWith(prefix)).length >= 2,
        "GC did not reach the blocked session mutex"
      );

      const refreshed = JSON.parse(fs.readFileSync(state, "utf8"));
      refreshed.refreshedByTest = true;
      const replacement = `${state}.replacement`;
      fs.writeFileSync(replacement, JSON.stringify(refreshed) + "\n", { mode: 0o600 });
      fs.renameSync(replacement, state);
      fileMutex.releaseFileMutex(lock);
      lock = null;

      const result = await worker.done;
      assert.equal(result.removed, 0);
      assert.equal(fs.existsSync(state), true);
      assert.equal(JSON.parse(fs.readFileSync(state, "utf8")).refreshedByTest, true);
    } finally {
      fileMutex.releaseFileMutex(lock);
      if (worker && worker.child.exitCode == null) {
        worker.child.kill();
        await worker.done.catch(() => {});
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("serializes repository-wide cap decisions so concurrent GC cannot over-prune", async () => {
    const root = tempRoot();
    const now = Date.now();
    let lock = null;
    let worker = null;
    try {
      for (const [index, session] of ["gc-global-a", "gc-global-b", "gc-global-c"].entries()) {
        experiment.openExposure(root, session, exposure({
          opportunityId: `op-${session}`,
          taskKey: forced(`task-${session}`).taskKey,
          nowMs: now + index,
        }));
        experiment.closeExposure(root, session, { nowMs: now + index + 10 });
        const file = experiment.experimentStatePath(root, session);
        const old = new Date(now - 60_000 + index * 1_000);
        fs.utimesSync(file, old, old);
      }

      const oldestLock = experiment.experimentLockPath(root, "gc-global-a");
      lock = fileMutex.acquireFileMutex(oldestLock, {
        attempts: 25, waitMs: 2, staleMs: 60_000,
      });
      assert.ok(lock);
      worker = spawnGc(root, {
        nowMs: now,
        ttlMs: experiment.STATE_TTL_MS,
        maxFiles: 2,
      });
      const prefix = `${path.basename(oldestLock)}.candidate.`;
      waitUntil(
        () => fs.readdirSync(path.dirname(oldestLock)).filter((name) => name.startsWith(prefix)).length >= 2,
        "first GC did not reach the blocked cap candidate"
      );

      const competing = experiment.gcExperimentStates(root, {
        nowMs: now,
        ttlMs: experiment.STATE_TTL_MS,
        maxFiles: 2,
      });
      assert.equal(competing.skipped, true);
      assert.equal(competing.removed, 0);
      fileMutex.releaseFileMutex(lock);
      lock = null;

      const collected = await worker.done;
      assert.equal(collected.removed, 1);
      const retained = fs.readdirSync(path.dirname(oldestLock)).filter((name) =>
        /^\.coherence-experiment\.[a-f0-9]{24}\.json$/.test(name)
      );
      assert.equal(retained.length, 2);
    } finally {
      fileMutex.releaseFileMutex(lock);
      if (worker && worker.child.exitCode == null) {
        worker.child.kill();
        await worker.done.catch(() => {});
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("ages orphan experiment lock, marker, and temp generations", () => {
    const root = tempRoot();
    const now = Date.now();
    try {
      const state = experiment.experimentStatePath(root, "gc-sidecars");
      const active = experiment.experimentActivePath(root, "gc-sidecars");
      const lockBase = experiment.experimentLockPath(root, "gc-sidecars");
      fs.mkdirSync(path.dirname(state), { recursive: true });
      fs.writeFileSync(active, "1\n", { mode: 0o600 });

      const temp = `${state}.2147483647.abcdefabcdef.tmp`;
      fs.writeFileSync(temp, "stale", { mode: 0o600 });
      const token = "e".repeat(32);
      const deadLock = `${lockBase}.candidate.${token}`;
      fs.writeFileSync(deadLock, JSON.stringify({
        schemaVersion: 1,
        token,
        pid: 2_147_483_647,
        choosing: false,
        ticket: 1,
        createdAt: 1,
      }), { mode: 0o600 });
      const old = new Date(now - experiment.STATE_TTL_MS - 1_000);
      fs.utimesSync(temp, old, old);
      fs.utimesSync(deadLock, old, old);

      const gc = experiment.gcExperimentStates(root, {
        nowMs: now,
        ttlMs: experiment.STATE_TTL_MS,
        maxFiles: 1,
      });
      assert.ok(gc.sidecarsRemoved >= 2, "cleanup may reap a dead contender while acquiring the marker lock");
      assert.equal(fs.existsSync(active), false);
      assert.equal(fs.existsSync(temp), false);
      assert.equal(fs.existsSync(deadLock), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not over-delete JSON state when malformed marker cleanup fails", () => {
    const root = tempRoot();
    const now = Date.now();
    try {
      for (const session of ["marker-a", "marker-b", "marker-c"]) {
        experiment.openExposure(root, session, exposure({
          opportunityId: `op-${session}`,
          taskKey: forced(`task-${session}`).taskKey,
          nowMs: now,
        }));
        experiment.closeExposure(root, session, { nowMs: now + 1 });
      }
      const oldest = experiment.experimentStatePath(root, "marker-a");
      const malformedMarker = experiment.experimentActivePath(root, "marker-a");
      fs.mkdirSync(malformedMarker);
      const old = new Date(now - 60_000);
      fs.utimesSync(oldest, old, old);

      const gc = experiment.gcExperimentStates(root, {
        nowMs: now + 100,
        ttlMs: experiment.STATE_TTL_MS,
        maxFiles: 2,
      });
      assert.equal(gc.removed, 1);
      const retained = fs.readdirSync(path.dirname(oldest)).filter((name) =>
        /^\.coherence-experiment\.[a-f0-9]{24}\.json$/.test(name)
      );
      assert.equal(retained.length, 2);
      assert.equal(fs.statSync(malformedMarker).isDirectory(), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed under a live token-owned session lock and never reaps its owner", () => {
    const root = tempRoot();
    try {
      const lockPath = experiment.experimentLockPath(root, "locked-session");
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      const owner = {
        schemaVersion: 1,
        token: "other-live-owner-token",
        pid: process.pid,
        createdAt: Date.now(),
      };
      fs.writeFileSync(lockPath, JSON.stringify(owner));
      assert.deepEqual(
        experiment.openExposure(root, "locked-session", exposure({ opportunityId: "blocked" })),
        []
      );
      assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, "utf8")), owner);
      assert.equal(fs.existsSync(experiment.experimentStatePath(root, "locked-session")), false);

      fs.rmSync(lockPath);
      assert.equal(
        experiment.openExposure(root, "locked-session", exposure({ opportunityId: "after" }))[0].name,
        experiment.EVENT_OPENED
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("closes at exactly eight file-tool touches and records target outcomes", () => {
    const root = tempRoot();
    try {
      experiment.openExposure(root, "s", exposure({ nowMs: 100 }));
      for (let rank = 1; rank <= 6; rank++) {
        const events = experiment.scoreTouch(root, "s", {
          path: `unrelated/${rank}.js`, action: "read", nowMs: 100 + rank,
        });
        assert.deepEqual(events, []);
      }
      const blind = experiment.scoreTouch(root, "s", {
        path: "lib/a.js", action: "mutation", nowMs: 107,
      });
      assert.deepEqual(blind, []);
      const beforeClose = readState(root, "s").windows[0];
      assert.equal(beforeClose.totalTouches, 7);
      assert.equal(beforeClose.targetMutation, true);
      assert.equal(beforeClose.blindTargetMutation, true);
      assert.equal(beforeClose.firstTargetRank, 7);

      const last = experiment.scoreTouch(root, "s", {
        path: "lib/a.js", action: "read", nowMs: 108,
      });
      assert.deepEqual(last.map((event) => event.name), [experiment.EVENT_CLOSED]);
      const closed = last[0];
      assert.equal(closed.closeReason, "touch_limit");
      assert.equal(closed.totalTouches, 8);
      assert.equal(closed.targetRead, true);
      assert.equal(closed.targetMutation, true);
      assert.equal(closed.blindTargetMutation, true);
      assert.equal(closed.firstTargetRank, 7);
      assert.ok(flat(closed));
      assert.equal(readState(root, "s").windows.length, 0);
      assert.equal(experiment.hasActiveExposure(root, "s"), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("defines blind mutation per exact target path, not any target read", () => {
    const root = tempRoot();
    try {
      experiment.openExposure(root, "same-path", exposure({ opportunityId: "same-path" }));
      assert.deepEqual(
        experiment.scoreTouch(root, "same-path", {
          path: "lib/a.js", action: "read", nowMs: 2_000,
        }),
        []
      );
      assert.deepEqual(experiment.scoreTouch(root, "same-path", {
        path: "lib/a.js", action: "mutation", nowMs: 2_001,
      }), []);
      const same = experiment.closeExposure(root, "same-path", { nowMs: 2_002 })[0];
      assert.equal(same.targetRead, true);
      assert.equal(same.targetMutation, true);
      assert.equal(same.blindTargetMutation, false);

      experiment.openExposure(root, "other-path", exposure({ opportunityId: "other-path" }));
      experiment.scoreTouch(root, "other-path", { path: "lib/a.js", action: "read", nowMs: 2_000 });
      assert.deepEqual(experiment.scoreTouch(root, "other-path", {
        path: "lib/b.js", action: "mutation", nowMs: 2_001,
      }), []);
      const other = experiment.closeExposure(root, "other-path", { nowMs: 2_002 })[0];
      assert.equal(other.targetRead, true);
      assert.equal(other.targetMutation, true);
      assert.equal(other.blindTargetMutation, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("expires at 30 minutes without counting the triggering operation as a touch", () => {
    const root = tempRoot();
    try {
      const openedAt = 10_000;
      experiment.openExposure(root, "s", exposure({ nowMs: openedAt }));
      assert.deepEqual(
        experiment.expireWindows(root, "s", { nowMs: openedAt + experiment.WINDOW_TTL_MS - 1 }),
        []
      );
      const events = experiment.expireWindows(root, "s", {
        nowMs: openedAt + experiment.WINDOW_TTL_MS,
      });
      assert.equal(events.length, 1);
      assert.equal(events[0].name, experiment.EVENT_CLOSED);
      assert.equal(events[0].closeReason, "timeout");
      assert.equal(events[0].totalTouches, 0);
      assert.equal(events[0].windowMs, experiment.WINDOW_TTL_MS);
      assert.equal(readState(root, "s").windows.length, 0);
      assert.equal(experiment.hasActiveExposure(root, "s"), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("closes one or all windows at a caller-declared next prompt", () => {
    const root = tempRoot();
    try {
      experiment.openExposure(root, "s", exposure({
        opportunityId: "one",
        taskKey: forced("task-one").taskKey,
        nowMs: 100,
      }));
      experiment.openExposure(root, "s", exposure({
        opportunityId: "two",
        taskKey: forced("task-two").taskKey,
        nowMs: 101,
      }));
      const one = experiment.closeExposure(root, "s", {
        opportunityId: "one", reason: "next_prompt", nowMs: 200,
      });
      assert.equal(one.length, 1);
      assert.equal(one[0].opportunityId, "one");
      assert.equal(one[0].closeReason, "next_prompt");
      assert.deepEqual(readState(root, "s").windows.map((window) => window.opportunityId), ["two"]);
      assert.equal(experiment.hasActiveExposure(root, "s"), true);

      const rest = experiment.closeExposure(root, "s", { reason: "next_prompt", nowMs: 201 });
      assert.deepEqual(rest.map((event) => event.opportunityId), ["two"]);
      assert.equal(readState(root, "s").windows.length, 0);
      assert.equal(experiment.hasActiveExposure(root, "s"), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("caps active windows, closes the oldest, and retains bounded dedupe history", () => {
    const root = tempRoot();
    try {
      let capacityEvents = [];
      for (let i = 0; i < experiment.MAX_WINDOWS + 2; i++) {
        capacityEvents = experiment.openExposure(root, "s", exposure({
          opportunityId: `op_${i}`,
          taskKey: forced(`capacity-task-${i}`).taskKey,
          nowMs: 1_000 + i,
        }));
      }
      assert.equal(capacityEvents[0].name, experiment.EVENT_CLOSED);
      assert.equal(capacityEvents[0].closeReason, "capacity");
      assert.equal(capacityEvents.at(-1).name, experiment.EVENT_OPENED);
      let state = readState(root, "s");
      assert.equal(state.windows.length, experiment.MAX_WINDOWS);
      assert.ok(state.seen.length <= experiment.MAX_SEEN_OPPORTUNITIES);

      experiment.closeExposure(root, "s", { nowMs: 2_000 });
      for (let i = 0; i < experiment.MAX_SEEN_OPPORTUNITIES + 10; i++) {
        experiment.openExposure(root, "s", exposure({
          opportunityId: `history_${i}`,
          taskKey: forced(`history-task-${i}`).taskKey,
          nowMs: 3_000 + i * 2,
        }));
        experiment.closeExposure(root, "s", {
          opportunityId: `history_${i}`,
          nowMs: 3_001 + i * 2,
        });
      }
      state = readState(root, "s");
      assert.equal(state.seen.length, experiment.MAX_SEEN_OPPORTUNITIES);
      const recent = experiment.openExposure(root, "s", exposure({
        opportunityId: `history_${experiment.MAX_SEEN_OPPORTUNITIES + 9}`,
        taskKey: forced(`history-task-${experiment.MAX_SEEN_OPPORTUNITIES + 9}`).taskKey,
        nowMs: 10_000,
      }));
      assert.equal(recent.at(-1).name, experiment.EVENT_DEDUPED);
      assert.equal(recent.at(-1).dedupeReason, "exact_opportunity");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("never throws on malformed state, invalid paths/actions, or unwritable roots", () => {
    const root = tempRoot();
    try {
      const statePath = experiment.experimentStatePath(root, "s");
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, "{not json");
      assert.doesNotThrow(() => experiment.openExposure(root, "s", exposure({
        opportunityId: "recovered",
      })));
      assert.equal(readState(root, "s").windows.length, 1);

      for (const badPath of ["../escape.js", "/absolute.js", "lib/../alias.js", "C:\\x.js", "bad\0x"] ) {
        assert.deepEqual(
          experiment.scoreTouch(root, "s", { path: badPath, action: "read" }),
          []
        );
      }
      assert.deepEqual(experiment.scoreTouch(root, "s", { path: "lib/a.js", action: "write-ish" }), []);
      assert.deepEqual(experiment.openExposure(root, "", exposure()), []);
      assert.deepEqual(experiment.closeExposure(root, "", {}), []);
      assert.deepEqual(experiment.expireWindows(root, "", {}), []);

      const rootFile = path.join(root, "not-a-directory");
      fs.writeFileSync(rootFile, "x");
      assert.doesNotThrow(() => experiment.openExposure(rootFile, "s", exposure()));
      assert.deepEqual(experiment.openExposure(rootFile, "s", exposure()), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
