'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const { allowedPath, makeSnapshot, candidatesFromResult, buildRequest, rankingMetrics, compareRankings, summary, live } = require('./repository');

function candidate(id, file, text = 'function target() { return true; }') {
  return { id, path: file, fileSha256: 'local-only-hash', spans: [{ startLine: 1, endLine: 1, text }] };
}

function task() {
  const candidates = [candidate('candidate_0', 'lib/consumer.js'), candidate('candidate_1', 'lib/definition.js')];
  return { id: 'fixture', candidates, labels: { relevantFiles: ['lib/definition.js', 'lib/omitted.js'], acceptableFiles: [], topK: 3 }, request: buildRequest('target', candidates) };
}

function response() {
  return { model: 'jev-1.13.0', usage: { input_tokens: 100, output_tokens: 10 }, answers: {
    relevance_candidate_0: { type: 'noul', noul: 0.1 }, relevance_candidate_1: { type: 'noul', noul: 0.9 },
    best_file: { type: 'choice', choice: 'candidate_1', confidence: 0.8, probabilities: { candidate_0: 0.1, candidate_1: 0.85, none: 0.05 } },
  } };
}

test('source admission excludes credentials, traversal, experiment and post-research pollution', () => {
  for (const file of ['.env', '.env.production', '.ssh/id_rsa', 'credentials.json', '../outside.js', '/tmp/outside.js', 'lib/../outside.js', 'lib\\outside.js',
    'experiments/jev/cases.js', 'docs/042-jev-research.md', 'docs/044-jev-repository-experiments.md', '.planning/jev/tasks.json', 'scripts/eval-dataset.json', 'scripts/eval-retrieve.js']) {
    assert.equal(allowedPath(file), false, file);
  }
  assert.equal(allowedPath('lib/retrieve.js'), true);
  assert.equal(allowedPath('docs/041-hibernation-results-review.md'), true);
});

test('request rebuild strips local metadata and labels and puts candidate identity into inference', () => {
  const candidates = [Object.assign(candidate('candidate_0', 'lib/target.js'), { expected: 'LABEL_SECRET', rationale: 'LABEL_SECRET' })];
  const request = buildRequest('target', candidates);
  assert.doesNotMatch(JSON.stringify(request), /LABEL_SECRET|fileSha256|local-only-hash|expected|rationale/);
  assert.equal(request.questions.relevance_candidate_0.instructions.candidate_path, 'lib/target.js');
  assert.equal(request.questions.best_file.criteria.candidate_0.path, 'lib/target.js');
  assert.ok(request.questions.best_file.criteria.none);
  assert.throws(() => buildRequest('target', [candidates[0], candidates[0]]), /duplicate/);
  assert.throws(() => buildRequest('target', [candidate('candidate_0', '.env')]), /mapping/);
  assert.throws(() => buildRequest('target', [candidate('candidate_0', 'lib/file.js', 'x'.repeat(1501))]), /span/);
});

test('ranking gains preserve primary/secondary/acceptable semantics and cannot hide omitted gold', () => {
  const t = task();
  const result = compareRankings(t, response());
  assert.equal(result.baseline.mrr, 0.5);
  assert.equal(result.noul.mrr, 1);
  assert.equal(result.choice.mrr, 1);
  assert.equal(result.candidateCoverage, 0.5);
  assert.ok(result.noul.ndcg < 1, 'Missing secondary gold remains in ideal denominator');
  assert.equal(rankingMetrics([], t.labels).mrr, 0);
  assert.equal(rankingMetrics([], t.labels).ndcg, 0);
  assert.throws(() => rankingMetrics(['a', 'a'], t.labels), /duplicate/);
});

test('Choice none abstains without hiding the ungated relative ordering', () => {
  const r = response();
  r.answers.best_file = { type: 'choice', choice: 'none', confidence: 0.8, probabilities: { candidate_0: 0.02, candidate_1: 0.08, none: 0.9 } };
  const result = compareRankings(task(), r);
  assert.equal(result.abstained, true);
  assert.equal(result.choice.mrr, 0);
  assert.equal(result.choiceRelative.mrr, 1);
  assert.deepEqual(result.rankings.choice, []);
});

test('malformed provider mappings cannot enter metrics', () => {
  const r = response();
  r.answers.best_file.probabilities.hallucinated = 0;
  assert.throws(() => compareRankings(task(), r), /distribution/);
  const missing = response(); delete missing.answers.relevance_candidate_1;
  assert.throws(() => compareRankings(task(), missing), /every requested/);
});

test('empty candidate pool has explicit none and honest zero coverage', () => {
  const request = buildRequest('absent implementation', []);
  assert.deepEqual(Object.keys(request.questions), ['best_file']);
  const t = { id: 'empty', candidates: [], request, labels: { relevantFiles: ['missing.js'] } };
  const result = compareRankings(t, { model: 'jev-1.13.0', usage: { input_tokens: 100, output_tokens: 10 }, answers: { best_file: { type: 'choice', choice: 'none', confidence: 1, probabilities: { none: 1 } } } });
  assert.equal(result.candidateCoverage, 0);
  assert.equal(result.primaryCandidatePresent, false);
  assert.equal(summary([t]).providerResults, 0);
  assert.equal(summary([t]).arms.noul, undefined);
});

