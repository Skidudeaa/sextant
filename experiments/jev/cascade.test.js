'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildVerification, decideVerification } = require('./cascade');

function schema() {
  return {
    type: 'object',
    properties: {
      registration_date: { type: 'string', description: 'Registration date', examples: ['09/05/2024'] },
      description: { type: 'string', description: 'Brief registration description', examples: ['Registration opens for the fall semester'] },
    },
    required: ['registration_date', 'description'],
    additionalProperties: false,
  };
}

function answers(plan, overrides = {}) {
  return {
    model: 'jev-1.13.0', usage: { input_tokens: 100, output_tokens: 10 },
    answers: Object.fromEntries(Object.keys(plan.questions).map(key => [key, { type: 'noul', noul: overrides[key] ?? 0.1 }])),
  };
}

test('cookbook record-owned iteration creates no field questions for {}; schema-owned iteration checks every omission', () => {
  const emptyRecord = {};
  const cookbookFieldIds = Object.keys(emptyRecord).map(key => `${key}::absence_wrong`);
  assert.deepEqual(cookbookFieldIds, []);
  const plan = buildVerification(schema(), emptyRecord, 'Registration opens September 5, 2024.');
  assert.deepEqual(plan.fieldPaths, ['registration_date', 'description']);
  assert.ok(plan.questions['f0::absence_wrong']);
  assert.ok(plan.questions['f1::absence_wrong']);
  assert.deepEqual(plan.structuralErrors.map(error => error.code), ['required_missing', 'required_missing']);
  assert.equal(decideVerification(plan, null).status, 'schema_failure');
});

test('cookbook unknown-key field lookup throws; repaired builder records structural error and source question', () => {
  const record = { registration_date: '', description: '', invented: 'something' };
  assert.throws(() => schema().properties.invented.type, TypeError);
  const plan = buildVerification(schema(), record, 'University navigation');
  assert.deepEqual(plan.structuralErrors, [{ path: 'invented', code: 'additional_property' }]);
  assert.ok(plan.questions['extra0::unsupported']);
  assert.equal(decideVerification(plan, null).nextAction, 'repair_structure');
});

test('additionalProperties follows JSON schema default and still verifies extra claims', () => {
  const s = schema();
  delete s.additionalProperties;
  const plan = buildVerification(s, { registration_date: '', description: '', extra: 'claimed' }, 'Source');
  assert.deepEqual(plan.structuralErrors, []);
  assert.equal(decideVerification(plan, answers(plan, { 'extra0::unsupported': 0.9 })).status, 'verifier_risk');
});

test('null and empty permitted values have semantic omission checks without invented type failures', () => {
  const s = {
    type: 'object', properties: {
      nickname: { type: ['string', 'null'] }, tags: { type: 'array', items: { type: 'string' } }, optional: { type: 'string' },
    }, required: ['nickname', 'tags'],
  };
  const plan = buildVerification(s, { nickname: null, tags: [] }, 'Nickname is Ace; tags are fast and trusted.');
  assert.deepEqual(plan.structuralErrors, []);
  assert.equal(Object.keys(plan.questions).filter(key => key.endsWith('absence_wrong')).length, 3);
  assert.equal(plan.questions['f2::absence_wrong'].instructions.present, false);
  assert.equal(decideVerification(plan, answers(plan, { 'f0::absence_wrong': 0.9 })).nextAction, 'escalate');
});

test('schema examples and descriptions remain specifications, never source evidence', () => {
  const s = schema();
  const plan = buildVerification(s, { registration_date: '', description: 'Registration opens for the fall semester' }, 'Skip to navigation. Campus map.');
  assert.deepEqual(plan.state, { source_text: 'Skip to navigation. Campus map.' });
  assert.doesNotMatch(JSON.stringify(plan.state), /09\/05\/2024|Registration opens/);
  assert.doesNotMatch(JSON.stringify(plan.questions), /09\/05\/2024/);
  assert.match(plan.questions['f1::unsupported'].instructions.evidence_rule, /examples.*never source facts/);
  const result = decideVerification(plan, answers(plan, { 'f1::unsupported': 0.95, '__source__::evidence_absent': 0.91 }));
  assert.equal(result.status, 'evidence_absent');
  assert.equal(result.nextAction, 'retrieve_evidence');
});

