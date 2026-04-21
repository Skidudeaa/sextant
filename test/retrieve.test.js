"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { rerankFiles, hitCountContribution, HIT_COUNT_WEIGHT } = require("../lib/retrieve");

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
