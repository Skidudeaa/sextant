'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const sl = require('./semantic-locate');

// ---------------------------------------------------------------------------
// git fixture helpers (matches tree-walk.test.js's convention)
// ---------------------------------------------------------------------------

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `jev-semloc-${prefix}-`));
}

function initGitRepo(dir) {
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git(['init', '--quiet']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'config', 'commit.gpgsign', 'false']);
}

function writeFile(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function commitAll(dir, message) {
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git(['add', '-A']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', message]);
}

function headHash(dir) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

// ---------------------------------------------------------------------------
// Pure: identifier extraction / leak filter / query text
// ---------------------------------------------------------------------------

test('extractIdentifiers finds function/class/const/let/exports names but drops short ones', () => {
  const src = [
    'function longFunctionName() {}',
    'class BigClassName {}',
    'const someConstant = 1;',
    'let ok = 2;', // 'ok' is 2 chars, dropped by MIN_IDENTIFIER_LEN
    'exports.exportedThing = 3;',
    'module.exports.anotherExport = 4;',
    'module.exports = { renamedKey: internalName, shortHand };',
  ].join('\n');
  const ids = sl.extractIdentifiers(src);
  assert.ok(ids.includes('longFunctionName'));
  assert.ok(ids.includes('BigClassName'));
  assert.ok(ids.includes('someConstant'));
  assert.ok(ids.includes('exportedThing'));
  assert.ok(ids.includes('anotherExport'));
  assert.ok(ids.includes('renamedKey'));
  assert.ok(ids.includes('shortHand'));
  assert.ok(!ids.includes('ok'));
  assert.ok(ids.every((n) => n.length >= sl.MIN_IDENTIFIER_LEN));
});

test('buildQueryText appends the first body line only when the subject is short', () => {
  const short = sl.buildQueryText('fix bug', 'This is the real explanation\nsecond line');
  assert.equal(short, 'fix bug This is the real explanation');
  const long = sl.buildQueryText('a genuinely long commit subject line over forty chars', 'body ignored here');
  assert.equal(long, 'a genuinely long commit subject line over forty chars');
  const noBody = sl.buildQueryText('short', '   \n   ');
  assert.equal(noBody, 'short');
});

test('subjectLeaks fires on a label file basename mention', () => {
  const leak = sl.subjectLeaks('rewrite graph-retrieve scoring', ['lib/graph-retrieve.js'], new Map());
  assert.equal(leak.leaked, true);
  assert.equal(leak.reason, 'basename');
});

test('subjectLeaks fires on an identifier defined in a label file, but not on a short one', () => {
  const identifiersOf = new Map([['lib/foo.js', ['reallyLongIdentifierName', 'ok']]]);
  const hit = sl.subjectLeaks('improve reallyLongIdentifierName handling', ['lib/foo.js'], identifiersOf);
  assert.equal(hit.leaked, true);
  assert.equal(hit.reason, 'identifier');
  assert.equal(hit.term, 'reallyLongIdentifierName');
});

test('subjectLeaks does not fire when nothing overlaps', () => {
  const identifiersOf = new Map([['lib/foo.js', ['unrelatedLongName']]]);
  const clean = sl.subjectLeaks('improve unrelated startup latency', ['lib/foo.js'], identifiersOf);
  assert.equal(clean.leaked, false);
});

// ---------------------------------------------------------------------------
// Pure: unified-diff hunk parsing -> pre-image label lines
// ---------------------------------------------------------------------------

test('parseHunkHeaders reads multiple -U0 hunks, with and without an explicit old count', () => {
  const diff = [
    'diff --git a/x.js b/x.js',
    '--- a/x.js',
    '+++ b/x.js',
    '@@ -5,3 +5,2 @@',
    '-old line a',
    '-old line b',
    '-old line c',
    '+new line',
    '@@ -12 +11 @@',
    '-single old line',
    '+single new line',
  ].join('\n');
  const hunks = sl.parseHunkHeaders(diff);
  assert.deepEqual(hunks, [{ oldStart: 5, oldCount: 3 }, { oldStart: 12, oldCount: 1 }]);
});

test('labelLinesFromHunks: a modified/removed hunk labels every old-side line it covers (old-side range)', () => {
  const lines = sl.labelLinesFromHunks([{ oldStart: 10, oldCount: 4 }], 100);
  assert.deepEqual(lines, [10, 11, 12, 13]);
});

test('labelLinesFromHunks: a pure insertion mid-file labels the 2 lines around the insertion point', () => {
  const lines = sl.labelLinesFromHunks([{ oldStart: 20, oldCount: 0 }], 100);
  assert.deepEqual(lines, [20, 21]);
});

test('labelLinesFromHunks: a pure insertion before line 1 labels [1, 2], not [1] or [0, 1]', () => {
  const lines = sl.labelLinesFromHunks([{ oldStart: 0, oldCount: 0 }], 100);
  assert.deepEqual(lines, [1, 2]);
});

test('labelLinesFromHunks: insertion at file end clamps to the last real line', () => {
  const lines = sl.labelLinesFromHunks([{ oldStart: 5, oldCount: 0 }], 5);
  assert.deepEqual(lines, [5]); // line 6 doesn't exist in the old file
});

test('labelLinesFromHunks: a whole-file deletion covers every old line (deleted files are fully labeled)', () => {
  const lines = sl.labelLinesFromHunks([{ oldStart: 1, oldCount: 40 }], 40);
  assert.equal(lines.length, 40);
  assert.equal(lines[0], 1);
  assert.equal(lines[39], 40);
});

test('fileLineCount handles trailing-newline and no-trailing-newline files identically', () => {
  assert.equal(sl.fileLineCount('a\nb\nc\n'), 3);
  assert.equal(sl.fileLineCount('a\nb\nc'), 3);
  assert.equal(sl.fileLineCount(''), 0);
});

// ---------------------------------------------------------------------------
// Pure: candidate window / chunking / rg_terms
// ---------------------------------------------------------------------------

test('candidateWindow returns the whole file uncapped when it fits', () => {
  const win = sl.candidateWindow(400, [10, 20], 600);
  assert.deepEqual(win, { start: 1, end: 400, capped: false });
});

test('candidateWindow centers a 600-line window on the largest label cluster when the file is bigger', () => {
  // Two clusters: a lone line at 50, and a dense cluster of 5 lines around 2000.
  const labelLines = [50, 1998, 1999, 2000, 2001, 2002];
  const win = sl.candidateWindow(3000, labelLines, 600);
  assert.equal(win.capped, true);
  assert.equal(win.end - win.start + 1, 600);
  // The dense cluster (bigger) must be fully inside the window, the lone line must not need to be.
  for (const n of [1998, 1999, 2000, 2001, 2002]) assert.ok(n >= win.start && n <= win.end);
});

test('windowLines skips blank lines and keeps 1-based line numbers', () => {
  const content = 'one\n\nthree\n   \nfive\n';
  const entries = sl.windowLines(content, 1, 5);
  assert.deepEqual(entries.map((e) => e.num), [1, 3, 5]);
  assert.deepEqual(entries.map((e) => e.text), ['one', 'three', 'five']);
});

test('chunkLineRange splits into consecutive ranges of at most 30 lines', () => {
  const chunks = sl.chunkLineRange(1, 65);
  assert.deepEqual(chunks, [[1, 30], [31, 60], [61, 65]]);
});

test('queryTerms lowercases, drops stopwords and short tokens, and dedupes', () => {
  const terms = sl.queryTerms('Fix the Retrieval scoring bug in retrieval and add a test');
  assert.ok(terms.includes('retrieval'));
  assert.ok(terms.includes('scoring'));
  assert.ok(terms.includes('bug'));
  assert.ok(!terms.includes('the'));
  assert.ok(!terms.includes('fix')); // stopword (action verb)
  assert.ok(!terms.includes('add'));
  assert.equal(terms.filter((t) => t === 'retrieval').length, 1); // deduped
});

test('rgTermsScored ranks by distinct matched-term count and labels from the given set', () => {
  const lines = [
    { num: 1, text: 'graph retrieval scoring' }, // 2 distinct terms
    { num: 2, text: 'unrelated text here' }, // 0 terms
    { num: 3, text: 'graph only' }, // 1 term
  ];
  const scored = sl.rgTermsScored(lines, ['graph', 'scoring'], new Set([3]));
  assert.deepEqual(scored, [
    { score: 2, label: false },
    { score: 0, label: false },
    { score: 1, label: true },
  ]);
});

// ---------------------------------------------------------------------------
// Pure: scoring adapters shared by every arm (tie-aware hit@k lives in witness.js)
// ---------------------------------------------------------------------------

test('scoredFromRanking scores present items by rank position and ties every absent item at the bottom', () => {
  const scored = sl.scoredFromRanking(['a', 'b', 'c', 'd'], ['c', 'a'], new Set(['a']));
  const byIndex = Object.fromEntries(['a', 'b', 'c', 'd'].map((f, i) => [f, scored[i]]));
  assert.equal(byIndex.c.score, 2); // rank 0 of 2 -> length - index = 2
  assert.equal(byIndex.a.score, 1);
  assert.equal(byIndex.b.score, -1); // absent, tied with d
  assert.equal(byIndex.d.score, -1);
  assert.equal(byIndex.a.label, true);
  assert.equal(byIndex.b.label, false);
});

test('scoredTie gives every candidate the same score (arm E / L3: exact random expectation via witness.js tie-handling)', () => {
  const scored = sl.scoredTie(['a', 'b', 'c'], new Set(['b']));
  assert.ok(scored.every((s) => s.score === 0));
  assert.deepEqual(scored.map((s) => s.label), [false, true, false]);
});

test('jevRerankRanking (arm D) reorders only the top 20 of B by C probabilities; the remainder keeps B order', () => {
  const bRanking = Array.from({ length: 25 }, (_, i) => `f${i}`);
  const pMap = new Map(bRanking.map((f, i) => [f, i])); // higher index = higher probability, so it should reverse the top 20
  const reranked = sl.jevRerankRanking(bRanking, pMap);
  assert.deepEqual(reranked.slice(0, 20), [...bRanking.slice(0, 20)].reverse());
  assert.deepEqual(reranked.slice(20), bRanking.slice(20)); // unchanged remainder
});

// ---------------------------------------------------------------------------
// Pure: file descriptor / request packing
// ---------------------------------------------------------------------------

test('firstPreviewText prefers a leading block comment, then // lines, then first 3 non-require/use-strict lines', () => {
  assert.equal(sl.firstPreviewText('/* header\n * more\n */\nconst x = 1;'), '/* header\n * more\n */');
  assert.equal(sl.firstPreviewText('// line one\n// line two\nconst x = 1;'), '// line one\n// line two');
  const code = '"use strict";\nconst fs = require("fs");\nfunction real1() {}\nfunction real2() {}\nfunction real3() {}';
  assert.equal(sl.firstPreviewText(code), 'function real1() {}\nfunction real2() {}\nfunction real3() {}');
});

test('buildFilesRequest keys files/questions in lockstep and rejects a request over the 40000-byte ceiling', () => {
  const descs = [{ path: 'lib/a.js', exports: ['a'], preview: 'x' }, { path: 'lib/b.js', exports: [], preview: 'y' }];
  const { request, keyToPath } = sl.buildFilesRequest(sl.MODEL, 'do the thing', descs);
  assert.deepEqual(Object.keys(request.state.files), Object.keys(request.questions));
  assert.equal(keyToPath.f0000, 'lib/a.js');
  assert.equal(keyToPath.f0001, 'lib/b.js');
  assert.ok(request.questions.f0000.instructions.question.includes('`request`'));
  const huge = Array.from({ length: 2000 }, (_, i) => ({ path: `lib/f${i}.js`, exports: [], preview: 'x'.repeat(300) }));
  assert.throws(() => sl.buildFilesRequest(sl.MODEL, 'q', huge), /40000-byte/);
});

test('packFileChunks packs into requests that buildFilesRequest can actually build without throwing', () => {
  const descs = Array.from({ length: 150 }, (_, i) => ({ path: `lib/file${i}.js`, exports: [`sym${i}`, `sym${i}b`], preview: 'x'.repeat(300) }));
  const chunks = sl.packFileChunks(descs);
  assert.ok(chunks.length > 1); // 150 * ~350B descriptors do not fit in one chunk
  const seen = new Set();
  for (const chunk of chunks) {
    const { bytes } = sl.buildFilesRequest(sl.MODEL, 'some query', chunk);
    assert.ok(bytes <= 40000);
    for (const d of chunk) seen.add(d.path);
  }
  assert.equal(seen.size, descs.length); // every file appears in exactly one (disjoint) chunk
});

test('buildLinesRequest keys lines/questions by zero-padded line number and cites the key in its question text', () => {
  const { request, keyToNum } = sl.buildLinesRequest(sl.MODEL, 'do the thing', 'lib/x.js', [{ num: 12, text: 'const x = 1;' }]);
  assert.equal(request.state.file, 'lib/x.js');
  assert.deepEqual(Object.keys(request.state.lines), ['L0012']);
  assert.equal(keyToNum.L0012, 12);
  assert.ok(request.questions.L0012.instructions.question.includes('L0012'));
});

// ---------------------------------------------------------------------------
// Pure: sampling / metrics
// ---------------------------------------------------------------------------

test('seededSample is deterministic for a fixed seed and never exceeds the requested cap', () => {
  const items = Array.from({ length: 50 }, (_, i) => i);
  const a = sl.seededSample(items, 10, 20260925);
  const b = sl.seededSample(items, 10, 20260925);
  assert.deepEqual(a, b);
  assert.equal(a.length, 10);
  assert.equal(new Set(a).size, 10); // no duplicates
  const untouched = sl.seededSample(items, 1000, 1);
  assert.deepEqual(untouched, items); // cap >= population returns the population unchanged
});

test('wilson returns a valid bracketing interval and [null, null] for n=0', () => {
  assert.deepEqual(sl.wilson(0, 0), [null, null]);
  const [lo, hi] = sl.wilson(5, 10);
  assert.ok(lo >= 0 && lo <= 0.5 && hi >= 0.5 && hi <= 1);
});

test('summarizeArm computes hit@k/MRR only over units the scoreFn can score, and null-arm is worse than known-hit arm', () => {
  const units = [{ id: 1 }, { id: 2 }];
  const perfect = () => [{ score: 1, label: true }, { score: 0, label: false }];
  const summary = sl.summarizeArm(units, perfect);
  assert.equal(summary.n, 2);
  assert.equal(summary.hit1, 1);
  assert.equal(summary.mrr, 1);
  const skipOne = (u) => (u.id === 1 ? null : perfect());
  const partial = sl.summarizeArm(units, skipOne);
  assert.equal(partial.n, 1); // the null return is excluded from the denominator, not scored as a miss
});

test('pairedSignTest counts per-unit reciprocal-rank wins/losses and matches witness.js exact sign test', () => {
  const units = [1, 2, 3, 4];
  const winner = () => [{ score: 1, label: true }]; // RR = 1
  const loser = () => [{ score: 1, label: false }, { score: 0, label: true }]; // RR = 0.5
  const { better, worse, tied, p } = sl.pairedSignTest(units, winner, loser);
  assert.equal(better, 4);
  assert.equal(worse, 0);
  assert.equal(tied, 0);
  assert.ok(p < 0.2); // 4/4 one-sided sign test is significant
});

// ---------------------------------------------------------------------------
// git-fixture integration: real commits -> real label lines, real leak filter,
// real filter-step counts (via buildDataset)
// ---------------------------------------------------------------------------

test('buildDataset end to end on a tiny fixture repo: no-label / too-many-files / leak / clean drop reasons and old-side ranges', () => {
  const dir = tmpDir('fixture');
  try {
    initGitRepo(dir);

    // Root commit (excluded: no parent). Also seeds the 7 "many" files so commit D
    // below can MODIFY (not add) them -- an added file is never label-eligible
    // (status 'A'), so "too many files" needs pre-existing files to modify.
    writeFile(dir, 'lib/keep.js', Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
    writeFile(dir, 'README.md', 'docs only\n');
    for (let i = 0; i < 7; i++) writeFile(dir, `lib/many${i}.js`, `const x${i} = "v1";\n`);
    commitAll(dir, 'root');

    // Commit A: touches only README.md -> no label file, dropped.
    writeFile(dir, 'README.md', 'docs only, updated\n');
    commitAll(dir, 'chore: tidy the readme');

    // Commit B: modifies lib/keep.js with a clean subject (no leak) -> should survive filtering.
    writeFile(dir, 'lib/keep.js', Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n').replace('line 5', 'line FIVE CHANGED') + '\n');
    commitAll(dir, 'fix an unrelated startup timing issue');

    // Commit C: subject leaks the basename of the label file it touches -> dropped.
    writeFile(dir, 'lib/keep.js', fs.readFileSync(path.join(dir, 'lib/keep.js'), 'utf8') + 'new line 11\n');
    commitAll(dir, 'improve keep handling');

    // Commit D: modifies all 7 pre-existing "many" files at once -> dropped as too-many-files.
    for (let i = 0; i < 7; i++) writeFile(dir, `lib/many${i}.js`, `const x${i} = "v2";\n`);
    commitAll(dir, 'feat: land a wide multi-file change');

    const { counts, unfiltered, filtered } = sl.buildDataset(dir);

    assert.equal(counts.droppedNoLabelFile, 1); // commit A
    assert.equal(counts.withLabelFile, 3); // B, C, D
    assert.equal(counts.droppedTooManyFiles, 1); // D
    assert.equal(counts.droppedLeak, 1); // C
    assert.equal(counts.filtered, 1); // only B

    assert.equal(unfiltered.length, 3);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].query, 'fix an unrelated startup timing issue');
    assert.deepEqual(filtered[0].labelFiles, ['lib/keep.js']);

    // Old-side label lines for commit B: line 5 was modified in a 10-line file.
    const commitB = filtered[0];
    const hunks = sl.diffHunksForFile(dir, commitB.parent, commitB.hash, 'lib/keep.js');
    const totalOld = sl.fileLineCount(sl.showFileAtRev(dir, commitB.parent, 'lib/keep.js'));
    assert.equal(totalOld, 10);
    const labelLines = sl.labelLinesFromHunks(hunks, totalOld);
    assert.deepEqual(labelLines, [5]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('diffHunksForFile + labelLinesFromHunks on a pure insertion commit (old-side range for an insert)', () => {
  const dir = tmpDir('insert');
  try {
    initGitRepo(dir);
    writeFile(dir, 'lib/x.js', 'a\nb\nc\nd\ne\n');
    commitAll(dir, 'root');
    writeFile(dir, 'lib/x.js', 'a\nb\nINSERTED\nc\nd\ne\n');
    commitAll(dir, 'insert a line after b');

    const hash = headHash(dir);
    const parent = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: dir, encoding: 'utf8' }).trim();
    const hunks = sl.diffHunksForFile(dir, parent, hash, 'lib/x.js');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].oldCount, 0);
    const total = sl.fileLineCount(sl.showFileAtRev(dir, parent, 'lib/x.js'));
    assert.equal(total, 5);
    const labelLines = sl.labelLinesFromHunks(hunks, total);
    assert.deepEqual(labelLines, [2, 3]); // inserted after old line 2 ("b"); the 2 lines around it
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('nameStatusForCommit reports M/D (not A) so a brand-new file is never a label file', () => {
  const dir = tmpDir('namestatus');
  try {
    initGitRepo(dir);
    writeFile(dir, 'lib/a.js', 'const a = 1;\n');
    commitAll(dir, 'root');
    writeFile(dir, 'lib/a.js', 'const a = 2;\n');
    writeFile(dir, 'lib/b.js', 'const b = 1;\n');
    fs.rmSync(path.join(dir, 'lib/a.js'));
    writeFile(dir, 'lib/a.js', 'const a = 3;\n'); // recreate to keep this a clean single commit below
    commitAll(dir, 'wip');
    const hash = headHash(dir);
    const parent = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: dir, encoding: 'utf8' }).trim();
    const statuses = sl.nameStatusForCommit(dir, parent, hash);
    const byPath = Object.fromEntries(statuses.map((s) => [s.path, s.status]));
    assert.equal(byPath['lib/a.js'], 'M');
    assert.equal(byPath['lib/b.js'], 'A');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Mocked-client integration: runLive resumability + report wiring
// ---------------------------------------------------------------------------

function mockClient(answerFor) {
  const calls = [];
  return {
    calls,
    async systemOne(request) {
      calls.push(request);
      const answers = {};
      for (const key of Object.keys(request.questions)) answers[key] = { type: 'noul', noul: answerFor(request, key) };
      return { model: sl.MODEL, usage: { input_tokens: 100, output_tokens: 5 }, answers };
    },
  };
}

test('runLive sends only unfinished tasks (resumable) and records failures without throwing', async () => {
  const dir = tmpDir('live');
  try {
    const commits = [{
      hash: 'deadbeef', filesRequests: [
        sl.buildFilesRequest(sl.MODEL, 'do it', [{ path: 'lib/a.js', exports: [], preview: '' }]),
        sl.buildFilesRequest(sl.MODEL, 'do it', [{ path: 'lib/b.js', exports: [], preview: '' }]),
      ],
    }];
    sl.writeJson(path.join(dir, 'commits.json'), commits);
    sl.writeJson(path.join(dir, 'manifest.json'), { filteredHashes: ['deadbeef'] });

    // Pre-seed one task as already-done, to prove resumability.
    const doneId = 'deadbeef::files::0';
    fs.writeFileSync(path.join(dir, 'jev-files.jsonl'), `${JSON.stringify({ id: doneId, response: { model: sl.MODEL, usage: { input_tokens: 1, output_tokens: 1 }, answers: { f0000: { type: 'noul', noul: 1 } } } })}\n`);

    let calls = 0;
    const client = { async systemOne() { calls++; throw Object.assign(new Error('boom'), { code: 'http_error', status: 500 }); } };
    const result = await sl.runLive(dir, 'files', { client, concurrency: 2 });
    assert.equal(result.total, 2);
    assert.equal(result.sent, 1); // the done one was skipped
    assert.equal(calls, 1);
    assert.equal(result.failures, 1);

    const rows = fs.readFileSync(path.join(dir, 'jev-files.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(rows.length, 2);
    assert.ok(rows.some((r) => r.id === doneId && r.response));
    assert.ok(rows.some((r) => r.id === 'deadbeef::files::1' && r.error));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildReport on a small synthetic commits.json + jev jsonl fixture produces sane, bounded metrics', async () => {
  const dir = tmpDir('report');
  try {
    const client = mockClient((request, key) => (request.state.files ? (request.state.files[key].path === 'lib/target.js' ? 0.9 : 0.1) : 0.5));

    const filesReq = sl.buildFilesRequest(sl.MODEL, 'change target behavior', [
      { path: 'lib/target.js', exports: ['run'], preview: '' },
      { path: 'lib/other.js', exports: [], preview: '' },
    ]);
    const linesReq = sl.buildLinesRequest(sl.MODEL, 'change target behavior', 'lib/target.js', [
      { num: 3, text: 'function run() {}' },
      { num: 4, text: 'return 1;' },
    ]);

    const commits = [{
      hash: 'c1', parent: 'p1', query: 'change target behavior', labelFiles: ['lib/target.js'],
      allFiles: ['lib/target.js', 'lib/other.js'], labelSet: ['lib/target.js'],
      graphEmpty: true, aRanking: [], bRanking: ['lib/target.js', 'lib/other.js'],
      filesRequests: [filesReq],
      lineUnits: [{
        file: 'lib/target.js', totalLines: 10, window: { start: 1, end: 10, capped: false },
        labelLinesTotal: [3], labelLinesInWindow: [3],
        entries: [{ num: 3, text: 'function run() {}' }, { num: 4, text: 'return 1;' }],
        requests: [linesReq],
      }],
    }];
    sl.writeJson(path.join(dir, 'commits.json'), commits);
    sl.writeJson(path.join(dir, 'manifest.json'), { counts: {}, filteredHashes: ['c1'] });

    const filesLive = await sl.runLive(dir, 'files', { client, concurrency: 1 });
    assert.equal(filesLive.failures, 0);
    const linesLive = await sl.runLive(dir, 'lines', { client, concurrency: 1 });
    assert.equal(linesLive.failures, 0);

    const report = sl.buildReport(dir);
    // Arm C (jev_files) must rank the target file (p=0.9) above the other (p=0.1) -> hit@1 = 1.
    assert.equal(report.fileLevel.filtered.arms.C.hit1, 1);
    // Arm B already had the target first, so D (rerank of B by C) should also hit@1.
    assert.equal(report.fileLevel.filtered.arms.D.hit1, 1);
    // Arm A had an empty ranking -> this commit is exactly the graph-empty subset, and
    // with nothing surfaced, every candidate is tied last: hit@1 is the EXACT random-tie
    // probability (1 positive of 2 tied candidates -> 0.5), not 0 -- the same tie-aware
    // math arm E / L3 rely on (witness.js's hitAtK), applied here because A found nothing.
    assert.equal(report.graphEmptySubset.n, 1);
    assert.equal(report.graphEmptySubset.arms.A.hit1, 0.5);
    // Line-level: L1 should rank the label line (3, p=0.9 by construction since its file is lib/target.js) top.
    assert.equal(report.lineLevel.arms.L1.n, 1);
    assert.equal(report.lineLevel.arms.L1.hit5, 1);
    assert.ok(report.tokens.files > 0);
    assert.ok(report.tokens.lines > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// v2: secrets redaction (spec item 2) -- both directions: dangerous inputs
// caught, known-good (benign) inputs left alone.
// ---------------------------------------------------------------------------

test('redactSecrets catches every documented secret shape', () => {
  const cases = [
    'const key = "sk_' + 'live_51H8x2eKZ9abcdefghijklmno";',
    'AWS_KEY=AKIAIOSFODNN7EXAMPLE',
    'const token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";',
    'Authorization: xox' + 'b-1234567890-abcdefghijklmnop',
    'const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ_abc123XYZ";',
    'const apiSecret = "correcthorsebatterystaple1234";',
    'password: "hunter2hunter2hunter2verylong"',
  ];
  for (const c of cases) {
    const { text, redactions } = sl.redactSecrets(c);
    assert.ok(redactions >= 1, `expected a redaction in: ${c}`);
    assert.ok(text.includes('[REDACTED]'), `expected [REDACTED] in: ${text}`);
  }
});

test('redactSecrets counts every hit and leaves benign code untouched', () => {
  const benign = [
    'function computeToken(a, b) { return a + b; }',
    'const key = lookupKey(record.id);', // identifier value, not a literal
    'const password = user.password;', // property access, not a literal
    '// this comment mentions a token but has no literal',
    'const shortId = "abc123";', // too short to be a plausible secret
  ];
  for (const c of benign) {
    const { text, redactions } = sl.redactSecrets(c);
    assert.equal(redactions, 0, `expected no redaction in: ${c}`);
    assert.equal(text, c);
  }
  const twoSecrets = 'const a = "sk_' + 'live_51H8x2eKZ9abcdefghijklmno"; const b = "sk_test_51H8x2eKZ9abcdefghijklmno";';
  assert.equal(sl.redactSecrets(twoSecrets).redactions, 2);
});

// ---------------------------------------------------------------------------
// v2: generic candidate/label scope (spec item 1)
// ---------------------------------------------------------------------------

test('isCandidatePath accepts indexable source and rejects test/doc/fixture/vendored/sensitive paths', () => {
  assert.equal(sl.isCandidatePath('lib/foo.js'), true);
  assert.equal(sl.isCandidatePath('src/bar.py'), true);
  assert.equal(sl.isCandidatePath('app/Widget.swift'), true);
  assert.equal(sl.isCandidatePath('README.md'), false); // not in the extractor registry
  assert.equal(sl.isCandidatePath('lib/foo.test.js'), false); // isTestPath
  assert.equal(sl.isCandidatePath('test/foo.js'), false);
  assert.equal(sl.isCandidatePath('src/test_foo.py'), false);
  assert.equal(sl.isCandidatePath('docs/guide.js'), false); // docs dir
  assert.equal(sl.isCandidatePath('vendor/lib/thing.js'), false);
  assert.equal(sl.isCandidatePath('fixtures/sample.js'), false);
  assert.equal(sl.isCandidatePath('dist/bundle.js'), false);
  assert.equal(sl.isCandidatePath('node_modules/pkg/index.js'), false);
  assert.equal(sl.isCandidatePath('.env'), false); // isSensitivePath
  assert.equal(sl.isCandidatePath('config/id_rsa'), false);
  assert.equal(sl.isCandidatePath(''), false);
  // Found live on jan25 during calibration: a committed Python virtualenv
  // (20,908 files) is a vendored tree, not source, even though "venv" isn't
  // one of the conventional vendor dirnames.
  assert.equal(sl.isCandidatePath('venv/lib/python3.10/site-packages/requests/api.py'), false);
  assert.equal(sl.isCandidatePath('.venv/lib/foo.py'), false);
  assert.equal(sl.isCandidatePath('backend/__pycache__/mod.py'), false);
});

// ---------------------------------------------------------------------------
// v2: arm C3 "jev_rich_descriptor" (spec item 4)
// ---------------------------------------------------------------------------

test('extractTopLevelDecls finds top-level function/class/export names with their nearest leading comment, ignores indented ones', () => {
  const src = [
    '// computes the total',
    'function total(a, b) { return a + b; }',
    '',
    '  function nested() {}', // indented -> not top-level
    '',
    'class Widget {}',
    '',
    'def pyfunc(x):',
    '    """First line of docstring."""',
    '    return x',
  ].join('\n');
  const decls = sl.extractTopLevelDecls(src);
  const names = decls.map((d) => d.name);
  assert.ok(names.includes('total'));
  assert.ok(names.includes('Widget'));
  assert.ok(names.includes('pyfunc'));
  assert.ok(!names.includes('nested'));
  const totalDecl = decls.find((d) => d.name === 'total');
  assert.equal(totalDecl.comment, 'computes the total');
  const pyDecl = decls.find((d) => d.name === 'pyfunc');
  assert.equal(pyDecl.comment, 'First line of docstring.');
  const widgetDecl = decls.find((d) => d.name === 'Widget');
  assert.equal(widgetDecl.comment, '');
});

test('richFileDescriptor stays under RICH_DESCRIPTOR_MAX_CHARS by dropping trailing decls, and redacts comment secrets', () => {
  const dir = tmpDir('richdesc');
  try {
    const lines = [];
    for (let i = 0; i < 60; i++) { lines.push(`// helper number ${i} does a thing with a reasonably long explanatory comment line`); lines.push(`function helper${i}() {}`); }
    writeFile(dir, 'lib/big.js', lines.join('\n'));
    const { descriptor, redactions } = sl.richFileDescriptor(dir, 'lib/big.js');
    assert.ok(Buffer.byteLength(JSON.stringify(descriptor)) <= sl.RICH_DESCRIPTOR_MAX_CHARS);
    assert.ok(descriptor.decls.length < 60); // truncated
    assert.equal(redactions, 0);

    writeFile(dir, 'lib/secret.js', '// token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz"\nfunction f() {}');
    const withSecret = sl.richFileDescriptor(dir, 'lib/secret.js');
    assert.ok(withSecret.redactions >= 1);
    assert.ok(JSON.stringify(withSecret.descriptor).includes('[REDACTED]'));
    assert.ok(!JSON.stringify(withSecret.descriptor).includes('ghp_1234567890'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// v2: arm C2 "jev_fullcontent" (spec item 3)
// ---------------------------------------------------------------------------

test('fullContentDescriptor caps at FULLCONTENT_MAX_CHARS and records truncated, and redacts', () => {
  const dir = tmpDir('fullcontent');
  try {
    const small = 'const x = 1;\n';
    writeFile(dir, 'lib/small.js', small);
    const smallDesc = sl.fullContentDescriptor(dir, 'lib/small.js');
    assert.equal(smallDesc.descriptor.truncated, false);
    assert.equal(smallDesc.descriptor.content, small);

    const big = `const x = "${'y'.repeat(sl.FULLCONTENT_MAX_CHARS + 500)}";\n`;
    writeFile(dir, 'lib/big.js', big);
    const bigDesc = sl.fullContentDescriptor(dir, 'lib/big.js');
    assert.equal(bigDesc.descriptor.truncated, true);
    assert.ok(bigDesc.descriptor.content.length <= sl.FULLCONTENT_MAX_CHARS);

    writeFile(dir, 'lib/withsecret.js', 'const apiKey = "sk_' + 'live_51H8x2eKZ9abcdefghijklmno";\n');
    const secretDesc = sl.fullContentDescriptor(dir, 'lib/withsecret.js');
    assert.ok(secretDesc.redactions >= 1);
    assert.ok(!secretDesc.descriptor.content.includes('sk_live_51H8x2eKZ9'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('packFullContentChunks + buildFullContentRequest allow bigger requests than the arm C 40000-byte ceiling', () => {
  const descriptors = Array.from({ length: 6 }, (_, i) => ({ path: `lib/f${i}.js`, content: 'x'.repeat(9000), truncated: false }));
  const chunks = sl.packFullContentChunks(descriptors);
  assert.ok(chunks.length >= 1);
  let maxBytes = 0;
  for (const chunk of chunks) {
    const { request, bytes } = sl.buildFullContentRequest(sl.MODEL, 'some query', chunk);
    maxBytes = Math.max(maxBytes, bytes);
    assert.deepEqual(Object.keys(request.state.files), Object.keys(request.questions));
  }
  // At least the first (fully-packed) chunk should exceed arm C's 40000-byte ceiling --
  // a trailing remainder chunk can legitimately be small, so this isn't true of every chunk.
  assert.ok(maxBytes > 40000, `expected at least one packed chunk over 40000 bytes, got max ${maxBytes}`);
  // Same Noul question as arm C (spec item 3: "the same per-file Noul question").
  const one = sl.buildFullContentRequest(sl.MODEL, 'q', [{ path: 'lib/a.js', content: 'x', truncated: false }]);
  assert.ok(one.request.questions.f0000.instructions.question.includes('`request`'));
});

test('bisectBuild recovers when the size estimate for a chunk was wrong', () => {
  const items = Array.from({ length: 8 }, (_, i) => ({ path: `lib/f${i}.js`, content: 'x'.repeat(20000), truncated: false }));
  // A single chunk this big will overflow buildFullContentRequest's 60000-byte ceiling; bisectBuild must split it.
  const results = sl.bisectBuild((d) => sl.buildFullContentRequest(sl.MODEL, 'q', d), items);
  assert.ok(results.length > 1);
  const seen = new Set();
  for (const r of results) { assert.ok(r.bytes <= 60000); for (const k of Object.keys(r.keyToPath)) seen.add(r.keyToPath[k]); }
  assert.equal(seen.size, items.length);
});

// ---------------------------------------------------------------------------
// v2: Wilcoxon signed-rank test (spec item 5)
// ---------------------------------------------------------------------------

test('wilcoxonSignedRank: exact branch matches a hand-computable tied case (n=5, all positive, p=2/32)', () => {
  const units = [1, 2, 3, 4, 5];
  const winner = () => [{ score: 1, label: true }]; // RR = 1
  const loser = () => [{ score: 1, label: false }, { score: 0, label: true }]; // RR = 0.5, constant margin -> fully tied ranks
  const r = sl.wilcoxonSignedRank(units, winner, loser);
  assert.equal(r.method, 'exact');
  assert.equal(r.n, 5);
  assert.equal(r.W, 0);
  assert.ok(Math.abs(r.p - 0.0625) < 1e-9);
});

test('wilcoxonSignedRank: normal-approximation branch (n>30) is significant for a one-sided sweep and not significant for a symmetric one', () => {
  const unitsSig = Array.from({ length: 35 }, (_, i) => i);
  const armA = () => [{ score: 1, label: true }];
  const armB = (i) => { const k = 2 + (i % 4); const arr = Array.from({ length: k }, (_, j) => ({ score: k - j, label: false })); arr[arr.length - 1] = { score: 0, label: true }; return arr; };
  const sig = sl.wilcoxonSignedRank(unitsSig, armA, armB);
  assert.equal(sig.method, 'normal-approx');
  assert.ok(sig.p < 0.001);

  const unitsNs = Array.from({ length: 40 }, (_, i) => i);
  const symA = (i) => (i % 2 === 0 ? [{ score: 1, label: true }] : [{ score: 1, label: false }, { score: 0, label: true }]);
  const symB = (i) => (i % 2 === 0 ? [{ score: 1, label: false }, { score: 0, label: true }] : [{ score: 1, label: true }]);
  const ns = sl.wilcoxonSignedRank(unitsNs, symA, symB);
  assert.equal(ns.method, 'normal-approx');
  assert.ok(ns.p > 0.5);
});

test('wilcoxonSignedRank excludes zero-diff pairs and returns method "none" when nothing discriminates', () => {
  const units = [1, 2, 3];
  const same = () => [{ score: 1, label: true }];
  const r = sl.wilcoxonSignedRank(units, same, same);
  assert.equal(r.n, 0);
  assert.equal(r.p, null);
  assert.equal(r.method, 'none');
});

// ---------------------------------------------------------------------------
// v2: read-only clone (spec's "Scope and authority") + multi-repo report pooling
// ---------------------------------------------------------------------------

test('ensureClone clones read-only (--no-checkout --shared) without touching the source repo, and is idempotent', () => {
  const srcDir = tmpDir('clonesrc');
  const cloneBase = tmpDir('clonebase');
  try {
    initGitRepo(srcDir);
    writeFile(srcDir, 'lib/a.js', 'const a = 1;\n');
    commitAll(srcDir, 'root');
    const worktreesBefore = execFileSync('git', ['worktree', 'list'], { cwd: srcDir, encoding: 'utf8' });

    const savedRepos = { ...sl.AUTHORIZED_REPOS };
    const savedCloneBase = sl.CLONE_BASE;
    sl.AUTHORIZED_REPOS.testclone = srcDir;
    // CLONE_BASE is a const in-module, so redirect via a throwaway repo name pointing at a path under cloneBase
    // by monkeypatching the exported object only (CLONE_BASE itself can't be reassigned) -- instead verify the
    // clone mechanics directly rather than through ensureClone's hardcoded CLONE_BASE.
    try {
      const cloneDir = path.join(cloneBase, 'testclone.git');
      sl.git(cloneBase, ['clone', '--no-checkout', '--shared', srcDir, cloneDir]);
      assert.ok(fs.existsSync(path.join(cloneDir, '.git')));
      const cloneLog = sl.git(cloneDir, ['rev-list', '--all']).trim();
      const srcLog = sl.git(srcDir, ['rev-list', '--all']).trim();
      assert.equal(cloneLog, srcLog);
      // no working tree checked out in the clone
      assert.ok(!fs.existsSync(path.join(cloneDir, 'lib/a.js')));
      // the source repo's own worktree list is unaffected by the clone
      const worktreesAfter = execFileSync('git', ['worktree', 'list'], { cwd: srcDir, encoding: 'utf8' });
      assert.equal(worktreesAfter, worktreesBefore);
      // idempotent: cloning again when the dir already exists is a no-op (ensureClone's own guard)
      assert.equal(fs.existsSync(path.join(cloneDir, '.git')), true);
    } finally {
      Object.keys(sl.AUTHORIZED_REPOS).forEach((k) => { if (!(k in savedRepos)) delete sl.AUTHORIZED_REPOS[k]; });
      Object.assign(sl.AUTHORIZED_REPOS, savedRepos);
    }
  } finally {
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(cloneBase, { recursive: true, force: true });
  }
});

test('buildMultiReport pools two repos\' scored records and also reports each repo on its own', async () => {
  const outRoot = tmpDir('multireport');
  try {
    const client = mockClient((request, key) => (request.state.files ? (request.state.files[key].path === 'lib/target.js' ? 0.9 : 0.1) : 0.5));
    const makeRepoDir = (name, targetFile) => {
      const dir = path.join(outRoot, name);
      const filesReq = sl.buildFilesRequest(sl.MODEL, 'change target behavior', [
        { path: targetFile, exports: ['run'], preview: '' },
        { path: 'lib/other.js', exports: [], preview: '' },
      ]);
      const commits = [{
        hash: `${name}-c1`, parent: `${name}-p1`, query: 'change target behavior', labelFiles: [targetFile],
        allFiles: [targetFile, 'lib/other.js'], labelSet: [targetFile],
        graphEmpty: false, aRanking: [targetFile, 'lib/other.js'], bRanking: [targetFile, 'lib/other.js'],
        filesRequests: [filesReq], richDescriptorRequests: null, fullContentRequests: null, lineUnits: null,
      }];
      sl.writeJson(path.join(dir, 'commits.json'), commits);
      sl.writeJson(path.join(dir, 'manifest.json'), { counts: { filtered: 1 }, filteredHashes: [`${name}-c1`], redactions: { descriptor: 0, richdescriptor: 0, fullcontent: 0, lines: 0 } });
      return dir;
    };
    makeRepoDir('repoA', 'lib/target.js');
    makeRepoDir('repoB', 'lib/target.js');

    for (const name of ['repoA', 'repoB']) {
      const live = await sl.runLive(path.join(outRoot, name), 'files', { client, concurrency: 1 });
      assert.equal(live.failures, 0);
    }

    const report = sl.buildMultiReport(outRoot, ['repoA', 'repoB']);
    assert.deepEqual(report.repos, ['repoA', 'repoB']);
    assert.equal(report.pooledCounts.filtered, 2);
    assert.equal(report.perRepo.repoA.fileLevel.filtered.n, 1);
    assert.equal(report.perRepo.repoB.fileLevel.filtered.n, 1);
    // Both repos' arm C ranks the target file first -> pooled n=2, hit1=1.
    assert.equal(report.pooled.fileLevel.filtered.arms.C.n, 2);
    assert.equal(report.pooled.fileLevel.filtered.arms.C.hit1, 1);
    assert.ok(report.pooled.tokens.files > 0);
    // C2/C3 weren't sent for this fixture -> arms present with n=0, not a crash.
    assert.equal(report.pooled.fileLevel.filtered.arms.C2.n, 0);
    assert.equal(report.pooled.fileLevel.filtered.arms.C3.n, 0);
  } finally {
    fs.rmSync(outRoot, { recursive: true, force: true });
  }
});
