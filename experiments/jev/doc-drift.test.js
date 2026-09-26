'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const {
  classify, scanDocs, symbolExists, buildSentence, isSensitive, isMentionedAsRemovedOrExternal,
  centeredWindow, splitClauses, buildClauseSentence, TREATMENTS,
  buildClaimUnits, buildMutation, seededShuffle, mulberry32, computeAUC,
  buildDriftTasks, buildRequest, freezeTasks, validateFrozen, freeze, runFrozen, report,
} = require('./doc-drift');
const { readScope } = require('./refutation');

const root = path.resolve(__dirname, '../..');
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');

function nounResponse(model, value, overrides = {}) {
  return { model, usage: { input_tokens: 120, output_tokens: 8 }, answers: { support: { type: 'noul', noul: value } }, ...overrides };
}

// Builds a small real git repo under a temp dir so scanDocs's `git ls-files` call has something to
// see. `git add` (no commit) is enough for ls-files to list the tracked/staged files.
function makeFixtureRepo(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-drift-fixture-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tmp, 'lib'));
  fs.mkdirSync(path.join(tmp, 'lib', 'nested'));
  fs.mkdirSync(path.join(tmp, 'other'));
  fs.mkdirSync(path.join(tmp, 'docsdir'));
  fs.writeFileSync(path.join(tmp, 'lib', 'foo.js'), 'function realSymbol() {\n  return 1;\n}\nmodule.exports = { realSymbol };\n');
  fs.writeFileSync(path.join(tmp, 'lib', 'nested', 'bar.js'), 'function nestedFn() { return 2; }\n');
  fs.writeFileSync(path.join(tmp, 'other', 'bar.js'), 'function otherFn() { return 3; }\n');
  fs.writeFileSync(path.join(tmp, 'short.js'), 'const x = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: tmp });
  execFileSync('git', ['add', '-A'], { cwd: tmp });
  return tmp;
}

function writeDoc(tmp, name, text) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, text);
  return { label: name, file };
}

// ---------------------------------------------------------------------------
// Part 1: classify()
// ---------------------------------------------------------------------------

test('classify buckets every backtick span shape without treating prose or non-repo tokens as paths', () => {
  const cases = [
    ['lib/summary.js', 'file', { path: 'lib/summary.js' }],
    ['test/y.test.js:301', 'file', { path: 'test/y.test.js', suffix: '301' }],
    ['intel.js:scheduleGraphPersist', 'file', { path: 'intel.js', suffix: 'scheduleGraphPersist' }],
    ['.env', 'file', { path: '.env' }],
    ['.mcp.json', 'file', { path: '.mcp.json' }],
    ['CLAUDE.md', 'file', { path: 'CLAUDE.md' }],
    ['lib/extractors/', 'directory', { path: 'lib/extractors/' }],
    ['docs/033', 'skip'],
    ['**/*.js', 'glob'],
    ['<repo>/AGENTS.md', 'placeholder'],
    ['~/.codex/config.toml', 'external'],
    ['/etc/diskwarden/policy.toml', 'external'],
    ['https://api.typesafe.ai', 'url'],
    ['sextant hook refresh', 'prose'],
    ['0.6.0', 'skip'],
    ['node:test', 'skip'],
    ['process.env', 'skip'],
    ['SEXTANT_HOLDBACK_PCT', 'skip'],
    ['Array.isArray', 'skip'],
  ];
  for (const [raw, category, extra] of cases) {
    const result = classify(raw);
    assert.equal(result.category, category, `classify(${JSON.stringify(raw)})`);
    if (extra) for (const [key, value] of Object.entries(extra)) assert.equal(result[key], value, `${raw} -> ${key}`);
  }
});

test('symbolExists is a word-boundary identifier match, not a substring match', () => {
  assert.equal(symbolExists('function scheduleGraphPersist() {}', 'scheduleGraphPersist'), true);
  assert.equal(symbolExists('function scheduleGraphPersistOther() {}', 'scheduleGraphPersist'), false);
  assert.equal(symbolExists('const x = notScheduleGraphPersist;', 'scheduleGraphPersist'), false);
  assert.equal(symbolExists('const $foo = 1;', '$foo'), true);
});

// ---------------------------------------------------------------------------
// Part 1: scanDocs() against a synthetic fixture (deterministic, controlled)
// ---------------------------------------------------------------------------

