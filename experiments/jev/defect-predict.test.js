'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  SCRATCH_ROOT, FILE_QUESTIONS,
  redact, isFixturePath, isDocPath, regexIsFix, chunkSource,
  buildCommitClassifyRequest, buildFileBatteryRequest,
  ensureClone, materializeSnapshot, removeWorktree, commitLog, temporalSplit, indexCommitsByFile,
  freezeRepo, freezeAll, liveAll,
  sigmoid, standardize, applyStandardize, fitLogisticRegression, predictProba, logLoss,
  effortAwareRecall, predictorAUC, bootstrapDeltaCI, loroRun, featureRow, BASELINE_KEYS, JEV_KEYS,
  classifierAgreement, repoReport, fullReport, assertScratchPath, estimateTokens,
} = require('./defect-predict');
const { mulberry32 } = require('./witness');

// ---------------------------------------------------------------- redaction

test('redact strips provider-shaped secrets and counts each hit', () => {
  assert.deepEqual(redact('key = "sk_live_ABCDEFGHIJKLMNOPQR"'), { text: 'key = "[REDACTED]"', count: 1 });
  assert.deepEqual(redact('AKIAABCDEFGHIJKLMNOP is the id'), { text: '[REDACTED] is the id', count: 1 });
  assert.deepEqual(redact('token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ01'), { text: 'token: [REDACTED]', count: 1 });
  assert.deepEqual(redact('pat github_pat_ABCDEFGHIJKLMNOPQRSTUVWX'), { text: 'pat [REDACTED]', count: 1 });
  assert.deepEqual(redact('slack xoxb-1234567890-abcdefgh'), { text: 'slack [REDACTED]', count: 1 });
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  assert.deepEqual(redact(`auth ${jwt}`), { text: 'auth [REDACTED]', count: 1 });
});

test('redact strips a key/secret/token/password assignment but keeps the identifier', () => {
  const { text, count } = redact('const apiSecretValue = "0123456789abcdefghij"; return apiSecretValue;');
  assert.equal(count, 1);
  assert.equal(text, 'const apiSecretValue = "[REDACTED]"; return apiSecretValue;');
  // A short value (<16 chars) is not a plausible secret literal and must survive.
  assert.deepEqual(redact('const token = "short";'), { text: 'const token = "short";', count: 0 });
});

test('redact leaves ordinary code untouched (no false positives)', () => {
  const code = [
    'function add(a, b) {',
    '  return a + b;',
    '}',
    'const total = add(1, 2);',
    'module.exports = { add, total };',
  ].join('\n');
  assert.deepEqual(redact(code), { text: code, count: 0 });
});

test('redact handles multiple hits in one string and non-string input', () => {
  assert.equal(redact('sk_test_ABCDEFGHIJKLMNOP and AKIAABCDEFGHIJKLMNOP').count, 2);
  assert.deepEqual(redact(''), { text: '', count: 0 });
  assert.deepEqual(redact(null), { text: '', count: 0 });
  assert.deepEqual(redact(undefined), { text: '', count: 0 });
});

// ---------------------------------------------------------------- path filters + regex classifier

test('isFixturePath / isDocPath match the intended directories only', () => {
  assert.ok(isFixturePath('fixtures/sample.js'));
  assert.ok(isFixturePath('lib/examples/demo.js'));
  assert.ok(isFixturePath('test/e2e/flow.js'));
  assert.ok(!isFixturePath('lib/mixture.js'));
  assert.ok(isDocPath('docs/guide.js'));
  assert.ok(isDocPath('documentation/api.js'));
  assert.ok(!isDocPath('lib/docstore.js'));
});

test('regexIsFix matches the task-specified fix vocabulary and nothing else', () => {
  for (const subject of [
    'Fix null check in alpha', 'Guard beta against crash on null', 'Fix leak in alpha connection',
    'Fix broken output in beta', 'Prevent race in alpha cache', 'Correct wrong output',
    'Stop retrying forever', 'Handle incorrect response gracefully',
  ]) assert.ok(regexIsFix(subject), subject);
  for (const subject of [
    'Add alpha module', 'Refactor beta for clarity', 'Tune alpha performance',
    'Add another feature to gamma', 'Polish gamma docs comment', 'Add helpful message to beta',
    'Update README', 'Bump dependency version',
  ]) assert.ok(!regexIsFix(subject), subject);
});

// ---------------------------------------------------------------- chunking

test('chunkSource returns the whole text as one chunk under the cap', () => {
  assert.deepEqual(chunkSource('short file'), ['short file']);
});

test('chunkSource splits on line boundaries and every chunk stays under the cap', () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `line ${i} `.repeat(3));
  const text = lines.join('\n');
  const chunks = chunkSource(text);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 20000);
  assert.equal(chunks.join('\n'), text);
});

