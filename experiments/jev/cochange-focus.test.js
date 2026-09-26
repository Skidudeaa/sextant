'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const cochange = require('../../lib/cochange');
const {
  MODEL,
  SEED,
  FOCUSED_MAX_FILES,
  seededRandom,
  isIncludedPath,
  loadHistory,
  eligibleForJev,
  buildRequest,
  computeWeightedCoChange,
  jevWeightedFn,
  jevHardDropFn,
  sizeInverseFn,
  sizeDropFn,
  buildAdjacency,
  scoreUnits,
  firstHitRank,
  buildCommitIndex,
  buildPureRerankAdjacency,
  signTestPValue,
  pairedComparison,
  freeze,
  validateFrozen,
  runLive,
  report,
} = require('./cochange-focus');

// --- Fixture: tiny temp git repo with hand-computable co-change structure --

function initRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-cochange-focus-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (args, env) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf8', env: { ...process.env, ...env } });
  git(['init', '--quiet']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.invalid']);
  return { dir, git };
}

function makeCommitter(dir, git) {
  let seq = 0;
  return ({ subject, body = '', files }) => {
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
    git(['add', ...Object.keys(files)]);
    const date = new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString();
    seq++;
    const message = body ? `${subject}\n\n${body}` : subject;
    git(['commit', '--quiet', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  };
}

// 8 train / 2 test commits (floor(10*0.8)=8). Only A.js/B.js ever accumulate
// >=3 raw co-occurrences (commits 2,3,4,6): every other candidate pair
// (A-C, A-D, C-D) appears at most once and never crosses the default
// MIN_PAIR_COUNT=3 floor in ANY arm, so this fixture's baseline/weighted
// pair tables are hand-computable exactly.
function buildFixtureRepo(t) {
  const { dir, git } = initRepo(t);
  const doCommit = makeCommitter(dir, git);
  doCommit({ subject: 'feat: add A', files: { 'A.js': 'exports.a = 1;\n' } });
  doCommit({ subject: 'feat: link A and B', files: { 'A.js': 'exports.a = 2;\n', 'B.js': 'exports.b = 1;\n' } });
  doCommit({ subject: 'fix: A,B contract', files: { 'A.js': 'exports.a = 3;\n', 'B.js': 'exports.b = 2;\n' } });
  doCommit({ subject: 'test: A,B coverage', files: { 'A.js': 'exports.a = 4;\n', 'B.js': 'exports.b = 3;\n' } });
  doCommit({ subject: 'chore: touches A,C,D while in there', files: { 'A.js': 'exports.a = 5;\n', 'C.js': 'exports.c = 1;\n', 'D.js': 'exports.d = 1;\n' } });
  doCommit({
    subject: 'refactor: big cleanup',
    body: 'Paragraph one explaining the change.\n\nParagraph two with a blank line above it.\n- bullet one\n- bullet two\n\nSigned-off-by: Test <test@example.invalid>',
    files: { 'A.js': 'exports.a = 6;\n', 'B.js': 'exports.b = 4;\n' },
  });
  doCommit({ subject: 'docs: update readme', files: { 'docs.md': '# Notes\n' } });
  doCommit({ subject: 'fix: F standalone tweak', files: { 'F.js': 'exports.f = 1;\n' } });
  doCommit({ subject: 'test: verify A,B again', files: { 'A.js': 'exports.a = 7;\n', 'B.js': 'exports.b = 5;\n' } });
  doCommit({ subject: 'chore: touches C,D again', files: { 'C.js': 'exports.c = 2;\n', 'D.js': 'exports.d = 2;\n' } });
  return dir;
}

function focusScoreFor(request) {
  const files = request.state.files;
  return files.length === 2 && files.includes('A.js') && files.includes('B.js') ? 0 : 2;
}

function mockResponse(request, { score, multiFix = 0.05, unrelated = 0.05, model = MODEL } = {}) {
  const criteria = request.questions.pr_scope.criteria;
  return {
    model,
    usage: { input_tokens: 120, output_tokens: 20 },
    answers: {
      pr_scope: {
        type: 'score',
        confidence: 0.9,
        probabilities: Object.fromEntries(criteria.map((_, i) => [String(i), i === score ? 1 : 0])),
        score,
        legend: Object.fromEntries(criteria.map((c, i) => [String(i), c])),
      },
      multiFix: { type: 'noul', noul: multiFix },
      unrelatedAreas: { type: 'noul', noul: unrelated },
    },
  };
}

function focusMockClient() {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async systemOne(request) {
      calls++;
      return mockResponse(request, { score: focusScoreFor(request) });
    },
  };
}

// --- Pure math: computeWeightedCoChange generalizes computeCoChange --------

test('computeWeightedCoChange with constant weight 1 matches lib/cochange.js computeCoChange exactly', () => {
  const commits = [
    { hash: 'c1', files: ['a.js', 'b.js'] },
    { hash: 'c2', files: ['a.js', 'b.js'] },
    { hash: 'c3', files: ['a.js', 'b.js'] },
    { hash: 'c4', files: ['a.js', 'c.js'] },
    { hash: 'c5', files: ['a.js', 'c.js'] },
  ];
  const baseline = cochange.computeCoChange(commits, { isIncluded: () => true });
  const weighted = computeWeightedCoChange(commits, () => 1, { isIncluded: () => true });
  assert.equal(weighted.pairs.length, baseline.pairs.length);
  const byKey = (pairs) => new Map(pairs.map((p) => [`${p.a}\x00${p.b}`, p]));
  const b = byKey(baseline.pairs);
  for (const p of weighted.pairs) {
    const match = b.get(`${p.a}\x00${p.b}`);
    assert.ok(match, `missing baseline pair for ${p.a}/${p.b}`);
    assert.equal(p.weight, match.count);
    assert.equal(p.confidence, match.confidence);
  }
  assert.equal(weighted.usedCommits, baseline.usedCommits);
  assert.equal(weighted.excludedCommits, baseline.excludedCommits);
});

test('computeWeightedCoChange: zero-weight commits are dropped and cannot inflate occurrence or pair counts', () => {
  const commits = [
    { hash: 'good1', files: ['a.js', 'b.js'] },
    { hash: 'good2', files: ['a.js', 'b.js'] },
    { hash: 'good3', files: ['a.js', 'b.js'] },
    { hash: 'bundle1', files: ['a.js', 'c.js', 'd.js'] },
    { hash: 'bundle2', files: ['a.js', 'c.js', 'd.js'] },
    { hash: 'bundle3', files: ['a.js', 'c.js', 'd.js'] },
  ];
  const weightOf = (c) => (c.hash.startsWith('bundle') ? 0 : 1);
  const result = computeWeightedCoChange(commits, weightOf, { isIncluded: () => true, minCount: 3 });
  assert.deepEqual(
    result.pairs.map((p) => `${p.a}/${p.b}`),
    ['a.js/b.js']
  );
  assert.equal(result.pairs[0].weight, 3);
  assert.equal(result.pairs[0].confidence, 1); // occ(a)=3 (bundle commits dropped, never counted), occ(b)=3
  assert.equal(result.droppedByWeight, 3);
  assert.equal(result.usedCommits, 3);
});

test('computeWeightedCoChange: explicit minCount lets a controlled small fixture cross the floor without touching production defaults', () => {
  const commits = [
    { hash: 'c1', files: ['x.js', 'y.js'] },
    { hash: 'c2', files: ['x.js', 'y.js'] },
  ];
  assert.equal(computeWeightedCoChange(commits, () => 1, { isIncluded: () => true }).pairs.length, 0); // default minCount=3
  const lowered = computeWeightedCoChange(commits, () => 1, { isIncluded: () => true, minCount: 2 });
  assert.equal(lowered.pairs.length, 1);
  assert.equal(lowered.pairs[0].weight, 2);
});

test('computeWeightedCoChange rejects a NaN/negative weight loudly instead of silently coercing it', () => {
  const commits = [{ hash: 'c1', files: ['a.js', 'b.js'] }];
  assert.throws(() => computeWeightedCoChange(commits, () => -1, { isIncluded: () => true }), /Invalid commit weight/);
  assert.throws(() => computeWeightedCoChange(commits, () => NaN, { isIncluded: () => true }), /Invalid commit weight/);
});

// --- Weight functions -------------------------------------------------------

test('jevWeightedFn maps score 0/1/2 to weight 1/0.5/0 and never calls the score map for single-file commits', () => {
  const scores = new Map([['multi', 1]]);
  const fn = jevWeightedFn(scores);
  assert.equal(fn({ hash: 'single' }, 1), 1); // n<2 shortcut; would throw if it looked up the map
  assert.equal(fn({ hash: 'multi' }, 2), 0.5);
  assert.throws(() => fn({ hash: 'unscored' }, 2), /Missing Jev focus score/);
});

test('jevHardDropFn drops only strictly-above-threshold scores', () => {
  const scores = new Map([
    ['focused', 1],
    ['bundled', 2],
    ['boundary', 1.5],
  ]);
  const fn = jevHardDropFn(scores);
  assert.equal(fn({ hash: 'focused' }, 2), 1);
  assert.equal(fn({ hash: 'boundary' }, 2), 1); // exactly 1.5 is not > 1.5
  assert.equal(fn({ hash: 'bundled' }, 2), 0);
});

test('jevWeightedFn/jevHardDropFn: an abstained commit gets the neutral ABSTAIN_WEIGHT fallback without ever consulting the (absent) score', () => {
  const scores = new Map(); // deliberately empty: would throw "Missing Jev focus score" without the abstainedIds carve-out
  const abstained = new Set(['unscorable']);
  assert.equal(jevWeightedFn(scores, abstained)({ hash: 'unscorable' }, 3), 1);
  assert.equal(jevHardDropFn(scores, abstained)({ hash: 'unscorable' }, 3), 1);
  assert.throws(() => jevWeightedFn(scores, abstained)({ hash: 'not-abstained' }, 3), /Missing Jev focus score/);
});

test('sizeInverseFn and sizeDropFn are pure functions of raw file count, independent of Jev', () => {
  assert.equal(sizeInverseFn(null, 4), 0.25);
  assert.equal(sizeDropFn(null, FOCUSED_MAX_FILES), 1); // boundary inclusive
  assert.equal(sizeDropFn(null, FOCUSED_MAX_FILES + 1), 0);
});

// --- Ranking + scoring -------------------------------------------------------

test('buildAdjacency + scoreUnits: deterministic tie-break produces exact hit@1/hit@3/MRR', () => {
  const pairs = [
    { a: 'A.js', b: 'B.js', confidence: 1 },
    { a: 'A.js', b: 'C.js', confidence: 1 },
    { a: 'A.js', b: 'D.js', confidence: 1 },
  ];
  const tieBreak = new Map([
    ['B.js', 0.9],
    ['D.js', 0.5],
    ['C.js', 0.1],
  ]);
  const adjacency = buildAdjacency(pairs, tieBreak);
  assert.deepEqual(
    adjacency['A.js'].map((p) => p.partner),
    ['B.js', 'D.js', 'C.js']
  );
  const units = [{ file: 'A.js', truth: new Set(['B.js']) }];
  const metrics = scoreUnits(units, adjacency);
  assert.deepEqual(metrics, { n: 1, hitAt1: 1, hitAt3: 1, mrr: 1, emptyRanking: 0 });
});

test('scoreUnits: a true partner ranked outside top 3 counts for MRR but not hit@1/hit@3; an unranked partner is a clean miss', () => {
  const adjacency = {
    'A.js': [{ partner: 'w.js', confidence: 4 }, { partner: 'x.js', confidence: 3 }, { partner: 'y.js', confidence: 2 }, { partner: 'z.js', confidence: 1 }],
    'B.js': [{ partner: 'q.js', confidence: 1 }],
  };
  const units = [
    { file: 'A.js', truth: new Set(['z.js']) }, // rank 4 (index 3)
    { file: 'B.js', truth: new Set(['unseen.js']) }, // never ranked at all
  ];
  const metrics = scoreUnits(units, adjacency);
  assert.equal(metrics.n, 2);
  assert.equal(metrics.hitAt1, 0);
  assert.equal(metrics.hitAt3, 0);
  assert.equal(metrics.mrr, 0.25 / 2); // (1/4 + 0) / 2
  assert.equal(metrics.emptyRanking, 0); // both units had a nonempty ranking, just the wrong answer
});

test('scoreUnits: empty ranking (arm dropped every partner) is a guaranteed miss and is counted', () => {
  const metrics = scoreUnits([{ file: 'A.js', truth: new Set(['B.js']) }], {});
  assert.deepEqual(metrics, { n: 1, hitAt1: 0, hitAt3: 0, mrr: 0, emptyRanking: 1 });
});

// --- Pure re-ranking evaluator (no floor, no pruning) -----------------------

test('firstHitRank finds the earliest matching partner, or -1 when none match', () => {
  const ranked = [{ partner: 'x' }, { partner: 'y' }, { partner: 'z' }];
  assert.equal(firstHitRank(ranked, new Set(['y'])), 1);
  assert.equal(firstHitRank(ranked, new Set(['q'])), -1);
  assert.equal(firstHitRank([], new Set(['y'])), -1);
});

test('buildCommitIndex only indexes isIncluded files, and bulk (>MAX_FILES_PER_COMMIT) commits index nothing', () => {
  const commits = [
    { hash: 'c0', files: ['a.js', 'b.js', 'skip.md'] },
    { hash: 'c1', files: Array.from({ length: 21 }, (_, i) => `bulk${i}.js`) },
  ];
  const isIncluded = (f) => f.endsWith('.js');
  const { commitFiles, fileToCommitIdxs } = buildCommitIndex(commits, isIncluded);
  assert.equal(commitFiles.length, 2);
  assert.deepEqual(commitFiles[0], { commit: commits[0], rawCount: 3 });
  assert.deepEqual(fileToCommitIdxs.get('a.js'), [0]);
  assert.deepEqual(fileToCommitIdxs.get('b.js'), [0]);
  assert.equal(fileToCommitIdxs.has('skip.md'), false); // not isIncluded
  assert.equal(fileToCommitIdxs.has('bulk0.js'), false); // bulk commit contributes nothing
});

test('buildPureRerankAdjacency: score is the arm weight function summed with no floor; zero-weight commits leave the candidate in the list at score 0, never remove it', () => {
  const commits = [
    { hash: 'ab-1', files: ['a.js', 'b.js'] },
    { hash: 'ab-2', files: ['a.js', 'b.js'] },
    { hash: 'ac-1', files: ['a.js', 'c.js'] },
  ];
  const commitIndex = buildCommitIndex(commits, () => true);
  // These pairs are handed in directly (as if already baseline's candidate
  // list) — buildPureRerankAdjacency never re-derives or filters the pair
  // SET itself, only re-scores the given pairs.
  const baselinePairs = [
    { a: 'a.js', b: 'b.js', count: 2, confidence: 1 },
    { a: 'a.js', b: 'c.js', count: 1, confidence: 0.4 },
  ];

  const unweighted = buildPureRerankAdjacency(baselinePairs, () => 1, commitIndex);
  assert.deepEqual(unweighted['a.js'], [
    { partner: 'b.js', score: 2, confidence: 1 },
    { partner: 'c.js', score: 1, confidence: 0.4 },
  ]);

  // Zero out the two commits that support a.js/b.js: the pair STAYS in the
  // list (score 0), it is not pruned — that is the entire point of this table.
  const zeroed = buildPureRerankAdjacency(baselinePairs, (c) => (c.hash.startsWith('ab-') ? 0 : 1), commitIndex);
  assert.deepEqual(zeroed['a.js'], [
    { partner: 'c.js', score: 1, confidence: 0.4 },
    { partner: 'b.js', score: 0, confidence: 1 },
  ]);
  assert.equal(zeroed['b.js'].length, 1); // b.js's only candidate is still present, just scored 0
  assert.equal(zeroed['b.js'][0].score, 0);
});

test('buildPureRerankAdjacency tie-break: score, then baseline confidence, then partner path — deterministic, no RNG', () => {
  const commits = [
    { hash: 'c0', files: ['x.js', 'aaa.js'] },
    { hash: 'c1', files: ['x.js', 'zzz.js'] },
    { hash: 'c2', files: ['x.js', 'mmm.js'] },
  ];
  const commitIndex = buildCommitIndex(commits, () => true);
  const baselinePairs = [
    { a: 'x.js', b: 'zzz.js', count: 1, confidence: 0.5 },
    { a: 'x.js', b: 'aaa.js', count: 1, confidence: 0.5 }, // same score, same confidence as zzz.js -> path breaks the tie
    { a: 'x.js', b: 'mmm.js', count: 1, confidence: 0.9 }, // same score, higher confidence -> ranks first
  ];
  const adj = buildPureRerankAdjacency(baselinePairs, () => 1, commitIndex);
  assert.deepEqual(
    adj['x.js'].map((p) => p.partner),
    ['mmm.js', 'aaa.js', 'zzz.js']
  );
});

test('signTestPValue matches the standard two-sided exact binomial sign test at p=0.5', () => {
  assert.equal(signTestPValue(0, 0), null); // no non-tied pairs
  assert.ok(Math.abs(signTestPValue(0, 10) - 2 * Math.pow(0.5, 10)) < 1e-12);
  assert.ok(Math.abs(signTestPValue(1, 9) - 2 * (1 + 10) * Math.pow(0.5, 10)) < 1e-12);
  assert.equal(signTestPValue(5, 5), 1); // maximally balanced -> capped at 1, never > 1
  assert.equal(signTestPValue(9, 1), signTestPValue(1, 9)); // symmetric in (improved, worsened)
});

test('pairedComparison classifies improved/worsened/tied by first-hit rank and reports the matching sign-test p-value', () => {
  const baselineAdj = { A: [{ partner: 'B' }, { partner: 'C' }], D: [{ partner: 'E' }] };
  const armAdj = { A: [{ partner: 'C' }, { partner: 'B' }], D: [{ partner: 'E' }] };
  const units = [
    { file: 'A', truth: new Set(['C']) }, // baseline rank 1, arm rank 0 -> improved
    { file: 'D', truth: new Set(['E']) }, // both rank 0 -> tied
  ];
  const result = pairedComparison(units, baselineAdj, armAdj);
  assert.deepEqual(result, { n: 2, improved: 1, worsened: 0, tied: 1, signTestPValue: signTestPValue(1, 0) });
});

test('pairedComparison: an arm finding a hit baseline entirely misses counts as improved, and vice versa', () => {
  const baselineAdj = { A: [{ partner: 'X' }] }; // never contains the true partner
  const armAdj = { A: [{ partner: 'B' }] }; // does
  const units = [{ file: 'A', truth: new Set(['B']) }];
  assert.deepEqual(pairedComparison(units, baselineAdj, armAdj), { n: 1, improved: 1, worsened: 0, tied: 0, signTestPValue: signTestPValue(1, 0) });
  assert.deepEqual(pairedComparison(units, armAdj, baselineAdj), { n: 1, improved: 0, worsened: 1, tied: 0, signTestPValue: signTestPValue(0, 1) });
});

test('seededRandom is deterministic and reproducible for a fixed seed', () => {
  const a = seededRandom(SEED);
  const b = seededRandom(SEED);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  assert.ok(seqA.every((v) => v >= 0 && v < 1));
  const c = seededRandom(SEED + 1);
  assert.notDeepEqual(seqA, [c(), c(), c()]);
});

// --- Request construction ----------------------------------------------------

test('buildRequest shape, truncation, and eligibility guards', () => {
  const commit = { hash: 'abc', subject: 'x'.repeat(10), body: 'y'.repeat(3000), files: ['a.js', 'b.js'], numstatText: 'z'.repeat(5000) };
  const request = buildRequest(commit);
  assert.equal(request.model, MODEL);
  assert.equal(request.state.body.length, 2000);
  assert.equal(request.state.diffstat.length, 3000);
  assert.deepEqual(request.state.files, ['a.js', 'b.js']);
  assert.equal(Object.keys(request.questions).length, 3);
  assert.equal(request.questions.pr_scope.type, 'score');
  assert.equal(request.questions.pr_scope.criteria.length, 3);
  assert.equal(request.questions.multiFix.type, 'noul');
  assert.equal(request.questions.unrelatedAreas.type, 'noul');
  assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 16000);

  assert.throws(() => buildRequest({ hash: 'single', files: ['a.js'] }), /not Jev-eligible/);
  assert.throws(() => buildRequest({ hash: 'toobig', files: Array.from({ length: 21 }, (_, i) => `f${i}.js`) }), /not Jev-eligible/);
});

