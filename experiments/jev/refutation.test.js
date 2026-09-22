'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const os = require('node:os');
const { tasks, buildRequest, validateTasks, readScope, freezeTasks, validateFrozen, report, runFrozen } = require('./refutation');
const root = path.resolve(__dirname, '../..');
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');

test('32 paired tasks carry validated real source and three-way labels', () => {
  const report = validateTasks(tasks);
  assert.equal(report.tasks, 32);
  assert.equal(report.groups, 16);
  assert.deepEqual(report.labels, { supports: 14, contradicts: 14, insufficient: 4 });
  assert.equal(report.providerCalls, 0);
  assert.ok(report.maxRequestBytes < 26000);
});

test('every quoted scope is an exact byte-derived AST slice, not a prose summary', () => {
  for (const task of tasks) for (const scope of task.scopes) {
    const bytes = fs.readFileSync(path.join(root, scope.path));
    assert.equal(sha256(bytes), scope.fileSha256);
    assert.equal(bytes.toString('utf8').slice(scope.startOffset, scope.endOffset), scope.text);
    assert.equal(sha256(scope.text), scope.scopeSha256);
    assert.ok(scope.endLine >= scope.startLine);
  }
});

test('provider builders omit labels, explanations, polarity, group IDs and hashes', () => {
  const task = structuredClone(tasks[0]);
  task.expected = { verdict: 'LABEL_CANARY', bestRefutation: 'LABEL_CANARY' };
  task.rationale = 'LABEL_CANARY'; task.groupId = 'LABEL_CANARY'; task.polarity = 'LABEL_CANARY'; task.provenance = { label: 'LABEL_CANARY' };
  task.scopes[0].label = 'LABEL_CANARY';
  const request = buildRequest(task);
  assert.doesNotMatch(JSON.stringify(request), /LABEL_CANARY|rationale|fileSha256|scopeSha256|groupId|polarity/);
  assert.equal(request.state.proposed_claim, task.claim);
  assert.equal(request.questions.best_refutation.criteria[task.scopes[0].id].path, task.scopes[0].path);
  assert.equal(request.questions.verdict.type, 'choice');
  assert.equal(request.questions.answerable.type, 'noul');
});

test('modified evidence and missing scopes fail before inference', () => {
  const changed = structuredClone(tasks[0]); changed.scopes[0].text += '\n// fabricated';
  assert.throws(() => buildRequest(changed), /hash mismatch/);
  assert.throws(() => buildRequest({ ...tasks[0], scopes: tasks[0].scopes.slice(0, 2) }), /three to six/);
  assert.throws(() => readScope(root, { path: 'lib/coherence.js', symbol: 'madeUpFunction' }), /Expected one/);
  assert.throws(() => readScope(root, { path: '.env', symbol: 'anything' }), /rejected/);
});

test('positive and negative claims share evidence, with no fixed-position refutation shortcut', () => {
  const locations = new Set();
  for (let index = 0; index < tasks.length; index += 2) {
    const [positive, negative] = tasks.slice(index, index + 2);
    assert.equal(positive.groupId, negative.groupId);
    assert.deepEqual(positive.scopes, negative.scopes);
    assert.notEqual(positive.claim, negative.claim);
    assert.equal(positive.expected.bestRefutation, 'none');
    if (negative.expected.verdict === 'contradicts') locations.add(negative.expected.bestRefutation);
  }
  assert.ok(locations.size >= 3);
});

test('real renderer demonstrates omitted later rows and non-hard final cap', () => {
  const { formatRetrievalDetailed } = require('../../lib/format-retrieval');
  const first = { path: 'lib/a.js', graphSignal: 'exported_symbol', matchedTerms: ['a'], fanIn: 5 };
  const second = { ...first, path: 'lib/second-very-long-name.js' };
  const rendered = formatRetrievalDetailed({ files: [first, second] }, { maxChars: 90 });
  assert.equal(rendered.files.length, 1);
  const oversized = formatRetrievalDetailed({ files: [{ path: 'x'.repeat(300) }] }, { maxChars: 80 });
  assert.ok(oversized.text.length > 80);
  const textOnly = formatRetrievalDetailed({ files: [{ ...first, zoektHit: { lineNumber: 7, line: 'const evidence = true;' } }] }, { textOnly: true });
  assert.doesNotMatch(textOnly.text, /exports a|fan-in/);
  assert.match(textOnly.text, /L7:/);
});

