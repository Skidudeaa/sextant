"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { rerankFiles, rerankAndCapHits, hitCountContribution, HIT_COUNT_WEIGHT } = require("../lib/retrieve");
const C = require("../lib/scoring-constants");

// WHY: these tests lock in the intent of the hit-count contribution added in
// the scoring refinement commit.  The eval harness verifies aggregate impact;
// these verify the specific ordering behavior that future changes could
// regress silently.

test("rerankFiles — higher bestAdjustedHitScore still wins when hit counts are equal", () => {
  const files = [
    { path: "a.js", bestAdjustedHitScore: 500, bestHitScore: 500, hitCount: 1, fanIn: 0 },
    { path: "b.js", bestAdjustedHitScore: 600, bestHitScore: 500, hitCount: 1, fanIn: 0 },
  ];
  const sorted = rerankFiles(files);
  assert.equal(sorted[0].path, "b.js");
  assert.equal(sorted[1].path, "a.js");
});

test("rerankFiles — many-hit file beats single-hit file when bestAdjustedHitScore ties", () => {
  const files = [
    { path: "one-hit.js", bestAdjustedHitScore: 501, bestHitScore: 501, hitCount: 1, fanIn: 0 },
    { path: "many-hit.js", bestAdjustedHitScore: 501, bestHitScore: 501, hitCount: 6, fanIn: 0 },
  ];
  const sorted = rerankFiles(files);
  assert.equal(sorted[0].path, "many-hit.js");
});

test("rerankFiles — hit-count contribution does not override a strong def-site advantage", () => {
  // Simulates a file with def_site_priority + exact_symbol (+65% on base 500 → 825)
  // vs a file with many hits but no special signals (base 500, 10 hits).
  // Definition file should win despite fewer hits.
  const files = [
    { path: "def-site.js", bestAdjustedHitScore: 825, bestHitScore: 500, hitCount: 1, fanIn: 0 },
    { path: "many-mentions.js", bestAdjustedHitScore: 500, bestHitScore: 500, hitCount: 10, fanIn: 0 },
  ];
  const sorted = rerankFiles(files);
  assert.equal(sorted[0].path, "def-site.js");
});

test("hitCountContribution — scales with log1p(hitCount)", () => {
  const oneHit = hitCountContribution({ bestHitScore: 100, hitCount: 1 });
  const tenHit = hitCountContribution({ bestHitScore: 100, hitCount: 10 });
  assert.ok(tenHit > oneHit, "more hits → larger contribution");
  // log1p(1) ≈ 0.693, log1p(10) ≈ 2.398 — tenHit should be ~3.5x oneHit
  assert.ok(tenHit / oneHit > 3, "log-scaled, not linear");
  assert.ok(tenHit / oneHit < 5, "bounded — not a runaway multiplier");
});

test("hitCountContribution — returns zero for zero hits", () => {
  assert.equal(hitCountContribution({ bestHitScore: 500, hitCount: 0 }), 0);
});

test("HIT_COUNT_WEIGHT — is a sane fraction, not an outlier value", () => {
  assert.ok(HIT_COUNT_WEIGHT > 0, "positive weight");
  assert.ok(HIT_COUNT_WEIGHT < 0.5, "not dominating other scoring signals");
});

test("rerankFiles — fan-in tiebreaker still applies when both primary scores tie exactly", () => {
  // Hit count equal AND bestAdjustedHitScore equal → fanIn breaks the tie.
  const files = [
    { path: "low-fanin.js", bestAdjustedHitScore: 500, bestHitScore: 500, hitCount: 2, fanIn: 1 },
    { path: "high-fanin.js", bestAdjustedHitScore: 500, bestHitScore: 500, hitCount: 2, fanIn: 10 },
  ];
  const sorted = rerankFiles(files);
  assert.equal(sorted[0].path, "high-fanin.js");
});

test("rerankAndCapHits — hotspot gate: strips +15% boost when no hit has def-site match", () => {
  // Simulates a variable-name query ("resolutionPct") where no hit is a
  // symbol definition.  Compare a hotspot file and a non-hotspot file — after
  // the gate fires, the hotspot's adjustedScore should be close to the
  // non-hotspot's (both have the same base score of 500, no other signals).
  const hits = [
    { path: "hub.js", line: "return obj.resolutionPct;", score: 500 },
    { path: "non-hub.js", line: "console.log(resolutionPct);", score: 500 },
  ];
  const fileByPath = new Map([
    ["hub.js", { path: "hub.js", isHotspot: true, fanIn: 0 }],
    ["non-hub.js", { path: "non-hub.js", isHotspot: false, fanIn: 0 }],
  ]);
  const out = rerankAndCapHits(hits, fileByPath, {
    useGraphBoost: true,
    maxHits: 10,
    hitsPerFileCap: 5,
    queryTerms: ["resolutionPct"],
  });
  const hubHit = out.find((h) => h.path === "hub.js");
  const nonHubHit = out.find((h) => h.path === "non-hub.js");
  // Gate fired → hotspot score collapsed to non-hotspot level (within rounding).
  assert.ok(
    Math.abs(hubHit.adjustedScore - nonHubHit.adjustedScore) < 1,
    `hotspot score ${hubHit.adjustedScore} should collapse to non-hotspot ${nonHubHit.adjustedScore} after gate`
  );
});

test("rerankAndCapHits — hotspot boost preserved when any hit has def-site match", () => {
  // If any hit is a true definition site (function/class whose name matches
  // the query), the gate does NOT fire — the existing suppression path
  // handles non-def files instead.  The hotspot def-file keeps its boost.
  const hits = [
    { path: "hub.js", line: "function myFunc() {}", score: 500 },
    { path: "other.js", line: "myFunc();", score: 500 },
  ];
  const fileByPath = new Map([
    ["hub.js", { path: "hub.js", isHotspot: true, fanIn: 0 }],
    ["other.js", { path: "other.js", isHotspot: false, fanIn: 0 }],
  ]);
  const out = rerankAndCapHits(hits, fileByPath, {
    useGraphBoost: true,
    maxHits: 10,
    hitsPerFileCap: 5,
    queryTerms: ["myFunc"],
  });
  const hubHit = out.find((h) => h.path === "hub.js");
  // hub.js is def-site + hotspot → adjustedScore > base (hotspot +15% preserved,
  // plus def_site_priority +25%, plus exact_symbol +40%, plus defline +3%,
  // plus symbol_contains_query +12% = ~+95% on 500 = ~975).
  assert.ok(hubHit.adjustedScore > 500 * 1.50, `def-site hotspot should keep multi-signal boost, got ${hubHit.adjustedScore}`);
});
