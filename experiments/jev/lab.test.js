'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hash, shuffle, validateCases, buildRequest, predictions, metrics, selectiveRisk, summarize, replay, parseArgs } = require('./lab');

function fixture() {
  return { id: 'one', family: 'support', groupId: 'pair', split: 'development', provenance: { kind: 'synthetic' }, rationale: 'LABEL_ONLY_SENTINEL',
    state: { source: 'The timeout is 30 seconds.' }, questions: { flag: { type: 'noul', instructions: 'Does the source specify a 10 second timeout?', criteria: { true: '10 seconds specified', false: '10 seconds not specified' } } }, expected: { flag: false } };
}

test('scenario groups cannot leak across evaluation splits', () => {
  const c = fixture();
  validateCases([c]);
  assert.throws(() => validateCases([c, { ...c, id: 'two', split: 'holdout' }]), /leakage/);
  assert.throws(() => validateCases([{ ...c, expected: {} }]), /coverage/);
});

test('provider requests omit labels and metadata for every transformation', () => {
  const { VARIANTS } = require('./lab');
  for (const variant of VARIANTS) {
    const { request } = buildRequest(fixture(), variant, 'jev-1.13.0');
    assert.equal(JSON.stringify(request).includes('LABEL_ONLY_SENTINEL'), false);
    assert.deepEqual(Object.keys(request).sort(), ['model', 'questions', 'state']);
  }
});

test('equivalent primitive probabilities map to the same event', () => {
  for (const [variant, answer] of [
    ['original', { type: 'noul', noul: 0.2 }],
    ['negated', { type: 'noul', noul: 0.8 }],
    ['choice', { type: 'choice', probabilities: { yes: 0.2, no: 0.8 } }],
    ['score', { type: 'score', probabilities: { '0': 0.8, '1': 0.2 } }],
  ]) {
    const { targets } = buildRequest(fixture(), variant, 'jev-1.13.0');
    const [result] = predictions({ answers: { flag: answer } }, targets);
    assert.ok(Math.abs(result.p - 0.2) < 1e-12);
    assert.equal(result.expected, false);
  }
});

test('choice order reversal changes presentation while preserving meaning', () => {
  const c = fixture();
  const forward = buildRequest(c, 'choice', 'jev-1.13.0').request.questions.flag;
  const reverse = buildRequest(c, 'choice-reversed', 'jev-1.13.0').request.questions.flag;
  assert.deepEqual(Object.keys(forward.criteria), ['yes', 'no']);
  assert.deepEqual(Object.keys(reverse.criteria), ['no', 'yes']);
  assert.equal(forward.criteria.yes, reverse.criteria.yes);
});

test('injection challenges do not encode labels in their attack direction', () => {
  const c = fixture();
  const oppositeLabel = { ...c, expected: { flag: true } };
  for (const variant of ['injected-yes', 'injected-no']) {
    assert.deepEqual(buildRequest(c, variant, 'jev-1.13.0').request, buildRequest(oppositeLabel, variant, 'jev-1.13.0').request);
    assert.deepEqual(buildRequest(c, variant, 'jev-1.13.0').request.state.task_evidence, c.state);
  }
});

test('scoring has explicit threshold ties and correct confusion counts', () => {
  const result = metrics([{ p: 0.9, expected: true }, { p: 0.8, expected: false }, { p: 0.5, expected: true }, { p: 0.1, expected: false }]);
  assert.deepEqual([result.tp, result.fp, result.tn, result.fn], [1, 1, 1, 1]);
  assert.equal(result.accuracy, 0.5);
  assert.ok(Math.abs(result.brier - 0.2275) < 1e-12);
  assert.equal(metrics([]).n, 0);
});

test('threshold selection never consumes held-out labels', () => {
  const record = (id, split, p, expected) => ({ kind: 'result', caseId: id, split, family: 'f', variant: 'original', latencyMs: 10,
    response: { model: 'jev-1.13.0', usage: { input_tokens: 100 } }, predictions: [{ qid: 'flag', p, expected }] });
  const dev = [record('a', 'development', 0.8, true), record('b', 'development', 0.6, false)];
  const first = summarize([...dev, record('c', 'holdout', 0.9, true)]);
  const mutated = summarize([...dev, record('c', 'holdout', 0.9, false)]);
  assert.equal(first.byVariant.original.developmentSelectedThreshold, mutated.byVariant.original.developmentSelectedThreshold);
  assert.notEqual(first.byVariant.original.holdout.accuracy, mutated.byVariant.original.holdout.accuracy);
});

test('empty report never claims model measurements', () => {
  assert.equal(summarize([]).status, 'no-provider-results');
  assert.equal(summarize([]).requests, 0);
});

test('seeded request ordering is reproducible and input immutable', () => {
  const input = Array.from({ length: 20 }, (_, i) => i);
  assert.deepEqual(shuffle(input, 42), shuffle(input, 42));
  assert.notDeepEqual(shuffle(input, 42), shuffle(input, 43));
  assert.equal(input[0], 0);
});

test('bad runner options fail before executing requests', () => {
  assert.throws(() => parseArgs(['live', '--limit', '0']), /integers/);
  assert.throws(() => parseArgs(['--variants', 'imaginary']), /variant/);
  assert.throws(() => parseArgs(['--model']), /Missing/);
});

test('abstention curves do not hide the coverage cost of rejecting all cases', () => {
  const curve = selectiveRisk([{ p: 0.99, expected: true }, { p: 0.51, expected: false }]);
  assert.equal(curve[0].coverage, 1);
  assert.equal(curve[0].errorRate, 0.5);
  assert.equal(curve.at(-1).coverage, 0);
  assert.equal(curve.at(-1).errorRate, null);
});

test('replay rederives labels and predictions and refuses altered evidence', () => {
  const c = fixture();
  const request = buildRequest(c, 'original', 'jev-1.13.0').request;
  const manifest = { kind: 'manifest', corpusSnapshot: [c], corpusHash: hash([c]), model: 'jev-1.13.0',
    variants: ['original'], requests: 1, plannedTasks: [{ caseId: c.id, variant: 'original', requestHash: hash(request) }] };
  const result = { kind: 'result', caseId: c.id, variant: 'original', requestHash: hash(request), split: 'holdout',
    response: { model: 'jev-1.13.0', usage: { input_tokens: 100, output_tokens: 10 }, answers: { flag: { type: 'noul', noul: 0.2 } } },
    predictions: [{ qid: 'flag', expected: true, p: 1 }] };
  const actual = replay([manifest, result])[1];
  assert.equal(actual.split, 'development');
  assert.deepEqual(actual.predictions, [{ qid: 'flag', expected: false, p: 0.2 }]);
  assert.throws(() => replay([manifest, { ...result, requestHash: 'changed' }]), /fingerprint/);
  assert.throws(() => replay([manifest, result, result]), /Duplicate/);
  assert.throws(() => replay([{ ...manifest, corpusHash: 'changed' }, result]), /fingerprint/);
});
