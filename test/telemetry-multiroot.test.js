"use strict";

// Multi-root telemetry pooling (docs/033 "Still open" → docs/035).
//
// WHY THIS FILE EXISTS: the holdback A/B randomizes per TURN, and one repo
// accrues turns far too slowly to ever clear HOLDBACK_MIN_TURNS. Pooling several
// repos' telemetry is the only way the arms accrue — but pooling is exactly the
// operation that can silently corrupt the unit it is trying to accumulate. The
// load-bearing assertion here is the cross-repo turn-id collision guard: the
// turn key is an injected-set `ts` in milliseconds, two repos CAN stamp the same
// millisecond, and a merged turn would let one arm absorb the other arm's opens
// — the same bias class docs/033 Tier 3 #3 removed at the dedupe path.
//
// Each collision test is paired with its own mutation control (the same events
// WITHOUT the __root tag must collapse), so a future refactor that drops the
// namespacing fails here instead of quietly re-biasing the delta.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const {
  summarize,
  readPooledEvents,
  rootContributions,
  printSummary,
} = require("../commands/telemetry");
const telemetry = require("../lib/telemetry");

const BIN = path.resolve(__dirname, "..", "bin", "intel.js");

function tmpRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sextant-mr-${label}-`));
  fs.mkdirSync(path.join(root, ".planning", "intel"), { recursive: true });
  return root;
}

// Hermetic env pinned INSIDE the helper: the dogfood repo sets
// SEXTANT_HOLDBACK_PCT in .claude/settings.json, and capsule/coherence env flags
// would override the per-root config these tests set on disk. A load-time
// snapshot is not enough — pin at spawn time.
function runCli(args) {
  const env = { ...process.env };
  delete env.SEXTANT_CAPSULE;
  delete env.SEXTANT_COHERENCE;
  delete env.SEXTANT_HOLDBACK_PCT;
  delete env.SEXTANT_HOLDBACK_FORCE;
  return spawnSync(process.execPath, [BIN, "telemetry", ...args], {
    encoding: "utf8",
    timeout: 30000,
    env,
  });
}

// An open scored against an injected set: `turn` is the injected-set ts.
function open(turn, arm, isHit, ts) {
  return {
    ts: ts == null ? turn + 1 : ts,
    name: isHit ? "retrieval.path_hit" : "retrieval.path_miss",
    turn,
    arm,
    tool: "Read",
    source: "exported_symbol",
  };
}

describe("pooled turn keys: cross-repo collision guard", () => {
  it("does NOT merge two repos' turns that share a millisecond", () => {
    // Same turn id, different repos, different arms — the worst case: merging
    // them would put a holdback turn's open into the armed arm.
    const events = [
      { ...open(1000, "armed", true), __root: "/repo/a" },
      { ...open(1000, "holdback", false), __root: "/repo/b" },
    ];
    const sum = summarize(events);
    assert.equal(sum.retrieval.turnsScored, 2, "two repos' turns must stay distinct");
    assert.deepEqual(sum.retrieval.turnCountsByArm, {
      armed: { turns: 1, hitTurns: 1 },
      holdback: { turns: 1, hitTurns: 0 },
    });
  });

  it("MUTATION CONTROL: the same events without __root DO collapse", () => {
    // Proves the assertion above is load-bearing rather than incidentally true.
    // Without the namespace both opens land on turn 1000, and the arm recorded
    // is whichever event arrived first — the exact corruption being guarded.
    const events = [open(1000, "armed", true), open(1000, "holdback", false)];
    const sum = summarize(events);
    assert.equal(sum.retrieval.turnsScored, 1);
    assert.deepEqual(sum.retrieval.turnCountsByArm, {
      armed: { turns: 1, hitTurns: 1 },
    });
  });

  it("keeps a single repo's repeated turn id merged (same turn, many opens)", () => {
    const events = [
      { ...open(2000, "armed", false), __root: "/repo/a" },
      { ...open(2000, "armed", true), __root: "/repo/a" },
    ];
    const sum = summarize(events);
    assert.equal(sum.retrieval.turnsScored, 1, "one repo's turn is still one turn");
    assert.equal(sum.retrieval.turnsWithHit, 1);
    // firstHitRank = 2: the hit was the second scored open of that turn.
    assert.equal(sum.retrieval.medianFirstTouchRank, 2);
  });

  it("root paths that are prefixes of each other do not alias", () => {
    // "/repo/a" + turn 11 and "/repo/a1" + turn 1 must not build the same key.
    const events = [
      { ...open(11, "armed", true), __root: "/repo/a" },
      { ...open(1, "armed", true), __root: "/repo/a1" },
    ];
    assert.equal(summarize(events).retrieval.turnsScored, 2);
  });

  it("pools arm counts additively across repos", () => {
    const events = [];
    for (let i = 0; i < 5; i++) events.push({ ...open(10 + i, "armed", i < 2), __root: "/repo/a" });
    for (let i = 0; i < 3; i++) {
      events.push({ ...open(10 + i, "holdback", i < 1), __root: "/repo/b" });
    }
    const sum = summarize(events);
    assert.equal(sum.retrieval.turnsScored, 8);
    assert.deepEqual(sum.retrieval.turnCountsByArm, {
      armed: { turns: 5, hitTurns: 2 },
      holdback: { turns: 3, hitTurns: 1 },
    });
    // 2/5 − 1/3 = 0.4 − 0.3333
    assert.equal(sum.retrieval.turnBenefitDelta, 0.0667);
  });
});

describe("readPooledEvents", () => {
  it("tags __root only when pooling more than one root", () => {
    const a = tmpRoot("tag-a");
    const b = tmpRoot("tag-b");
    try {
      telemetry.recordEvent(a, "freshness.fresh_hit", {});
      telemetry.recordEvent(b, "freshness.fresh_hit", {});

      const single = readPooledEvents([a], false);
      assert.equal(single.length, 1);
      assert.equal(
        Object.prototype.hasOwnProperty.call(single[0], "__root"),
        false,
        "single-root reads must stay byte-identical — no __root key"
      );

      const multi = readPooledEvents([a, b], false);
      assert.equal(multi.length, 2);
      assert.deepEqual(multi.map((e) => e.__root).sort(), [a, b].sort());
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  it("orders the pooled stream chronologically, not repo-major", () => {
    const a = tmpRoot("ord-a");
    const b = tmpRoot("ord-b");
    try {
      // b's event is written first in time; a is read first. Without the sort
      // the window and the percentiles would read repo-major blocks.
      telemetry.recordEvent(b, "freshness.fresh_hit", {});
      telemetry.recordEvent(a, "freshness.stale_hit", { reason: "head_changed" });
      const pooled = readPooledEvents([a, b], false);
      const ts = pooled.map((e) => e.ts);
      assert.deepEqual(ts, [...ts].sort((x, y) => x - y), "pooled stream must be time-ordered");
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  it("applies the coherence gate PER ROOT, not once for the pool", () => {
    // The gate is per-repo config. A repo with coherence on must never drag a
    // gate-off repo's coherence events into a pooled report.
    const on = tmpRoot("coh-on");
    const off = tmpRoot("coh-off");
    try {
      fs.writeFileSync(
        path.join(on, ".codebase-intel.json"),
        JSON.stringify({ capsule: true, coherence: true })
      );
      fs.writeFileSync(path.join(off, ".codebase-intel.json"), JSON.stringify({}));
      telemetry.recordEvent(on, "coherence.lifecycle", { stage: "child_spawn" });
      telemetry.recordEvent(off, "coherence.lifecycle", { stage: "child_spawn" });
      telemetry.recordEvent(off, "freshness.fresh_hit", {});

      const pooled = readPooledEvents([on, off], false);
      const coherenceRoots = pooled
        .filter((e) => e.name.startsWith("coherence."))
        .map((e) => e.__root);
      assert.deepEqual(coherenceRoots, [on], "only the gate-ON repo may expose coherence events");
      assert.equal(pooled.length, 2);
    } finally {
      fs.rmSync(on, { recursive: true, force: true });
      fs.rmSync(off, { recursive: true, force: true });
    }
  });
});

describe("rootContributions", () => {
  it("emits a row for a root that contributed nothing", () => {
    // No silent caps: a repo missing from the pooled denominator would make a
    // one-repo number read as a fleet number.
    const rows = rootContributions(
      ["/repo/a", "/repo/empty"],
      [{ ...open(1, "armed", true), __root: "/repo/a" }]
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[1].root, "/repo/empty");
    assert.equal(rows[1].events, 0);
    assert.equal(rows[1].turnsScored, 0);
  });

  it("splits arm counts per root", () => {
    const rows = rootContributions(
      ["/repo/a", "/repo/b"],
      [
        { ...open(1, "armed", true), __root: "/repo/a" },
        { ...open(2, "holdback", false), __root: "/repo/b" },
        { ...open(3, "holdback", true), __root: "/repo/b" },
      ]
    );
    assert.deepEqual(
      rows.map((r) => [r.armedTurns, r.holdbackTurns]),
      [[1, 0], [0, 2]]
    );
  });

  it("renders the zero row and the pooling caveats in the text report", () => {
    const rows = rootContributions(["/repo/a", "/repo/empty"], []);
    const out = printSummary("2 roots (pooled)", summarize([]), rows);
    assert.match(out, /Pooled roots/);
    assert.match(out, /CONTRIBUTED NOTHING/);
    assert.match(out, /UNSTRATIFIED/);
    assert.match(out, /\/repo\/empty/);
  });
});

describe("sextant telemetry --roots (CLI)", () => {
  it("pools turns across repos and shows the per-root contributions", () => {
    const a = tmpRoot("cli-a");
    const b = tmpRoot("cli-b");
    try {
      // Deliberately reuse the SAME turn ids in both repos: the CLI path must
      // carry the namespacing through, not just the in-process summarize().
      for (const [root, arm] of [[a, "armed"], [b, "holdback"]]) {
        for (let i = 0; i < 3; i++) {
          telemetry.recordEvent(root, "retrieval.path_hit", {
            turn: 5000 + i,
            arm,
            tool: "Read",
            source: "exported_symbol",
          });
        }
      }

      const res = runCli(["--roots", `${a},${b}`, "--json"]);
      assert.equal(res.status, 0, res.stderr);
      const parsed = JSON.parse(res.stdout);
      assert.deepEqual(parsed.roots, [a, b]);
      assert.equal(parsed.retrieval.turnsScored, 6, "3 turns per repo, not 3 merged");
      assert.deepEqual(parsed.retrieval.turnCountsByArm, {
        armed: { turns: 3, hitTurns: 3 },
        holdback: { turns: 3, hitTurns: 3 },
      });
      assert.equal(parsed.rootContributions.length, 2);

      const text = runCli(["--roots", `${a},${b}`]);
      assert.equal(text.status, 0, text.stderr);
      assert.match(text.stdout, /2 roots \(pooled\)/);
      assert.match(text.stdout, /Pooled roots/);
      assert.ok(text.stdout.includes(a) && text.stdout.includes(b));
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  it("a single --root prints no pooling section and no roots key", () => {
    const a = tmpRoot("cli-single");
    try {
      telemetry.recordEvent(a, "freshness.fresh_hit", {});
      const text = runCli(["--root", a]);
      assert.equal(text.status, 0, text.stderr);
      assert.doesNotMatch(text.stdout, /Pooled roots/);
      const parsed = JSON.parse(runCli(["--root", a, "--json"]).stdout);
      assert.equal(parsed.roots, undefined);
      assert.equal(parsed.rootContributions, undefined);
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
    }
  });

  it("dedupes a repeated root so it cannot double-count itself", () => {
    const a = tmpRoot("cli-dupe");
    try {
      telemetry.recordEvent(a, "retrieval.path_hit", { turn: 900, arm: "armed", tool: "Read" });
      const parsed = JSON.parse(runCli(["--roots", `${a},${a}`, "--json"]).stdout);
      assert.equal(parsed.roots, undefined, "one distinct root is not a pooled read");
      assert.equal(parsed.retrieval.turnsScored, 1);
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
    }
  });

  it("REFUSES to pool the coherence scorecard across roots", () => {
    // Its lifecycle joins key on (taskKey, agentKey), unique only within a repo.
    // Pooling would manufacture cross-repo joins and report integrity defects
    // that do not exist — fail loudly instead.
    const a = tmpRoot("cli-coh-a");
    const b = tmpRoot("cli-coh-b");
    try {
      const res = runCli(["--roots", `${a},${b}`, "--coherence-scorecard"]);
      assert.notEqual(res.status, 0, "must exit non-zero");
      assert.match(res.stderr + res.stdout, /cannot be pooled across roots/);
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  it("REFUSES to record a coherence review against a pooled read", () => {
    const a = tmpRoot("cli-rev-a");
    const b = tmpRoot("cli-rev-b");
    try {
      const res = runCli([
        "--roots", `${a},${b}`,
        "--review", "abc",
        "--verdict", "accurate_useful",
        "--reviewed-findings", "1",
      ]);
      assert.notEqual(res.status, 0);
      assert.match(res.stderr + res.stdout, /single --root/);
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });
});