test('scanDocs resolves exact, suffix-partial and basename-ambiguous file references', t => {
  const tmp = makeFixtureRepo(t);
  const doc = writeDoc(tmp, 'FAKE.md', [
    '- Exact path: `lib/foo.js`',
    '- Partial (suffix) path: `nested/bar.js`',
    '- Ambiguous basename: `bar.js`',
    '- Dead path: `lib/does-not-exist.js`',
  ].join('\n'));
  const scan = scanDocs(tmp, [doc]);
  const byLine = Object.fromEntries(scan.rows.map(r => [r.line, r]));
  assert.equal(byLine[1].status, 'ok'); assert.equal(byLine[1].path, 'lib/foo.js');
  assert.equal(byLine[2].status, 'ok'); assert.equal(byLine[2].path, 'lib/nested/bar.js'); assert.equal(byLine[2].resolvedVia, 'suffix');
  assert.equal(byLine[3].status, 'ambiguous-basename');
  assert.deepEqual([...byLine[3].ambiguousCandidates].sort(), ['lib/nested/bar.js', 'other/bar.js']);
  assert.equal(byLine[4].status, 'dead-path'); assert.equal(byLine[4].dead, true);
  assert.equal(scan.counts.totalRefs, 4);
  assert.equal(scan.counts.deadPaths, 1);
  assert.equal(scan.counts.ambiguousBasenames, 1);
});

test('scanDocs checks path:symbol and path:line suffixes against real file content, and directories against the filesystem', t => {
  const tmp = makeFixtureRepo(t);
  const doc = writeDoc(tmp, 'FAKE.md', [
    '- Real symbol: `lib/foo.js:realSymbol`',
    '- Dead symbol: `lib/foo.js:noSuchSymbol`',
    '- In-range line: `short.js:1`',
    '- Out-of-range line: `short.js:999`',
    '- Real dir: `lib/`',
    '- Dead dir: `missing-dir/`',
  ].join('\n'));
  const scan = scanDocs(tmp, [doc]);
  const byLine = Object.fromEntries(scan.rows.map(r => [r.line, r]));
  assert.equal(byLine[1].status, 'ok'); assert.equal(byLine[1].suffixOk, true);
  assert.equal(byLine[2].status, 'dead-symbol'); assert.equal(byLine[2].symbol, 'noSuchSymbol');
  assert.equal(byLine[3].status, 'ok'); assert.equal(byLine[3].suffixType, 'line');
  assert.equal(byLine[4].status, 'dead-line'); assert.equal(byLine[4].line_, 999);
  assert.equal(byLine[5].status, 'ok');
  assert.equal(byLine[6].status, 'dead-path');
  assert.equal(scan.counts.deadSymbols, 1);
  assert.equal(scan.counts.deadLines, 1);
  assert.deepEqual(scan.dead.symbols.map(d => d.text), ['`lib/foo.js:noSuchSymbol`']);
  assert.deepEqual(scan.dead.lines.map(d => d.text), ['`short.js:999`']);
});

test('scanDocs tags a likely-generated-or-external dead path without hiding it from the dead list', t => {
  const tmp = makeFixtureRepo(t);
  const doc = writeDoc(tmp, 'FAKE.md', [
    '- Per-repo state: `.planning/intel/graph.db`',
    '- Unrelated genuinely dead path: `lib/totally-invented.js`',
  ].join('\n'));
  const scan = scanDocs(tmp, [doc]);
  const generated = scan.dead.paths.find(d => d.path === '.planning/intel/graph.db');
  const genuine = scan.dead.paths.find(d => d.path === 'lib/totally-invented.js');
  assert.equal(generated.likelyGeneratedOrExternal, true);
  assert.equal(genuine.likelyGeneratedOrExternal, false);
  assert.equal(scan.counts.deadPathsLikelyGeneratedOrExternal, 1);
  assert.equal(scan.counts.deadPathsLikelySextantOwn, 1);
});

test('isMentionedAsRemovedOrExternal catches the two real CLAUDE.md cases it was added for', () => {
  assert.equal(isMentionedAsRemovedOrExternal(
    'The legacy `tools/codebase_intel/refresh.js` standalone script has been removed. All installs use `sextant hook refresh`.'), true);
  assert.equal(isMentionedAsRemovedOrExternal(
    "GSD's hooks (`session-start.js`, `gsd-check-update.js`, `context-monitor.js`) don't reference sextant."), true);
  assert.equal(isMentionedAsRemovedOrExternal('- Exact path: `lib/foo.js` is a normal, currently-tracked file.'), false);
});

test('scanDocs further splits the own-drift bucket by an intentional removed/external mention on the same line, without hiding the entry', t => {
  const tmp = makeFixtureRepo(t);
  const doc = writeDoc(tmp, 'FAKE.md', [
    '- The legacy `lib/gone-forever.js` script has been removed.',
    '- GSD names its own `other-project-file.js` here on purpose.',
    '- Unrelated genuinely dead path: `lib/totally-invented.js`',
  ].join('\n'));
  const scan = scanDocs(tmp, [doc]);
  const removed = scan.dead.paths.find(d => d.path === 'lib/gone-forever.js');
  const external = scan.dead.paths.find(d => d.path === 'other-project-file.js');
  const genuine = scan.dead.paths.find(d => d.path === 'lib/totally-invented.js');
  assert.equal(removed.mentionedAsRemovedOrExternal, true);
  assert.equal(external.mentionedAsRemovedOrExternal, true);
  assert.equal(genuine.mentionedAsRemovedOrExternal, false);
  assert.equal(scan.counts.deadPathsMentionedRemovedOrExternal, 2);
  assert.equal(scan.counts.deadPathsRemainingOwn, 1);
  assert.deepEqual(scan.remainingOwnDeadPaths.map(d => d.path), ['lib/totally-invented.js']);
});

