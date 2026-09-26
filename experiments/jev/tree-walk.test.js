'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const tw = require('./tree-walk');
const { JevClient } = require('./client');
const graph = require('../../lib/graph');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `jev-tree-walk-${prefix}-`));
}

/** Even probability distribution favoring one key, respecting the 0.001 sum tolerance. */
function evenProbs(keys, favorite, favoriteProb = 0.7) {
  const rest = keys.filter((k) => k !== favorite);
  const each = rest.length ? (1 - favoriteProb) / rest.length : 0;
  const probs = {};
  for (const k of rest) probs[k] = each;
  probs[favorite] = favoriteProb;
  return probs;
}

function findNode(tree, relPath) {
  if (relPath === '' || relPath === tree.path) return tree;
  let node = tree;
  for (const seg of relPath.split('/')) {
    node = node.children.get(seg);
    if (!node) return null;
  }
  return node;
}

/**
 * A scripted mock client: for each Choice question, resolves the frontier
 * node from instructions.current_path via the SAME sortedChildren() the
 * real implementation used to assign option keys, so the mock never drifts
 * out of alignment with production option ordering. `script` maps
 * current_path -> preferred child NAME; unscripted paths default to the
 * first sorted child.
 */
function scriptedClient(tree, script, { model = tw.MODEL, favoriteProb = 0.7, inputTokensPerQuestion = 40 } = {}) {
  let calls = 0;
  return {
    calls: () => calls,
    async systemOne({ model: reqModel, state, questions }) {
      calls += 1;
      const answers = {};
      let qCount = 0;
      for (const [qKey, question] of Object.entries(questions)) {
        qCount += 1;
        const currentPath = question.instructions.current_path === '(repository root)' ? '' : question.instructions.current_path;
        const node = findNode(tree, currentPath);
        const kids = tw.sortedChildren(node);
        const preferredName = script[currentPath];
        const idx = preferredName ? kids.findIndex((k) => k.name === preferredName) : 0;
        if (idx < 0) throw new Error(`scriptedClient: no child named ${preferredName} under ${currentPath}`);
        const favorite = `opt${idx}`;
        const keys = Object.keys(question.criteria);
        answers[qKey] = { type: 'choice', choice: favorite, confidence: 0.8, probabilities: evenProbs(keys, favorite, favoriteProb) };
      }
      return {
        model: reqModel,
        usage: { input_tokens: inputTokensPerQuestion * qCount, output_tokens: 5 * qCount },
        answers,
      };
    },
  };
}

function initGitRepo(dir) {
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git(['init', '--quiet']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'config', 'commit.gpgsign', 'false']);
}

