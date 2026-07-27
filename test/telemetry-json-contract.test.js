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

// ─── THE FUNNEL + THE DOMINANCE GUARD (docs/035 #1) ─────────────────────────

describe("retrieval funnel — turn_outcome rows", () => {
  const outcome = (fields) => ev("retrieval.turn_outcome", fields);

  it("counts every exit, so turns cannot vanish from the funnel", () => {
    const s = summarize([
      outcome({ turn: 1, arm: "armed", status: "delivered", blockBytes: 500, surfacedCount: 3, surfacedBySource: { path_match: 3 }, sid: "a" }),
      outcome({ turn: 2, arm: "armed", status: "deduped", blockBytes: 0, surfacedCount: 3, surfacedBySource: { path_match: 3 }, sid: "a" }),
      outcome({ turn: 3, arm: "holdback", status: "holdback", blockBytes: 0, surfacedCount: 2, surfacedBySource: { exported_symbol: 2 }, sid: "b" }),
      outcome({ turn: 4, arm: null, status: "empty", blockBytes: 0, surfacedCount: 0, surfacedBySource: {}, sid: "b", graphEmpty: true }),
    ]);
    assert.deepEqual(s.retrieval.turnOutcomes, { delivered: 1, deduped: 1, holdback: 1, empty: 1 });
    // The byte cost that `grep -c blockBytes` returned 0 for.
    assert.equal(s.retrieval.blockBytes.total, 500);
    assert.equal(s.retrieval.blockBytes.injections, 1);
    assert.equal(s.retrieval.emptyDiagnosis.total, 1);
    assert.equal(s.retrieval.emptyDiagnosis.graphEmpty, 1);
  });

  it("surfacedBySource is a DISTINCT field from injectedBySource", () => {
    // The two vocabularies collide on the token `text_only`:
    // injected.source ∈ {graph_merged, text_only}; path_hit.source ∈
    // {path_match, exported_symbol, text_only, …}. Joining them would emit a
    // silently wrong per-source rate.
    const s = summarize([
      ev("retrieval.injected", { source: "text_only", fileCount: 2 }),
      outcome({ turn: 1, arm: "armed", status: "delivered", blockBytes: 10, surfacedCount: 2, surfacedBySource: { path_match: 2 }, sid: "a" }),
    ]);
    assert.deepEqual(s.retrieval.injectedBySource, { text_only: 1 });
    assert.deepEqual(s.retrieval.surfacedBySource, { path_match: 2 });
  });

  it("scopes the per-source numerator to turns that carry a funnel row", () => {
    // FAIL-pre observed live: all-time hits over a since-ship denominator
    // printed "268.8% opened". Numerator and denominator must cover the same
    // turns or the rate is not a rate.
    const s = summarize([
      // A historical hit on a turn with NO funnel row — must not be counted.
      ev("retrieval.path_hit", { source: "path_match", tool: "Read", arm: "armed", turn: 999 }),
      outcome({ turn: 1, arm: "armed", status: "delivered", blockBytes: 10, surfacedCount: 4, surfacedBySource: { path_match: 4 }, sid: "a" }),
      ev("retrieval.path_hit", { source: "path_match", tool: "Read", arm: "armed", turn: 1 }),
    ]);
    assert.equal(s.retrieval.pathHitsBySource.path_match, 2, "all-time composition keeps both");
    assert.equal(s.retrieval.hitsBySourceScoped.path_match, 1, "scoped numerator keeps only the joined one");
    const rate = s.retrieval.hitsBySourceScoped.path_match / s.retrieval.surfacedBySource.path_match;
    assert.ok(rate <= 1, `a rate must not exceed 1, got ${rate}`);
  });

  it("flags a session that drew BOTH arms", () => {
    const s = summarize([
      outcome({ turn: 1, arm: "armed", status: "delivered", blockBytes: 1, surfacedCount: 1, surfacedBySource: {}, sid: "same" }),
      outcome({ turn: 2, arm: "holdback", status: "holdback", blockBytes: 0, surfacedCount: 1, surfacedBySource: {}, sid: "same" }),
      outcome({ turn: 3, arm: "armed", status: "delivered", blockBytes: 1, surfacedCount: 1, surfacedBySource: {}, sid: "clean" }),
    ]);
    assert.equal(s.retrieval.sessionsSeen, 2);
    assert.equal(s.retrieval.contaminatedSessions, 1);
  });
});

describe("pooling dominance guard", () => {
  const hit = (turn, arm, root) => {
    const e = ev("retrieval.path_hit", { source: "path_match", tool: "Read", arm, turn });
    if (root) e.__root = root;
    return e;
  };

  it("refuses a delta when the arms are drawn from different repos", () => {
    // The live fleet shape: holdback is 100% one repo, armed is ~92% others.
    // The printed contrast would be BETWEEN REPOS, not between arms.
    const events = [];
    for (let i = 0; i < 40; i++) events.push(hit(1000 + i, "armed", "/root/repoA"));
    for (let i = 0; i < 40; i++) events.push(hit(2000 + i, "holdback", "/root/repoB"));
    const r = summarize(events).retrieval;
    assert.equal(r.armComposition.confounded, true);
    assert.ok(r.armComposition.tvd >= 0.5, `tvd ${r.armComposition.tvd}`);
    assert.equal(r.turnBenefitDeltaGate.status, "CONFOUNDED");
    assert.equal(r.turnBenefitDeltaGate.atVolume, false, "volume must not override a confound");
    assert.equal(r.benefitDeltaGate.status, "CONFOUNDED");
  });

  it("allows a delta when both arms draw from the same repos", () => {
    const events = [];
    for (let i = 0; i < 40; i++) {
      events.push(hit(1000 + i, "armed", "/root/repoA"));
      events.push(hit(2000 + i, "holdback", "/root/repoA"));
    }
    const r = summarize(events).retrieval;
    assert.equal(r.armComposition.confounded, false);
    assert.equal(r.armComposition.tvd, 0);
    assert.notEqual(r.turnBenefitDeltaGate.status, "CONFOUNDED");
  });

  it("a single-root read is never confounded by this measure", () => {
    const events = [];
    for (let i = 0; i < 5; i++) {
      events.push(hit(1000 + i, "armed", null));
      events.push(hit(2000 + i, "holdback", null));
    }
    const r = summarize(events).retrieval;
    assert.equal(r.armComposition.confounded, false);
  });
});