test('buildRequest throws when body/diffstat truncation still leaves the request over the byte ceiling (long file paths)', () => {
  const files = Array.from({ length: 20 }, (_, i) => `some/deeply/nested/package/module/path/for/padding/file-${i}-${'x'.repeat(600)}.js`);
  const commit = { hash: 'huge', subject: 's', body: 'b'.repeat(2000), files, numstatText: 'n'.repeat(3000) };
  assert.throws(() => buildRequest(commit), /exceeds the 16000-byte ceiling/);
});

// --- eligibleForJev -----------------------------------------------------------

test('eligibleForJev matches the raw-file-count band computeWeightedCoChange actually reaches weightOf for', () => {
  assert.equal(eligibleForJev({ files: [] }), false);
  assert.equal(eligibleForJev({ files: ['a.js'] }), false);
  assert.equal(eligibleForJev({ files: ['a.js', 'b.js'] }), true);
  assert.equal(eligibleForJev({ files: Array.from({ length: 20 }, (_, i) => `f${i}.js`) }), true);
  assert.equal(eligibleForJev({ files: Array.from({ length: 21 }, (_, i) => `f${i}.js`) }), false);
  assert.equal(eligibleForJev({ files: ['dup.js', 'dup.js'] }), false); // dedupes to 1 file
});

