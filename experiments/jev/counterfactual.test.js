'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const parser = require('@babel/parser');
const { buildRequest } = require('./refutation');
const { buildTasks, stripComments, execute, validateExperiment, freeze, runFrozen, report } = require('./counterfactual');
const root = path.resolve(__dirname, '../..');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function response(task, request, overrides = {}) {
  const choice = (question, value) => ({ type: 'choice', choice: value, confidence: 1,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === value)])) });
  return { model: overrides.model || 'jev-1.13.0', usage: { input_tokens: 100, output_tokens: 10 }, answers: {
    verdict: choice(request.questions.verdict, overrides.verdict || task.expected.verdict),
    best_refutation: choice(request.questions.best_refutation, task.expected.bestRefutation),
    answerable: { type: 'noul', noul: 0.95 },
  } };
}

test('sixteen bounded development requests derive opposing labels from four real executed functions', () => {
  const tasks = buildTasks();
  assert.equal(tasks.length, 16);
  assert.equal(new Set(tasks.map(task => task.groupId)).size, 4);
  assert.equal(tasks.filter(task => task.expected.verdict === 'supports').length, 8);
  assert.equal(tasks.filter(task => task.expected.verdict === 'contradicts').length, 8);
  for (const task of tasks) {
    assert.equal(task.split, 'development');
    assert.notEqual(task.oracle.originalOutput, task.oracle.mutantOutput);
    assert.equal(task.oracle.unaffectedControl.originalOutput, task.oracle.unaffectedControl.mutantOutput);
    const target = task.scopes.find(scope => scope.origin);
    assert.equal(execute(target.text, target.symbol, task.oracle.input), task.oracle.actualOutput);
    assert.equal(task.scopes.length, 3);
    assert.ok(Buffer.byteLength(JSON.stringify(buildRequest(task))) < 26000);
  }
});

test('source origin hashes and AST spans match real files, while generated transformations never change them', () => {
  const files = ['lib/summary.js', 'lib/claims.js', 'lib/retrieve.js', 'lib/closure.js', 'lib/freshness.js'];
  const before = files.map(file => digest(fs.readFileSync(path.join(root, file))));
  const tasks = buildTasks();
  for (const task of tasks) {
    const target = task.scopes.find(scope => scope.origin), original = target.origin;
    const bytes = fs.readFileSync(path.join(root, original.path));
    assert.equal(digest(bytes), original.fileSha256);
    assert.equal(bytes.toString('utf8').slice(original.startOffset, original.endOffset), original.text);
    assert.equal(digest(original.text), original.scopeSha256);
    assert.equal(digest(target.text), target.scopeSha256);
    assert.equal(target.text.split('\n').length, original.text.split('\n').length);
    if (task.codeState === 'mutant') {
      assert.notEqual(target.text, original.text);
      assert.ok(target.transformation.semanticEdit.from);
      assert.ok(target.transformation.semanticEdit.to);
      assert.equal(target.evidenceStatus, 'request-only-transformed-scope');
    }
  }
  assert.deepEqual(files.map(file => digest(fs.readFileSync(path.join(root, file)))), before);
});

test('comment treatment preserves actual comments or removes only AST comment spans, never inventing annotations', () => {
  const tasks = buildTasks();
  for (const task of tasks.filter(task => task.commentTreatment === 'preserved')) {
    const target = task.scopes.find(scope => scope.origin);
    const originalComments = parser.parse(target.origin.text).comments.map(comment => comment.value);
    const preservedComments = parser.parse(target.text).comments.map(comment => comment.value);
    assert.ok(originalComments.length > 0);
    assert.deepEqual(preservedComments, originalComments);
    const counterpart = tasks.find(item => item.groupId === task.groupId && item.codeState === task.codeState && item.commentTreatment === 'stripped');
    const stripped = counterpart.scopes.find(scope => scope.origin);
    assert.equal(stripped.text, stripComments(target.text));
    assert.equal(parser.parse(stripped.text).comments.length, 0);
    assert.equal(execute(stripped.text, stripped.symbol, task.oracle.input), task.oracle.actualOutput);
  }
  const literal = 'function example() { /* real comment */ return "// not a comment"; }';
  assert.equal(execute(stripComments(literal), 'example', []), '// not a comment');
  assert.throws(() => stripComments('function none() { return 1; }'), /actual existing/);
});

test('fixed claims, stable scope positions and label-free provider state rule out filename or metadata labels', () => {
  const tasks = buildTasks();
  const positions = new Set();
  for (const groupId of new Set(tasks.map(task => task.groupId))) {
    const group = tasks.filter(task => task.groupId === groupId);
    assert.equal(new Set(group.map(task => task.claim)).size, 1);
    assert.equal(new Set(group.map(task => task.scopes.find(scope => scope.origin).id)).size, 1);
    positions.add(group[0].scopes.find(scope => scope.origin).id);
    assert.equal(new Set(group.map(task => JSON.stringify(task.scopes.map(scope => ({ path: scope.path, symbol: scope.symbol }))))).size, 1);
    assert.equal(new Set(group.map(task => JSON.stringify(task.scopes.filter(scope => !scope.origin)))).size, 1);
  }
  assert.equal(positions.size, 3);
  const task = structuredClone(tasks[0]);
  task.oracle = task.expected = task.rationale = task.provenance = 'LABEL_CANARY';
  const request = buildRequest(task);
  assert.doesNotMatch(JSON.stringify(request), /LABEL_CANARY|"oracle"|"expected"|"codeState"|"commentTreatment"|"origin"|"transformation"/);
});