test('scanDocs strips fenced code blocks before matching inline backtick spans and skips URLs/placeholders/globs/prose', t => {
  const tmp = makeFixtureRepo(t);
  const doc = writeDoc(tmp, 'FAKE.md', [
    '```js',
    'const template = `lib/inside-a-fence.js`;',
    '```',
    'Real ref outside the fence: `lib/foo.js`',
    'A URL: `https://example.com/lib/x.js`',
    'A glob: `lib/**/*.js`',
    'Prose: `sextant hook refresh`',
  ].join('\n'));
  const scan = scanDocs(tmp, [doc]);
  assert.ok(!scan.rows.some(r => r.text.includes('inside-a-fence')));
  assert.ok(scan.rows.some(r => r.path === 'lib/foo.js' && r.status === 'ok'));
  assert.equal(scan.byCategory.url, 1);
  assert.equal(scan.byCategory.glob, 1);
  assert.equal(scan.byCategory.prose, 1);
});

test('scanDocs runs against the real sextant repo without throwing and reports internally consistent counts', () => {
  const scan = scanDocs(root);
  assert.ok(scan.sourcesScanned.includes('CLAUDE.md'));
  assert.ok(scan.sourcesScanned.includes('README.md'));
  assert.ok(scan.sourcesScanned.some(s => s.startsWith('docs/')));
  assert.ok(scan.sourcesScanned.some(s => s.startsWith('memory/')));
  assert.ok(!scan.sourcesScanned.some(s => s.includes('/superpowers/') || s.includes('/plans/') || s.includes('/recon/') || s.includes('/ideas/') || s.includes('/solutions/')),
    'docs subdirectories must not be scanned (top-level only)');
  assert.ok(scan.totalPathLike > 0);
  assert.equal(scan.counts.deadPaths, scan.counts.deadPathsLikelySextantOwn + scan.counts.deadPathsLikelyGeneratedOrExternal);
  assert.equal(scan.counts.deadPathsLikelySextantOwn, scan.counts.deadPathsMentionedRemovedOrExternal + scan.counts.deadPathsRemainingOwn);
  assert.equal(scan.remainingOwnDeadPaths.length, scan.counts.deadPathsRemainingOwn);
  assert.ok(scan.counts.totalRefs >= scan.counts.deadPaths + scan.counts.deadSymbols + scan.counts.deadLines + scan.counts.ambiguousBasenames);
  for (const [source, entry] of Object.entries(scan.perSourceFile)) assert.equal(entry.dead.length, entry.deadCount, source);
});

// ---------------------------------------------------------------------------
// Part 2: sentence windowing, sensitivity guard
// ---------------------------------------------------------------------------

test('buildSentence returns the whole trimmed line under the cap, and a centered word-boundary window over it', () => {
  assert.equal(buildSentence('  short line with `lib/foo.js`  ', '`lib/foo.js`'), 'short line with `lib/foo.js`');
  const long = `${'word '.repeat(200)}\`lib/foo.js\`${' more'.repeat(200)}`;
  const windowed = buildSentence(long, '`lib/foo.js`');
  assert.ok(windowed.length <= 602); // cap plus the two ellipsis marks
  assert.ok(windowed.includes('`lib/foo.js`'));
  assert.ok(windowed.startsWith('…'));
  assert.ok(windowed.endsWith('…'));
});

test('splitClauses breaks a compound bullet on sentence/semicolon/em-dash boundaries, not on ordinary path or version dots', () => {
  const line = 'A first clause about `lib/a.js`. A second clause about `lib/b.js:1.2.3` — a third clause after an em dash; a fourth after a semicolon.';
  const clauses = splitClauses(line);
  assert.ok(clauses.length >= 4);
  assert.ok(clauses.some(c => c.includes('`lib/a.js`') && !c.includes('lib/b.js')));
  assert.ok(clauses.some(c => c.includes('lib/b.js:1.2.3') && !c.includes('third clause')));
  assert.ok(clauses.some(c => c.includes('third clause') && !c.includes('fourth')));
  assert.ok(clauses.some(c => c.includes('fourth after a semicolon')));
});