test('real workset functions preserve delivery boundary, deduplication and uncapped totals', () => {
  const coherence = require('../../lib/coherence');
  const filtered = coherence.visibleRoleWorkset({ primary: [{ path: 'a.js' }, { path: 'b.js' }], witnesses: [{ path: 'b.js' }] }, [{ path: 'a.js' }]);
  assert.deepEqual(filtered.primary, [{ path: 'a.js' }]); assert.deepEqual(filtered.witnesses, []);
  const context = coherence.contextPathWorkset([{ path: './b.js' }, { path: 'a.js' }, { path: 'b.js' }]);
  assert.deepEqual(context.context, [{ path: 'a.js' }, { path: 'b.js' }]); assert.deepEqual(context.primary, []);
  const primary = Array.from({ length: 70 }, (_, index) => ({ path: `file-${index}.js` }));
  const overlap = coherence.worksetOverlap({ primary }, { primary });
  assert.equal(overlap.sharedPathTotal, 70); assert.equal(overlap.sharedPaths.length, 50);
  assert.equal(coherence.coherenceEnabled(root, { SEXTANT_COHERENCE: '1', SEXTANT_CAPSULE: '0' }), false);
});

test('real clamps and secret-path guards prove exception claims', () => {
  const { clampBlock } = require('../../lib/summary');
  const { isSensitivePath } = require('../../lib/zoekt-scope');
  assert.equal(clampBlock('x'.repeat(300), 80), 'x'.repeat(80));
  assert.equal(isSensitivePath('.env.example'), false);
  assert.equal(isSensitivePath('.env.example.local'), true);
});

test('non-exported pure function behavior is replayed from exact AST source', () => {
  function fn(file, symbol, globals = {}) {
    return vm.runInNewContext(`(${readScope(root, { path: `lib/${file}.js`, symbol }).text})`, globals, { timeout: 1000 });
  }
  assert.equal(fn('claims', 'provenanceOf')('unknown-source'), 'live_text');
  const added = new Set(['a']), removed = new Set();
  fn('closure', 'foldObservedPair')(added, removed, [], ['a']);
  assert.equal(added.size, 0); assert.equal(removed.size, 0);
  assert.equal(fn('freshness', 'sameRepoState')({ head: 'h', statusHash: 's', scannerVersion: 'old' }, { head: 'h', statusHash: 's', scannerVersion: 'new' }), true);
  let installedChecks = 0;
  assert.equal(fn('retrieve', 'pickBackend', { zoekt: { isInstalled() { installedChecks++; return true; } } })('rg', root), 'rg');
  assert.equal(installedChecks, 0);
});

test('unknown current events stay insufficient for both polarities', () => {
  const unknown = tasks.filter(task => task.expected.verdict === 'insufficient');
  assert.equal(unknown.length, 4);
  for (const task of unknown) {
    assert.equal(task.expected.bestRefutation, 'none');
    assert.ok(task.rationale.includes('neither') || task.rationale.includes('Neither'));
  }
  const closure = tasks.find(task => task.groupId === 'closure-not-proof');
  assert.match(closure.scopes.find(scope => scope.symbol === 'renderClosure').text, /does not assert the change is correct, complete, or safe to merge/);
});

function fakeResponse(task, request, { model = 'jev-1.13.0', verdict = task.expected.verdict, selection = task.expected.bestRefutation, p = 0.8 } = {}) {
  const choice = (question, selected) => ({ type: 'choice', choice: selected, confidence: 1,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === selected)])) });
  return { model, usage: { input_tokens: 100, output_tokens: 10 }, answers: {
    verdict: choice(request.questions.verdict, verdict), best_refutation: choice(request.questions.best_refutation, selection), answerable: { type: 'noul', noul: p },
  } };
}

test('frozen evidence roundtrips with bounded reconstructed label-free requests', () => {
  const frozen = freezeTasks(tasks);
  assert.equal(validateFrozen(JSON.parse(JSON.stringify(frozen))).fingerprint, frozen.fingerprint);
  for (const row of frozen.plan) assert.doesNotMatch(JSON.stringify(row.request), /"expected"|"rationale"|"polarity"|"provenance"|"fileSha256"/);
  const bad = structuredClone(frozen); bad.tasks[0].scopes[0].text += ' altered';
  assert.throws(() => validateFrozen(bad), /fingerprint/);
  const injected = structuredClone(frozen);
  injected.plan[0].request.state.expected = injected.tasks[0].expected;
  injected.plan[0].requestHash = sha256(JSON.stringify(injected.plan[0].request));
  const { fingerprint, ...payload } = injected; injected.fingerprint = sha256(JSON.stringify(payload));
  assert.throws(() => validateFrozen(injected), /label-free builder/);
});