// --- isIncludedPath -----------------------------------------------------------

test('isIncludedPath requires both an indexable extension and current existence on disk', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-cochange-focus-inc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'present.js'), '1;\n');
  const isIncluded = isIncludedPath(dir);
  assert.equal(isIncluded('present.js'), true);
  assert.equal(isIncluded('missing.js'), false); // indexable extension, but not on disk
  assert.equal(isIncluded('present.md'), false); // on disk (if it existed) but not indexable
});

// --- git plumbing: loadHistory on a real temp repo --------------------------

test('loadHistory parses subject/body/numstat correctly (including a multi-line body) and produces the expected temporal split', (t) => {
  const dir = buildFixtureRepo(t);
  const { train, test: testCommits, ordered } = loadHistory(dir);
  assert.equal(ordered.length, 10);
  assert.equal(train.length, 8);
  assert.equal(testCommits.length, 2);
  assert.equal(train[0].subject, 'feat: add A');
  assert.equal(train.at(-1).subject, 'fix: F standalone tweak');
  assert.equal(testCommits[0].subject, 'test: verify A,B again');
  assert.equal(testCommits[1].subject, 'chore: touches C,D again');

  const multiline = train.find((c) => c.subject === 'refactor: big cleanup');
  assert.ok(multiline, 'multi-line-body commit must be present in train');
  assert.match(multiline.body, /Paragraph one explaining the change\.\n\nParagraph two with a blank line above it\.\n- bullet one\n- bullet two\n\nSigned-off-by:/);
  assert.deepEqual([...multiline.files].sort(), ['A.js', 'B.js']);
  assert.match(multiline.numstatText, /A\.js/);
  assert.match(multiline.numstatText, /B\.js/);

  // chronological ascending
  for (let i = 1; i < ordered.length; i++) assert.ok(new Date(ordered[i].date).getTime() >= new Date(ordered[i - 1].date).getTime());
});