function commitAll(dir, message) {
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git(['add', '.']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', message]);
}

function writeFile(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// ---------------------------------------------------------------------------
// Tree construction
// ---------------------------------------------------------------------------

test('buildTree nests directories and rejects a file/directory path collision', () => {
  const tree = tw.buildTree(['lib/a.js', 'lib/b/c.js', 'README.md']);
  assert.deepEqual([...tree.children.keys()].sort(), ['README.md', 'lib']);
  const lib = tree.children.get('lib');
  assert.equal(lib.type, 'dir');
  assert.equal(lib.path, 'lib');
  assert.deepEqual([...lib.children.keys()].sort(), ['a.js', 'b']);
  assert.equal(lib.children.get('b').children.get('c.js').path, 'lib/b/c.js');
  assert.throws(() => tw.buildTree(['lib/a.js', 'lib/a.js/impossible.js']), /collision/);
});

test('walkablePath excludes fixtures and vendor on top of repository.js allowedPath', () => {
  assert.equal(tw.walkablePath('lib/retrieve.js'), true);
  assert.equal(tw.walkablePath('fixtures/python-eval/foo.py'), false);
  assert.equal(tw.walkablePath('vendor/tree-sitter-swift.wasm'), false);
  assert.equal(tw.walkablePath('.env'), false); // still excluded via allowedPath's isSensitivePath
  assert.equal(tw.walkablePath('experiments/jev/tree-walk.js'), false); // allowedPath excludes 'experiments'
});

test('sortedChildren orders directories before files, alphabetically within type', () => {
  const tree = tw.buildTree(['b.js', 'a/z.js', 'a.js', 'z/y.js']);
  const names = tw.sortedChildren(tree).map((n) => `${n.type}:${n.name}`);
  assert.deepEqual(names, ['dir:a', 'dir:z', 'file:a.js', 'file:b.js']);
});

test('firstLeaves is deterministic and respects the cap', () => {
  // sortedChildren puts directories before files, so under root the 'b/'
  // subtree is visited before the sibling file 'a.js'.
  const tree = tw.buildTree(['b/2.js', 'b/1.js', 'a.js']);
  assert.deepEqual(tw.firstLeaves(tree, 2), ['b/1.js', 'b/2.js']);
  assert.deepEqual(tw.firstLeaves(tree, 99), ['b/1.js', 'b/2.js', 'a.js']);
  // Re-running is byte-identical — no hidden randomness.
  assert.deepEqual(tw.firstLeaves(tree, 2), tw.firstLeaves(tree, 2));
});

test('describeOption trims a large directory to direct children plus a leaf sample, and caps file exports', () => {
  const many = Array.from({ length: 50 }, (_, i) => `big/f${String(i).padStart(2, '0')}.js`);
  const tree = tw.buildTree([...many, 'small/one.js']);
  const caps = { ...tw.DEFAULT_CAPS, maxChildrenListed: 5, maxLeafSample: 3, maxExportsShown: 2, maxDescChars: 10000 };
  const bigDesc = tw.describeOption(tree.children.get('big'), caps);
  assert.match(bigDesc, /\(\+45 more\)/);
  assert.equal((bigDesc.match(/Sample leaves:/g) || []).length, 1);

  tw.attachExports(tree, new Map([['small/one.js', ['alpha', 'beta', 'gamma', 'delta']]]), caps.maxExportsShown);
  const fileDesc = tw.describeOption(tree.children.get('small').children.get('one.js'), caps);
  assert.match(fileDesc, /exports: alpha, beta \(\+2 more\)/);

  const noExportDesc = tw.describeOption(tree.children.get('big').children.get('f00.js'), caps);
  assert.match(noExportDesc, /no indexed exports/);
});

test('describeOption hard-truncates to maxDescChars', () => {
  const many = Array.from({ length: 300 }, (_, i) => `dir/f${i}.js`);
  const tree = tw.buildTree(many);
  const caps = { ...tw.DEFAULT_CAPS, maxChildrenListed: 300, maxDescChars: 40 };
  const desc = tw.describeOption(tree.children.get('dir'), caps);
  assert.equal(desc.length, 40);
  assert.ok(desc.endsWith('…'));
});

// ---------------------------------------------------------------------------
// Level-question construction and budget enforcement
// ---------------------------------------------------------------------------

test('buildLevelQuestions fans out one Choice per frontier entry with a none_of_these option', () => {
  const tree = tw.buildTree(['a.js', 'b/c.js', 'b/d.js']);
  const frontier = [
    { node: tree, score: 1, depth: 0 },
    { node: tree.children.get('b'), score: 0.5, depth: 1 },
  ];
  const { questions, optionMaps } = tw.buildLevelQuestions(frontier, 'find c', tw.DEFAULT_CAPS);
  assert.deepEqual(Object.keys(questions), ['q0', 'q1']);
  assert.equal(questions.q0.type, 'choice');
  assert.ok('none_of_these' in questions.q0.criteria);
  assert.equal(Object.keys(questions.q0.criteria).length, 3); // a.js, b, none_of_these
  assert.equal(Object.keys(questions.q1.criteria).length, 3); // c.js, d.js, none_of_these
  assert.equal(optionMaps[0].get('none_of_these'), null);
  assert.equal(optionMaps[1].get('opt0').path, 'b/c.js');
  assert.equal(questions.q0.instructions.query, 'find c');
  assert.equal(questions.q1.instructions.current_path, 'b');
});

test('buildLevelQuestions throws before any request when a node exceeds the 255-option Choice cap', () => {
  const many = Array.from({ length: 260 }, (_, i) => `big/f${i}.js`);
  const tree = tw.buildTree(many);
  const frontier = [{ node: tree.children.get('big'), score: 1, depth: 1 }];
  assert.throws(() => tw.buildLevelQuestions(frontier, 'q', tw.DEFAULT_CAPS), /255-option/);
});

test('checkBudget rejects requests over the documented state+questions and state+longest-question ceilings', () => {
  assert.doesNotThrow(() => tw.checkBudget({ query: 'short' }, { q0: { type: 'choice', criteria: { a: 'x' } } }));
  const hugeState = { query: 'x'.repeat(250000) }; // ~83k estimated tokens alone
  assert.throws(() => tw.checkBudget(hugeState, { q0: { type: 'choice', criteria: { a: 'x' } } }), /state\+questions/);
  const smallState = { query: 'q' };
  const hugeQuestion = { q0: { type: 'choice', criteria: { a: 'y'.repeat(150000) } } };
  assert.throws(() => tw.checkBudget(smallState, hugeQuestion), /state\+question\[q0\]/);
});

// ---------------------------------------------------------------------------
// expandFrontier / pruneTopB (pure scoring)
// ---------------------------------------------------------------------------

test('expandFrontier multiplies parent score by child probability and drops none_of_these', () => {
  const tree = tw.buildTree(['a.js', 'b.js']);
  const frontier = [{ node: tree, score: 0.5, depth: 0 }];
  const { questions, optionMaps } = tw.buildLevelQuestions(frontier, 'q', tw.DEFAULT_CAPS);
  const response = {
    answers: {
      q0: { type: 'choice', choice: 'opt0', confidence: 0.9, probabilities: { opt0: 0.6, opt1: 0.3, none_of_these: 0.1 } },
    },
  };
  const expanded = tw.expandFrontier(frontier, response, optionMaps);
  assert.equal(expanded.length, 2); // opt0, opt1 — none_of_these excluded
  const a = expanded.find((e) => e.node.name === 'a.js');
  assert.equal(a.score, 0.5 * 0.6);
  assert.equal(a.depth, 1);
});

test('pruneTopB keeps the highest-scoring B candidates, tie-broken by path', () => {
  const cands = [
    { node: { path: 'z' }, score: 0.5 },
    { node: { path: 'a' }, score: 0.5 },
    { node: { path: 'b' }, score: 0.9 },
  ];
  assert.deepEqual(tw.pruneTopB(cands, 2).map((c) => c.node.path), ['b', 'a']);
  assert.deepEqual(tw.pruneTopB(cands, 1).map((c) => c.node.path), ['b']);
});

// ---------------------------------------------------------------------------
// walkBeam — scripted round trips
// ---------------------------------------------------------------------------

test('walkBeam=1 is a greedy single path and yields at most one result (no backfill)', async () => {
  const tree = tw.buildTree(['a/target.js', 'a/other.js', 'b/decoy.js']);
  const client = scriptedClient(tree, { '': 'a', a: 'target.js' });
  const walk = await tw.walkBeam(client, tw.MODEL, tree, 'find target', 1);
  assert.deepEqual(walk.ranking, ['a/target.js']);
  assert.equal(walk.results.length, 1);
  assert.equal(walk.requests, 2); // one Choice per level: root, then 'a'
  assert.equal(walk.beamWidth, 1);
  assert.ok(walk.inputTokens > 0);
  assert.deepEqual(walk.models, [tw.MODEL]);
});

test('walkBeam=2 fans multiple active beams into one request per level', async () => {
  const tree = tw.buildTree(['a/hit.js', 'a/miss.js', 'b/other.js']);
  // Both root children ('a', 'b') survive into a beam of width 2, so level 2
  // must ask about BOTH — fanned into one request with 2 questions, and
  // both resolve straight to files (their only children), ending the walk.
  const client = scriptedClient(tree, { '': 'a', a: 'hit.js', b: 'other.js' }, { favoriteProb: 0.9 });
  let requestSizes = [];
  const wrapped = {
    async systemOne(req) {
      requestSizes.push(Object.keys(req.questions).length);
      return client.systemOne(req);
    },
  };
  const walk = await tw.walkBeam(wrapped, tw.MODEL, tree, 'find hit', 2);
  assert.deepEqual(requestSizes, [1, 2]);
  assert.ok(walk.results.length >= 1);
});

test('walkBeam reports both a product-score ranking and a geometric-mean ranking, neither claimed calibrated', async () => {
  const tree = tw.buildTree(['a/target.js', 'b/other.js']);
  const client = scriptedClient(tree, { '': 'a' });
  const walk = await tw.walkBeam(client, tw.MODEL, tree, 'q', 1);
  assert.deepEqual(walk.ranking, ['a/target.js']);
  assert.deepEqual(walk.rankingByGeomMean, ['a/target.js']);
});

test('walkBeam surfaces a validateResponse contract violation instead of silently accepting a malformed answer', async () => {
  const tree = tw.buildTree(['a.js', 'b.js']);
  const badClient = { async systemOne({ model, questions }) {
    return { model, usage: { input_tokens: 10, output_tokens: 1 },
      answers: { q0: { type: 'choice', choice: 'opt0', confidence: 0.5, probabilities: { opt0: 0.9, opt1: 0.05, none_of_these: 0.05 } } } };
  } };
  // probabilities sum to 1.0 here but choice 'opt0' is fine — now break it: make probabilities not sum to 1.
  const reallyBadClient = { async systemOne({ model }) {
    return { model, usage: { input_tokens: 10, output_tokens: 1 },
      answers: { q0: { type: 'choice', choice: 'opt0', confidence: 0.5, probabilities: { opt0: 0.9, opt1: 0.9, none_of_these: 0.9 } } } };
  } };
  await assert.rejects(tw.walkBeam(reallyBadClient, tw.MODEL, tree, 'q', 1), /sum to one/);
});

test('walkBeam throws (never silently truncates) when the request would exceed the token budget, before spending a request', async () => {
  const many = Array.from({ length: 40 }, (_, i) => `dir/${'x'.repeat(3000)}${i}.js`);
  const tree = tw.buildTree(many);
  let calls = 0;
  const client = { async systemOne() { calls += 1; throw new Error('must not be called'); } };
  await assert.rejects(tw.walkBeam(client, tw.MODEL, tree, 'q', 4, { ...tw.DEFAULT_CAPS, maxChildrenListed: 40, maxDescChars: 100000 }));
  assert.equal(calls, 0);
});

test('a real JevClient (mocked fetch, full wire validation) accepts a built level request end to end', async () => {
  const tree = tw.buildTree(['a/target.js', 'b/other.js']);
  const client = new JevClient({
    apiKey: 'test-key',
    fetch: async (url, opts) => {
      const body = JSON.parse(opts.body);
      assert.equal(body.model, tw.MODEL);
      const answers = {};
      for (const [qKey, q] of Object.entries(body.questions)) {
        const keys = Object.keys(q.criteria);
        answers[qKey] = { type: 'choice', choice: keys[0], confidence: 0.7, probabilities: evenProbs(keys, keys[0], 0.8) };
      }
      return Response.json({ model: tw.MODEL, usage: { input_tokens: 50, output_tokens: 5 }, answers });
    },
  });
  const walk = await tw.walkBeam(client, tw.MODEL, tree, 'find target', 1);
  // Root's children are directories ('a', 'b'), each holding one file, so a
  // greedy beam=1 walk needs two levels (pick 'a', then pick its file) to
  // reach a leaf.
  assert.equal(walk.requests, 2);
  assert.equal(walk.ranking.length, 1);
});

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

function fakeDb() {
  const dir = tmpDir('graph-arm');
  fs.mkdirSync(path.join(dir, '.planning', 'intel'), { recursive: true });
  return { dir };
}

test('graphArm ranks by graphRetrieve and reports an empty ranking as the "graph found nothing" signal', async () => {
  const { dir } = fakeDb();
  const db = await graph.loadDb(dir);
  graph.upsertFile(db, { relPath: 'lib/resolver.js', type: 'js', sizeBytes: 100, mtimeMs: 1 });
  graph.replaceExports(db, 'lib/resolver.js', [{ name: 'resolveImport', kind: 'named' }]);
  const hit = tw.graphArm(db, 'where is resolveImport defined', 5);
  assert.deepEqual(hit.ranking, ['lib/resolver.js']);
  const miss = tw.graphArm(db, 'zzz nonexistent qqq symbol', 5);
  assert.deepEqual(miss.ranking, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('randomControlArm draws up to k distinct files deterministically from a seeded rng', () => {
  const { makeRng } = require('../../lib/trajectory');
  const pool = ['a', 'b', 'c', 'd', 'e'];
  const picked = tw.randomControlArm(pool, makeRng(1), 3);
  assert.equal(picked.length, 3);
  assert.equal(new Set(picked).size, 3);
  assert.deepEqual(tw.randomControlArm(pool, makeRng(1), 3), picked); // reproducible
  assert.deepEqual(tw.randomControlArm(['only'], makeRng(1), 5), ['only']); // never exceeds pool size
});

test('combinedArm prefers a non-empty graph ranking and falls back to tree-walk only when graph is empty', () => {
  assert.deepEqual(tw.combinedArm(['g1', 'g2'], ['t1']), ['g1', 'g2']);
  assert.deepEqual(tw.combinedArm([], ['t1']), ['t1']);
  assert.deepEqual(tw.combinedArm([], []), []);
});

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

test('hitAtK checks membership within the top-k slice only', () => {
  assert.equal(tw.hitAtK(['a', 'b', 'c'], ['c'], 5), true);
  assert.equal(tw.hitAtK(['a', 'b', 'c'], ['c'], 2), false);
  assert.equal(tw.hitAtK([], ['c'], 5), false);
});

test('wilsonInterval brackets the point estimate and handles n=0 and boundary rates honestly', () => {
  const mid = tw.wilsonInterval(5, 10);
  assert.ok(mid.lo < 0.5 && mid.hi > 0.5);
  assert.equal(mid.rate, 0.5);
  const zero = tw.wilsonInterval(0, 0);
  assert.equal(zero.n, 0);
  assert.equal(zero.lo, null);
  const allHits = tw.wilsonInterval(3, 3);
  assert.ok(allHits.hi <= 1 && allHits.hi > 0.5);
  assert.throws(() => tw.wilsonInterval(4, 3), /0 <= successes <= n/);
  assert.throws(() => tw.wilsonInterval(1.5, 3), /integers/);
});

// ---------------------------------------------------------------------------
// Dataset: PHI/length/basename filters and hook-injection detection
// ---------------------------------------------------------------------------

test('isDisallowedPrompt catches email, phone, "patient", and "somanotes" but not ordinary code prompts', () => {
  assert.equal(tw.isDisallowedPrompt('contact me at a@b.com please'), true);
  assert.equal(tw.isDisallowedPrompt('call 555-123-4567 about this'), true);
  assert.equal(tw.isDisallowedPrompt('the Patient record schema needs a fix'), true);
  assert.equal(tw.isDisallowedPrompt('check somaNotes integration'), true);
  assert.equal(tw.isDisallowedPrompt('fix the resolveImport function in lib/resolver.js'), false);
});

test('recordIsHookInjection recognizes both the legacy string-content schema and the current hook_additional_context array schema', () => {
  const legacy = { type: 'attachment', attachment: { content: 'prose <codebase-retrieval>\n- `a.js`\n</codebase-retrieval>' } };
  assert.equal(tw.recordIsHookInjection(legacy), true);
  const current = { type: 'attachment', attachment: { type: 'hook_additional_context', hookName: 'UserPromptSubmit', content: ['unrelated', '<codebase-intelligence>stuff</codebase-intelligence>'] } };
  assert.equal(tw.recordIsHookInjection(current), true);
  const unrelatedHook = { type: 'attachment', attachment: { type: 'hook_additional_context', hookName: 'SessionStart', content: ['just a reminder'] } };
  assert.equal(tw.recordIsHookInjection(unrelatedHook), false);
  assert.equal(tw.recordIsHookInjection({ type: 'user' }), false);
  assert.equal(tw.recordIsHookInjection(null), false);
});

test('isRealPrompt requires string content on a non-sidechain user record (tool_result turns and subagent turns are excluded)', () => {
  assert.equal(tw.isRealPrompt({ type: 'user', message: { content: 'hello there this is real' } }), true);
  assert.equal(tw.isRealPrompt({ type: 'user', message: { content: [{ type: 'tool_result' }] } }), false);
  assert.equal(tw.isRealPrompt({ type: 'user', isSidechain: true, message: { content: 'sub-agent turn' } }), false);
  assert.equal(tw.isRealPrompt({ type: 'assistant', message: { content: 'x' } }), false);
});

test('toRel normalizes an absolute path under cwd and returns null outside it', () => {
  assert.equal(tw.toRel('/root/sextant', '/root/sextant/lib/a.js'), 'lib/a.js');
  assert.equal(tw.toRel('/root/sextant', '/root/sextant'), '');
  assert.equal(tw.toRel('/root/sextant', '/tmp/outside.js'), null);
  assert.equal(tw.toRel('/root/sextant', 42), null);
});

test('collectPromptCandidates correlates each real prompt with hook injection and opens up to the next real prompt', () => {
  const records = [
    { cwd: '/repo' },
    { type: 'user', message: { content: 'first real prompt about resolveImport function please' }, timestamp: 't1' },
    { type: 'attachment', attachment: { type: 'hook_additional_context', hookName: 'UserPromptSubmit', content: ['<codebase-retrieval>\n- `lib/a.js`\n</codebase-retrieval>'] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/repo/lib/a.js' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result' }] } }, // NOT a real prompt — must not reset the window
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/repo/lib/b.js' } }] } },
    { type: 'user', message: { content: 'second real prompt, totally different ask here' }, timestamp: 't2' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/lib/c.js' } }] } },
  ];
  const out = tw.collectPromptCandidates(records);
  assert.equal(out.length, 2);
  assert.equal(out[0].hookInjected, true);
  assert.deepEqual(out[0].rawOpens, ['/repo/lib/a.js', '/repo/lib/b.js']); // spans across the tool_result pseudo-user record
  assert.equal(out[1].hookInjected, false);
  assert.deepEqual(out[1].rawOpens, ['/repo/lib/c.js']);
});

test('deriveLabels keeps only walkable-tree, deduped, chronological opens, capped at 3', () => {
  const walkable = new Set(['lib/a.js', 'lib/c.js']);
  const labels = tw.deriveLabels(
    ['/repo/lib/a.js', '/repo/lib/a.js', '/repo/outside-tree.js', '/repo/lib/c.js', '/repo/lib/d.js', '/repo/lib/e.js'],
    '/repo',
    walkable
  );
  assert.deepEqual(labels, ['lib/a.js', 'lib/c.js']); // 'outside-tree.js', 'd.js', 'e.js' excluded/never reached cap
});

test('buildDatasetCandidates drops short/PHI/label-basename-leaking/unlabeled prompts and separates strict vs fallback pools', () => {
  const walkable = new Set(['lib/resolver.js']);
  const candidates = [
    { text: 'too short', hookInjected: true, wouldRetrieve: true, rawOpens: ['/repo/lib/resolver.js'], cwd: '/repo', ts: null, recordIndex: 0 },
    { text: 'contact me at a@b.com about resolveImport', hookInjected: true, wouldRetrieve: true, rawOpens: ['/repo/lib/resolver.js'], cwd: '/repo', ts: null, recordIndex: 1 },
    { text: 'please open resolver.js and fix the bug there', hookInjected: true, wouldRetrieve: true, rawOpens: ['/repo/lib/resolver.js'], cwd: '/repo', ts: null, recordIndex: 2 }, // leaks basename
    { text: 'neither hook fired nor classifier would retrieve on this', hookInjected: false, wouldRetrieve: false, rawOpens: ['/repo/lib/resolver.js'], cwd: '/repo', ts: null, recordIndex: 3 },
    { text: 'fix the import resolution logic please, it is broken', hookInjected: true, wouldRetrieve: true, rawOpens: ['/repo/lib/resolver.js'], cwd: '/repo', ts: null, recordIndex: 4 },
    { text: 'classifier only would fire on this one about symbols', hookInjected: false, wouldRetrieve: true, rawOpens: ['/repo/lib/resolver.js'], cwd: '/repo', ts: null, recordIndex: 5 },
    { text: 'hook fired but nothing usable got opened afterward at all', hookInjected: true, wouldRetrieve: true, rawOpens: [], cwd: '/repo', ts: null, recordIndex: 6 },
  ];
  const { strict, all } = tw.buildDatasetCandidates(candidates, walkable);
  assert.deepEqual(strict.map((c) => c.text), ['fix the import resolution logic please, it is broken']);
  assert.deepEqual(all.map((c) => c.text).sort(), ['classifier only would fire on this one about symbols', 'fix the import resolution logic please, it is broken'].sort());
});

test('seededSample is deterministic under a fixed seed and returns the whole pool under the cap', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ id: i }));
  assert.deepEqual(tw.seededSample(items, 100, 1), items);
  const a = tw.seededSample(items, 3, 42).map((i) => i.id);
  const b = tw.seededSample(items, 3, 42).map((i) => i.id);
  assert.deepEqual(a, b);
  assert.equal(a.length, 3);
  assert.equal(new Set(a).size, 3);
});

