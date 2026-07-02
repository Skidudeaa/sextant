"use strict";

// `sextant tune` — the R3 fallback (docs/016): reporting-only per-source
// diagnostics.  These tests lock the two properties that make it honest:
// correct Wilson intervals at small-n extremes, and the reporting-only
// framing in the human output.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { wilson95, printTune, PRIOR_MIN_N } = require("../commands/tune");

describe("tune — wilson95", () => {
  it("matches known values (42/540 ≈ [5.8%, 10.3%] — the R3 path_match row)", () => {
    const ci = wilson95(42, 540);
    assert.ok(Math.abs(ci.lo - 0.0581) < 0.002, `lo=${ci.lo}`);
    assert.ok(Math.abs(ci.hi - 0.1035) < 0.002, `hi=${ci.hi}`);
  });

  it("does not degenerate at 0/n extremes (the exported_symbol trap)", () => {
    const ci = wilson95(0, 19);
    assert.equal(ci.lo, 0);
    assert.ok(ci.hi > 0.15 && ci.hi < 0.2, `0/19 upper bound must be ~17%, got ${ci.hi}`);
  });

  it("returns null on empty n", () => {
    assert.equal(wilson95(0, 0), null);
  });
});

describe("tune — printTune framing", () => {
  const report = {
    projectsRoot: "/p",
    repoFilter: null,
    sessionsWithInjection: 50,
    sessionsScanned: 72,
    repos: ["a", "b"],
    priorMinN: PRIOR_MIN_N,
    sources: [
      { source: "path_match", surfaced: 540, opened: 42, openRatePct: 7.78, wilson95Pct: { lo: 5.81, hi: 10.35 }, priorEligible: true },
      { source: "exported_symbol", surfaced: 19, opened: 0, openRatePct: 0, wilson95Pct: { lo: 0, hi: 16.82 }, priorEligible: false },
    ],
    mode: "reporting-only",
  };

  it("leads with REPORTING ONLY and carries the rejected-tuning rationale", () => {
    const out = printTune(report);
    assert.match(out, /REPORTING ONLY/);
    assert.match(out, /No scoring weight reads this table/);
    assert.match(out, /docs\/016-phase0-recon\.md/);
  });

  it("marks thin sources as prior-ineligible", () => {
    const out = printTune(report);
    assert.match(out, /exported_symbol.*NO/s);
    assert.match(out, /path_match.*yes/s);
  });

  it("handles an empty corpus without throwing", () => {
    const out = printTune({ ...report, sources: [] });
    assert.match(out, /No retrieval injections found/);
  });
});