test('loadHistory refuses a history too small for an 80/20 split', (t) => {
  const { dir, git } = initRepo(t);
  const doCommit = makeCommitter(dir, git);
  doCommit({ subject: 'only commit', files: { 'a.js': '1;\n' } });
  assert.throws(() => loadHistory(dir), /too small/);
});

// --- freeze / validateFrozen --------------------------------------------------

test('freeze() on the fixture repo finds exactly the raw 2..20-file train commits and freezes a reproducible, tamper-evident plan', (t) => {
  const dir = buildFixtureRepo(t);
  const frozen = freeze(dir);
  assert.equal(frozen.jevEligibleCommits, 5); // commits 2,3,4,5,6 (commit5 is [A,C,D], still raw 2..20)
  assert.equal(frozen.plan.length, 5);
  assert.equal(frozen.split.trainCount, 8);
  assert.equal(frozen.split.testCount, 2);
  validateFrozen(frozen, dir); // does not throw

  const tampered = JSON.parse(JSON.stringify(frozen));
  tampered.plan[0].requestHash = 'deadbeef';
  assert.throws(() => validateFrozen(tampered, dir), /fingerprint mismatch/);

  const tamperedSplit = JSON.parse(JSON.stringify(frozen));
  tamperedSplit.split.trainCount = 999;
  assert.throws(() => validateFrozen(tamperedSplit, dir), /fingerprint mismatch/);
});