test('no-answer controls are separate from positive-query ranking means', () => {
  const empty = { id: 'empty', candidates: [], labels: { relevantFiles: [], acceptableFiles: [] } };
  const result = summary([task(), empty]);
  assert.equal(result.arms.baseline.mrr, 0.5);
  assert.equal(result.primaryCandidateCoverage, 1);
  assert.equal(result.noAnswerCases, 1);
  assert.equal(result.noAnswerEvaluated, 0);
  assert.equal(rankingMetrics([], empty.labels).mrr, null);
});

test('snapshot excludes sensitive tracked files and symlinks before indexing', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-repository-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'root'); fs.mkdirSync(root);
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git(['init', '--quiet']);
  fs.mkdirSync(path.join(root, 'lib')); fs.mkdirSync(path.join(root, 'experiments'));
  fs.writeFileSync(path.join(root, 'lib/a.js'), 'function target() { return 1; }\n');
  fs.writeFileSync(path.join(root, '.env'), 'PRIVATE');
  fs.writeFileSync(path.join(root, 'experiments/answers.js'), 'LABEL_SECRET');
  fs.symlinkSync('a.js', path.join(root, 'lib/link.js'));
  git(['add', '.']); git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  fs.writeFileSync(path.join(root, 'lib/a.js'), 'function target() { return 2; }\n');
  const snapshot = path.join(temp, 'snapshot');
  const provenance = makeSnapshot(root, snapshot);
  assert.deepEqual(Object.keys(provenance.files), ['lib/a.js']);
  assert.match(fs.readFileSync(path.join(snapshot, 'lib/a.js'), 'utf8'), /return 2/);
  assert.equal(fs.existsSync(path.join(snapshot, '.env')), false);
  assert.equal(fs.existsSync(path.join(snapshot, 'experiments')), false);
  assert.equal(fs.existsSync(path.join(snapshot, 'lib/link.js')), false);
  const result = { results: { files: [{ path: 'lib/a.js' }], hits: [{ path: 'lib/a.js', lineNumber: 1 }] } };
  const candidates = candidatesFromResult(snapshot, result);
  assert.equal(candidates[0].fileSha256, provenance.files['lib/a.js'].sha256);
  assert.match(candidates[0].spans[0].text, /return 2/);
  assert.throws(() => candidatesFromResult(snapshot, { results: { ...result.results, hits: [{ path: 'lib/a.js', lineNumber: 99 }] } }), /outside source/);
});

test('live refuses modified artifacts before any model call', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-repository-artifact-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ tasksHash: 'wrong' }));
  fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify([task()]));
  let calls = 0;
  await assert.rejects(live(dir, path.join(dir, 'result.jsonl'), { client: { systemOne() { calls++; } } }), /hash mismatch/);
  assert.equal(calls, 0);
});

test('live sends only rebuilt evidence and records paired metrics and usage', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-repository-live-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const item = { ...task(), id: 'fixture', localLabel: 'NEVER_SEND' };
  item.requestHash = hash(item.request);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ model: 'jev-1.13.0', tasksHash: hash([item]) }));
  fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify([item]));
  let calls = 0;
  const result = await live(dir, path.join(dir, 'result.jsonl'), { client: { async systemOne(request) {
    calls++;
    assert.doesNotMatch(JSON.stringify(request), /NEVER_SEND|relevantFiles|omitted.js|fileSha256/);
    return response();
  } } });
  assert.equal(calls, 1);
  assert.equal(result.inputTokens, 100);
  assert.equal(result.arms.noul.pairedDeltaMrr, 0.5);
  const records = fs.readFileSync(path.join(dir, 'result.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map(row => row.kind), ['manifest', 'result', 'summary']);
});

test('provider failure leaves a durable partial summary with exact missing identities', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-repository-failure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const items = ['first', 'second', 'third'].map(id => { const item = { ...task(), id }; item.requestHash = hash(item.request); return item; });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ model: 'jev-1.13.0', tasksHash: hash(items), runnerSha256: 'historical-collector' }));
  fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify(items));
  let calls = 0;
  await assert.rejects(live(dir, path.join(dir, 'result.jsonl'), { client: { async systemOne() {
    if (++calls === 2) throw new Error('provider failed');
    return response();
  } } }), /provider failed/);
  const records = fs.readFileSync(path.join(dir, 'result.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records[0].collectionRunnerSha256, 'historical-collector');
  assert.match(records[0].evaluatorRunnerSha256, /^[a-f0-9]{64}$/);
  const last = records.at(-1);
  assert.equal(last.kind, 'summary'); assert.equal(last.status, 'failed-partial');
  assert.equal(last.planned, 3); assert.equal(last.succeeded, 1); assert.equal(last.failed, 1); assert.equal(last.pending, 1);
  assert.deepEqual(last.failedIds, ['second']); assert.deepEqual(last.missingIds, ['second', 'third']);
});
