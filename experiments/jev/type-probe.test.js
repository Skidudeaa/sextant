'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { MODEL, buildTasks, buildRequest, freeze, validateFrozen, report, live } = require('./type-probe');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const answer = (p, model = MODEL) => ({ model, usage: { input_tokens: 100, output_tokens: 5 }, answers: { changed: { type: 'noul', noul: p } } });

test('96 development requests match hand-derived coercion truth tables', () => {
  const tasks = buildTasks();
  assert.equal(tasks.length, 96); assert.equal(new Set(tasks.map(task => task.id)).size, 96);
  const truth = { 0: [false, true, true, false, true, false, true, true], 7: [false, true, true, false, false, false, false, true] };
  for (const task of tasks) {
    assert.equal(task.split, 'development');
    assert.equal(task.expected, task.variant === 'reversed-strict' ? false : truth[task.target][task.inputIndex], task.id);
  }
  assert.equal(tasks.filter(task => task.expected).length, 24);
  assert.deepEqual(buildTasks(), tasks);
});

test('confirmation uses new targets and decimal strings with independent coercion labels', () => {
  const tasks = buildTasks('confirmation');
  assert.equal(tasks.length, 96); assert.equal(new Set(tasks.map(task => task.id)).size, 96);
  assert.deepEqual([...new Set(tasks.map(task => task.target))].sort((a, b) => a - b), [-2, 11]);
  const truth = [false, true, true, false, false, false, false, true];
  for (const task of tasks) {
    assert.equal(task.split, 'development');
    assert.equal(task.expected, task.variant === 'reversed-strict' ? false : truth[task.inputIndex], task.id);
    if (task.inputIndex === 2) assert.equal(task.input, `${task.target}.0`);
    const request = buildRequest(task);
    assert.doesNotMatch(JSON.stringify(request), /confirmation|diagnostic|expected|oracle|cohort/);
  }
  assert.equal(tasks.filter(task => task.expected).length, 18);
  assert.deepEqual(buildTasks('confirmation'), tasks);
  assert.throws(() => buildTasks('unknown'), /cohort/);
});

test('confirmation freezes separately while legacy diagnostic artifacts retain their shape', () => {
  const diagnostic = freeze(); const confirmation = freeze('confirmation');
  assert.equal(Object.hasOwn(diagnostic, 'cohort'), false);
  assert.equal(confirmation.cohort, 'confirmation');
  validateFrozen(diagnostic); validateFrozen(confirmation);
  const changedCohort = structuredClone(confirmation); delete changedCohort.cohort;
  const { fingerprint, ...payload } = changedCohort; changedCohort.fingerprint = hash(payload);
  assert.throws(() => validateFrozen(changedCohort), /executable label/);
  const records = [{ kind: 'manifest', executionKind: 'mock-transport', experiment: confirmation }, ...confirmation.tasks.map((task, index) => ({
    kind: 'result', id: task.id, requestHash: confirmation.plan[index].requestHash, latencyMs: 1,
    response: answer(task.expected ? 0.9 : 0.1),
  }))];
  const result = report(records);
  assert.equal(result.cohort, 'confirmation'); assert.equal(result.split, 'development');
  assert.equal(result.completed, 96); assert.equal(result.byModel[MODEL].byRepresentation.structured.accuracy, 1);
});

test('all representations preserve typed input semantics and hide local oracle labels', () => {
  for (const task of buildTasks()) {
    const request = buildRequest({ ...task, expected: 'LOCAL_CANARY', oracle: 'LOCAL_CANARY', provenance: 'LOCAL_CANARY' });
    assert.doesNotMatch(JSON.stringify(request), /LOCAL_CANARY|"expected"|"oracle"|"split"|"groupId"|"variant"/);
    if (task.representation === 'code-literal') {
      const run = body => vm.runInNewContext(`(function(){${body}})()`, {}, { timeout: 100 });
      assert.equal(run(request.state.referenceFunctionBody), task.oracle.reference.value);
      assert.equal(run(request.state.candidateFunctionBody), task.oracle.candidate.value);
    } else {
      assert.deepEqual(request.state.input, task.input);
      if (task.representation === 'annotated') {
        assert.equal(request.state.inputTypeof, typeof task.input);
        assert.equal(request.state.inputLiteral, JSON.stringify(task.input));
      } else assert.equal(request.state.inputTypeof, undefined);
    }
  }
});