test('fake live orchestration reports independently computed confusion and answerability', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-refutation-live-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const subset = [tasks[0], tasks[1], tasks.at(-2), tasks.at(-1)];
  const frozen = freezeTasks(subset);
  let count = 0;
  const result = await runFrozen(frozen, path.join(dir, 'result.jsonl'), { client: { async systemOne(request) {
    const index = count++;
    assert.doesNotMatch(JSON.stringify(request), /"expected"|"rationale"/);
    return fakeResponse(subset[index], request, { p: [0.8, 0.3, 0.1, 0.7][index],
      ...(index === 1 ? { verdict: 'supports', selection: 'none' } : {}) });
  } } });
  assert.equal(count, 4); assert.equal(result.executionKind, 'mock-transport');
  assert.equal(result.status, 'complete'); assert.equal(result.completed, 4); assert.equal(result.unattempted, 0);
  const measured = result.byModel['jev-1.13.0'];
  assert.equal(measured.verdict.accuracy, 0.75);
  assert.equal(measured.verdict.confusion.contradicts.supports, 1);
  assert.equal(measured.bestRefutation.accuracy, 0.75);
  assert.deepEqual([measured.answerability.tp, measured.answerability.tn, measured.answerability.fp, measured.answerability.fn], [1, 1, 1, 1]);
  assert.ok(Math.abs(measured.answerability.brier - 0.2575) < 1e-12);
  assert.equal(measured.inputTokens, 400);
  const records = fs.readFileSync(path.join(dir, 'result.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(report(records), result);
});

test('replay partitions actual models and rejects duplicate, reordered and post-error records', () => {
  const frozen = freezeTasks(tasks.slice(0, 2));
  const header = { kind: 'manifest', executionKind: 'mock-transport', experiment: frozen };
  const rows = frozen.plan.map((planned, index) => ({ kind: 'result', id: planned.id, requestHash: planned.requestHash,
    latencyMs: 1, response: fakeResponse(frozen.tasks[index], planned.request, { model: index ? 'jev-other-version' : 'jev-1.13.0' }) }));
  const result = report([header, ...rows]);
  assert.equal(result.modelStampMismatch, 1);
  assert.equal(Object.keys(result.byModel).length, 2);
  assert.equal(result.verdict, undefined, 'No mixed-model pooled quality');
  assert.throws(() => report([header, rows[0], rows[0]]), /schedule/);
  assert.throws(() => report([header, rows[1], rows[0]]), /schedule/);
  const error = { kind: 'error', id: rows[0].id, requestHash: rows[0].requestHash };
  assert.throws(() => report([header, error, rows[1]]), /after stop/);
  assert.equal(report([header, rows[0]]).unattempted, 1);
});

test('failed fake call writes terminal error and accurate partial summary without retries', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-refutation-partial-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const frozen = freezeTasks(tasks.slice(0, 3));
  let calls = 0;
  await assert.rejects(runFrozen(frozen, path.join(dir, 'result.jsonl'), { client: { async systemOne(request) {
    if (++calls === 2) throw new Error('PRIVATE_PROVIDER_BODY');
    return fakeResponse(frozen.tasks[0], request);
  } } }), /PRIVATE_PROVIDER_BODY/);
  assert.equal(calls, 2);
  const text = fs.readFileSync(path.join(dir, 'result.jsonl'), 'utf8');
  assert.doesNotMatch(text, /PRIVATE_PROVIDER_BODY/);
  const result = report(text.trim().split('\n').map(JSON.parse));
  assert.equal(result.status, 'failed-partial');
  assert.deepEqual([result.planned, result.completed, result.errorCount, result.unattempted], [3, 1, 1, 1]);
  assert.deepEqual(result.errorIds, [tasks[1].id]);
  assert.deepEqual(result.unattemptedIds, [tasks[2].id]);
});

test('tampered frozen experiment fails before output creation or transport', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-refutation-corrupt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const frozen = freezeTasks(tasks.slice(0, 2)); frozen.tasks[0].expected.verdict = 'insufficient';
  let calls = 0;
  const out = path.join(dir, 'result.jsonl');
  await assert.rejects(runFrozen(frozen, out, { client: { systemOne() { calls++; } } }), /fingerprint/);
  assert.equal(calls, 0); assert.equal(fs.existsSync(out), false);
});