test('malformed JSON is explicit structural failure; markdown-wrapped JSON is not fished out', () => {
  for (const text of ['{', '```json\n{"registration_date":"", "description":""}\n```', 'null', '[]', '7']) {
    const plan = buildVerification(schema(), text, 'Source');
    assert.ok(plan.structuralErrors.some(error => ['invalid_json', 'record_not_object'].includes(error.code)));
    assert.ok(plan.questions['f0::absence_wrong']);
    assert.equal(decideVerification(plan, null).status, 'schema_failure');
  }
  const plan = buildVerification(schema(), '{"registration_date":"", "description":""}', 'Source');
  assert.deepEqual(plan.structuralErrors, []);
});

test('threshold equality does not fire, one field above threshold suffices, and no flag retains only a candidate', () => {
  const plan = buildVerification(schema(), { registration_date: '09/05/2024', description: 'Registration opens' }, 'Registration opens September 5, 2024.');
  const equality = decideVerification(plan, answers(plan, { 'f0::unsupported': 0.7 }), 0.7);
  assert.equal(equality.status, 'no_flag');
  assert.equal(equality.nextAction, 'retain_candidate');
  assert.equal(Object.hasOwn(equality, 'correct'), false);
  const fired = decideVerification(plan, answers(plan, { 'f0::unsupported': 0.70001 }), 0.7);
  assert.equal(fired.status, 'verifier_risk');
  assert.deepEqual(fired.fired, [{ id: 'f0::unsupported', probability: 0.70001 }]);
  for (const threshold of [-1, 1.1, NaN, Infinity, '0.7']) assert.throws(() => decideVerification(plan, answers(plan), threshold), /threshold/);
});

test('missing answers and missing provider metadata cannot become no-flag decisions', () => {
  const plan = buildVerification(schema(), { registration_date: '', description: '' }, 'Source');
  const response = answers(plan);
  delete response.answers['f0::absence_wrong'];
  assert.throws(() => decideVerification(plan, response), /exactly one answer/);
  const unstamped = answers(plan);
  delete unstamped.usage;
  assert.throws(() => decideVerification(plan, unstamped), /usage/);
  assert.throws(() => decideVerification(plan, null), /exactly one answer/);
});

test('flat schema constraints run deterministically, including Unicode string lengths and array item types', () => {
  const s = { type: 'object', properties: {
    name: { type: 'string', minLength: 1, maxLength: 1 },
    count: { type: 'integer', minimum: 1, maximum: 3 },
    items: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 },
    state: { type: 'string', enum: ['ready', 'done'] },
  } };
  const valid = buildVerification(s, { name: '🚀', count: 2, items: ['x'], state: 'ready' }, 'Source');
  assert.deepEqual(valid.structuralErrors, []);
  const invalid = buildVerification(s, { name: 'long', count: 4, items: [false, 'x', 'y'], state: 'unknown' }, 'Source');
  assert.deepEqual(invalid.structuralErrors.map(error => error.code), ['string_length', 'numeric_range', 'array_length', 'type_mismatch', 'enum_mismatch']);
  const falseValue = buildVerification({ type: 'object', properties: { enabled: { type: 'boolean' }, n: { type: 'number' } } }, { enabled: false, n: 0 }, 'Disabled, zero items.');
  assert.ok(falseValue.questions['f0::unsupported']);
  assert.ok(falseValue.questions['f1::unsupported']);
});

test('unsupported schema shapes and validation keywords fail explicitly', () => {
  for (const property of [
    { type: 'object', properties: { nested: { type: 'string' } } },
    { anyOf: [{ type: 'string' }, { type: 'null' }] },
    { type: 'string', format: 'date' },
    { type: 'string', pattern: '^x' },
    { type: 'array', items: { type: 'array', items: { type: 'string' } } },
    { type: ['string', 'number'] },
    { type: 'string', minLength: 4, maxLength: 2 },
  ]) assert.throws(() => buildVerification({ type: 'object', properties: { field: property } }, {}, 'Source'), TypeError);
  assert.throws(() => buildVerification({ ...schema(), patternProperties: {} }, {}, 'Source'), /Unsupported/);
});

test('field and question identifiers cannot collide through adversarial property names', () => {
  const s = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"},"__source__::evidence_absent":{"type":"string"}},"required":["__proto__"]}');
  const record = JSON.parse('{"__proto__":"source value","__source__::evidence_absent":""}');
  const plan = buildVerification(s, record, 'Source value');
  assert.deepEqual(plan.structuralErrors, []);
  assert.ok(plan.questions['f0::unsupported']);
  assert.ok(plan.questions['f1::absence_wrong']);
  assert.ok(plan.questions['__source__::evidence_absent']);
});
