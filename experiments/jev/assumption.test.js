'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { prepare, recheckFreshness, presentAssessment, runAssessment, parseArgs } = require('./assumption');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sextant-assumption-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'lib'));
  fs.writeFileSync(path.join(root, 'lib/alpha.js'), "'use strict';\nfunction cap(value) { return Math.min(value, 10); }\n");
  fs.writeFileSync(path.join(root, 'lib/beta.js'), 'function doubled(value) { return value * 2; }\n');
  fs.writeFileSync(path.join(root, 'lib/gamma.js'), 'const label = value => `Value: ${value}`;\n');
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git(['init', '--quiet']); git(['add', 'lib']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  return { root, claim: 'cap always returns its input unchanged.', scopes: [
    { path: 'lib/alpha.js', symbol: 'cap' }, { path: 'lib/beta.js', symbol: 'doubled' }, { path: 'lib/gamma.js', symbol: 'label' },
  ], git };
}

function response(request, { verdict = 'contradicts', selected = 'scope_0', answerable = 0.9, model = 'jev-1.13.0', selectionProbability = 1 } = {}) {
  const choice = (question, value, probability = 1) => ({ type: 'choice', choice: value, confidence: probability,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === value ? probability : (1 - probability) / (Object.keys(question.criteria).length - 1)])) });
  return { model, usage: { input_tokens: 120, output_tokens: 30 }, answers: {
    verdict: choice(request.questions.verdict, verdict),
    best_refutation: choice(request.questions.best_refutation, selected, selectionProbability),
    answerable: { type: 'noul', noul: answerable },
  } };
}

