'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gateMetrics, compare } = require('./compare');
const { hash, buildRequest } = require('./lab');
const { buildBaselineRequest } = require('./openai-baseline');

function evidence() {
  const cases = [false, true, true, false].map((label, i) => ({ id: `c${i}`, family: 'example', groupId: `g${i}`,
    split: i < 2 ? 'development' : 'holdout', provenance: { kind: 'synthetic' }, rationale: 'Independent label',
    state: { value: i }, questions: { flag: { type: 'noul', instructions: 'Does the value have the requested property?', criteria: { true: 'Present', false: 'Absent' } } }, expected: { flag: label } }));
  const basePlan = cases.map(c => ({ caseId: c.id, requestHash: hash(buildBaselineRequest(c, 'gpt-5.4-mini')) }));
  const jevPlan = cases.map(c => ({ caseId: c.id, variant: 'original', requestHash: hash(buildRequest(c, 'original', 'jev-1.13.0').request) }));
  const baseline = [{ kind: 'manifest', model: 'gpt-5.4-mini', requests: cases.length, corpusSnapshot: cases, corpusHash: hash(cases), plannedTasks: basePlan }];
  const jev = [{ kind: 'manifest', model: 'jev-1.13.0', requests: cases.length, variants: ['original'], corpusSnapshot: cases, corpusHash: hash(cases), plannedTasks: jevPlan }];
  cases.forEach((c, i) => {
    const label = i === 1 ? false : c.expected.flag;
    baseline.push({ kind: 'result', caseId: c.id, requestHash: basePlan[i].requestHash, response: { model: 'gpt-5.4-mini-2026-03-17', labels: { flag: label }, rawDecisionText: JSON.stringify({ flag: label }),
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 }, latencyMs: 1 } });
    jev.push({ kind: 'result', caseId: c.id, variant: 'original', requestHash: jevPlan[i].requestHash, latencyMs: 1,
      response: { model: 'jev-1.13.0', answers: { flag: { type: 'noul', noul: c.expected.flag ? 0.9 : 0.1 } }, usage: { input_tokens: 100, output_tokens: 10 } } });
  });
  return { baseline, jev };
}

test('cascade upper bound charges false acceptance even when routing saves work', () => {
  const rows = [{ miniWrong: true, risk: 0.1 }, { miniWrong: false, risk: 0.9 }];
  const gate = gateMetrics(rows, 0.5);
  assert.equal(gate.retainedErrorRate, 1);
  assert.equal(gate.oracleEscalationAccuracyUpperBound, 0.5);
  assert.equal(gate.escalations, 1);
});

test('paired comparison complements Jev probabilities according to mini answer', () => {
  const { baseline, jev } = evidence();
  const result = compare(baseline, jev);
  assert.equal(result.joinedCases, 4);
  assert.equal(result.miniErrors, 1);
  assert.equal(result.jevErrorsAtHalf, 0);
  assert.equal(result.holdoutAtSelectedThreshold.retainedWrong, 0);
  assert.equal(result.holdoutAtSelectedThreshold.retained, 2);
});

test('mismatched task evidence cannot masquerade as a paired provider comparison', () => {
  const { baseline, jev } = evidence();
  const altered = jev[0].corpusSnapshot.map(c => structuredClone(c));
  altered[0].state.value = 999;
  jev[0].corpusSnapshot = altered;
  jev[0].corpusHash = hash(altered);
  const changedHash = hash(buildRequest(altered[0], 'original', 'jev-1.13.0').request);
  jev[0].plannedTasks[0].requestHash = changedHash;
  jev[1].requestHash = changedHash;
  assert.throws(() => compare(baseline, jev), /Mismatched task/);
});