// --- runLive + report: full pipeline on the fixture repo ---------------------

test('runLive + report: full pipeline produces exact hand-computed arms and metrics on the fixture repo', async (t) => {
  const dir = buildFixtureRepo(t);
  const frozen = freeze(dir);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-cochange-focus-out-')), 'results.jsonl');
  t.after(() => fs.rmSync(path.dirname(out), { recursive: true, force: true }));
  const client = focusMockClient();

  const result = await runLive(frozen, out, { client, root: dir });
  assert.equal(client.calls, 5);
  assert.equal(result.status, 'complete');
  assert.equal(result.completed, 5);
  assert.equal(result.modelStampMismatch, 0);
  assert.equal(result.inputTokens, 5 * 120);
  assert.equal(result.estimatedCostUsd, (5 * 120 * 0.042) / 1e6);

  // Only A.js/B.js ever cross the reporting floor in every arm; the bundle
  // commit (A,C,D) never contributed a surviving pair regardless of weight,
  // so baseline/jevWeighted/jevHardDrop/sizeDrop all land on the identical
  // single pair here (sizeDrop never triggers: max raw commit size is 3,
  // exactly at FOCUSED_MAX_FILES, which is inclusive).
  for (const arm of ['baseline', 'jevWeighted', 'jevHardDrop', 'sizeDrop']) {
    assert.equal(result.arms[arm].pairCount, 1, arm);
    const pair = result.arms[arm].pairs[0];
    assert.deepEqual([pair.a, pair.b].sort(), ['A.js', 'B.js']);
    assert.equal(pair.confidence, 1, arm);
  }
  assert.equal(result.arms.jevHardDrop.droppedByWeight, 1); // the (A,C,D) bundle commit, scored 2
  assert.equal(result.arms.jevWeighted.droppedByWeight, 1);
  assert.equal(result.arms.sizeInverse.pairCount, 0); // fractional per-commit weight never crosses the absolute floor here

  assert.equal(result.evalUnits, 2); // file=A truth={B}, file=B truth={A}; C/D never became baseline-adjacency keys
  assert.equal(result.focusedEvalUnits, 2);
  for (const arm of ['baseline', 'jevWeighted', 'jevHardDrop', 'sizeDrop']) {
    assert.deepEqual(result.metricsByArm[arm].all, { n: 2, hitAt1: 1, hitAt3: 1, mrr: 1, emptyRanking: 0 }, arm);
  }
  assert.deepEqual(result.metricsByArm.sizeInverse.all, { n: 2, hitAt1: 0, hitAt3: 0, mrr: 0, emptyRanking: 2 });

  assert.equal(result.focusValidityCheck.n, 5);
  assert.equal(result.focusValidityCheck.bucketCounts.low, 4); // the 4 A,B-only commits, scored 0
  assert.equal(result.focusValidityCheck.bucketCounts.high, 1); // the (A,C,D) commit, scored 2
  assert.equal(result.focusValidityCheck.multiFixMeanByFocusBucket.low, 0.05);
  assert.equal(result.focusValidityCheck.multiFixMeanByFocusBucket.high, 0.05);

  const rows = fs.readFileSync(out, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((r) => r.kind), ['manifest', 'result', 'result', 'result', 'result', 'result', 'summary']);
  assert.equal(rows[0].executionKind, 'mock-transport');

  // report() rebuilt from the JSONL alone (as a separate CLI invocation would)
  // reproduces the identical summary.
  const rebuilt = report(rows.slice(0, -1), dir);
  assert.deepEqual(rebuilt.metricsByArm, result.metricsByArm);

  // pureRerank: this fixture's baseline has exactly ONE candidate pair
  // (A.js/B.js) — none of its 4 supporting commits (c2,c3,c4,c6) are ever
  // down-weighted by any arm (only the inert A,C,D commit is), so every
  // arm's re-scored candidate list for A is still just [B] (and vice versa)
  // — including sizeInverse, whose weighted score is a nonzero 2.0 here.
  // With the floor, sizeInverse was structurally empty (2.0 < minCount 3);
  // without it, it correctly matches every other arm.
  assert.equal(result.pureRerank.evalUnits, 2);
  for (const arm of ['baseline', 'jevWeighted', 'jevHardDrop', 'sizeInverse', 'sizeDrop']) {
    assert.deepEqual(result.pureRerank.metricsByArm[arm], { n: 2, hitAt1: 1, hitAt3: 1, mrr: 1, emptyRanking: 0 }, arm);
  }
  for (const arm of ['jevWeighted', 'jevHardDrop', 'sizeInverse', 'sizeDrop']) {
    assert.deepEqual(result.pureRerank.pairedVsBaseline[arm], { n: 2, improved: 0, worsened: 0, tied: 2, signTestPValue: null }, arm);
  }
});