test('collects exact tracked source spans, hashes and line evidence without leaking local metadata into provider state', t => {
  const options = fixture(t);
  const prepared = prepare({ ...options, expected: 'LABEL_CANARY', rationale: 'RATIONALE_CANARY' });
  assert.equal(prepared.task.scopes.length, 3);
  assert.ok(prepared.requestBytes < 26000);
  const alpha = prepared.task.scopes[0];
  assert.equal(alpha.startLine, 2); assert.equal(alpha.endLine, 2);
  const bytes = fs.readFileSync(path.join(options.root, alpha.path));
  assert.equal(alpha.fileSha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(alpha.text, bytes.toString('utf8').slice(alpha.startOffset, alpha.endOffset));
  assert.deepEqual(Object.keys(prepared.request.state), ['proposed_claim', 'scopes']);
  assert.doesNotMatch(JSON.stringify(prepared.request), /LABEL_CANARY|RATIONALE_CANARY|fileSha256|scopeSha256|collectedAt/);
  assert.ok(!JSON.stringify(prepared.request).includes(options.root));
});

test('rejects unsupported, outside, sensitive, untracked, duplicate and excessive scopes before inference', t => {
  const options = fixture(t);
  for (const descriptor of [
    { path: '../outside.js', symbol: 'cap' }, { path: '/tmp/outside.js', symbol: 'cap' },
    { path: '.env', symbol: 'cap' }, { path: 'lib/alpha.ts', symbol: 'cap' },
    { path: 'lib/missing.js', symbol: 'cap' }, { path: 'lib/alpha.js', symbol: 'missing' },
  ]) assert.throws(() => prepare({ ...options, scopes: [descriptor, ...options.scopes.slice(1)] }));
  fs.writeFileSync(path.join(options.root, 'lib/untracked.js'), 'function cap() {}');
  assert.throws(() => prepare({ ...options, scopes: [{ path: 'lib/untracked.js', symbol: 'cap' }, ...options.scopes.slice(1)] }));
  assert.throws(() => prepare({ ...options, scopes: options.scopes.slice(0, 2) }), /three or four/);
  assert.throws(() => prepare({ ...options, scopes: [...options.scopes, ...options.scopes.slice(0, 2)] }), /three or four/);
  assert.throws(() => prepare({ ...options, scopes: [options.scopes[0], options.scopes[0], options.scopes[2]] }), /Duplicate/);
});

test('existing guard rejects tracked sensitive and symlink source files', t => {
  const options = fixture(t);
  fs.writeFileSync(path.join(options.root, '.env.js'), 'function secret() { return "NOT_A_REAL_SECRET"; }');
  fs.symlinkSync('alpha.js', path.join(options.root, 'lib/link.js'));
  options.git(['add', '.env.js', 'lib/link.js']);
  assert.throws(() => prepare({ ...options, scopes: [{ path: '.env.js', symbol: 'secret' }, ...options.scopes.slice(1)] }), /rejected/);
  assert.throws(() => prepare({ ...options, scopes: [{ path: 'lib/link.js', symbol: 'cap' }, ...options.scopes.slice(1)] }), /regular tracked source/);
});

test('only a coherent answerable contradiction yields a located refutation candidate', t => {
  const prepared = prepare(fixture(t));
  const freshness = recheckFreshness(prepared.root, prepared.task.scopes);
  const result = presentAssessment(prepared, response(prepared.request), freshness);
  assert.equal(result.status, 'refutation_candidate');
  assert.equal(result.suggestedRefutation.path, 'lib/alpha.js');
  assert.equal(result.suggestedRefutation.startLine, 2);
  assert.match(result.interpretation, /correctness is not certified/);
  for (const options of [
    { verdict: 'supports', selected: 'none', answerable: 0.9 },
    { verdict: 'insufficient', selected: 'none', answerable: 0.1 },
  ]) {
    const result = presentAssessment(prepared, response(prepared.request, options), freshness);
    assert.equal(result.suggestedRefutation, null);
    assert.notEqual(result.status, 'needs_review');
  }
});

test('observed supports-versus-refuting-scope disagreement remains needs_review, even at 0.57 selection probability', t => {
  const prepared = prepare(fixture(t));
  const result = presentAssessment(prepared, response(prepared.request, { verdict: 'supports', selected: 'scope_0', selectionProbability: 0.57 }),
    recheckFreshness(prepared.root, prepared.task.scopes));
  assert.equal(result.status, 'needs_review');
  assert.equal(result.suggestedRefutation, null);
  assert.ok(result.reviewReasons.includes('refutation_scope_disagrees_with_verdict'));
});

test('all inconsistent head combinations and exact answerability boundary prevent refutation suggestions', t => {
  const prepared = prepare(fixture(t));
  const freshness = recheckFreshness(prepared.root, prepared.task.scopes);
  for (const options of [
    { verdict: 'contradicts', selected: 'none', answerable: 0.9 },
    { verdict: 'contradicts', selected: 'scope_0', answerable: 0.5 },
    { verdict: 'supports', selected: 'none', answerable: 0.1 },
    { verdict: 'insufficient', selected: 'none', answerable: 0.9 },
    { verdict: 'insufficient', selected: 'scope_0', answerable: 0.1 },
    { model: 'jev-other-version' },
  ]) {
    const result = presentAssessment(prepared, response(prepared.request, options), freshness);
    assert.equal(result.status, 'needs_review'); assert.equal(result.suggestedRefutation, null);
  }
  assert.throws(() => presentAssessment(prepared, response(prepared.request), { unchanged: true, checks: [] }), /freshness recheck/);
});

test('live orchestration preserves typed heads, source evidence and measured stamps in an exclusive private artifact', async t => {
  const options = fixture(t), out = path.join(options.root, 'assessment.json');
  let calls = 0;
  const client = { async systemOne(request) { calls++; return response(request); } };
  const result = await runAssessment({ ...options, out }, { client });
  assert.equal(calls, 1); assert.equal(result.status, 'refutation_candidate');
  assert.equal(result.executionKind, 'injected-client');
  assert.equal(result.requestedModel, 'jev-1.13.0'); assert.equal(result.returnedModel, 'jev-1.13.0');
  assert.deepEqual(result.usage, { input_tokens: 120, output_tokens: 30 });
  assert.ok(result.latencyMs >= 0); assert.ok(result.freshness.unchanged);
  assert.equal(result.scopes.length, 3); assert.equal(result.modelAssessment.verdict.choice, 'contradicts');
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), result);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  const original = fs.readFileSync(out, 'utf8');
  await assert.rejects(runAssessment({ ...options, out }, { client }), error => error.code === 'EEXIST');
  assert.equal(calls, 1); assert.equal(fs.readFileSync(out, 'utf8'), original);
});

test('source changed during inference invalidates suggestion while retaining original evidence and typed output', async t => {
  const options = fixture(t), out = path.join(options.root, 'changed.json');
  const result = await runAssessment({ ...options, out }, { client: { async systemOne(request) {
    fs.writeFileSync(path.join(options.root, 'lib/alpha.js'), 'function cap(value) { return value; }\n');
    return response(request);
  } } });
  assert.equal(result.status, 'needs_review'); assert.equal(result.suggestedRefutation, null);
  assert.equal(result.freshness.unchanged, false);
  assert.ok(result.reviewReasons.includes('source_changed_after_request'));
  assert.match(result.scopes[0].text, /Math\.min/);
  assert.equal(result.modelAssessment.verdict.choice, 'contradicts');
});