test('chunkSource hard-slices a single line longer than the cap', () => {
  const text = 'x'.repeat(45000);
  const chunks = chunkSource(text);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(c.length <= 20000);
  assert.equal(chunks.join(''), text);
});

// ---------------------------------------------------------------- request builders

test('buildCommitClassifyRequest redacts, truncates the body, and caps changed paths', () => {
  const commit = {
    hash: 'abc123', subject: 'Fix leak with token = "0123456789abcdefghij"',
    body: 'A'.repeat(2000), files: Array.from({ length: 250 }, (_, i) => `lib/file${i}.js`),
  };
  const { request, redactions } = buildCommitClassifyRequest(commit, 'jev-1.13.0');
  assert.equal(redactions, 1);
  assert.match(request.state.subject, /\[REDACTED\]/);
  assert.equal(request.state.body.length, 1500);
  assert.equal(request.state.changedPaths.length, 200);
  assert.equal(request.state.changedPathsOmitted, 50);
  assert.equal(request.questions.isDefectFix.type, 'noul');
  assert.ok(request.questions.isDefectFix.criteria.true.examples.length > 0);
  assert.ok(request.questions.isDefectFix.criteria.false.examples.length > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 25000);
});

test('buildFileBatteryRequest asks exactly the seven battery questions and marks chunk context', () => {
  const request = buildFileBatteryRequest('lib/alpha.js', 'function f() {}', 0, 2, 'jev-1.13.0');
  assert.deepEqual(Object.keys(request.questions).sort(), FILE_QUESTIONS.map(([k]) => k).sort());
  for (const q of Object.values(request.questions)) assert.equal(q.type, 'noul');
  assert.match(request.questions.directRisk.instructions.note, /chunk 1 of 2/);
  const single = buildFileBatteryRequest('lib/alpha.js', 'function f() {}', 0, 1, 'jev-1.13.0');
  assert.doesNotMatch(single.questions.directRisk.instructions.note, /chunk/);
});

test('buildFileBatteryRequest refuses a request over the byte ceiling', () => {
  assert.throws(() => buildFileBatteryRequest('lib/big.js', 'x'.repeat(90000), 0, 1, 'jev-1.13.0'), /byte ceiling/);
});

// ---------------------------------------------------------------- guards

test('assertScratchPath refuses anything outside SCRATCH_ROOT, including the live repo', () => {
  assert.throws(() => assertScratchPath('/root/sextant'), /Refusing/);
  assert.throws(() => assertScratchPath('/root/jan25/.git'), /Refusing/);
  assert.throws(() => assertScratchPath('/tmp/whatever'), /Refusing/);
  assert.doesNotThrow(() => assertScratchPath(path.join(SCRATCH_ROOT, 'x.git')));
  assert.doesNotThrow(() => assertScratchPath(SCRATCH_ROOT));
});

test('estimateTokens is the bytes/4 heuristic used across the sibling jev experiments', () => {
  const request = { a: 'x'.repeat(400) };
  assert.equal(estimateTokens(request), Buffer.byteLength(JSON.stringify(request)) / 4);
});

// ---------------------------------------------------------------- git fixture

function initRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-defect-predict-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (args, env) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf8', env: { ...process.env, ...env } });
  git(['init', '--quiet']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.invalid']);
  return { dir, git };
}

