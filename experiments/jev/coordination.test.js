'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const lab = require('./lab');
const { buildCases, plan, replay, summarize, live } = require('./coordination');

function result(c, model = 'jev-1.13.0') {
  return { kind: 'result', caseId: c.id, variant: 'original', requestHash: lab.hash(lab.buildRequest(c, 'original', 'jev-1.13.0').request),
    latencyMs: 1, response: { model, usage: { input_tokens: 10, output_tokens: 0 },
      answers: Object.fromEntries(Object.entries(c.expected).map(([id, expected]) => [id, { type: 'noul', noul: expected ? 0.9 : 0.1 }])) } };
}

test('32 protocol fixtures execute all four combinations and have balanced interaction controls', () => {
  const cases = buildCases();
  assert.equal(cases.length, 32);
  assert.equal(new Set(cases.map(c => c.family)).size, 8);
  for (const c of cases) {
    assert.equal(c.split, 'development');
    assert.notEqual(c.state.agent_A.path, c.state.agent_B.path);
    assert.notEqual(c.state.agent_A.baseline_function, c.state.agent_A.edited_function);
    assert.notEqual(c.state.agent_B.baseline_function, c.state.agent_B.edited_function);
    assert.deepEqual(Object.keys(c.oracle).sort(), ['A_only', 'B_only', 'baseline', 'merged']);
    const sameA = isDeepStrictEqual(c.oracle.baseline, c.oracle.A_only);
    const sameB = isDeepStrictEqual(c.oracle.baseline, c.oracle.B_only);
    const sameMerged = isDeepStrictEqual(c.oracle.baseline, c.oracle.merged);
    assert.equal(c.expected.joint_regression, !sameMerged);
    assert.equal(c.expected.emergent_conflict, sameA && sameB && !sameMerged);
    assert.equal(c.expected.mutual_repair, !sameA && !sameB && sameMerged);
  }
  for (const [name, gold] of [
    ['mutual-repair', { joint_regression: false, emergent_conflict: false, mutual_repair: true }],
    ['emergent-conflict', { joint_regression: true, emergent_conflict: true, mutual_repair: false }],
    ['one-sided-regression', { joint_regression: true, emergent_conflict: false, mutual_repair: false }],
    ['benign-pair', { joint_regression: false, emergent_conflict: false, mutual_repair: false }],
  ]) {
    const group = cases.filter(c => c.id.endsWith('/' + name));
    assert.equal(group.length, 8);
    for (const c of group) assert.deepEqual(c.expected, gold, c.id);
  }
});

test('independent hand-computed unit protocol results establish emergence and repair', () => {
  const cases = buildCases();
  const returnNumber = value => ({ kind: 'return', value: { type: 'number', value } });
  const emergence = cases.find(c => c.id === 'coordination/units/emergent-conflict');
  assert.deepEqual(emergence.oracle, { baseline: returnNumber(2000), A_only: returnNumber(2000), B_only: returnNumber(2000), merged: returnNumber(2000000) });
  const repair = cases.find(c => c.id === 'coordination/units/mutual-repair');
  assert.deepEqual(repair.oracle.baseline, returnNumber(2000));
  assert.deepEqual(repair.oracle.A_only, returnNumber('NaN'));
  assert.deepEqual(repair.oracle.B_only, { kind: 'return', value: { type: 'undefined' } });
  assert.deepEqual(repair.oracle.merged, returnNumber(2000));
});

test('undefined, exceptions and null are not serialized into a fake common outcome', () => {
  const c = buildCases().find(c => c.id === 'coordination/metadata_validation/mutual-repair');
  assert.deepEqual(c.oracle.baseline, { kind: 'return', value: { type: 'number', value: 9 } });
  assert.deepEqual(c.oracle.A_only, { kind: 'return', value: { type: 'undefined' } });
  assert.deepEqual(c.oracle.B_only, { kind: 'throw', name: 'TypeError' });
  assert.deepEqual(c.oracle.merged, c.oracle.baseline);
});

test('provider sees literal input and code but no outputs, expected labels or scenario identities', () => {
  for (const c of buildCases()) {
    const { request } = lab.buildRequest(c, 'original', 'jev-1.13.0');
    assert.equal(typeof request.state.input_literal, 'string');
    assert.deepEqual(Object.keys(request).sort(), ['model', 'questions', 'state']);
    assert.deepEqual(Object.keys(request.state).sort(), ['agent_A', 'agent_B', 'comparison_contract', 'execution_contract', 'input_literal', 'language']);
    const wire = JSON.stringify(request);
    for (const field of ['oracle', 'expected', 'sourceHash', 'provenance', 'rationale']) assert.equal(wire.includes(`"${field}"`), false);
    assert.equal(wire.includes(c.id), false);
    for (const q of Object.values(request.questions)) assert.match(q.instructions, /exact/);
  }
});

test('same seed produces identical plans and different seed changes order', () => {
  const a = plan({ seed: 1 }), b = plan({ seed: 1 }), c = plan({ seed: 2 });
  assert.deepEqual(a.manifest.plannedTasks, b.manifest.plannedTasks);
  assert.notDeepEqual(a.manifest.plannedTasks, c.manifest.plannedTasks);
  assert.equal(a.manifest.corpusHash, b.manifest.corpusHash);
  assert.throws(() => plan({ seed: -1 }), /uint32/);
});