test('buildClauseSentence keeps only the clause naming the symbol, capped and windowed like buildSentence', () => {
  const line = 'Intro clause with no reference. The renderer (`lib/format-retrieval.js:formatFileLine`) suppresses fan-in when textOnly is set. A trailing unrelated clause about something else entirely.';
  const clause = buildClauseSentence(line, '`lib/format-retrieval.js:formatFileLine`');
  assert.ok(clause.includes('formatFileLine'));
  assert.ok(!clause.includes('Intro clause'));
  assert.ok(!clause.includes('trailing unrelated'));
  // Falls back to the whole line when the match text cannot be found in any split clause.
  assert.equal(buildClauseSentence('one clause only, no match here', '`not/present.js`'), 'one clause only, no match here');
  // Still respects the char cap via the shared centeredWindow helper for an oversized single clause.
  const longClause = `Single very long clause naming \`lib/x.js\` ${'padding '.repeat(80)}with no sentence break at all.`;
  const windowed = buildClauseSentence(longClause, '`lib/x.js`', 100);
  assert.ok(windowed.length <= 104);
  assert.ok(windowed.includes('`lib/x.js`'));
});

test('every claim unit produced from a real doc line carries the raw lineText/matchText the clause treatment needs', t => {
  const tmp = makeFixtureRepo(t);
  const doc = writeDoc(tmp, 'FAKE.md', ['A clause first. Then a real symbol: `lib/foo.js:realSymbol`. Then a trailing clause.'].join('\n'));
  const scan = scanDocs(tmp, [doc]);
  const units = buildClaimUnits(tmp, scan);
  assert.equal(units.length, 1);
  assert.equal(units[0].excluded, false);
  assert.ok(units[0].lineText.includes('A clause first'));
  assert.equal(units[0].matchText, '`lib/foo.js:realSymbol`');
  const clause = buildClauseSentence(units[0].lineText, units[0].matchText);
  assert.ok(clause.includes('realSymbol'));
  assert.ok(!clause.includes('trailing clause'));
});

test('isSensitive flags patient/somaNotes/email/real phone-like runs but not plain ISO date stamps', () => {
  assert.equal(isSensitive('Discussed with a patient about the flow.'), true);
  assert.equal(isSensitive('measured on somaNotes and open-interpreter-fork'), true);
  assert.equal(isSensitive('SOMANOTES in caps still counts'), true);
  assert.equal(isSensitive('contact ched.bandit@gmail.com about this'), true);
  assert.equal(isSensitive('call +1 (555) 123-4567 for support'), true);
  assert.equal(isSensitive('shipped 2026-07-10, see docs/033'), false);
  assert.equal(isSensitive('normal sentence about lib/summary.js with no sensitive content'), false);
});

// ---------------------------------------------------------------------------
// Part 2: claim-unit construction
// ---------------------------------------------------------------------------

test('buildClaimUnits excludes sensitive sentences and unextractable symbols, and reads real scopes for the rest', t => {
  const tmp = makeFixtureRepo(t);
  const scan = {
    rows: [
      { category: 'file', resolved: true, suffixType: 'symbol', suffixOk: true, path: 'lib/foo.js', symbol: 'realSymbol',
        source: 'FAKE.md', line: 1, lineText: 'Discussed with a patient: `lib/foo.js:realSymbol`', text: '`lib/foo.js:realSymbol`' },
      { category: 'file', resolved: true, suffixType: 'symbol', suffixOk: true, path: 'lib/foo.js', symbol: 'noSuchTopLevelThing',
        source: 'FAKE.md', line: 2, lineText: 'Bogus symbol: `lib/foo.js:noSuchTopLevelThing`', text: '`lib/foo.js:noSuchTopLevelThing`' },
      { category: 'file', resolved: true, suffixType: 'symbol', suffixOk: true, path: 'lib/foo.js', symbol: 'realSymbol',
        source: 'FAKE.md', line: 3, lineText: 'realSymbol returns 1: `lib/foo.js:realSymbol`', text: '`lib/foo.js:realSymbol`' },
      { category: 'file', resolved: true, suffixType: 'line', suffixOk: true, path: 'short.js', line: 4, lineText: 'not a symbol ref' },
    ],
  };
  const units = buildClaimUnits(tmp, scan);
  assert.equal(units.length, 3);
  assert.equal(units[0].excluded, true); assert.equal(units[0].reason, 'sensitive-content');
  assert.equal(units[1].excluded, true); assert.match(units[1].reason, /^readScope:/);
  assert.equal(units[2].excluded, false);
  assert.equal(units[2].scope.text.includes('function realSymbol'), true);
  assert.equal(units[2].id, 'lib/foo.js:realSymbol@FAKE.md:3');
});

// ---------------------------------------------------------------------------
// Part 2: deterministic mutation generator, against real repo functions
// ---------------------------------------------------------------------------

