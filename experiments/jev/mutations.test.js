'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { programs, execute, buildCases } = require('./mutations');
const { validateCases, buildRequest } = require('./lab');

test('96 executable controls preserve cosmetic changes and expose conditional mutants', () => {
  const cases = buildCases();
  validateCases(cases);
  assert.equal(cases.length, 96);
  const cosmetic = cases.filter(c => c.oracle.variant === 'cosmetic');
  assert.equal(cosmetic.length, 48);
  assert.equal(cosmetic.filter(c => c.expected.flag).length, 0);
  for (const program of programs) {
    const mutants = cases.filter(c => c.groupId === `mutation/${program.id}` && c.oracle.variant === 'semantic');
    assert.ok(mutants.some(c => c.expected.flag), `${program.id}: mutant never changes behavior`);
    assert.ok(mutants.some(c => !c.expected.flag), `${program.id}: no unchanged input control`);
  }
});

test('execution labels distinguish structural equality and JavaScript corner cases', () => {
  assert.deepEqual(execute('x || 7', 0), { kind: 'value', value: 7 });
  assert.deepEqual(execute('x ?? 7', 0), { kind: 'value', value: 0 });
  assert.deepEqual(execute('Number(x)', '12px'), { kind: 'NaN' });
  assert.deepEqual(execute('[...x].sort()', [2, 10, 1]), { kind: 'value', value: [1, 10, 2] });
});

test('oracle evidence cannot enter provider requests', () => {
  for (const c of buildCases()) {
    const request = buildRequest(c, 'original', 'jev-1.13.0').request;
    assert.equal(Object.hasOwn(request.state, 'oracle'), false);
    assert.equal(Object.hasOwn(request.state, 'expected'), false);
  }
});