test('deleted source or changes outside selected function still invalidate the source snapshot', async t => {
  const options = fixture(t);
  const prepared = prepare(options);
  fs.appendFileSync(path.join(options.root, 'lib/alpha.js'), '\nconst another = 2;\n');
  let freshness = recheckFreshness(prepared.root, prepared.task.scopes);
  assert.equal(freshness.unchanged, false);
  assert.equal(freshness.checks[0].currentScopeSha256, prepared.task.scopes[0].scopeSha256);
  fs.unlinkSync(path.join(options.root, 'lib/beta.js'));
  freshness = recheckFreshness(prepared.root, prepared.task.scopes);
  assert.equal(freshness.checks[1].reason, 'source_unavailable_or_rejected');
  assert.equal(presentAssessment(prepared, response(prepared.request), freshness).suggestedRefutation, null);
});

test('freshness evidence cannot be reused from another repository or another scope descriptor', t => {
  const original = prepare(fixture(t));
  const other = prepare(fixture(t));
  fs.writeFileSync(path.join(original.root, 'lib/alpha.js'), 'function cap(value) { return value; }\n');
  const unrelatedFreshness = recheckFreshness(other.root, other.task.scopes);
  assert.ok(unrelatedFreshness.unchanged);
  assert.throws(() => presentAssessment(original, response(original.request), unrelatedFreshness), /freshness|Freshness/);
  const freshness = recheckFreshness(other.root, other.task.scopes);
  freshness.checks[0].symbol = 'differentDeclaration';
  assert.throws(() => presentAssessment(other, response(other.request), freshness), /freshness|Freshness/);
});

test('whitespace claims and nonexact scope descriptors fail before an output artifact or provider call', async t => {
  const options = fixture(t);
  const out = path.join(options.root, 'must-not-exist.json');
  let calls = 0;
  const client = { async systemOne() { calls++; throw new Error('unreachable'); } };
  await assert.rejects(runAssessment({ ...options, claim: ' \t\n ', out }, { client }), /Claim/);
  for (const descriptor of [
    { path: 'lib/alpha.js ', symbol: 'cap' }, { path: 'lib/./alpha.js', symbol: 'cap' },
    { path: 'lib/alpha.js', symbol: 'cap ' }, { path: 'lib/alpha.js', symbol: 'ca' },
  ]) await assert.rejects(runAssessment({ ...options, scopes: [descriptor, ...options.scopes.slice(1)], out }, { client }));
  assert.equal(calls, 0); assert.equal(fs.existsSync(out), false);
});

test('provider failures and malformed heads fail loudly with sanitized artifacts and no retry', async t => {
  const options = fixture(t);
  for (const malformed of [false, true]) {
    let calls = 0;
    const out = path.join(options.root, `failed-${malformed}.json`);
    await assert.rejects(runAssessment({ ...options, out }, { client: { async systemOne(request) {
      calls++;
      if (malformed) { const r = response(request); delete r.answers.answerable; return r; }
      const error = new Error('PRIVATE_PROVIDER_RESPONSE'); error.status = 429; throw error;
    } } }), /request failed/);
    assert.equal(calls, 1);
    const text = fs.readFileSync(out, 'utf8');
    assert.doesNotMatch(text, /PRIVATE_PROVIDER_RESPONSE/);
    assert.equal(JSON.parse(text).status, 'provider_error');
  }
});

test('CLI requires explicit root, claim, scopes and a new output path for live', () => {
  const args = ['inspect', '--root', '/repo', '--claim', 'Quoted claim', '--scope', 'lib/a.js:run', '--scope', 'lib/b.js:other', '--scope', 'lib/c.js:third'];
  assert.equal(parseArgs(args).scopes.length, 3);
  assert.throws(() => parseArgs(['inspect', '--claim', 'Claim']), /Explicit/);
  assert.throws(() => parseArgs(['live', ...args.slice(1)]), /--out/);
  assert.throws(() => parseArgs([...args, '--root', '/elsewhere']), /Duplicate/);
  assert.throws(() => parseArgs([...args, '--out', 'ignored.json']), /only used for live/);
});