test('loadDatasetFromProjects reads only top-level *.jsonl (no subagents/ recursion) and reports strict-vs-fallback pool sizes', () => {
  const dir = tmpDir('projects');
  const cwd = '/repo';
  const line = (obj) => JSON.stringify(obj) + '\n';
  fs.writeFileSync(
    path.join(dir, 'session.jsonl'),
    [
      { cwd },
      {
        type: 'user',
        message: { content: 'please locate the resolveImport function for me now' },
        timestamp: 't1',
      },
      {
        type: 'attachment',
        attachment: { type: 'hook_additional_context', hookName: 'UserPromptSubmit', content: ['<codebase-retrieval>\n- `lib/resolver.js`\n</codebase-retrieval>'] },
      },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/repo/lib/resolver.js' } }] } },
    ]
      .map(line)
      .join('')
  );
  // A nested "subagents" dir must be ignored even if it also holds a .jsonl file.
  fs.mkdirSync(path.join(dir, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'subagents', 'child.jsonl'), line({ type: 'user', message: { content: 'x'.repeat(50) } }));

  const dataset = tw.loadDatasetFromProjects(dir, new Set(['lib/resolver.js']), { cap: 120, seed: 1 });
  assert.equal(dataset.sessionsScanned, 1);
  assert.equal(dataset.tasks.length, 1);
  assert.equal(dataset.usedFallback, false);
  assert.deepEqual(dataset.tasks[0].labels.relevantFiles, ['lib/resolver.js']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadDatasetFromProjects falls back to the classifier-would-retrieve pool when no strict hook-injected prompt qualifies', () => {
  const dir = tmpDir('projects-fallback');
  const line = (obj) => JSON.stringify(obj) + '\n';
  fs.writeFileSync(
    path.join(dir, 'session.jsonl'),
    [
      { cwd: '/repo' },
      { type: 'user', message: { content: 'please locate the resolveImport function for me now' }, timestamp: 't1' },
      // no attachment at all — hook never fired
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/repo/lib/resolver.js' } }] } },
    ]
      .map(line)
      .join('')
  );
  const dataset = tw.loadDatasetFromProjects(dir, new Set(['lib/resolver.js']), { cap: 120, seed: 1 });
  assert.equal(dataset.strictPoolSize, 0);
  assert.equal(dataset.usedFallback, true);
  assert.equal(dataset.tasks.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Dataset: git history (second, primary query source)
// ---------------------------------------------------------------------------

test('isLabelEligiblePath matches only lib/, commands/, mcp/, bin/, scripts/, and watch.js', () => {
  assert.equal(tw.isLabelEligiblePath('lib/graph.js'), true);
  assert.equal(tw.isLabelEligiblePath('commands/hook-refresh.js'), true);
  assert.equal(tw.isLabelEligiblePath('mcp/server.js'), true);
  assert.equal(tw.isLabelEligiblePath('bin/intel.js'), true);
  assert.equal(tw.isLabelEligiblePath('scripts/eval-retrieve.js'), true);
  assert.equal(tw.isLabelEligiblePath('watch.js'), true);
  assert.equal(tw.isLabelEligiblePath('test/graph-retrieve.test.js'), false);
  assert.equal(tw.isLabelEligiblePath('docs/001-x.md'), false);
  assert.equal(tw.isLabelEligiblePath('README.md'), false);
  assert.equal(tw.isLabelEligiblePath('libnotreal/x.js'), false); // prefix must end at a path segment
});

test('buildGitHistoryCandidates filters pure docs/test commits, >8-file commits, missing-at-HEAD labels, and basename/export leaks', () => {
  const walkable = new Set(['lib/resolver.js', 'lib/other.js']);
  const noExports = () => [];
  const commits = [
    { hash: 'h1', files: ['docs/plan.md', 'test/x.test.js'] }, // pure docs/test — no label-eligible files
    { hash: 'h2', files: ['lib/resolver.js', 'README.md'] }, // real candidate
    { hash: 'h3', files: Array.from({ length: 9 }, (_, i) => `lib/f${i}.js`) }, // >8 label files — too broad
    { hash: 'h4', files: ['lib/deleted-later.js'] }, // label-eligible but not walkable at HEAD
    { hash: 'h5', files: ['lib/other.js'] }, // basename leak in subject
  ];
  const messages = new Map([
    ['h1', { subject: 'update docs', body: '' }],
    ['h2', { subject: 'fix import resolution', body: 'closes a bug in the resolver' }],
    ['h3', { subject: 'sweep', body: '' }],
    ['h4', { subject: 'remove a stale helper', body: '' }],
    ['h5', { subject: 'fix bug in other.js handling', body: '' }],
  ]);
  const out = tw.buildGitHistoryCandidates(commits, messages, walkable, noExports);
  assert.deepEqual(out.map((c) => c.hash), ['h2']);
  assert.deepEqual(out[0].labels, ['lib/resolver.js']);
  // subject alone is under 40 chars, so the body's first line is appended.
  assert.equal(out[0].text, 'fix import resolution closes a bug in the resolver');
});

test('buildGitHistoryCandidates also excludes on an exported symbol name leak, guarded by a minimum term length', () => {
  const walkable = new Set(['lib/resolver.js']);
  const exportNamesOf = (p) => (p === 'lib/resolver.js' ? ['resolveImport', 'x'] : []);
  const commits = [{ hash: 'h1', files: ['lib/resolver.js'] }];
  const messages = new Map([['h1', { subject: 'teach resolveImport to follow symlinks', body: '' }]]);
  assert.deepEqual(tw.buildGitHistoryCandidates(commits, messages, walkable, exportNamesOf), []);
  // A 1-char export name ('x') must not itself trigger the leak guard via a coincidental substring hit.
  const messages2 = new Map([['h1', { subject: 'fix xylophone rendering edge case', body: '' }]]);
  const out2 = tw.buildGitHistoryCandidates(commits, messages2, walkable, exportNamesOf);
  assert.equal(out2.length, 1);
});

test('buildGitHistoryCandidates appends the body first line when the subject is short', () => {
  const walkable = new Set(['lib/a.js']);
  const commits = [{ hash: 'h1', files: ['lib/a.js'] }];
  const messages = new Map([['h1', { subject: 'fix bug', body: '\nThe root cause was a stale cache entry.\nmore detail here.' }]]);
  const out = tw.buildGitHistoryCandidates(commits, messages, walkable, () => []);
  assert.equal(out[0].text, 'fix bug The root cause was a stale cache entry.');
});

test('parseGitLogMessages and parseGitLogFiles read a real temp repo end to end and join by commit hash', () => {
  const root = buildFixtureRepo();
  try {
    const messages = tw.parseGitLogMessages(root);
    const commits = tw.parseGitLogFiles(root);
    assert.equal(commits.length, 1);
    assert.deepEqual(commits[0].files.sort(), ['README.md', 'lib/other.js', 'lib/resolver.js']);
    const msg = messages.get(commits[0].hash);
    assert.equal(msg.subject, 'fixture');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadGitHistoryDataset wires the real git log + graph export lookup into buildGitHistoryCandidates and caps/samples deterministically', async () => {
  const root = buildFixtureRepo();
  const { dir } = fakeDb();
  try {
    const db = await graph.loadDb(dir);
    graph.replaceExports(db, 'lib/resolver.js', [{ name: 'resolveImport', kind: 'named' }]);
    const walkable = new Set(['lib/resolver.js', 'lib/other.js']);
    const dataset = tw.loadGitHistoryDataset(root, db, walkable, { cap: 120, seed: 1 });
    assert.equal(dataset.commitsTotal, 1);
    assert.equal(dataset.tasks.length, 1);
    assert.equal(dataset.tasks[0].id, 'g0');
    assert.deepEqual(dataset.tasks[0].labels.relevantFiles.sort(), ['lib/other.js', 'lib/resolver.js']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// runArms / buildReport / summarizeArm
// ---------------------------------------------------------------------------

test('buildReport splits overall vs the empty-graph subset and excludes skipped arms from the denominator, not as misses', () => {
  const rows = [
    {
      id: 'q0', query: 'x', labels: ['lib/a.js'], graphEmpty: false,
      arms: {
        graph: { ranking: ['lib/a.js'] },
        beam1: { requests: 3, inputTokens: 300, outputTokens: 10, wallMs: 50, ranking: ['lib/b.js'] },
        beam2: { skipped: true, reason: 'dry run' },
        beam4: { skipped: true, reason: 'dry run' },
        random: { ranking: ['lib/z.js'] },
        combined: { ranking: ['lib/a.js'] },
      },
    },
    {
      id: 'q1', query: 'y', labels: ['lib/c.js'], graphEmpty: true,
      arms: {
        graph: { ranking: [] },
        beam1: { requests: 2, inputTokens: 150, outputTokens: 8, wallMs: 40, ranking: ['lib/c.js'] },
        beam2: { skipped: true, reason: 'dry run' },
        beam4: { skipped: true, reason: 'dry run' },
        random: { ranking: ['lib/q.js'] },
        combined: { ranking: ['lib/c.js'] },
      },
    },
  ];
  const report = tw.buildReport(rows);
  assert.equal(report.tasksTotal, 2);
  assert.equal(report.tasksGraphEmpty, 1);
  assert.equal(report.overall.graph.hit1At.n, 2);
  assert.equal(report.overall.graph.hit1At.rate, 0.5); // hit on q0 only
  assert.equal(report.overall.beam2.hit1At.n, 0); // both skipped — excluded, not scored as miss
  assert.equal(report.emptyGraphSubset.combined.hit1At.n, 1);
  assert.equal(report.emptyGraphSubset.combined.hit1At.rate, 1); // combined fell back to beam1's hit on the empty-graph row
  assert.equal(report.cost.requests, 5); // sums only the non-skipped beam arms' own request counts (3 + 2)
  assert.equal(report.cost.inputTokens, 450);
});

test('runArms wires arm (d) to fall back to the beam-4 tree-walk ranking exactly when arm (a) graph is empty', async () => {
  const tree = tw.buildTree(['a/target.js', 'b/other.js']);
  const { dir } = fakeDb();
  const db = await graph.loadDb(dir); // empty graph — every query misses
  const client = scriptedClient(tree, { '': 'a' });
  const tasks = [{ id: 'q0', query: 'find target please now', labels: { relevantFiles: ['a/target.js'], topK: 5 } }];
  const rows = await tw.runArms(tasks, { db, tree, walkableFiles: ['a/target.js', 'b/other.js'] }, { mode: 'live', client, model: tw.MODEL, seed: 1 });
  assert.equal(rows[0].graphEmpty, true);
  assert.deepEqual(rows[0].arms.combined.ranking, rows[0].arms.beam4.ranking);
  assert.ok(rows[0].arms.beam4.ranking.length > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runArms marks all beam arms skipped in dry mode with zero client calls', async () => {
  const tree = tw.buildTree(['a/target.js']);
  const { dir } = fakeDb();
  const db = await graph.loadDb(dir);
  let calls = 0;
  const client = { async systemOne() { calls += 1; throw new Error('must not be called in dry mode'); } };
  const tasks = [{ id: 'q0', query: 'find target please', labels: { relevantFiles: ['a/target.js'], topK: 5 } }];
  const rows = await tw.runArms(tasks, { db, tree, walkableFiles: ['a/target.js'] }, { mode: 'dry', client, model: tw.MODEL, seed: 1 });
  assert.equal(calls, 0);
  assert.equal(rows[0].arms.beam1.skipped, true);
  assert.equal(rows[0].arms.beam4.skipped, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Full run() — dry and live (mocked), real disposable snapshot + real transcripts
// ---------------------------------------------------------------------------

function buildFixtureRepo() {
  const root = tmpDir('repo');
  initGitRepo(root);
  writeFile(root, 'lib/resolver.js', 'function resolveImport() { return 1; }\nmodule.exports = { resolveImport };\n');
  writeFile(root, 'lib/other.js', 'function unrelatedHelper() { return 2; }\nmodule.exports = { unrelatedHelper };\n');
  writeFile(root, 'README.md', '# fixture repo\n');
  commitAll(root, 'fixture');
  return root;
}

function buildFixtureProjectsDir(root, { hookInjected } = { hookInjected: true }) {
  const dir = tmpDir('projects-e2e');
  const line = (obj) => JSON.stringify(obj) + '\n';
  const records = [
    { cwd: root },
    { type: 'user', message: { content: 'please help me find the resolveImport implementation now' }, timestamp: 't1' },
  ];
  if (hookInjected) {
    records.push({
      type: 'attachment',
      attachment: { type: 'hook_additional_context', hookName: 'UserPromptSubmit', content: ['<codebase-retrieval>\n- `lib/resolver.js`\n</codebase-retrieval>'] },
    });
  }
  records.push({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: path.join(root, 'lib/resolver.js') } }] } });
  fs.writeFileSync(path.join(dir, 'session.jsonl'), records.map(line).join(''));
  return dir;
}

test('run() in dry mode builds a real disposable snapshot+tree+dataset, writes 0600 artifacts, and spends nothing', async (t) => {
  const root = buildFixtureRepo();
  const projectsDir = buildFixtureProjectsDir(root);
  const out = path.join(tmpDir('out'), 'run');
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(projectsDir, { recursive: true, force: true }); fs.rmSync(path.dirname(out), { recursive: true, force: true }); });

  const result = await tw.run(root, out, { mode: 'dry', projectsDir, seed: 1, cap: 10 });
  // 1 transcript task + 1 git-history task (the fixture repo's own single "fixture" commit, which touches lib/resolver.js + lib/other.js).
  assert.equal(result.report.overall.tasksTotal, 2);
  assert.equal(result.report.transcript.tasksTotal, 1);
  assert.equal(result.report.gitHistory.tasksTotal, 1);
  assert.equal(result.rows[0].source, 'transcript');
  assert.deepEqual(result.rows[0].labels, ['lib/resolver.js']);
  assert.equal(result.rows[0].arms.beam1.skipped, true);
  assert.equal(result.rows[1].source, 'git-history');
  assert.deepEqual(result.rows[1].labels.sort(), ['lib/other.js', 'lib/resolver.js']);

  for (const f of ['manifest.json', 'tasks.json', 'rows.json', 'report.json']) {
    const stat = fs.statSync(path.join(out, f));
    assert.equal(stat.mode & 0o777, 0o600, f);
  }
  assert.equal(fs.statSync(out).mode & 0o777, 0o700);
});

test('run() in live mode (mocked client) actually calls the beam walk and can resolve the target via arm (b) when arm (a) graph is empty', async (t) => {
  const root = buildFixtureRepo();
  const projectsDir = buildFixtureProjectsDir(root);
  const out = path.join(tmpDir('out'), 'run');
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(projectsDir, { recursive: true, force: true }); fs.rmSync(path.dirname(out), { recursive: true, force: true }); });

  // A query with no matching export/path term forces arm (a) empty, so arm
  // (d) must lean on the tree-walk. The scripted client still steers
  // toward the labeled file regardless of query wording (mock, not real
  // semantics) — this test proves the WIRING, not model quality.
  const tree = tw.buildTree(['lib/resolver.js', 'lib/other.js', 'README.md']);
  const client = scriptedClient(tree, { '': 'lib' });
  const result = await tw.run(root, out, { mode: 'live', projectsDir, client, seed: 1, cap: 10 });

  const row = result.rows[0];
  assert.equal(row.arms.beam1.skipped, undefined);
  assert.ok(row.arms.beam1.requests > 0);
  assert.equal(result.report.overall.cost.requests > 0, true);
  if (row.graphEmpty) assert.deepEqual(row.arms.combined.ranking, row.arms.beam4.ranking);
});