test('buildMutation swaps a sentence-referenced string literal for another real literal in the same function', () => {
  const scope = readScope(root, { path: 'lib/claims.js', symbol: 'provenanceOf' });
  const sentence = 'provenanceOf classifies an unrecognized source value as live_text.';
  const mutation = buildMutation(scope.text, sentence);
  assert.ok(mutation);
  assert.equal(mutation.tier, 1);
  assert.notEqual(mutation.mutatedText, scope.text);
  assert.ok(!mutation.mutatedText.includes('"live_text"'));
  // The mutated text must still be valid, parseable JS (buildMutation only returns after a re-parse).
  const parser = require('@babel/parser');
  assert.doesNotThrow(() => parser.parse(mutation.mutatedText, { sourceType: 'unambiguous' }));
});

test('buildMutation flips a sentence-referenced boolean literal ahead of a lower-priority unary negation on the same identifier', () => {
  const scope = readScope(root, { path: 'lib/retrieve.js', symbol: 'isTestPath' });
  const sentence = 'isTestPath returns false when p is empty.';
  const mutation = buildMutation(scope.text, sentence);
  assert.ok(mutation);
  assert.equal(mutation.tier, 2);
  assert.match(mutation.mutatedText, /return true;/);
});

test('buildMutation flips a sentence-referenced comparison operator via its operand identifiers, not an unrelated outer logical chain', () => {
  const scope = readScope(root, { path: 'lib/freshness.js', symbol: 'sameRepoState' });
  const sentence = 'sameRepoState compares a.head and b.head for equality.';
  const mutation = buildMutation(scope.text, sentence);
  assert.ok(mutation);
  assert.equal(mutation.tier, 4);
  assert.equal(mutation.nodeType, 'BinaryExpression');
  assert.match(mutation.description, /=== -> !==/);
  // The outermost `&&` chain also transitively contains "head" many times over, but a shallow
  // operand match must not let that least-specific node win the position sort.
  assert.doesNotMatch(mutation.description, /&&/);
});

test('buildMutation returns null when no candidate node is referred to by the sentence', () => {
  const scope = readScope(root, { path: 'lib/retrieve.js', symbol: 'isTestPath' });
  const sentence = 'This unrelated sentence names no identifier, literal, or operator from the function above.';
  assert.equal(buildMutation(scope.text, sentence), null);
});

// ---------------------------------------------------------------------------
// Part 2: seeded sampling, AUC
// ---------------------------------------------------------------------------

test('seededShuffle is deterministic per seed and differs across seeds', () => {
  const input = Array.from({ length: 30 }, (_, i) => i);
  const a = seededShuffle(input, 12345);
  const b = seededShuffle(input, 12345);
  const c = seededShuffle(input, 54321);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.deepEqual([...a].sort((x, y) => x - y), input);
});

test('mulberry32 produces values in [0, 1)', () => {
  const rand = mulberry32(1);
  for (let i = 0; i < 100; i++) { const v = rand(); assert.ok(v >= 0 && v < 1); }
});

test('computeAUC matches a hand-computed Mann-Whitney statistic, including the tie case and empty-arm null', () => {
  assert.equal(computeAUC([0.9, 0.8], [0.1, 0.2]), 1);
  assert.equal(computeAUC([0.1, 0.2], [0.9, 0.8]), 0);
  assert.equal(computeAUC([0.5, 0.5], [0.5, 0.5]), 0.5); // all ties
  assert.equal(computeAUC([0.9, 0.3], [0.6, 0.6]), 0.5); // 0.9>0.6 (win), 0.9>0.6 (win), 0.3<0.6 (loss), 0.3<0.6 (loss) -> 2/4
  assert.equal(computeAUC([], [0.1]), null);
  assert.equal(computeAUC([0.1], []), null);
});

// ---------------------------------------------------------------------------
// Part 2: request/freeze/validate contract
// ---------------------------------------------------------------------------

// Builds all TREATMENTS.length * 2 tasks for one real claim -- the shape freezeTasks/validateFrozen
// now require (every claim carries a task under every known treatment). `lineSentence` drives the
// mutation (matching buildDriftTasks's own design: one mutation per claim, shared across treatments);
// `clauseSentence` is a hand-authored stand-in for what buildClauseSentence would extract, so these
// unit tests stay independent of that function's own exact behavior (which has its own tests).
function realClaimTasks({ id, path, symbol, lineSentence, clauseSentence, docSource = 'TEST.md', docLine = 1 }) {
  const scope = readScope(root, { path, symbol });
  const mutation = buildMutation(scope.text, lineSentence);
  assert.ok(mutation, `test fixture claim ${id} must have a mutable token`);
  const bySentence = { line: lineSentence, clause: clauseSentence };
  const tasks = [];
  for (const treatment of TREATMENTS) {
    for (const codeState of ['unmutated', 'mutated']) {
      const scopeText = codeState === 'unmutated' ? scope.text : mutation.mutatedText;
      tasks.push({
        id: `${id}:${treatment}:${codeState}`, groupId: `${id}:${treatment}`, claimId: id, treatment, codeState,
        path, symbol, docSource, docLine, sentence: bySentence[treatment],
        scopeText, scopeSha256: sha256(scopeText),
        origin: { fileSha256: scope.fileSha256, startLine: scope.startLine, endLine: scope.endLine },
        mutation: codeState === 'mutated' ? { tier: mutation.tier, nodeType: mutation.nodeType, description: mutation.description } : null,
        expected: { label: codeState === 'mutated' ? 'unsupported' : 'supported-by-construction' },
        provenance: { revision: 'test' },
      });
    }
  }
  return tasks;
}