test('runLive: a commit that fails every attempt is retried exactly MAX_ATTEMPTS_PER_COMMIT times, then abstained (not aborted); the run still exceeds the abstain-rate ceiling on this small fixture', async (t) => {
  const dir = buildFixtureRepo(t);
  const frozen = freeze(dir);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-cochange-focus-fail-')), 'results.jsonl');
  t.after(() => fs.rmSync(path.dirname(out), { recursive: true, force: true }));
  const callsPerCommit = new Map();
  const client = {
    async systemOne(request) {
      const subject = request.state.subject;
      callsPerCommit.set(subject, (callsPerCommit.get(subject) || 0) + 1);
      if (subject === 'chore: touches A,C,D while in there') throw new Error('provider unavailable for this commit');
      return mockResponse(request, { score: focusScoreFor(request) });
    },
  };
  // Does not throw: the run completes the whole plan even though one commit
  // never produces a validated response.
  const result = await runLive(frozen, out, { client, root: dir });
  assert.equal(callsPerCommit.get('chore: touches A,C,D while in there'), 3);
  assert.equal(result.status, 'abstain-rate-exceeded'); // 1/5 = 20% > the 10% ceiling
  assert.equal(result.abstainedCount, 1);
  assert.equal(result.abstainedDetail[0].attempts, 3);
  assert.match(result.abstainedDetail[0].reason, /provider unavailable for this commit/);
  assert.equal(result.completed, 4); // the other 4 eligible commits still succeeded normally
  assert.equal(result.errorCount, 0); // not a hard error path
  assert.equal(result.arms, null);
  assert.equal(result.metricsByArm, null);
  assert.match(result.note, /Abstain rate 20\.0% exceeds the 10% ceiling/);

  const rows = fs.readFileSync(out, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((r) => r.kind), ['manifest', 'result', 'result', 'result', 'abstained', 'result', 'summary']);
  const last = rows.at(-1);
  assert.equal(last.kind, 'summary');
  assert.equal(last.status, 'abstain-rate-exceeded');
});