test('frozen plan revalidates executable labels rather than trusting refreshed outer fingerprints', () => {
  const frozen = freeze();
  assert.equal(validateExperiment(JSON.parse(JSON.stringify(frozen))).fingerprint, frozen.fingerprint);
  assert.equal(frozen.generatorSha256, digest(fs.readFileSync(path.join(__dirname, 'counterfactual.js'))));
  for (const change of [
    value => { value.tasks[0].oracle.actualOutput = 'fabricated'; },
    value => { value.tasks[0].expected.verdict = 'contradicts'; },
    value => { value.tasks[0].codeState = 'invented'; },
  ]) {
    const changed = structuredClone(frozen); change(changed);
    const { fingerprint, ...payload } = changed; changed.fingerprint = digest(JSON.stringify(payload));
    assert.throws(() => validateExperiment(changed), /Executable output|treatment/);
  }
});

test('fake transport reports source-change sensitivity and comment invariance without measuring intelligence', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-counterfactual-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const frozen = freeze();
  let calls = 0;
  const out = path.join(dir, 'result.jsonl');
  const result = await runFrozen(frozen, out, { client: { async systemOne(request) {
    const task = frozen.tasks[calls++];
    return response(task, request);
  } } });
  assert.equal(calls, 16); assert.equal(result.executionKind, 'mock-transport');
  const model = result.byModel['jev-1.13.0'];
  assert.equal(model.verdict.accuracy, 1);
  assert.deepEqual(model.sourceChangeSensitivity, { completePairs: 8, verdictFlips: 8, bothCorrect: 8 });
  assert.deepEqual(model.commentInvariance, { completePairs: 8, sameVerdict: 8 });
  assert.equal(model.byCommentTreatment.preserved.verdictCorrect, 8);
  assert.match(result.evidence, /no provider intelligence/);
  assert.deepEqual(report(fs.readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse)), result);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
});

test('sensitivity score rejects a constant-claim shortcut and partitions mixed models', () => {
  const frozen = freeze();
  const rows = frozen.plan.map((planned, index) => ({ kind: 'result', id: planned.id, requestHash: planned.requestHash, latencyMs: 1,
    response: response(frozen.tasks[index], planned.request, { verdict: 'supports' }) }));
  const header = { kind: 'manifest', experiment: frozen, executionKind: 'mock-transport' };
  const result = report([header, ...rows]);
  assert.equal(result.byModel['jev-1.13.0'].verdict.accuracy, 0.5);
  assert.deepEqual(result.byModel['jev-1.13.0'].sourceChangeSensitivity, { completePairs: 8, verdictFlips: 0, bothCorrect: 0 });
  rows[2].response.model = 'different-model';
  const mixed = report([header, ...rows]);
  assert.equal(Object.keys(mixed.byModel).length, 2);
  assert.equal(mixed.byModel['different-model'].sourceChangeSensitivity.completePairs, 0);
  assert.equal(mixed.modelStampMismatch, 1);
});

test('failure halts the immutable request plan with sanitized accounting and no retry', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-counterfactual-failed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'result.jsonl');
  let calls = 0;
  await assert.rejects(runFrozen(freeze(), out, { client: { async systemOne() { calls++; throw new Error('PRIVATE_FAILURE'); } } }), /sanitized status/);
  assert.equal(calls, 1);
  const text = fs.readFileSync(out, 'utf8');
  assert.doesNotMatch(text, /PRIVATE_FAILURE/);
  const result = report(text.trim().split('\n').map(JSON.parse));
  assert.equal(result.errorCount, 1); assert.equal(result.completed, 0); assert.equal(result.unattempted, 15);
});

test('error diagnostics keep recognized client codes and static messages, never exception text', async t => {
  const { JevError } = require('./client');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-counterfactual-errors-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const frozen = freeze();
  for (const [index, failure] of [
    new JevError('PRIVATE_CONTRACT', { code: 'invalid_contract' }),
    new JevError('PRIVATE_HTTP_BODY', { code: 'http_error', status: 429 }),
    new JevError('PRIVATE_UNKNOWN', { code: 'PRIVATE_CODE', status: 401 }),
    Object.assign(new Error('PRIVATE_FAKE'), { code: 'http_error', status: 401 }),
  ].entries()) {
    const out = path.join(dir, `${index}.jsonl`);
    await assert.rejects(runFrozen(frozen, out, { client: { async systemOne() { throw failure; } } }), /sanitized status/);
    const text = fs.readFileSync(out, 'utf8');
    assert.doesNotMatch(text, /PRIVATE_/);
    const error = text.trim().split('\n').map(JSON.parse).find(row => row.kind === 'error');
    assert.equal(error.code, ['invalid_contract', 'http_error', 'unknown_failure', 'unknown_failure'][index]);
    assert.equal(error.status, index === 1 ? 429 : null);
    assert.equal(error.message, index === 0 ? 'Response failed the local typed contract.' : index === 1
      ? 'Provider returned an unsuccessful HTTP status.' : 'Request failed without a recognized client error.');
  }
});
