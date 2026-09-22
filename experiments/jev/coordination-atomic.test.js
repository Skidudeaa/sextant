'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const atomic = require('./coordination-atomic');
const coordination = require('./coordination');
const lab = require('./lab');

function records(module = atomic) {
  const { manifest, ordered } = module.plan();
  return [manifest, ...ordered.map(c => ({ kind: 'result', caseId: c.id, variant: 'original', requestHash: lab.hash(lab.buildRequest(c, 'original', manifest.model).request), latencyMs: 10,
    response: { model: manifest.model, usage: { input_tokens: 100, output_tokens: 5 }, answers: Object.fromEntries(Object.entries(c.expected).map(([h, yes]) => [h, { type: 'noul', noul: yes ? 0.99 : 0.01 }])) } }))];
}
function probability(rows, id, head, p) { rows.find(r => r.caseId === id).response.answers[head].noul = p; }

test('same frozen states and original heads; independently execute all 64 atomic labels', () => {
  const old = coordination.buildCases(), cases = atomic.buildCases();
  assert.equal(cases.length, 32);
  function run(p, c, x) { try { return { value: Function(`return (${c})((${p})((${x})))`)() }; } catch (error) { return { error: error.name }; } }
  for (const [i, c] of cases.entries()) {
    assert.deepEqual(c.state, old[i].state);
    for (const h of Object.keys(old[i].questions)) assert.deepEqual(c.questions[h], old[i].questions[h]);
    const s = c.state, a = s.agent_A, b = s.agent_B;
    const baseline = run(a.baseline_function, b.baseline_function, s.input_literal);
    assert.equal(c.expected.A_regression, !isDeepStrictEqual(baseline, run(a.edited_function, b.baseline_function, s.input_literal)));
    assert.equal(c.expected.B_regression, !isDeepStrictEqual(baseline, run(a.baseline_function, b.edited_function, s.input_literal)));
    const request = lab.buildRequest(c, 'original', 'jev-1.13.0').request;
    assert.deepEqual(Object.keys(request).sort(), ['model', 'questions', 'state']);
    assert.equal(Object.keys(request.questions).length, 5);
    assert.equal('oracle' in request.state, false);
    assert.equal('expected' in request.state, false);
  }
});

test('exact planned order deterministic; changing seed changes schedule but not cases', () => {
  assert.deepEqual(atomic.plan().manifest.plannedTasks, atomic.plan().manifest.plannedTasks);
  assert.notDeepEqual(atomic.plan({ seed: 5 }).manifest.plannedTasks, atomic.plan().manifest.plannedTasks);
  assert.deepEqual(atomic.plan({ seed: 5 }).manifest.corpusSnapshot, atomic.plan().manifest.corpusSnapshot);
  assert.throws(() => atomic.plan({ seed: -1 }));
});

test('ideal atomic results give executable truth and 32 complete correct decisions', () => {
  const s = atomic.summarize(records());
  assert.equal(s.direct.allThreeCorrect, 32);
  assert.equal(s.derived.allThreeCorrect, 32);
  assert.equal(s.derived.contradictoryDecisions, 0);
  assert.equal(s.rawHeads.A_regression.accuracy, 1);
  assert.equal(s.sameRequestComparison.matchedCases, 32);
  assert.equal('brier' in s.derived.perHead.emergent_conflict, false);
});

test('Boolean decomposition can correct a direct error AND introduce a regression', () => {
  const r = records();
  probability(r, 'coordination/units/emergent-conflict', 'emergent_conflict', 0.1);
  probability(r, 'coordination/field_names/mutual-repair', 'A_regression', 0.1);
  const s = atomic.summarize(r);
  assert.equal(s.sameRequestComparison.perHead.emergent_conflict.corrected, 1);
  assert.equal(s.sameRequestComparison.perHead.mutual_repair.regressed, 1);
  assert.equal(s.direct.allThreeCorrect, 31);
  assert.equal(s.derived.allThreeCorrect, 31);
  assert.equal(s.derived.contradictoryDecisions, 0);
});

