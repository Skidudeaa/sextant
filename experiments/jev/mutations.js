'use strict';

const vm = require('node:vm');
const { isDeepStrictEqual } = require('node:util');

// Each mutation is executed locally to establish its label. Model output never
// supplies ground truth. These bounded programs test interpretation, not safety.
const programs = [
  { id: 'nullish', inputs: [null, 0, false, ''], original: 'x ?? 7', equivalent: '(x ?? 7)', mutant: 'x || 7' },
  { id: 'boundary', inputs: [9, 10, 11, -1], original: 'x >= 10', equivalent: '10 <= x', mutant: 'x > 10' },
  { id: 'number-sort', inputs: [[2, 10, 1], [1, 2, 3], [9, 80, 3], []], original: '[...x].sort((a,b) => a-b)', equivalent: 'x.slice().sort((a,b) => a-b)', mutant: '[...x].sort()' },
  { id: 'dedup-order', inputs: [[3, 1, 3, 2], [1, 1, 2], [2, 1], []], original: '[...new Set(x)]', equivalent: 'x.filter((v,i,a) => a.indexOf(v) === i)', mutant: '[...new Set(x)].sort((a,b) => a-b)' },
  { id: 'strict-equality', inputs: ['1', 1, true, null], original: 'x === 1', equivalent: '1 === x', mutant: 'x == 1' },
  { id: 'slice-end', inputs: [[1, 2, 3, 4], [1, 2], [], [1, 2, 3]], original: 'x.slice(0, 2)', equivalent: 'x.slice().slice(0, 2)', mutant: 'x.slice(0, 3)' },
  { id: 'filter-presence', inputs: [[0, 1, null, false], [1, 2], [null], ['']], original: 'x.filter(v => v !== null)', equivalent: 'x.filter(v => !(v === null))', mutant: 'x.filter(Boolean)' },
  { id: 'last-write', inputs: [['a', 'b', 'a'], ['a', 'b'], [], ['x', 'x']], original: 'Object.fromEntries(x.map((v,i) => [v,i]))', equivalent: 'Object.fromEntries(x.map((v,i) => [v,i]).slice())', mutant: 'Object.fromEntries(x.map((v,i) => [v,i]).reverse())' },
  { id: 'case-sensitive', inputs: ['Admin', 'admin', 'ADMIN', 'user'], original: 'x === "admin"', equivalent: '"admin" === x', mutant: 'x.toLowerCase() === "admin"' },
  { id: 'fallback-key', inputs: [{ enabled: false }, { enabled: true }, {}, { enabled: null }], original: 'x.enabled ?? true', equivalent: '(x.enabled ?? true)', mutant: 'x.enabled || true' },
  { id: 'empty-all', inputs: [[], [1, 2], [0, 1], [-1]], original: 'x.every(v => v > 0)', equivalent: '!x.some(v => v <= 0)', mutant: 'x.length > 0 && x.every(v => v > 0)' },
  { id: 'prefix-parse', inputs: ['12px', '12', '', '0x10'], original: 'Number(x)', equivalent: '+x', mutant: 'parseInt(x, 10)' },
];

function execute(expression, input) {
  const value = vm.runInNewContext(`(${expression})`, { x: structuredClone(input) }, { timeout: 100 });
  // JSON cannot encode NaN: preserve it explicitly in local oracle evidence.
  if (typeof value === 'number' && Number.isNaN(value)) return { kind: 'NaN' };
  return { kind: 'value', value: JSON.parse(JSON.stringify(value)) };
}

function buildCases() {
  const cases = [];
  for (const [index, program] of programs.entries()) {
    for (const [inputIndex, input] of program.inputs.entries()) {
      const reference = execute(program.original, input);
      for (const [variant, candidate] of [['cosmetic', program.equivalent], ['semantic', program.mutant]]) {
        const actual = execute(candidate, input);
        const expected = !isDeepStrictEqual(reference, actual);
        cases.push({ id: `mutation/${program.id}/${inputIndex}/${variant}`, family: `executable_${program.id}`,
          groupId: `mutation/${program.id}`, split: index < 6 ? 'development' : 'holdout',
          provenance: { kind: 'executable-synthetic', source: 'experiments/jev/mutations.js', runtime: process.version },
          rationale: 'Label computed by executing both expressions on identical cloned input; this establishes only the given input, not universal equivalence.',
          oracle: { reference, actual, variant },
          state: { language: 'JavaScript', referenceExpression: program.original, candidateExpression: candidate, input,
            questionScope: 'Compare the final returned values for exactly this input. Ignore allocation identity. NaN equals NaN for this comparison; arrays must preserve order and object property order is irrelevant.' },
          questions: { flag: { type: 'noul', instructions: 'For the given input x, do referenceExpression and candidateExpression produce different returned values under questionScope?',
            criteria: { true: 'The resulting values differ for this input.', false: 'The resulting values are equal for this input.' } } },
          expected: { flag: expected } });
      }
    }
  }
  return cases;
}

module.exports = { programs, execute, buildCases };