test('frozen requests reject rehashed label injection and oracle alterations', () => {
  const frozen = freeze(); validateFrozen(frozen);
  const injected = structuredClone(frozen);
  injected.plan[0].request.state.expected = injected.tasks[0].expected;
  injected.plan[0].requestHash = hash(injected.plan[0].request);
  let { fingerprint, ...payload } = injected; injected.fingerprint = hash(payload);
  assert.throws(() => validateFrozen(injected), /label-free/);
  const badOracle = structuredClone(frozen); badOracle.tasks[0].expected = !badOracle.tasks[0].expected;
  ({ fingerprint, ...payload } = badOracle); badOracle.fingerprint = hash(payload);
  assert.throws(() => validateFrozen(badOracle), /executable label/);
});

test('paired corrections and regressions have independent arithmetic controls', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-type-probe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const frozen = freeze();
  const corrected = frozen.tasks.find(task => task.expected).groupId;
  const regressed = frozen.tasks.find(task => !task.expected).groupId;
  let calls = 0;
  const result = await live(frozen, path.join(dir, 'fake.jsonl'), { client: { async systemOne(request) {
    const task = frozen.tasks[calls++]; assert.deepEqual(request, buildRequest(task));
    let predicted = task.expected;
    if (task.groupId === corrected && task.representation === 'structured') predicted = !predicted;
    if (task.groupId === regressed && task.representation === 'annotated') predicted = !predicted;
    return answer(predicted ? 0.9 : 0.1);
  } } });
  assert.equal(calls, 96); assert.equal(result.executionKind, 'mock-transport'); assert.equal(result.status, 'complete');
  const metrics = result.byModel[MODEL];
  assert.equal(metrics.byRepresentation.structured.accuracy, 31 / 32);
  assert.equal(metrics.byRepresentation.annotated.accuracy, 31 / 32);
  assert.equal(metrics.byRepresentation['code-literal'].accuracy, 1);
  assert.equal(metrics.paired.annotated.corrections, 1); assert.equal(metrics.paired.annotated.regressions, 1);
  assert.equal(metrics.paired['code-literal'].corrections, 1); assert.equal(metrics.paired['code-literal'].regressions, 0);
  assert.equal(metrics.paired.annotated.pairedGroups, 32); assert.equal(metrics.inputTokens, 9600);
  const records = fs.readFileSync(path.join(dir, 'fake.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(report(records), result);
  assert.throws(() => report([records[0], records[2], records[1]]), /next planned/);
  assert.throws(() => report([records[0], records[1], records[1]]), /next planned/);
});

test('representation pairing never crosses actual returned model versions', () => {
  const frozen = freeze();
  const records = [{ kind: 'manifest', executionKind: 'mock-transport', experiment: frozen }, ...frozen.tasks.map((task, index) => ({
    kind: 'result', id: task.id, requestHash: frozen.plan[index].requestHash, latencyMs: 1,
    response: answer(task.expected ? 0.9 : 0.1, task.representation === 'annotated' ? 'another-actual-version' : MODEL),
  }))];
  const result = report(records);
  assert.equal(Object.keys(result.byModel).length, 2);
  assert.equal(result.byModel[MODEL].paired.annotated.pairedGroups, 0);
  assert.equal(result.byModel['another-actual-version'].paired.annotated.pairedGroups, 0);
  assert.equal(result.byModel[MODEL].paired['code-literal'].pairedGroups, 32);
  assert.equal(result.byRepresentation, undefined);
});

test('failure stops after one attempt and leaves a sanitized partial report', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-type-probe-failure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const frozen = freeze(); let calls = 0;
  await assert.rejects(live(frozen, path.join(dir, 'fake.jsonl'), { client: { async systemOne() {
    if (++calls === 2) throw new Error('UNSAFE_PROVIDER_BODY');
    return answer(frozen.tasks[0].expected ? 0.9 : 0.1);
  } } }), /UNSAFE_PROVIDER_BODY/);
  assert.equal(calls, 2);
  const text = fs.readFileSync(path.join(dir, 'fake.jsonl'), 'utf8'); assert.doesNotMatch(text, /UNSAFE_PROVIDER_BODY/);
  const result = report(text.trim().split('\n').map(JSON.parse));
  assert.deepEqual([result.planned, result.completed, result.errors, result.unattempted], [96, 1, 1, 94]);
  assert.equal(result.status, 'failed-partial');
});

test('invalid frozen artifact fails before output creation or transport', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-type-probe-corrupt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const frozen = freeze(); frozen.tasks[0].input = 'altered'; let calls = 0;
  const out = path.join(dir, 'fake.jsonl');
  await assert.rejects(live(frozen, out, { client: { systemOne() { calls++; } } }), /fingerprint/);
  assert.equal(calls, 0); assert.equal(fs.existsSync(out), false);
});
