"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { cases } = require("./cases");

test("corpus has 64 independent scenario pairs across 16 task families", () => {
  assert.equal(cases.length, 128);
  assert.equal(new Set(cases.map(c => c.id)).size, cases.length);
  assert.equal(new Set(cases.map(c => c.family)).size, 16);
  const groups = Map.groupBy(cases, c => c.groupId);
  assert.equal(groups.size, 64);
  for (const [id, pair] of groups) {
    assert.equal(pair.length, 2, id);
    assert.deepEqual(pair.map(c => c.expected.flag).sort(), [false, true], id);
    assert.deepEqual(pair[0].state.context, pair[1].state.context, id);
    assert.notDeepEqual(pair[0].state.observation, pair[1].state.observation, id);
    assert.deepEqual(pair[0].questions, pair[1].questions, id);
  }
});

test("no scenario leaks across development and holdout; four families are fully held out", () => {
  const groupSplits = new Map();
  for (const item of cases) {
    if (!groupSplits.has(item.groupId)) groupSplits.set(item.groupId, item.split);
    assert.equal(groupSplits.get(item.groupId), item.split, item.id);
  }
  const families = Map.groupBy(cases, c => c.family);
  const familyHoldouts = [...families.values()].filter(rows => rows.every(c => c.holdoutReason === "family"));
  assert.equal(familyHoldouts.length, 4);
  assert.equal(cases.filter(c => c.split === "development").length, 48);
  assert.equal(cases.filter(c => c.split === "holdout").length, 80);
  for (const split of ["development", "holdout"]) {
    const rows = cases.filter(c => c.split === split);
    assert.equal(rows.filter(c => c.expected.flag).length, rows.length / 2);
  }
});

test("HTTP questions are self-contained and labels remain outside provider input", () => {
  for (const item of cases) {
    assert.deepEqual(Object.keys(item.questions), Object.keys(item.expected));
    assert.deepEqual(Object.keys(item.state).sort(), ["context", "observation"]);
    for (const question of Object.values(item.questions)) {
      assert.equal(question.type, "noul");
      assert.equal(typeof question.instructions.question, "string");
      assert.ok(question.instructions.question.includes("context"), item.id);
      assert.ok(question.instructions.question.includes("observation"), item.id);
      assert.equal(typeof question.criteria.true, "string");
      assert.equal(typeof question.criteria.false, "string");
    }
    assert.ok(item.rationale.length > 30, item.id);
    assert.deepEqual(JSON.parse(JSON.stringify(item)).state, item.state);
  }
});

test("repository examples are explicitly pinned to source paths that exist in the cited revision", () => {
  const rows = cases.filter(c => c.provenance.kind === "repository");
  assert.equal(rows.length, 16);
  const root = path.resolve(__dirname, "../..");
  const checked = new Set();
  for (const row of rows) {
    assert.match(row.provenance.revision, /^[a-f0-9]{40}$/);
    for (const reference of row.provenance.source.split(";")) {
      const [file, line] = reference.split(":");
      const key = `${row.provenance.revision}:${file}`;
      if (checked.has(key)) continue;
      const source = execFileSync("git", ["show", key], { cwd: root, encoding: "utf8" });
      assert.ok(source.split("\n").length >= Number(line), reference);
      checked.add(key);
    }
  }
  assert.equal(cases.filter(c => c.provenance.kind === "synthetic").length, 112);
});

test("repository semantic controls remain grounded in their named implementation", () => {
  const { shouldRetrieve } = require("../../lib/classifier");
  const { formatRetrievalDetailed } = require("../../lib/format-retrieval");
  const { worksetOverlap } = require("../../lib/coherence");
  assert.equal(shouldRetrieve("!npm test").retrieve, false);
  assert.equal(shouldRetrieve("/help").retrieve, false);
  const formatted = formatRetrievalDetailed({ files: [{ path: "lib/example.js", graphSignal: "exported_symbol", matchedTerms: ["parse"], fanIn: 10, zoektHit: { line: "const parse = config.parser;" } }] }, { textOnly: true });
  assert.doesNotMatch(formatted.text, /exports parse|fan-in/);
  assert.equal(formatted.files.length, 1);
  assert.deepEqual(worksetOverlap({}, {}), { sharedPaths: [], sharedRegions: [], sharedPathTotal: 0, sharedRegionTotal: 0 });
});