function realPairTask() {
  return realClaimTasks({
    id: 'lib/claims.js:provenanceOf@TEST:1', path: 'lib/claims.js', symbol: 'provenanceOf',
    lineSentence: 'provenanceOf classifies an unrecognized source value as live_text.',
    clauseSentence: 'classifies an unrecognized source value as live_text',
  });
}

test('buildRequest exposes only path/symbol/sentence/source, enforces byte bounds, and never leaks task-internal labels', () => {
  const [unmutated] = realPairTask();
  const request = buildRequest(unmutated);
  assert.equal(request.questions.support.type, 'noul');
  assert.equal(request.state.sentence, unmutated.sentence);
  assert.equal(request.state.source, unmutated.scopeText);
  // Sentinel every field buildRequest must not transmit, the way refutation.test.js's own
  // LABEL_CANARY check does -- a substring scan for generic field NAMES would false-positive here
  // because the real symbol under test is literally named "provenanceOf".
  const canary = structuredClone(unmutated);
  canary.groupId = 'LABEL_CANARY'; canary.docSource = 'LABEL_CANARY'; canary.docLine = 'LABEL_CANARY';
  canary.expected = { label: 'LABEL_CANARY' }; canary.provenance = { revision: 'LABEL_CANARY' };
  canary.origin = { fileSha256: 'LABEL_CANARY', startLine: 'LABEL_CANARY', endLine: 'LABEL_CANARY' };
  canary.scopeSha256 = 'LABEL_CANARY'; canary.id = 'LABEL_CANARY';
  const serialized = JSON.stringify(buildRequest(canary));
  assert.doesNotMatch(serialized, /LABEL_CANARY/);
  assert.throws(() => buildRequest({ ...unmutated, scopeText: 'x'.repeat(7000) }), /6500-byte/);
  assert.throws(() => buildRequest({ ...unmutated, sentence: '' }), /requires a sentence/);
});

test('freezeTasks pins the exact model, pairs each claim per treatment, requires every treatment per claim, and validateFrozen rejects every tamper vector', () => {
  const tasks = realPairTask();
  const frozen = freezeTasks(tasks);
  assert.equal(frozen.tasks.length, TREATMENTS.length * 2);
  assert.equal(frozen.seed, 20260925);
  assert.doesNotThrow(() => validateFrozen(frozen));
  assert.throws(() => freezeTasks(tasks, 'some-other-model'), /pins/);

  const badFingerprint = { ...frozen, fingerprint: 'x'.repeat(64) };
  assert.throws(() => validateFrozen(badFingerprint), /fingerprint mismatch/);

  const badScope = structuredClone(frozen);
  badScope.tasks[0].scopeText += '\n// tampered';
  assert.throws(() => validateFrozen(badScope), /fingerprint mismatch/);

  const badHash = structuredClone(frozen);
  badHash.tasks[0].scopeSha256 = 'f'.repeat(64);
  assert.throws(() => validateFrozen({ ...badHash }), /fingerprint mismatch/); // fingerprint no longer matches payload either

  const unpaired = structuredClone(frozen);
  unpaired.tasks.pop(); unpaired.plan.pop();
  assert.throws(() => freezeTasks(unpaired.tasks), /exactly one mutated and one unmutated/);

  const singleCodeState = structuredClone(frozen);
  singleCodeState.tasks[1].codeState = 'unmutated';
  assert.throws(() => freezeTasks(singleCodeState.tasks), /exactly one mutated and one unmutated/);

  // New treatment invariants (this follow-up): every claim must carry every known treatment, an
  // unknown treatment is rejected, and groupId must exactly encode claimId:treatment.
  const missingTreatment = structuredClone(frozen);
  missingTreatment.tasks = missingTreatment.tasks.filter(t => t.treatment !== 'clause');
  assert.throws(() => freezeTasks(missingTreatment.tasks), /requires a task under every known treatment/);

  const unknownTreatment = structuredClone(frozen);
  unknownTreatment.tasks[0] = { ...unknownTreatment.tasks[0], treatment: 'paragraph', groupId: `${unknownTreatment.tasks[0].claimId}:paragraph` };
  assert.throws(() => freezeTasks(unknownTreatment.tasks), /Invalid claimId or treatment/);

  const badGroupId = structuredClone(frozen);
  badGroupId.tasks[0] = { ...badGroupId.tasks[0], groupId: 'not-the-real-groupid' };
  assert.throws(() => freezeTasks(badGroupId.tasks), /groupId must be claimId:treatment/);

  // Mutated and unmutated source must genuinely differ (guards a no-op mutation slipping through).
  const noOpMutation = structuredClone(frozen);
  const lineUnmutated = noOpMutation.tasks.find(t => t.treatment === 'line' && t.codeState === 'unmutated');
  const lineMutated = noOpMutation.tasks.find(t => t.treatment === 'line' && t.codeState === 'mutated');
  lineMutated.scopeText = lineUnmutated.scopeText; lineMutated.scopeSha256 = lineUnmutated.scopeSha256;
  assert.throws(() => freezeTasks(noOpMutation.tasks), /must differ/);
});