function makeCommitter(dir, git) {
  let seq = 0;
  return ({ subject, files, date }) => {
    for (const [name, content] of Object.entries(files)) {
      const abs = path.join(dir, name);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    git(['add', ...Object.keys(files)]);
    const commitDate = date || new Date(Date.UTC(2024, 0, 1, 0, 0, seq)).toISOString();
    seq++;
    git(['commit', '--quiet', '-m', subject], { GIT_AUTHOR_DATE: commitDate, GIT_COMMITTER_DATE: commitDate });
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  };
}

// ---------------------------------------------------------------- commitLog / temporalSplit / churn

test('commitLog breaks same-second ties by ancestry, not raw git-log (newest-first) order', t => {
  const { dir, git } = initRepo(t);
  const doCommit = makeCommitter(dir, git);
  const sameInstant = new Date(Date.UTC(2024, 5, 1, 12, 0, 0)).toISOString();
  const expectedOrder = ['first', 'second', 'third', 'fourth'];
  for (const subject of expectedOrder) doCommit({ subject, files: { [`${subject}.txt`]: 'x' }, date: sameInstant });
  const commits = commitLog(dir, 'HEAD', 100);
  assert.deepEqual(commits.map(c => c.subject), expectedOrder);
});

test('commitLog sorts distinct dates ascending regardless of git log raw order', t => {
  const { dir, git } = initRepo(t);
  const doCommit = makeCommitter(dir, git);
  for (let i = 0; i < 5; i++) {
    doCommit({ subject: `commit ${i}`, files: { [`f${i}.txt`]: 'x' }, date: new Date(Date.UTC(2024, 0, 1 + i)).toISOString() });
  }
  const commits = commitLog(dir, 'HEAD', 100);
  assert.deepEqual(commits.map(c => c.subject), ['commit 0', 'commit 1', 'commit 2', 'commit 3', 'commit 4']);
  assert.ok(commits.every((c, i) => i === 0 || new Date(c.date) >= new Date(commits[i - 1].date)));
});

test('commitLog captures body and --name-only file lists per commit', t => {
  const { dir, git } = initRepo(t);
  const doCommit = makeCommitter(dir, git);
  git(['commit', '--allow-empty', '--quiet', '-m', 'Subject line\n\nBody paragraph one.\nBody paragraph two.'],
    { GIT_AUTHOR_DATE: new Date(Date.UTC(2024, 0, 1)).toISOString(), GIT_COMMITTER_DATE: new Date(Date.UTC(2024, 0, 1)).toISOString() });
  doCommit({ subject: 'Add two files', files: { 'a.txt': 'a', 'b.txt': 'b' }, date: new Date(Date.UTC(2024, 0, 2)).toISOString() });
  const commits = commitLog(dir, 'HEAD', 100);
  assert.equal(commits[0].subject, 'Subject line');
  assert.match(commits[0].body, /Body paragraph one\.\nBody paragraph two\./);
  assert.deepEqual(commits[0].files, []);
  assert.deepEqual(commits[1].files.sort(), ['a.txt', 'b.txt']);
});

test('temporalSplit cuts at the 60th-percentile commit, inclusive in preT', () => {
  const commits = Array.from({ length: 20 }, (_, i) => ({ hash: `h${i}`, date: `2024-01-${String(i + 1).padStart(2, '0')}`, subject: `c${i}`, files: [] }));
  const { T, preT, postT } = temporalSplit(commits);
  assert.equal(T.hash, 'h12');
  assert.equal(preT.length, 13);
  assert.equal(postT.length, 7);
  assert.equal(preT.at(-1).hash, 'h12');
  assert.equal(postT[0].hash, 'h13');
});

test('temporalSplit refuses a history too small for a meaningful split', () => {
  assert.throws(() => temporalSplit([{ hash: 'a', date: '2024-01-01' }]), /too small/);
  assert.throws(() => temporalSplit([]), /too small/);
});

test('indexCommitsByFile counts churn only for paths in the given set, preserving chronological order', () => {
  const commits = [
    { hash: 'a', date: '2024-01-01', subject: 'one', files: ['x.js', 'y.js'] },
    { hash: 'b', date: '2024-01-02', subject: 'two', files: ['x.js'] },
    { hash: 'c', date: '2024-01-03', subject: 'three', files: ['z.js'] },
  ];
  const idx = indexCommitsByFile(commits, new Set(['x.js']));
  assert.deepEqual(idx.get('x.js').map(c => c.hash), ['a', 'b']);
  assert.equal(idx.get('z.js'), undefined);
});

// ---------------------------------------------------------------- git plumbing (clone/worktree)

function scratchTestName(prefix) {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

test('ensureClone clones once and reuses on a second call; materializeSnapshot/removeWorktree round-trip', t => {
  const { dir: srcDir } = initRepo(t);
  const doCommit = makeCommitter(srcDir, (args, env) => execFileSync('git', args, { cwd: srcDir, stdio: 'pipe', encoding: 'utf8', env: { ...process.env, ...env } }));
  const sha = doCommit({ subject: 'Add file', files: { 'a.txt': 'hello\n' }, date: new Date(Date.UTC(2024, 0, 1)).toISOString() });

  const name = scratchTestName('test-ensureclone');
  const cloneDir = path.join(SCRATCH_ROOT, `${name}.git`);
  const snapshotDir = path.join(SCRATCH_ROOT, `${name}-snapshot`);
  t.after(() => { fs.rmSync(cloneDir, { recursive: true, force: true }); fs.rmSync(snapshotDir, { recursive: true, force: true }); });

  const first = ensureClone(srcDir, cloneDir);
  assert.equal(first.reused, false);
  const second = ensureClone(srcDir, cloneDir);
  assert.equal(second.reused, true);

  materializeSnapshot(cloneDir, sha, snapshotDir);
  assert.equal(fs.readFileSync(path.join(snapshotDir, 'a.txt'), 'utf8'), 'hello\n');
  removeWorktree(cloneDir, snapshotDir);
  assert.equal(fs.existsSync(snapshotDir), false);
  // The clone itself survives worktree removal, exactly what "leave the clones for reruns" requires.
  assert.ok(fs.existsSync(cloneDir));
});

// ---------------------------------------------------------------- freezeRepo end-to-end (real repo, real intel.scan)

// A hand-computable 20-commit history: T lands on commit index 12 (floor(20*0.6)),
// giving alpha/beta/gamma churn, pastFixes, age and post-T labels that can all be
// verified by hand (see the inline table in the test body).
function buildLabelFixture(t) {
  const { dir, git } = initRepo(t);
  const doCommit = makeCommitter(dir, git);
  const day = i => new Date(Date.UTC(2024, 0, 1 + i)).toISOString();
  const alpha = [
    'function alphaAdd(a, b) {', '  return a + b;', '}', 'function alphaSub(a, b) {', '  return a - b;', '}',
    'function alphaMul(a, b) {', '  return a * b;', '}', 'function alphaDiv(a, b) {', '  return a / b;', '}',
    'module.exports = { alphaAdd, alphaSub, alphaMul, alphaDiv };', '',
  ].join('\n');
  const beta = [
    "const alpha = require('./alpha');", 'function betaCombine(a, b) {', '  return alpha.alphaAdd(a, b) * 2;', '}',
    'function betaOther(x) {', '  return x + 1;', '}', 'function betaThird(x) {', '  return x - 1;', '}',
    'function betaFourth(x) {', '  return x * 2;', '}', 'module.exports = { betaCombine, betaOther, betaThird, betaFourth };', '',
  ].join('\n');
  const gamma = [
    'function gammaOne(x) {', '  return x + 10;', '}', 'function gammaTwo(x) {', '  return x - 10;', '}',
    'function gammaThree(x) {', '  return x * 10;', '}', 'function gammaFour(x) {', '  return x / 10;', '}',
    'module.exports = { gammaOne, gammaTwo, gammaThree, gammaFour };', '',
  ].join('\n');
  const short = 'module.exports = x => x + 1;\n';
  const testFile = ['test("alpha adds", () => {', '  const alpha = require("../lib/alpha");', '  if (alpha.alphaAdd(1, 2) !== 3) throw new Error("bad");', '});', '// padding', '// padding', '// padding', '// padding', '// padding', '// padding', '// padding', '// padding'].join('\n');
  const docsHelper = ['function helper() {', '  return "help";', '}', 'module.exports = helper;', '// padding', '// padding', '// padding', '// padding', '// padding', '// padding', '// padding', '// padding'].join('\n');
  const fixtureFile = ['function sample() {', '  return 1;', '}', 'module.exports = sample;', '// padding', '// padding', '// padding', '// padding', '// padding', '// padding', '// padding', '// padding'].join('\n');

  const steps = [
    { subject: 'Add alpha module', files: { 'lib/alpha.js': alpha } },
    { subject: 'Add beta module', files: { 'lib/beta.js': beta } },
    { subject: 'Add gamma module', files: { 'lib/gamma.js': gamma } },
    { subject: 'Add short util', files: { 'lib/short.js': short } },
    { subject: 'Add tests for alpha', files: { 'test/alpha.test.js': testFile } },
    { subject: 'Add docs helper', files: { 'docs/readme_helper.js': docsHelper } },
    { subject: 'Add fixture sample', files: { 'fixtures/sample.js': fixtureFile } },
    { subject: 'Fix null check in alpha', files: { 'lib/alpha.js': `${alpha}// null check\n` } },
    { subject: 'Refactor beta for clarity', files: { 'lib/beta.js': `${beta}// refactor\n` } },
    { subject: 'Add helper to gamma', files: { 'lib/gamma.js': `${gamma}// helper\n` } },
    { subject: 'Guard beta against crash on null', files: { 'lib/beta.js': `${beta}// refactor\n// guard\n` } },
    { subject: 'Tune alpha performance', files: { 'lib/alpha.js': `${alpha}// null check\n// tune\n` } },
    { subject: 'Fix leak in alpha connection', files: { 'lib/alpha.js': `${alpha}// null check\n// tune\n// leak fix\n` } }, // T (index 12)
    { subject: 'Add another feature to gamma', files: { 'lib/gamma.js': `${gamma}// helper\n// feature\n` } },
    { subject: 'Fix broken output in beta', files: { 'lib/beta.js': `${beta}// refactor\n// guard\n// broken fix\n` } },
    { subject: 'Add config option to gamma', files: { 'lib/gamma.js': `${gamma}// helper\n// feature\n// config\n` } },
    { subject: 'Prevent race in alpha cache', files: { 'lib/alpha.js': `${alpha}// null check\n// tune\n// leak fix\n// race fix\n` } },
    { subject: 'Polish gamma docs comment', files: { 'lib/gamma.js': `${gamma}// helper\n// feature\n// config\n// polish\n` } },
    { subject: 'Add validation to short util', files: { 'lib/short.js': `${short}// validation\n` } },
    { subject: 'Add helpful message to beta', files: { 'lib/beta.js': `${beta}// refactor\n// guard\n// broken fix\n// message\n` } },
  ];
  steps.forEach((s, i) => doCommit({ ...s, date: day(i) }));
  return dir;
}

test('freezeRepo: real intel.scan filters units and hand-computable git-derived features match', async t => {
  const srcDir = buildLabelFixture(t);
  const name = scratchTestName('test-freeze-label');
  const cloneDir = path.join(SCRATCH_ROOT, `${name}.git`);
  const snapshotDir = path.join(SCRATCH_ROOT, `${name}-snapshot`);
  t.after(() => fs.rmSync(cloneDir, { recursive: true, force: true }));

  const frozen = await freezeRepo({ name, src: srcDir }, { tokenCap: 10_000_000, repoIndex: 0 });
  assert.equal(fs.existsSync(snapshotDir), false, 'worktree must be removed when freezeRepo returns');

  const byPath = Object.fromEntries(frozen.units.map(u => [u.path, u]));
  assert.deepEqual(Object.keys(byPath).sort(), ['lib/alpha.js', 'lib/beta.js', 'lib/gamma.js']);
  assert.equal(frozen.T.subject, 'Fix leak in alpha connection');
  assert.equal(frozen.counts.preT, 13);
  assert.equal(frozen.counts.postT, 7);

  // Hand-computed churn/pastFixes/age (see buildLabelFixture's inline comment table).
  assert.equal(byPath['lib/alpha.js'].churn, 4);
  assert.equal(byPath['lib/alpha.js'].pastFixes, 2);
  assert.equal(byPath['lib/alpha.js'].ageDays, 12);
  assert.equal(byPath['lib/beta.js'].churn, 3);
  assert.equal(byPath['lib/beta.js'].pastFixes, 1);
  assert.equal(byPath['lib/beta.js'].ageDays, 11);
  assert.equal(byPath['lib/gamma.js'].churn, 2);
  assert.equal(byPath['lib/gamma.js'].pastFixes, 0);
  assert.equal(byPath['lib/gamma.js'].ageDays, 10);

  // fan-in: beta AND the test file both require alpha (fan-in is graph-wide,
  // not filtered to non-test importers); nothing requires beta/gamma.
  assert.equal(byPath['lib/alpha.js'].fanIn, 2);
  assert.equal(byPath['lib/beta.js'].fanIn, 0);
  assert.equal(byPath['lib/gamma.js'].fanIn, 0);

  // Secondary (regex) label from post-T history.
  assert.equal(byPath['lib/alpha.js'].regexFixed, true);
  assert.equal(byPath['lib/beta.js'].regexFixed, true);
  assert.equal(byPath['lib/gamma.js'].regexFixed, false);

  // Only commits touching a surviving unit are planned for Jev classification;
  // the short.js-only post-T commit must be excluded.
  assert.equal(frozen.commitPlan.length, 6);
  const subjects = frozen.commitPlan.map(p => p.request.state.subject).sort();
  assert.deepEqual(subjects, [
    'Add another feature to gamma', 'Add config option to gamma', 'Add helpful message to beta',
    'Fix broken output in beta', 'Polish gamma docs comment', 'Prevent race in alpha cache',
  ].sort());
  assert.ok(!subjects.includes('Add validation to short util'));

  assert.equal(frozen.filePlan.length, 3); // one chunk per surviving unit, all small
  assert.equal(frozen.sampling.applied, false);
});

// ---------------------------------------------------------------- stats: LR / standardize / effort recall

test('standardize/applyStandardize produce mean~0 std~1 on the fitting data', () => {
  const X = [[1, 10], [2, 20], [3, 30], [4, 40]];
  const stats = standardize(X);
  const Xs = applyStandardize(X, stats);
  for (let j = 0; j < 2; j++) {
    const col = Xs.map(r => r[j]);
    const mean = col.reduce((s, v) => s + v, 0) / col.length;
    assert.ok(Math.abs(mean) < 1e-9);
  }
});

test('fitLogisticRegression separates a perfectly linearly separable dataset and loss decreases with more iterations', () => {
  const X = [[0], [0.2], [0.4], [5], [5.2], [5.4]];
  const y = [0, 0, 0, 1, 1, 1];
  const stats = standardize(X);
  const Xs = applyStandardize(X, stats);
  const early = fitLogisticRegression(Xs, y, { l2: 1, lr: 0.5, iters: 5 });
  const late = fitLogisticRegression(Xs, y, { l2: 1, lr: 0.5, iters: 3000 });
  const lossEarly = logLoss(predictProba(Xs, early), y);
  const lossLate = logLoss(predictProba(Xs, late), y);
  assert.ok(lossLate < lossEarly, `expected convergence to lower loss: ${lossLate} vs ${lossEarly}`);
  const probsLate = predictProba(Xs, late);
  assert.ok(probsLate[0] < 0.5 && probsLate[5] > 0.5);
  const aucResult = predictorAUC(X.map((r, i) => ({ val: probsLate[i], lab: y[i] === 1 })), u => u.val, u => u.lab);
  assert.equal(aucResult.auc, 1);
});

test('effortAwareRecall spends the 20%-LOC budget greedily by predictor/LOC density', () => {
  const units = [
    { path: 'a', loc: 10, val: 10, fixed: true },
    { path: 'b', loc: 10, val: 9, fixed: true },
    { path: 'c', loc: 10, val: 1, fixed: false },
    { path: 'd', loc: 70, val: 0.5, fixed: false },
  ];
  // totalLOC=100, budget=20; density order a(1.0) > b(0.9) > c(0.1) > d(0.007);
  // greedy: add a (acc=10<20, captured=1), add b (acc=20, captured=2), stop (acc>=20).
  const result = effortAwareRecall(units, u => u.val, u => u.fixed);
  assert.equal(result.totalFixed, 2);
  assert.equal(result.recallAt20PctLOC, 1);
});

test('effortAwareRecall excludes units with a non-finite predictor and reports n', () => {
  const units = [
    { path: 'a', loc: 10, val: 1, fixed: true },
    { path: 'b', loc: 10, val: undefined, fixed: true },
  ];
  const result = effortAwareRecall(units, u => u.val, u => u.fixed);
  assert.equal(result.n, 1);
  assert.equal(result.totalFixed, 1);
});

test('predictorAUC excludes null/undefined predictor values and delegates to the shared auc()', () => {
  const units = [{ v: 1, l: true }, { v: 0, l: false }, { v: undefined, l: true }];
  const result = predictorAUC(units, u => u.v, u => u.l);
  assert.equal(result.n, 2);
  assert.equal(result.auc, 1);
});

// ---------------------------------------------------------------- bootstrap

test('bootstrapDeltaCI: a well-separated full model against a near-uncorrelated baseline gives a CI that excludes zero', () => {
  const labels = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1];
  const predFull = [0.05, 0.08, 0.1, 0.12, 0.15, 0.85, 0.88, 0.9, 0.92, 0.95];
  const predBaseline = [0.4, 0.6, 0.45, 0.55, 0.5, 0.52, 0.48, 0.58, 0.42, 0.5]; // deliberately uncorrelated with label
  const result = bootstrapDeltaCI({ repoA: { predBaseline, predFull, labels } }, 20260925, 1000);
  // A handful of the 1000 resamples can, by chance, draw only one class (5
  // positives / 5 negatives, so P(all-same-class) is small but nonzero) and
  // are skipped rather than forced to a fabricated AUC; expect nearly all to
  // land, not exactly all.
  assert.ok(result.n >= 950, `expected most resamples to score, got ${result.n}`);
  assert.ok(result.mean > 0.2, `expected a clearly positive mean delta, got ${result.mean}`);
  assert.equal(result.spansZero, false);
  assert.ok(result.lo > 0);
});

test('bootstrapDeltaCI is deterministic for a fixed seed', () => {
  const labels = [0, 0, 0, 1, 1, 1];
  const predFull = [0.1, 0.2, 0.3, 0.7, 0.8, 0.9];
  const predBaseline = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
  const a = bootstrapDeltaCI({ r: { predBaseline, predFull, labels } }, 42, 200);
  const b = bootstrapDeltaCI({ r: { predBaseline, predFull, labels } }, 42, 200);
  assert.deepEqual(a, b);
});

test('bootstrapDeltaCI stratifies by repo: pooling two identical repos matches one repo alone (same per-repo composition)', () => {
  const labels = [0, 0, 0, 1, 1, 1];
  const predFull = [0.1, 0.2, 0.3, 0.7, 0.8, 0.9];
  const predBaseline = [0.5, 0.4, 0.6, 0.5, 0.4, 0.6];
  const one = bootstrapDeltaCI({ r1: { predBaseline, predFull, labels } }, 7, 500);
  const two = bootstrapDeltaCI({ r1: { predBaseline, predFull, labels }, r2: { predBaseline, predFull, labels } }, 7, 500);
  assert.ok(Math.abs(one.mean - two.mean) < 0.05, `${one.mean} vs ${two.mean}`);
});

// ---------------------------------------------------------------- loroRun (pure synthetic multi-repo)

// Three synthetic repos, 24 units each. Baseline features (churn/pastFixes/loc/
// fanIn/ageDays) are the SAME fixed small integers regardless of label (no
// signal); jev.directRisk (and the rest of the battery) is set to the label
// plus tiny deterministic noise (strong signal). This is a known-answer test:
// the full model must clearly outperform the baseline-only model held out on
// each repo, and the pooled bootstrap CI must exclude zero.
function syntheticUnitsByRepo() {
  // Baseline features are drawn from one continuous seeded RNG stream, so
  // their values are independent of i's parity (the label). An earlier draft
  // set pastFixes = i % 2, which is literally the label's own parity in
  // disguise -- that made the "uninformative" baseline perfectly predictive
  // and defeated the point of the test.
  const rand = mulberry32(20260925);
  const repos = {};
  let counter = 0;
  for (const repoName of ['r1', 'r2', 'r3']) {
    const units = [];
    for (let i = 0; i < 24; i++) {
      counter++;
      const label = i % 2 === 0; // alternate fixed/not-fixed
      const noise = ((counter * 37) % 11) / 1000; // deterministic, tiny
      const jevVal = Math.min(1, Math.max(0, (label ? 0.85 : 0.15) + noise));
      const jev = {};
      for (const key of JEV_KEYS) jev[key] = jevVal;
      units.push({
        path: `${repoName}/f${i}.js`, loc: 20 + Math.floor(rand() * 10), churn: Math.floor(rand() * 6),
        pastFixes: Math.floor(rand() * 3), fanIn: Math.floor(rand() * 5), ageDays: 20 + Math.floor(rand() * 40),
        jevFixed: label, regexFixed: label, jev,
      });
    }
    repos[repoName] = units;
  }
  return repos;
}

test('loroRun: baseline+Jev clearly beats baseline-only when Jev features carry the real signal', () => {
  const unitsByRepo = syntheticUnitsByRepo();
  const result = loroRun(unitsByRepo, u => u.jevFixed, { seed: 20260925, iters: 2000 });
  for (const repoName of Object.keys(unitsByRepo)) {
    const fold = result.perRepo[repoName];
    assert.ok(fold, `missing fold for ${repoName}`);
    assert.ok(fold.aucFull > fold.aucBaseline, `${repoName}: full ${fold.aucFull} should beat baseline ${fold.aucBaseline}`);
    assert.ok(fold.aucFull > 0.9, `${repoName}: expected a strongly separating full model, got ${fold.aucFull}`);
  }
  assert.ok(result.pooled.delta > 0.3, `expected a large pooled delta, got ${result.pooled.delta}`);
  assert.equal(result.pooled.bootstrap.spansZero, false);
});

test('featureRow log1p-transforms skewed baseline counts but passes Jev probabilities through untouched', () => {
  const unit = { churn: 3, pastFixes: 1, loc: 99, fanIn: 2, ageDays: 30 };
  const row = featureRow(unit, BASELINE_KEYS);
  assert.deepEqual(row, BASELINE_KEYS.map(k => Math.log1p(unit[k])));
});

// ---------------------------------------------------------------- classifier agreement

test('classifierAgreement counts both/jevOnly/regexOnly/neither and skips unscored commits', () => {
  const commits = [
    { hash: 'a', subject: 'Fix crash' }, { hash: 'b', subject: 'Add feature' },
    { hash: 'c', subject: 'Fix crash' }, { hash: 'd', subject: 'Add feature' }, { hash: 'e', subject: 'Fix crash' },
  ];
  const jevByHash = new Map([
    ['a', { noul: 0.9 }], // fix+fix -> both
    ['b', { noul: 0.9 }], // not-fix+fix -> jevOnly
    ['c', { noul: 0.1 }], // fix+not-fix -> regexOnly
    ['d', { noul: 0.1 }], // not-fix+not-fix -> neither
    // 'e' has no Jev result -> unscored, excluded
  ]);
  const result = classifierAgreement(commits, jevByHash);
  assert.equal(result.scored, 4);
  assert.equal(result.both, 1);
  assert.equal(result.jevOnly, 1);
  assert.equal(result.regexOnly, 1);
  assert.equal(result.neither, 1);
  assert.equal(result.agreement, 0.5);
});

// ---------------------------------------------------------------- end-to-end: freeze -> live (mock) -> report

function fakeAnswers(request, scoreFn) {
  const answers = {};
  for (const key of Object.keys(request.questions)) answers[key] = { type: 'noul', noul: scoreFn(key, request) };
  return answers;
}

function fakeClient({ commitScoreFor, fileScoreFor, model = 'jev-1.13.0', failFor = () => false }) {
  return {
    async systemOne(request) {
      if (failFor(request)) throw new Error('synthetic provider failure');
      const isCommit = Object.keys(request.questions).length === 1 && request.questions.isDefectFix;
      const answers = isCommit
        ? fakeAnswers(request, () => commitScoreFor(request.state.subject))
        : fakeAnswers(request, key => fileScoreFor(request.state.path, key));
      return { model, usage: { input_tokens: Math.max(1, Math.round(Buffer.byteLength(JSON.stringify(request)) / 4)), output_tokens: 5 }, answers };
    },
  };
}

test('freeze -> live -> report: primary (Jev) label can diverge from secondary (regex) label, and every downstream table is well-shaped', async t => {
  const srcDir = buildLabelFixture(t);
  const name = scratchTestName('test-e2e-label');
  const cloneDir = path.join(SCRATCH_ROOT, `${name}.git`);
  t.after(() => fs.rmSync(cloneDir, { recursive: true, force: true }));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-defect-predict-out-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

  await freezeAll({ repos: [{ name, src: srcDir }], budget: 10_000_000, outDir });

  // Jev AGREES with regex on the alpha fix, but DISAGREES on the beta fix
  // ("Fix broken output in beta" -> Jev says false) -- this is the point of
  // running a real, separate classification rather than mirroring regex.
  const commitScoreFor = subject => (subject === 'Prevent race in alpha cache' ? 0.9 : 0.1);
  // directRisk (and the rest of the battery) deterministic per path: alpha
  // highest, beta medium, gamma lowest -- hand-verifiable AUC below.
  const fileScoreFor = (unitPath, key) => {
    const base = unitPath.includes('alpha') ? 0.9 : unitPath.includes('beta') ? 0.5 : 0.1;
    return key === 'mostlyBoilerplate' ? 1 - base : base; // vary one question so max-over-chunks logic is exercised meaningfully
  };
  // Fails on every attempt (all MAX_ATTEMPTS retries) for this one commit, so
  // liveRepo genuinely exhausts retries and records a failure, rather than
  // succeeding on a retry after a single flaky failure.
  const client = fakeClient({
    commitScoreFor, fileScoreFor,
    failFor: request => request.questions.isDefectFix && request.state.subject === 'Add config option to gamma',
  });
  await liveAll({ client, outDir, repos: [name], concurrency: 4 });

  const report = repoReport(name, outDir);
  const byPath = Object.fromEntries(report.units.map(u => [u.path, u]));
  assert.equal(byPath['lib/alpha.js'].jevFixed, true);
  assert.equal(byPath['lib/beta.js'].jevFixed, false); // diverges from regexFixed=true
  assert.equal(byPath['lib/beta.js'].regexFixed, true);
  assert.equal(byPath['lib/gamma.js'].jevFixed, false);

  // Agreement: 6 relevant commits, but 1 ("Add config option to gamma") never
  // gets a validated Jev response (deliberate synthetic failure below), so 5
  // are scored; of those, 1 disagreement (the beta "broken" fix Jev rejected).
  assert.equal(report.commitClassifierAgreement.scored, 5);
  assert.equal(report.commitClassifierAgreement.regexOnly, 1);
  assert.equal(report.commitClassifierAgreement.agreement, 4 / 5);

  // Hand-verifiable AUC: primary-label pairs are alpha(0.9,true), beta(0.5,false), gamma(0.1,false).
  assert.equal(report.singlePredictorAUC.primary.jevDirect.auc, 1);
  assert.equal(report.effortAwareRecall.primary.jevDirect.recallAt20PctLOC, 1);

  // One deliberate provider failure must be recorded, never silently dropped.
  assert.equal(report.providerFailures.commits.length, 1);

  // Spot-check lists are paths only, well-formed.
  assert.ok(Array.isArray(report.spotCheck.highJevNoFix));
  assert.ok(Array.isArray(report.spotCheck.lowJevFixed));
  assert.ok(report.spotCheck.highJevNoFix.every(p => typeof p === 'string'));

  // fullReport must not crash with a single repo (LORO degrades gracefully).
  const full = fullReport({ outDir });
  assert.equal(typeof full.kill.verdict, 'string');
  assert.equal(full.loroPrimary.perRepo[name], null);
  assert.equal(full.loroPrimary.pooled.bootstrap.n, 0);
});
