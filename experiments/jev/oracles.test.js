"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { cases } = require("./cases");
const { runOracles, compareIntentBaseline } = require("./oracles");

test("32 authored labels agree with independently executed code and protocol checks", async () => {
  const report = await runOracles();
  assert.equal(report.verifiedCount, 32);
  assert.equal(report.unexecutedCount, 96);
  assert.deepEqual(report.mismatches, []);
  assert.equal(new Set(report.verified.map(row => row.family)).size, 4);
});

test("oracle catches a flipped label instead of reading expected as its answer", async () => {
  const row = structuredClone(cases.find(row => row.id === "behavior_change/boundary/b"));
  row.expected.flag = false;
  const report = await runOracles([row]);
  assert.equal(report.mismatches.length, 1);
  assert.equal(report.mismatches[0].observedFlag, true);
});

test("oracle catches observation changes independently of the unchanged label", async () => {
  const row = structuredClone(cases.find(row => row.id === "cross_file_invariant/field-rename/b"));
  row.state.observation.consumer = "record(value.turnId);";
  const report = await runOracles([row]);
  assert.equal(report.mismatches.length, 1);
  assert.equal(report.mismatches[0].observedFlag, false);
});

test("passing constructor test must use real initialization to kill the constructor mutation", async () => {
  const report = await runOracles(cases.filter(row => row.groupId === "test_gap/real-constructor"));
  const useful = report.verified.find(row => row.id.endsWith("/a"));
  const bypass = report.verified.find(row => row.id.endsWith("/b"));
  assert.equal(useful.evidence.before.passed, false);
  assert.equal(useful.evidence.after.passed, true);
  assert.equal(bypass.evidence.before.passed, true);
  assert.equal(bypass.evidence.after.passed, true);
});

test("type-only runtime semantics remain distinct from Sextant's current import graph", async () => {
  const report = await runOracles(cases.filter(row => row.groupId === "dependency_edge/type-only"));
  assert.equal(report.verified[0].evidence.runtimeImport, false);
  assert.equal(report.verified[0].evidence.sextantGraphImports[0].kind, "import");
  assert.deepEqual(report.mismatches, []);
});

test("intent baseline records actual classifier output without treating it as label authority", () => {
  const report = compareIntentBaseline();
  assert.equal(report.length, 8);
  assert.ok(report.every(row => typeof row.retrieve === "boolean"));
  const explicit = report.filter(row => row.id.includes("explicit-code"));
  assert.ok(explicit.every(row => row.agrees));
  assert.ok(report.every(row => row.note.includes("not independent verification")));
});