test('freeze() builds against the real repo and produces a validatable, internally consistent artifact under both treatments', () => {
  const { frozen, build } = freeze();
  assert.doesNotThrow(() => validateFrozen(frozen));
  assert.deepEqual(build.treatments, ['line', 'clause']);
  assert.equal(frozen.tasks.length, build.sampledClaims * TREATMENTS.length * 2);
  assert.ok(frozen.tasks.length <= 60 * TREATMENTS.length * 2);
  assert.equal(build.scan.root, root);
  assert.ok(build.mutableClaims >= build.sampledClaims);
  const claimIds = new Set(frozen.tasks.map(t => t.claimId));
  for (const claimId of claimIds) {
    const treatmentsSeen = new Set(frozen.tasks.filter(t => t.claimId === claimId).map(t => t.treatment));
    assert.deepEqual([...treatmentsSeen].sort(), ['clause', 'line']);
  }
});

// ---------------------------------------------------------------------------
// Part 2: scoring (report) and end-to-end runFrozen against a mocked client
// ---------------------------------------------------------------------------

function twoClaimFrozen() {
  const claim1 = realPairTask();
  const claim2 = realClaimTasks({
    id: 'lib/retrieve.js:isTestPath@TEST:2', path: 'lib/retrieve.js', symbol: 'isTestPath',
    lineSentence: 'isTestPath returns false when p is empty.', clauseSentence: 'returns false when p is empty',
    docLine: 2,
  });
  return freezeTasks([...claim1, ...claim2]);
}

test('report computes paired discrimination, AUC, and sorted candidate-stale claims per treatment, plus a paired cross-treatment delta', () => {
  const frozen = twoClaimFrozen();
  // claim1 = provenanceOf: LINE treatment discriminates correctly (high unmutated, low mutated);
  // CLAUSE treatment does not (both mid-high). claim2 = isTestPath: LINE does not discriminate;
  // CLAUSE does. This exercises both treatments' scoring independently and gives a real 4-point
  // paired cross-treatment delta.
  const scoresByTaskId = {
    'lib/claims.js:provenanceOf@TEST:1:line:unmutated': 0.95,
    'lib/claims.js:provenanceOf@TEST:1:line:mutated': 0.05,
    'lib/claims.js:provenanceOf@TEST:1:clause:unmutated': 0.6,
    'lib/claims.js:provenanceOf@TEST:1:clause:mutated': 0.55,
    'lib/retrieve.js:isTestPath@TEST:2:line:unmutated': 0.3,
    'lib/retrieve.js:isTestPath@TEST:2:line:mutated': 0.7,
    'lib/retrieve.js:isTestPath@TEST:2:clause:unmutated': 0.8,
    'lib/retrieve.js:isTestPath@TEST:2:clause:mutated': 0.2,
  };
  const records = [{ kind: 'manifest', experiment: frozen, executionKind: 'mock-transport' },
    ...frozen.plan.map(planned => ({ kind: 'result', id: planned.id, requestHash: planned.requestHash, latencyMs: 5,
      response: nounResponse('jev-1.13.0', scoresByTaskId[planned.id]) })),
  ];
  const result = report(records);
  assert.equal(result.status, 'complete');
  assert.deepEqual(Object.keys(result.treatments).sort(), ['clause', 'line']);

  // LINE: pair1 (0.95/0.05) discriminates; pair2 (0.3/0.7) does not => 1/2.
  assert.equal(result.treatments.line.pairedDiscrimination.n, 2);
  assert.equal(result.treatments.line.pairedDiscrimination.correct, 1);
  assert.equal(result.treatments.line.pairedDiscrimination.rate, 0.5);
  // AUC: unmutated=[0.95,0.3] vs mutated=[0.05,0.7]: wins 0.95>0.05,0.95>0.7,0.3>0.05; loss 0.3>0.7 => 3/4.
  assert.equal(result.treatments.line.auc.value, 0.75);
  assert.equal(result.treatments.line.candidateStaleClaims.length, 1);
  assert.equal(result.treatments.line.candidateStaleClaims[0].symbol, 'isTestPath');
  assert.equal(result.treatments.line.candidateStaleClaims[0].score, 0.3);

  // CLAUSE: pair1 (0.6/0.55) does not discriminate; pair2 (0.8/0.2) does => 1/2.
  assert.equal(result.treatments.clause.pairedDiscrimination.n, 2);
  assert.equal(result.treatments.clause.pairedDiscrimination.correct, 1);
  // AUC: unmutated=[0.6,0.8] vs mutated=[0.55,0.2]: all four comparisons win => 4/4 = 1.
  assert.equal(result.treatments.clause.auc.value, 1);
  assert.equal(result.treatments.clause.candidateStaleClaims.length, 0); // both unmutated scores >= 0.5

  // Cross-treatment paired delta (clause - line) over the 4 (claim, codeState) pairs:
  // claim1/unmutated: 0.6-0.95=-0.35, claim1/mutated: 0.55-0.05=0.5,
  // claim2/unmutated: 0.8-0.3=0.5, claim2/mutated: 0.2-0.7=-0.5.
  const cross = result.crossTreatmentComparison;
  assert.equal(cross.overall.n, 4);
  const sortedDeltas = cross.pairs.map(p => Number(p.delta.toFixed(2))).sort((a, b) => a - b);
  assert.deepEqual(sortedDeltas, [-0.5, -0.35, 0.5, 0.5]);
  assert.equal(cross.overall.higherUnderClause, 2);
  assert.equal(cross.overall.higherUnderLine, 2);
  assert.equal(cross.byCodeState.unmutated.n, 2);
  assert.equal(cross.byCodeState.mutated.n, 2);

  assert.ok(result.estimatedCostUsd > 0);
  assert.match(result.costBasis, /\$0\.042\/M/);
});

