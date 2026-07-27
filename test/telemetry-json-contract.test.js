"use strict";

// TELEMETRY --json CONTRACT (docs/035 #10).
//
// The defect this locks: `sextant telemetry --json` emitted bare
// `benefitDelta` / `turnBenefitDelta` / `regionBenefitDelta` with ZERO sibling
// gate keys, while the human surface on the IDENTICAL bytes printed DORMANT.
// The volume gate existed in three independent re-implementations (the human
// open-precision render, the human turn render, and
// scripts/check-holdback-benefit.sh) and had already diverged once — the cron
// gated on scored OPENS only, so it would have published
// "BENEFIT READY … benefitDelta = -41.5pts" off ONE randomized holdback turn.
// The only thing binding a JSON consumer to the floors was prose in CLAUDE.md.
//
// The test is REFLECTIVE on purpose. An assertion naming the three known deltas
// would not have caught `regionBenefitDelta`, which shipped ungated and was
// missed by every reviewer of the original finding. Anything ending in
// `BenefitDelta` must carry a `…BenefitDeltaGate` sibling, so a fourth delta
// cannot be added without one.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { summarize } = require("../commands/telemetry");

// Minimal synthetic event stream: one armed hit, one holdback miss. Enough to
// make every delta computable (both arms present) and nothing near the floors,
// which is precisely the state in which a bare number is most misleading.
// `turn` must be a NUMBER: summarize() gates on Number.isFinite(e.turn) and
// routes anything else to turnUnscoredOpens, so string ids score nothing.
// Events are FLAT on disk — {ts, name, ...fields} — not {ts, name, data}.
function ev(name, fields, ts) {
  return Object.assign({ ts: ts || 1777516546853, name }, fields);
}

function bothArmsStream() {
  return [
    ev("retrieval.path_hit", { source: "path_match", tool: "Read", arm: "armed", turn: 1001 }),
    ev("retrieval.path_miss", { tool: "Read", arm: "holdback", turn: 1002 }),
    ev("retrieval.region_hit", { source: "path_match", tool: "Edit", arm: "armed", turn: 1001 }),
    ev("retrieval.region_miss", { tool: "Edit", arm: "holdback", turn: 1002 }),
  ];
}

// Walk every plain object in the summary and collect key paths.
function walk(node, path, out) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return out;
  for (const [k, v] of Object.entries(node)) {
    const p = path ? `${path}.${k}` : k;
    out.push({ path: p, key: k, value: v, parent: node });
    walk(v, p, out);
  }
  return out;
}

