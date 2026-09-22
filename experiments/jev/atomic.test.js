'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freeze: typeFreeze } = require('./type-probe');
const { freeze, report, live, validateExperiment } = require('./atomic');

function observed(item, truths = item.expected, model = 'jev-test') {
  return { kind: 'result', id: item.id, requestHash: item.requestHash, latencyMs: 1,
    response: { model, usage: { input_tokens: 100, output_tokens: 20 },
      answers: Object.fromEntries(Object.entries(truths).map(([key, value]) => [key, { type: 'noul', noul: value ? 0.9 : 0.1 }])) } };
}

test('freezes 64 exact label-free requests with three target-specific heads', () => {
  const experiment = freeze(typeFreeze());
  assert.equal(experiment.plan.length, 64);
  validateExperiment(experiment);
  for (const item of experiment.plan) {
    assert.equal(Object.keys(item.request.questions).length, 3);
    assert.doesNotMatch(JSON.stringify(item.request), /oracle|expected|split|groupId|inputIndex/);
    assert.match(item.request.questions.reference_true.instructions, /reference/);
    assert.match(item.request.questions.candidate_true.instructions, /candidate/);
  }
  const corrupted = structuredClone(experiment);
  corrupted.plan[0].expected.changed = !corrupted.plan[0].expected.changed;
  assert.throws(() => validateExperiment(corrupted), /frozen/);
});

test('distinguishes atomic correction from canceled intermediate errors and direct regression', () => {
  const experiment = freeze(typeFreeze());
  const rows = [{ kind: 'manifest', executionKind: 'mock-transport', experiment }];
  for (const [index, item] of experiment.plan.entries()) {
    const truths = { ...item.expected };
    if (index === 0) truths.changed = !truths.changed; // atomic correction
    if (index === 1) truths.reference_true = !truths.reference_true; // atomic regression
    if (index === 2) { truths.reference_true = !truths.reference_true; truths.candidate_true = !truths.candidate_true; }
    rows.push(observed(item, truths));
  }
  const summary = report(rows), metrics = Object.values(summary.byModel['jev-test'].byRepresentation);
  const sum = key => metrics.reduce((total, row) => total + row[key], 0);
  assert.equal(summary.completed, 64); assert.equal(summary.status, 'complete');
  assert.equal(sum('directCorrect'), 63); assert.equal(sum('decomposedCorrect'), 63);
  assert.equal(sum('corrections'), 1); assert.equal(sum('regressions'), 1); assert.equal(sum('inconsistent'), 2);
  assert.equal(metrics.reduce((n, row) => n + row.headCorrect.reference_true, 0), 62);
  assert.equal(metrics.reduce((n, row) => n + row.headCorrect.candidate_true, 0), 63);
  const poisoned = structuredClone(rows);
  poisoned[1].expected = { changed: !experiment.plan[0].expected.changed };
  poisoned[1].representation = 'invented';
  assert.deepEqual(report(poisoned), summary);
  assert.throws(() => report([...rows, rows[1]]), /schedule/);
  assert.throws(() => report([rows[0], rows[2], rows[1]]), /schedule/);
});

test('separates actual models and exposes partial failure with no retry or overwritten evidence', async t => {
  const experiment = freeze(typeFreeze());
  const manifest = { kind: 'manifest', executionKind: 'mock-transport', experiment };
  const partitioned = report([manifest, observed(experiment.plan[0], undefined, 'one'), observed(experiment.plan[1], undefined, 'two')]);
  assert.equal(partitioned.status, 'partial'); assert.equal(Object.keys(partitioned.byModel).length, 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-atomic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'results.jsonl'); let calls = 0;
  const client = { async systemOne() { calls++; if (calls === 2) throw new Error('SECRET_CANARY'); return observed(experiment.plan[0]).response; } };
  await assert.rejects(live(experiment, out, { client }), /partial evidence/);
  const text = fs.readFileSync(out, 'utf8'); assert.doesNotMatch(text, /SECRET_CANARY/);
  const summary = report(text.trim().split('\n').map(JSON.parse));
  assert.equal(summary.completed, 1); assert.equal(summary.errors, 1); assert.equal(summary.unattempted, 62);
  assert.equal(calls, 2); assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  await assert.rejects(live(experiment, out, { client }), error => error.code === 'EEXIST');
  assert.equal(calls, 2);
});