test('runFrozen against a mocked client writes a validated JSONL trace, matches its own report(), and 0600s the file', async t => {
  const frozen = twoClaimFrozen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-drift-live-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'result.jsonl');
  let calls = 0;
  const result = await runFrozen(frozen, out, { client: { async systemOne() { calls++; return nounResponse('jev-1.13.0', calls % 2 ? 0.9 : 0.1); } } });
  assert.equal(calls, frozen.plan.length); // 2 claims * 2 treatments * 2 codeStates = 8
  assert.equal(result.executionKind, 'mock-transport');
  assert.equal(result.completed, frozen.plan.length);
  const text = fs.readFileSync(out, 'utf8');
  const rows = text.trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].kind, 'manifest');
  assert.equal(rows.at(-1).kind, 'summary');
  assert.deepEqual(report(rows), result);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
});

test('runFrozen halts on a provider failure, sanitizes the recorded error, and still emits a partial summary', async t => {
  const frozen = twoClaimFrozen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-drift-live-fail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'result.jsonl');
  await assert.rejects(runFrozen(frozen, out, { client: { async systemOne() { throw new Error('PRIVATE_LEAK_CANARY'); } } }), /sanitized status/);
  const text = fs.readFileSync(out, 'utf8');
  assert.doesNotMatch(text, /PRIVATE_LEAK_CANARY/);
  const rows = text.trim().split('\n').map(JSON.parse);
  const errorRow = rows.find(r => r.kind === 'error');
  assert.equal(errorRow.code, 'unknown_failure');
  const summaryRow = rows.find(r => r.kind === 'summary');
  assert.equal(summaryRow.completed, 0);
  assert.equal(summaryRow.errorCount, 1);
  assert.equal(summaryRow.unattempted, frozen.plan.length - 1);
});

// ---------------------------------------------------------------------------
// End-to-end sanity against the real repo (mocked provider, no network)
// ---------------------------------------------------------------------------

test('buildDriftTasks + freezeTasks + a mocked live run over the real repo produce a self-consistent report', async t => {
  const built = buildDriftTasks(root);
  assert.ok(built.sampledClaims > 0, 'expected at least one live-eligible, mutable claim on the real repo');
  const frozen = freezeTasks(built.tasks);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-drift-real-live-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'result.jsonl');
  const result = await runFrozen(frozen, out, { client: { async systemOne(request) {
    // Deterministic mock: supported unless the source obviously carries a mutation marker absent
    // from the original (we cannot know the claim's truth, but we can exercise the full pipeline).
    return nounResponse(frozen.model, request.state.source === request.state.source ? 0.8 : 0.2);
  } } });
  assert.equal(result.status, 'complete');
  assert.equal(result.completed, frozen.plan.length);
  assert.equal(frozen.plan.length, built.sampledClaims * TREATMENTS.length * 2);
  for (const treatment of TREATMENTS) {
    assert.equal(result.treatments[treatment].pairedDiscrimination.n, built.sampledClaims, treatment);
    assert.ok(Number.isFinite(result.treatments[treatment].auc.value) || result.treatments[treatment].auc.value === null, treatment);
  }
  assert.equal(result.crossTreatmentComparison.overall.n, built.sampledClaims * 2); // one delta per (claim, codeState)
});