test('strict greater than 0.5 and inconsistent direct heads remain visible', () => {
  const r = records(), id = 'coordination/units/benign-pair';
  probability(r, id, 'A_regression', 0.5);
  probability(r, id, 'B_regression', 0.5);
  probability(r, id, 'joint_regression', 0.5);
  probability(r, id, 'mutual_repair', 0.8);
  probability(r, id, 'emergent_conflict', 0.8);
  const s = atomic.summarize(r), c = s.cases.find(c => c.caseId === id);
  assert.deepEqual(c.derived, { joint_regression: false, emergent_conflict: false, mutual_repair: false });
  assert.equal(s.direct.contradictoryDecisions, 1);
  assert.equal(s.derived.contradictoryDecisions, 0);
});

test('prior three-head run compared on exact IDs; direct rerun variation not hidden', () => {
  const now = records(), prior = records(coordination);
  probability(prior, 'coordination/units/emergent-conflict', 'emergent_conflict', 0.1);
  const s = atomic.summarize(now, prior).previousRunComparisonByModel['jev-1.13.0'];
  assert.equal(s.originalDirectToNewDerived.matchedCases, 32);
  assert.equal(s.originalDirectToNewDerived.perHead.emergent_conflict.corrected, 1);
  assert.equal(s.originalDirectToNewDirect.perHead.emergent_conflict.corrected, 1);
});

test('actual model partitions prevent pooled claims and partial runs expose coverage', () => {
  const r = records().slice(0, 4);
  r[2].response.model = 'another-model';
  const s = atomic.summarize(r, records(coordination));
  assert.equal(s.completedRequests, 3);
  assert.equal(s.unattemptedRequests, 29);
  assert.equal('direct' in s, false);
  assert.equal(s.byModel['jev-1.13.0'].n, 2);
  assert.equal(s.byModel['another-model'].n, 1);
  assert.equal(s.byModel['another-model'].previousRunComparisonByModel['jev-1.13.0'].originalDirectToNewDerived.matchedCases, 1);
});

test('frozen replay rejects labels, source, schedule, duplicates and incomplete answer vectors', () => {
  const variants = [
    r => { r[0].sourceHash = 'wrong'; },
    r => { r[0].baseSourceHash = 'wrong'; },
    r => { r[0].corpusSnapshot[0].expected.A_regression = !r[0].corpusSnapshot[0].expected.A_regression; r[0].corpusHash = lab.hash(r[0].corpusSnapshot); },
    r => { [r[1], r[2]] = [r[2], r[1]]; },
    r => { r.push(r[1]); },
    r => { delete r[1].response.answers.A_regression; },
  ];
  for (const mutate of variants) { const r = records(); mutate(r); assert.throws(() => atomic.replay(r)); }
});

test('cached scores and saved terminal summary never override raw responses', () => {
  const r = records();
  r[1].predictions = [{ qid: 'joint_regression', expected: true, p: 0.5 }];
  r.push({ kind: 'summary', derived: { allThreeCorrect: 0 } });
  assert.equal(atomic.summarize(r).derived.allThreeCorrect, 32);
});

test('offline injected client writes private frozen raw results and exact requests', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-atomic-'));
  try {
    const out = path.join(directory, 'results.jsonl');
    const { ordered } = atomic.plan();
    let index = 0;
    const client = { async systemOne(request) {
      const c = ordered[index++];
      assert.deepEqual(request, lab.buildRequest(c, 'original', 'jev-1.13.0').request);
      return { model: 'jev-1.13.0', usage: { input_tokens: 100, output_tokens: 5 }, answers: Object.fromEntries(Object.entries(c.expected).map(([h, yes]) => [h, { type: 'noul', noul: yes ? 0.99 : 0.01 }])) };
    } };
    await atomic.live(out, { client });
    assert.equal(index, 32);
    assert.equal(fs.statSync(out).mode & 0o777, 0o600);
    const r = fs.readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(r.length, 34);
    assert.equal(atomic.summarize(r).derived.allThreeCorrect, 32);
    await assert.rejects(atomic.live(out, { client }), /EEXIST/);
  } finally { fs.rmSync(directory, { recursive: true }); }
});

test('provider failure persists terminal error and partial summary without succeeding later', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-atomic-'));
  try {
    const out = path.join(directory, 'error.jsonl');
    await assert.rejects(atomic.live(out, { client: { async systemOne() { throw new Error('offline failure'); } } }), /offline failure/);
    const r = fs.readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(r.at(-1).errors, 1);
    assert.equal(r.at(-1).unattemptedRequests, 31);
    assert.equal(r.at(-1).completedRequests, 0);
  } finally { fs.rmSync(directory, { recursive: true }); }
});