test('runLive: --cache reuses prior results by commit SHA + requestHash and makes zero new provider calls on a full replay', async (t) => {
  const dir = buildFixtureRepo(t);
  const frozen = freeze(dir);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-cochange-focus-cache-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const first = path.join(tmp, 'first.jsonl');
  const client1 = focusMockClient();
  await runLive(frozen, first, { client: client1, root: dir });
  assert.equal(client1.calls, 5);

  const second = path.join(tmp, 'second.jsonl');
  const throwingClient = { async systemOne() { throw new Error('must not be called: cache should have covered every planned task'); } };
  const replay = await runLive(frozen, second, { client: throwingClient, cachePath: first, root: dir });
  assert.equal(replay.status, 'complete');
  assert.equal(replay.completed, 5);
  assert.deepEqual(replay.metricsByArm, (await runLive(frozen, path.join(tmp, 'third.jsonl'), { client: focusMockClient(), root: dir })).metricsByArm);
});

test('runLive: a response model differing from the pinned request model is recorded, not thrown', async (t) => {
  const dir = buildFixtureRepo(t);
  const frozen = freeze(dir);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-cochange-focus-model-')), 'results.jsonl');
  t.after(() => fs.rmSync(path.dirname(out), { recursive: true, force: true }));
  let calls = 0;
  const client = {
    async systemOne(request) {
      calls++;
      return mockResponse(request, { score: focusScoreFor(request), model: calls === 1 ? 'jev-1.13.0-routed' : MODEL });
    },
  };
  const result = await runLive(frozen, out, { client, root: dir });
  assert.equal(result.status, 'complete');
  assert.equal(result.modelStampMismatch, 1);
});