describe("telemetry --json contract — every benefit delta ships its gate", () => {
  it("every *BenefitDelta key has a sibling *BenefitDeltaGate", () => {
    const s = summarize(bothArmsStream());
    const nodes = walk(s, "", []);
    // [Bb] on purpose: the top-level field is `benefitDelta`, so a
    // capital-only pattern would silently match 2 of 3 and pass.
    const deltas = nodes.filter((n) => /[Bb]enefitDelta$/.test(n.key));

    // Guard the guard: if the deltas are ever renamed, this test must fail
    // loudly rather than silently passing over an empty set.
    assert.ok(deltas.length >= 3, `expected >=3 *BenefitDelta keys, found ${deltas.length}`);

    for (const d of deltas) {
      const gateKey = `${d.key}Gate`;
      assert.ok(
        Object.prototype.hasOwnProperty.call(d.parent, gateKey),
        `${d.path} has no sibling ${gateKey} — a consumer can read the number ` +
          `without the floors that make it citable`
      );
      const gate = d.parent[gateKey];
      assert.equal(typeof gate, "object", `${gateKey} must be an object`);
      assert.equal(typeof gate.atVolume, "boolean", `${gateKey}.atVolume must be a boolean`);
      assert.ok(
        ["NO_ARM", "DORMANT", "SPANS_ZERO", "AT_VOLUME"].includes(gate.status),
        `${gateKey}.status was ${JSON.stringify(gate.status)}`
      );
    }
  });

  it("reports DORMANT, not a citable delta, at n=1 per arm", () => {
    const s = summarize(bothArmsStream());
    const r = s.retrieval;

    // The numbers themselves still exist — four assertions in
    // test/hook-holdback.test.js and the cron's own `td * 100` depend on them.
    assert.equal(typeof r.benefitDelta, "number");
    assert.equal(r.benefitDeltaGate.atVolume, false);
    assert.equal(r.benefitDeltaGate.status, "DORMANT");
    assert.equal(r.benefitDeltaGate.minScored, 30);
    assert.equal(r.benefitDeltaGate.minTurns, 30);

    assert.equal(r.turnBenefitDeltaGate.atVolume, false);
    assert.equal(r.turnBenefitDeltaGate.status, "DORMANT");

    // The lane the original finding missed.
    assert.equal(r.regionBenefitDeltaGate.atVolume, false);
    assert.equal(r.regionBenefitDeltaGate.status, "DORMANT");
  });

  it("reports NO_ARM when the holdback arm never ran (a normal install)", () => {
    const s = summarize([
      ev("retrieval.path_hit", { source: "path_match", tool: "Read", arm: "armed", turn: 1001 }),
      ev("retrieval.path_miss", { tool: "Read", arm: "armed", turn: 1001 }),
    ]);
    const r = s.retrieval;
    assert.equal(r.benefitDelta, null);
    assert.equal(r.benefitDeltaGate.status, "NO_ARM");
    assert.equal(r.benefitDeltaGate.atVolume, false);
    assert.equal(r.turnBenefitDeltaGate.status, "NO_ARM");
  });

  it("the per-OPEN gate carries no interval; the turn gate is where it lives", () => {
    // Within-turn opens are correlated (~28/turn on the dogfood repo), so a
    // binomial interval over opens would understate its own width — the exact
    // analysis-unit error the gate exists to prevent.
    const s = summarize(bothArmsStream());
    assert.equal(s.retrieval.benefitDeltaGate.ci, null);
    assert.equal(s.retrieval.benefitDeltaGate.spansZero, null);
    assert.ok("ci" in s.retrieval.turnBenefitDeltaGate);
    assert.ok("spansZero" in s.retrieval.turnBenefitDeltaGate);
  });

  it("clears to AT_VOLUME or SPANS_ZERO only when BOTH floors are met", () => {
    // 30 turns per arm, every armed turn a hit and every holdback turn a miss:
    // a +100pt separation, the one case whose interval cannot span zero.
    const events = [];
    for (let i = 0; i < 30; i++) {
      events.push(
        ev("retrieval.path_hit", {
          source: "path_match",
          tool: "Read",
          arm: "armed",
          turn: 2000 + i,
        })
      );
      events.push(
        ev("retrieval.path_miss", { tool: "Read", arm: "holdback", turn: 3000 + i })
      );
    }
    const g = summarize(events).retrieval;
    assert.equal(g.turnBenefitDeltaGate.atVolume, true);
    assert.equal(g.turnBenefitDeltaGate.status, "AT_VOLUME");
    assert.equal(g.turnBenefitDeltaGate.spansZero, false);
    assert.ok(g.turnBenefitDeltaGate.ci);

    // The per-OPEN gate clears too here (30 opens AND 30 turns per arm) — the
    // point of the both-floors rule is that 30 opens in ONE turn would NOT.
    assert.equal(g.benefitDeltaGate.atVolume, true);

    const oneTurn = [];
    for (let i = 0; i < 30; i++) {
      oneTurn.push(
        ev("retrieval.path_hit", {
          source: "path_match",
          tool: "Read",
          arm: "armed",
          turn: 2000,
        })
      );
      oneTurn.push(ev("retrieval.path_miss", { tool: "Read", arm: "holdback", turn: 3000 }));
    }
    const concentrated = summarize(oneTurn).retrieval;
    assert.equal(concentrated.benefitDeltaGate.armedScored, 30);
    assert.equal(concentrated.benefitDeltaGate.armedTurns, 1);
    assert.equal(
      concentrated.benefitDeltaGate.atVolume,
      false,
      "30 opens concentrated in 1 turn/arm must NOT clear the gate"
    );
  });
});