test('strict replay derives cached predictions and exposes partial plan accounting', () => {
  const { manifest, ordered } = plan();
  const r = result(ordered[0]);
  r.predictions = [{ qid: 'invented', expected: true, p: 1 }];
  const validated = replay([manifest, r]);
  assert.equal(validated[1].predictions.length, 3);
  assert.ok(validated[1].predictions.every(p => p.qid !== 'invented'));
  const measured = summarize([manifest, r]);
  assert.equal(measured.status, 'partial-provider-results');
  assert.equal(measured.completedRequests, 1);
  assert.equal(measured.unattemptedRequests, 31);
});

test('oracle and source tampering cannot become fresh truth by recomputing corpus hash', () => {
  for (const change of [
    c => { c.expected.joint_regression = !c.expected.joint_regression; },
    c => { c.oracle.merged = c.oracle.baseline; c.expected.joint_regression = false; },
    c => { c.state.agent_A.edited_function = 'x => ({ value: 100 })'; c.provenance.sourceHash = lab.hash(c.state); },
  ]) {
    const { manifest } = plan();
    const c = manifest.corpusSnapshot.find(c => c.expected.joint_regression);
    change(c); manifest.corpusHash = lab.hash(manifest.corpusSnapshot);
    assert.throws(() => replay([manifest]), /source|labels/);
  }
  const { manifest } = plan(); manifest.sourceHash = 'changed';
  assert.throws(() => replay([manifest]), /fingerprint/);
});

test('frozen seed order, duplicate attempts and malformed answers are rejected', () => {
  const { manifest, ordered } = plan();
  const a = result(ordered[0]), b = result(ordered[1]);
  assert.throws(() => replay([manifest, b, a]), /order/);
  assert.throws(() => replay([manifest, a, a]), /Duplicate/);
  const altered = structuredClone(manifest); altered.plannedTasks.reverse();
  assert.throws(() => replay([altered]), /seed/);
  delete a.response.answers.mutual_repair;
  assert.throws(() => replay([manifest, a]), /every requested/);
});

test('perfect semantic answers beat the explicitly blind path-overlap comparator', () => {
  const { manifest, ordered } = plan();
  const measured = summarize([manifest, ...ordered.map(c => result(c))]);
  assert.equal(measured.status, 'completed-provider-results');
  assert.equal(measured.allThreeCorrect, 32);
  assert.equal(measured.contradictoryDecisions, 0);
  for (const head of Object.values(measured.perHead)) assert.equal(head.accuracy, 1);
  assert.equal(measured.pathOverlapComparator.accuracy, 0.5);
  assert.equal(measured.pathOverlapComparator.fn, 16);
});

test('contradictory heads are surfaced and mixed returned models are never pooled', () => {
  const { manifest, ordered } = plan();
  const rows = ordered.map(c => result(c));
  rows[0].response.answers.joint_regression.noul = 0.1;
  rows[0].response.answers.emergent_conflict.noul = 0.9;
  assert.equal(summarize([manifest, ...rows]).contradictoryDecisions, 1);
  rows[1].response.model = 'jev-other';
  const mixed = summarize([manifest, ...rows]);
  assert.equal(mixed.status, 'mixed-model-results-partitioned');
  assert.equal(mixed.perHead, undefined);
  assert.equal(Object.keys(mixed.byModel).length, 2);
});

test('offline injected transport writes private raw evidence and a replayable completed report', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-coordination-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cases = buildCases();
  const byState = new Map(cases.map(c => [lab.hash(c.state), c]));
  const output = path.join(directory, 'run.jsonl');
  let calls = 0;
  await live(output, { client: { async systemOne(request) { calls++; return result(byState.get(lab.hash(request.state))).response; } } });
  assert.equal(calls, 32);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  const records = fs.readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.at(-1).kind, 'summary');
  assert.equal(summarize(records).allThreeCorrect, 32);
});

test('terminal provider failure remains visible with failed and unattempted counts', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-coordination-fail-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'run.jsonl');
  await assert.rejects(live(output, { client: { async systemOne() { throw new Error('OFFLINE_SENTINEL'); } } }), /OFFLINE_SENTINEL/);
  const text = fs.readFileSync(output, 'utf8');
  assert.equal(text.includes('OFFLINE_SENTINEL'), false);
  const records = text.trim().split('\n').map(JSON.parse);
  assert.equal(records.at(-1).errors, 1);
  assert.equal(records.at(-1).unattemptedRequests, 31);
  assert.equal(records.at(-1).completedRequests, 0);
});

test('CLI inspect parses seed and model without a credential or provider call', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'coordination.js'), 'inspect', '--seed', '7', '--model', 'jev-test'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(result.status, 0, result.stderr);
  const inspected = JSON.parse(result.stdout);
  assert.equal(inspected.seed, 7);
  assert.equal(inspected.model, 'jev-test');
  assert.equal(inspected.cases, 32);
  assert.equal(inspected.providerCalls, 0);
});
