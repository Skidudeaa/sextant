'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { validateResponse } = require('./client');
const m = require('./role-map');

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

test('taxonomy has 4 groups and 15 leaves, each leaf structured {what, not_for, examples}', () => {
  assert.deepEqual(m.GROUP_IDS, ['interface', 'domain', 'infrastructure', 'support']);
  assert.equal(m.LEAF_ROLES.length, 15);
  assert.equal(new Set(m.LEAF_ROLES).size, 15); // no duplicate leaf ids across groups
  for (const group of m.GROUP_IDS) {
    const leaves = m.TAXONOMY[group].leaves;
    assert.ok(typeof m.TAXONOMY[group].what === 'string' && m.TAXONOMY[group].what.length > 0);
    for (const [leaf, def] of Object.entries(leaves)) {
      assert.equal(m.GROUP_OF_LEAF[leaf], group);
      assert.ok(def.what && def.not_for && def.examples, `${leaf} missing structured criteria`);
    }
  }
  const expected = { interface: ['cli', 'http_api', 'ui_component', 'plugin_or_hook_entry'],
    domain: ['business_rules', 'data_model_or_schema'],
    infrastructure: ['persistence', 'external_api_client', 'llm_call', 'filesystem_io', 'scheduling_or_jobs'],
    support: ['configuration', 'logging_or_telemetry', 'generic_utilities', 'build_or_deploy_scripts'] };
  for (const [group, leaves] of Object.entries(expected)) assert.deepEqual(Object.keys(m.TAXONOMY[group].leaves).sort(), leaves.sort());
});

test('A1/group/leaf requests are valid Jev contracts (client.js validateResponse accepts a well-formed mock answer)', () => {
  const a1 = m.buildA1Request('lib/x.js', 'function f(){}');
  assert.equal(Object.keys(a1.questions).length, 15);
  const a1Answers = Object.fromEntries(Object.keys(a1.questions).map((k) => [k, { type: 'noul', noul: 0.3 }]));
  validateResponse({ model: 'jev-1.13.0', usage: { input_tokens: 10, output_tokens: 1 }, answers: a1Answers }, a1.questions);

  const group = m.buildGroupChoiceRequest('lib/x.js', 'function f(){}');
  const gKeys = Object.keys(group.questions.group.criteria);
  assert.deepEqual(gKeys.sort(), m.GROUP_IDS.slice().sort());
  const gProbs = Object.fromEntries(gKeys.map((k, i) => [k, i === 0 ? 0.7 : 0.1]));
  validateResponse({ model: 'jev-1.13.0', usage: { input_tokens: 10, output_tokens: 1 },
    answers: { group: { type: 'choice', choice: gKeys[0], confidence: 0.9, probabilities: gProbs } } }, group.questions);

  const leaf = m.buildLeafChoiceRequest('lib/x.js', 'function f(){}', ['interface', 'support']);
  assert.deepEqual(Object.keys(leaf.questions).sort(), ['leaf_interface', 'leaf_support']);
  const leafAnswers = {};
  for (const [qk, q] of Object.entries(leaf.questions)) {
    const keys = Object.keys(q.criteria);
    const probs = Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.6 : 0.4 / (keys.length - 1)]));
    leafAnswers[qk] = { type: 'choice', choice: keys[0], confidence: 0.8, probabilities: probs };
  }
  validateResponse({ model: 'jev-1.13.0', usage: { input_tokens: 10, output_tokens: 1 }, answers: leafAnswers }, leaf.questions);
});

test('buildTaggingRequest merges A1 and A2-group questions into one request sharing one state (one full-file resend instead of two)', () => {
  const a1 = m.buildA1Request('lib/x.js', 'function f(){}');
  const group = m.buildGroupChoiceRequest('lib/x.js', 'function f(){}');
  const combined = m.buildTaggingRequest('lib/x.js', 'function f(){}');
  assert.deepEqual(combined.state, a1.state);
  assert.deepEqual(combined.state, group.state);
  assert.equal(Object.keys(combined.questions).length, Object.keys(a1.questions).length + 1);
  assert.ok(combined.questions.group);
  for (const key of Object.keys(a1.questions)) assert.deepEqual(combined.questions[key], a1.questions[key]);
  const answers = Object.fromEntries(Object.keys(a1.questions).map((k) => [k, { type: 'noul', noul: 0.4 }]));
  const gKeys = Object.keys(combined.questions.group.criteria);
  answers.group = { type: 'choice', choice: gKeys[0], confidence: 0.9, probabilities: Object.fromEntries(gKeys.map((k, i) => [k, i === 0 ? 0.7 : 0.1])) };
  validateResponse({ model: 'jev-1.13.0', usage: { input_tokens: 20, output_tokens: 1 }, answers }, combined.questions);
});

test('query-role and directory-routing requests are valid Jev contracts', () => {
  const roleReq = m.buildQueryRoleRequest('fix the retrieval scoring bug');
  assert.equal(Object.keys(roleReq.questions).length, 15);
  const dirs = m.buildDirectoryIndex([{ path: 'lib/a.js' }, { path: 'lib/b.js' }, { path: 'commands/c.js' }]);
  assert.deepEqual(dirs, [{ dir: 'lib', files: ['lib/a.js', 'lib/b.js'] }]);
  const dirReq = m.buildDirRoutingRequest('fix the retrieval scoring bug', dirs);
  assert.deepEqual(Object.keys(dirReq.questions), ['dir_0']);
  assert.deepEqual(dirReq.questions.dir_0.criteria.true, { dir: 'lib', files: ['lib/a.js', 'lib/b.js'] });
  assert.equal('moreFiles' in dirReq.questions.dir_0.criteria.true, false);
  const answers = { dir_0: { type: 'noul', noul: 0.6 } };
  validateResponse({ model: 'jev-1.13.0', usage: { input_tokens: 5, output_tokens: 1 }, answers }, dirReq.questions);
});

test('directory routing caps listed files and reports moreFiles without leaving an undefined key (JSON-losslessness)', () => {
  const files = Array.from({ length: 40 }, (_, i) => `lib/f${String(i).padStart(2, '0')}.js`);
  const dirs = m.buildDirectoryIndex(files.map((path) => ({ path })));
  const req = m.buildDirRoutingRequest('anything', dirs);
  const listed = req.questions.dir_0.criteria.true.files;
  assert.equal(listed.length, m.DIR_FILES_LISTED_CAP);
  const expectedMore = 40 - m.DIR_FILES_LISTED_CAP;
  assert.equal(req.questions.dir_0.criteria.true.moreFiles, expectedMore);
  // Would throw "Request must be losslessly JSON-compatible" if an undefined leaked in.
  const { JevError } = require('./client');
  assert.doesNotThrow(() => {
    const round = JSON.parse(JSON.stringify(req));
    assert.equal(round.questions.dir_0.criteria.true.moreFiles, expectedMore);
  });
  void JevError;
});

// ---------------------------------------------------------------------------
// Beam logic (A2)
// ---------------------------------------------------------------------------

test('beam keeps a 2nd group only within the 0.15 gap, and the boundary is inclusive', () => {
  assert.deepEqual(m.selectBeamGroups({ interface: 0.7, domain: 0.1, infrastructure: 0.1, support: 0.1 }), ['interface']);
  assert.deepEqual(m.selectBeamGroups({ interface: 0.5, domain: 0.4, infrastructure: 0.05, support: 0.05 }), ['interface', 'domain']);
  // Exactly at the 0.15 boundary: kept (spec says "within 0.15", inclusive <=).
  assert.deepEqual(m.selectBeamGroups({ interface: 0.5, domain: 0.35, infrastructure: 0.1, support: 0.05 }), ['interface', 'domain']);
  assert.deepEqual(m.selectBeamGroups({ interface: 0.51, domain: 0.35, infrastructure: 0.09, support: 0.05 }), ['interface']);
});

test('combineFileTags takes the max A1 probability per role across chunks, and the max-joint-probability A2 leaf', () => {
  const task = { chunks: [{ chunkIndex: 0 }, { chunkIndex: 1 }] };
  const rows = new Map([
    [0, {
      a1: { answers: { role_cli: { noul: 0.2 }, role_persistence: { noul: 0.9 } } },
      group: { answers: { group: { probabilities: { interface: 0.6, domain: 0.1, infrastructure: 0.2, support: 0.1 } } } },
      leaf: { answers: { leaf_interface: { probabilities: { cli: 0.9, http_api: 0.1, ui_component: 0, plugin_or_hook_entry: 0 } } } },
      leafGroups: ['interface'],
    }],
    [1, {
      a1: { answers: { role_cli: { noul: 0.7 }, role_persistence: { noul: 0.3 } } },
      group: { answers: { group: { probabilities: { interface: 0.2, domain: 0.1, infrastructure: 0.65, support: 0.05 } } } },
      leaf: { answers: { leaf_infrastructure: { probabilities: { persistence: 0.95, external_api_client: 0.02, llm_call: 0.01, filesystem_io: 0.01, scheduling_or_jobs: 0.01 } } } },
      leafGroups: ['infrastructure'],
    }],
  ]);
  const { a1, a2 } = m.combineFileTags(task, rows);
  assert.equal(a1.cli, 0.7); // max(0.2, 0.7)
  assert.equal(a1.persistence, 0.9); // max(0.9, 0.3)
  // chunk0 joint: interface(0.6)*cli(0.9)=0.54; chunk1 joint: infrastructure(0.65)*persistence(0.95)=0.6175 -> wins
  assert.equal(a2.group, 'infrastructure');
  assert.equal(a2.leaf, 'persistence');
  assert.ok(Math.abs(a2.jointProbability - 0.65 * 0.95) < 1e-9);
});

// ---------------------------------------------------------------------------
// Redactor
// ---------------------------------------------------------------------------

test('redactor removes secret-shaped strings and counts them, leaving ordinary code untouched', () => {
  const src = [
    'const API_KEY = "sk_live_ABCDEFGHIJKL1234";',
    'const token = "ghp_1234567890abcdefghij";',
    'const aws = "AKIAABCDEFGHIJKLMNOP";',
    'const slack = "xoxb-1234567890-abcdefghij";',
    'const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";',
    'const password = "hunter2hunter2hunter2";',
    'function add(a, b) { return a + b; }',
  ].join('\n');
  const { text, count } = m.redact(src);
  assert.equal(count, 6);
  assert.ok(!text.includes('sk_live_'));
  assert.ok(!text.includes('ghp_'));
  assert.ok(!text.includes('AKIAABCDEFGHIJKLMNOP'));
  assert.ok(!text.includes('xoxb-'));
  assert.ok(!text.includes('hunter2hunter2hunter2'));
  assert.match(text, /function add\(a, b\) \{ return a \+ b; \}/);
});

test('redactor is idempotent on already-clean source (zero false positives on ordinary code)', () => {
  const src = 'function scoreFile(path, source) {\n  const ratio = source.length / 20000;\n  return ratio > 0.7;\n}\nmodule.exports = { scoreFile };\n';
  const { text, count } = m.redact(src);
  assert.equal(count, 0);
  assert.equal(text, src);
});

// ---------------------------------------------------------------------------
// Detectors (known-answer, Python and JS/TS)
// ---------------------------------------------------------------------------

test('http_api detector: py decorator and js router positives, plain-function negatives', () => {
  assert.equal(m.DETECTORS.http_api('py', '@app.route("/x")\ndef handler():\n    pass\n'), true);
  assert.equal(m.DETECTORS.http_api('py', 'class ItemView(APIView):\n    pass\n'), true);
  assert.equal(m.DETECTORS.http_api('py', 'def add(a, b):\n    return a + b\n'), false);
  assert.equal(m.DETECTORS.http_api('js', "router.post('/items', createItem);\n"), true);
  assert.equal(m.DETECTORS.http_api('js', 'function add(a, b) { return a + b; }\n'), false);
});

test('cli detector: argparse-family or main-guard+arg-parsing (py), commander/main-guard (js)', () => {
  assert.equal(m.DETECTORS.cli('py', 'import argparse\np = argparse.ArgumentParser()\n'), true);
  assert.equal(m.DETECTORS.cli('py', 'if __name__ == "__main__":\n    import sys\n    print(sys.argv)\n'), true);
  assert.equal(m.DETECTORS.cli('py', 'if __name__ == "__main__":\n    main()\n'), false); // main guard alone, no arg-parsing indicator
  assert.equal(m.DETECTORS.cli('py', 'def add(a, b):\n    return a + b\n'), false);
  assert.equal(m.DETECTORS.cli('js', "const { program } = require('commander');\n"), true);
  assert.equal(m.DETECTORS.cli('js', 'module.exports = { add: (a, b) => a + b };\n'), false);
});

test('persistence detector: DB client imports and CREATE TABLE/execute(SQL)', () => {
  assert.equal(m.DETECTORS.persistence('py', 'import sqlite3\nconn = sqlite3.connect("x.db")\n'), true);
  assert.equal(m.DETECTORS.persistence('js', "const { PrismaClient } = require('@prisma/client');\n"), true);
  assert.equal(m.DETECTORS.persistence('js', 'db.execute(`CREATE TABLE files (id INTEGER)`);\n'), true);
  assert.equal(m.DETECTORS.persistence('py', 'def add(a, b):\n    return a + b\n'), false);
});

test('llm_call detector: provider SDK imports and model-id strings', () => {
  assert.equal(m.DETECTORS.llm_call('py', 'import anthropic\nclient = anthropic.Anthropic()\n'), true);
  assert.equal(m.DETECTORS.llm_call('js', 'const model = "claude-sonnet-5";\n'), true);
  assert.equal(m.DETECTORS.llm_call('py', 'def add(a, b):\n    return a + b\n'), false);
});

test('external_api_client detector: requests/httpx (py), fetch/axios (js) — never fires for llm_call\'s own imports', () => {
  assert.equal(m.DETECTORS.external_api_client('py', 'import requests\nrequests.get(url)\n'), true);
  assert.equal(m.DETECTORS.external_api_client('js', "fetch('https://example.com/api').then(r => r.json());\n"), true);
  assert.equal(m.DETECTORS.external_api_client('py', 'def add(a, b):\n    return a + b\n'), false);
});

test('ui_component detector: tsx/jsx with export + JSX return only', () => {
  assert.equal(m.DETECTORS.ui_component('tsx', 'export function Foo() {\n  return <div>hi</div>;\n}\n'), true);
  assert.equal(m.DETECTORS.ui_component('ts', 'export function Foo() {\n  return 1;\n}\n'), false); // wrong extension
  assert.equal(m.DETECTORS.ui_component('tsx', 'function helper() {\n  return 1;\n}\n'), false); // no export, no JSX
});

test('filesystem_io detector: open()/Path (py), fs.* (js)', () => {
  assert.equal(m.DETECTORS.filesystem_io('py', 'with open("f.txt") as fh:\n    data = fh.read()\n'), true);
  assert.equal(m.DETECTORS.filesystem_io('js', "const fs = require('fs');\nfs.writeFileSync('x', 'y');\n"), true);
  assert.equal(m.DETECTORS.filesystem_io('py', 'def add(a, b):\n    return a + b\n'), false);
});

test('configuration detector: >=70% of top-level statements are constant assignments, in either language', () => {
  const py = 'HOST = "localhost"\nPORT = 8080\nDEBUG = True\nTIMEOUT = 30\n';
  assert.equal(m.DETECTORS.configuration('py', py), true);
  const js = 'const HOST = "localhost";\nconst PORT = 8080;\nconst DEBUG = true;\nmodule.exports = { HOST, PORT, DEBUG };\n';
  assert.equal(m.DETECTORS.configuration('js', js), true);
  const logic = 'function process(items) {\n  const out = [];\n  for (const item of items) {\n    if (item.active) out.push(item);\n  }\n  return out;\n}\nmodule.exports = { process };\n';
  assert.equal(m.DETECTORS.configuration('js', logic), false);
  assert.equal(m.DETECTORS.configuration('swift', 'let x = 1\n'), false); // detector scoped to Python and JS/TS only
});

test('runDetectors reports null (not applicable) for a non-Python/JS language', () => {
  const out = m.runDetectors('swift', 'struct Foo {}\n');
  for (const role of m.LEAF_ROLES) if (m.DETECTORS[role]) assert.equal(out[role], null);
});

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

test('chunkSource passes a small file through as one chunk', () => {
  const src = 'line1\nline2\nline3\n';
  assert.deepEqual(m.chunkSource(src, 20000), [src]);
});

test('chunkSource splits a large file on line boundaries under the cap, losing no lines', () => {
  const lines = Array.from({ length: 500 }, (_, i) => `const x${i} = ${i};`);
  const src = lines.join('\n');
  const chunks = m.chunkSource(src, 400);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(Buffer.byteLength(c) <= 400 + 60); // one line may push slightly over; never wildly
  assert.equal(chunks.join('\n'), src); // rejoining chunks reconstructs the source exactly
});

test('chunkSource never drops a single line that alone exceeds the cap', () => {
  const longLine = 'x'.repeat(500);
  const chunks = m.chunkSource(`short\n${longLine}\nshort2`, 100);
  assert.ok(chunks.some((c) => c.includes(longLine)));
});

// ---------------------------------------------------------------------------
// Corpus scope
// ---------------------------------------------------------------------------

test('scope filter: extractor registry, test paths, sensitive paths, vendored/build dirs, non-indexable extensions', () => {
  assert.equal(m.isInScopePath('lib/intel.js'), true);
  assert.equal(m.isInScopePath('commands/scan.js'), true);
  assert.equal(m.isInScopePath('app/main.py'), true);
  assert.equal(m.isInScopePath('test/foo.test.js'), false);
  assert.equal(m.isInScopePath('lib/test_foo.py'), false); // pytest convention
  assert.equal(m.isInScopePath('fixtures/vapor-baseline.json'), false); // not indexable anyway
  assert.equal(m.isInScopePath('fixtures/python-eval/app.py'), false); // fixtures dir
  assert.equal(m.isInScopePath('vendor/lib/thing.js'), false);
  assert.equal(m.isInScopePath('node_modules/foo/index.js'), false);
  assert.equal(m.isInScopePath('dist/bundle.js'), false);
  assert.equal(m.isInScopePath('.env'), false);
  assert.equal(m.isInScopePath('README.md'), false); // not a registered extractor extension
  assert.equal(m.isInScopePath('docs/001-thing.md'), false);
});

// ---------------------------------------------------------------------------
// Identifier extraction (leak filter) — Python and JS/TS
// ---------------------------------------------------------------------------

test('extractDefinedIdentifiers finds function/class/const definitions >=5 chars, per language', () => {
  const js = m.extractDefinedIdentifiers('function computeScore(x) {}\nconst ab = 1;\nconst RETRIEVAL_LIMIT = 5;\nclass ScoringEngine {}\n', 'js');
  assert.ok(js.includes('computeScore'));
  assert.ok(js.includes('RETRIEVAL_LIMIT'));
  assert.ok(js.includes('ScoringEngine'));
  assert.ok(!js.includes('ab')); // below MIN_LEAK_IDENTIFIER_LENGTH
  const py = m.extractDefinedIdentifiers('def compute_score(x):\n    pass\nRETRIEVAL_LIMIT = 5\nclass ScoringEngine:\n    pass\n', 'py');
  assert.ok(py.includes('compute_score'));
  assert.ok(py.includes('RETRIEVAL_LIMIT'));
  assert.ok(py.includes('ScoringEngine'));
});

// ---------------------------------------------------------------------------
// Stage B leak filter and label rules
// ---------------------------------------------------------------------------

test('buildStageBCandidates: drops no-label / too-many-label / subject-leak commits, keeps clean ones, matches query construction', () => {
  const commits = [
    { hash: 'h1', unixSeconds: 1, subject: 'Fix computeScore rounding', body: '', files: ['lib/scoring.js'] },
    { hash: 'h2', unixSeconds: 2, subject: 'Improve retrieval ranking', body: 'touches lib/scoring.js', files: ['lib/scoring.js'] },
    { hash: 'h3', unixSeconds: 3, subject: '', body: '', files: ['lib/scoring.js'] },
    { hash: 'h4', unixSeconds: 4, subject: 'Too many files change', body: '',
      files: ['alpha.js', 'bravo.js', 'charlie.js', 'delta.js', 'echo.js', 'foxtrot.js', 'golf.js'] },
    { hash: 'h5', unixSeconds: 5, subject: 'Docs only change', body: '', files: ['README.md'] },
    { hash: 'h6', unixSeconds: 6, subject: 'Tune the ranking weights', body: 'small follow-up', files: ['lib/scoring.js'] },
  ];
  const inScope = new Set(['lib/scoring.js', 'alpha.js', 'bravo.js', 'charlie.js', 'delta.js', 'echo.js', 'foxtrot.js']);
  const ids = new Map([['lib/scoring.js', ['computeScore', 'RETRIEVAL_LIMIT']]]);
  const out = m.buildStageBCandidates(commits, inScope, ids);
  const byHash = Object.fromEntries(out.map((c) => [c.hash, c]));
  assert.deepEqual(Object.keys(byHash).sort(), ['h2', 'h4', 'h6']);
  assert.equal(byHash.h4.labels.length, 6); // exactly at the boundary — kept (only > 6 drops)
  assert.equal(byHash.h2.query, 'Improve retrieval ranking touches lib/scoring.js'); // short subject gets the body's first line appended
  assert.equal(byHash.h6.query, 'Tune the ranking weights small follow-up');
});

test('buildStageBCandidates drops a commit whose subject names a >=5-char identifier defined in its own label file at T', () => {
  const commits = [{ hash: 'h1', unixSeconds: 1, subject: 'Refactor RETRIEVAL_LIMIT handling', body: '', files: ['lib/x.js'] }];
  const inScope = new Set(['lib/x.js']);
  const ids = new Map([['lib/x.js', ['RETRIEVAL_LIMIT']]]);
  assert.deepEqual(m.buildStageBCandidates(commits, inScope, ids), []);
});

test('buildStageBCandidates does not leak-filter on a body line naming the file (leak check is subject-only, per spec)', () => {
  const commits = [{ hash: 'h1', unixSeconds: 1, subject: 'Fix rounding', body: 'in lib/scoring.js', files: ['lib/scoring.js'] }];
  const inScope = new Set(['lib/scoring.js']);
  const ids = new Map();
  const out = m.buildStageBCandidates(commits, inScope, ids);
  assert.equal(out.length, 1);
});

test('seededSample is deterministic for a fixed seed, caps size, and never duplicates', () => {
  const items = Array.from({ length: 40 }, (_, i) => `item${i}`);
  const a = m.seededSample(items, 10, 20260925);
  const b = m.seededSample(items, 10, 20260925);
  assert.deepEqual(a, b);
  assert.equal(a.length, 10);
  assert.equal(new Set(a).size, 10);
  const different = m.seededSample(items, 10, 1);
  assert.notDeepEqual(a, different);
  assert.deepEqual(m.seededSample(items.slice(0, 5), 10, 1), items.slice(0, 5)); // no cap needed
});

// ---------------------------------------------------------------------------
// Stage B routing arms
// ---------------------------------------------------------------------------

function fileProbs(map) { return new Map(Object.entries(map)); }

test('r1CandidateSet: files whose max active-role probability clears thetaF, restricted to roles the query clears thetaQ on', () => {
  const files = [{ path: 'a' }, { path: 'b' }, { path: 'c' }];
  const probs = fileProbs({ a: { persistence: 0.9, cli: 0.1 }, b: { persistence: 0.2, cli: 0.8 }, c: { persistence: 0.1, cli: 0.1 } });
  const queryProbs = Object.fromEntries(m.LEAF_ROLES.map((r) => [r, r === 'persistence' ? 0.8 : 0.1]));
  assert.deepEqual(m.r1CandidateSet(queryProbs, probs, files, 0.5, 0.5), ['a']);
  // No role clears thetaQ -> empty set, regardless of file probabilities.
  assert.deepEqual(m.r1CandidateSet(queryProbs, probs, files, 0.95, 0.5), []);
});

test('r2CandidateSet: union of files under directories whose Noul probability clears thetaQ', () => {
  const dirs = [{ dir: 'lib', files: ['lib/a.js', 'lib/b.js'] }, { dir: 'commands', files: ['commands/c.js'] }];
  const dirProbs = { dir_0: 0.8, dir_1: 0.2 };
  assert.deepEqual(m.r2CandidateSet(dirProbs, dirs, 0.5).sort(), ['lib/a.js', 'lib/b.js']);
  assert.deepEqual(m.r2CandidateSet(dirProbs, dirs, 0.9), []);
});

test('r3CandidateSet draws exactly `size` distinct paths, deterministically for a fixed seed', () => {
  const all = ['a', 'b', 'c', 'd', 'e'];
  const r3a = m.r3CandidateSet(all, 3, 7);
  const r3b = m.r3CandidateSet(all, 3, 7);
  assert.equal(r3a.length, 3);
  assert.equal(new Set(r3a).size, 3);
  assert.deepEqual(r3a, r3b);
  assert.deepEqual(m.r3CandidateSet(all, 0, 7), []);
});

test('r4CandidateSet unions R1+R2, ranks by membership count then score, and always matches |R1| in size', () => {
  const r1 = ['a', 'b'];
  const r2 = ['b', 'c', 'd'];
  const r1Score = (p) => ({ a: 0.9, b: 0.6 }[p] ?? 0);
  const r2Score = (p) => ({ b: 0.7, c: 0.95, d: 0.5 }[p] ?? 0);
  const r4 = m.r4CandidateSet(r1, r2, r1Score, r2Score);
  assert.equal(r4.length, r1.length);
  assert.ok(r4.includes('b')); // in both arms -> highest membership, always kept
  // c has membership 1 but the highest tiebreak (0.95) among the remaining single-membership pool.
  assert.ok(r4.includes('c') || r4.includes('a'));
});

test('r4CandidateSet size never exceeds the union (falls back to the full union when it is smaller than |R1| would imply)', () => {
  const r4 = m.r4CandidateSet(['a', 'b', 'c'], ['a'], () => 1, () => 1);
  assert.equal(r4.length, 3); // union == r1 here since r2 subseteq r1
});

test('r4CandidateSet lets disjoint R2 candidates displace R1 members, even when R2 scores are numerically much lower (round-robin, not a raw cross-arm score compare)', () => {
  // On the real corpus, r1's members already cleared a role threshold (>=0.5+)
  // while r2's members only cleared a directory threshold, so a naive
  // "sort the union by whichever score" collapsed R4 to exactly R1 every
  // time. Round-robin must still let e/f in despite their tiny scores.
  const r1 = ['a', 'b', 'c', 'd'];
  const r2 = ['e', 'f'];
  const r1Score = (p) => ({ a: 0.95, b: 0.9, c: 0.85, d: 0.8 }[p]);
  const r2Score = (p) => ({ e: 0.31, f: 0.2 }[p]);
  const r4 = m.r4CandidateSet(r1, r2, r1Score, r2Score);
  assert.equal(r4.length, 4);
  assert.ok(r4.includes('e'), 'a disjoint, lower-scored R2 candidate must still get a slot');
  assert.ok(r4.includes('f'), 'a disjoint, lower-scored R2 candidate must still get a slot');
  assert.ok(r4.includes('a')); // the top r1-only candidate is kept
  assert.ok(!r4.includes('d')); // the weakest r1-only candidate is the one displaced
});

test('r4CandidateSet keeps files both arms agree on first, unconditionally', () => {
  const r4 = m.r4CandidateSet(['a', 'b'], ['b', 'c'], () => 0, (p) => (p === 'c' ? 1 : 0));
  assert.ok(r4.includes('b')); // in both r1 and r2
  assert.equal(r4.length, 2);
});

// ---------------------------------------------------------------------------
// Coverage-vs-size + AUC + matched comparison
// ---------------------------------------------------------------------------

test('coverageVsSize computes coverage as hit rate and mean size as a fraction of in-scope files', () => {
  const rows = [{ hit: true, size: 2 }, { hit: false, size: 4 }, { hit: true, size: 6 }];
  const out = m.coverageVsSize(rows, 10);
  assert.equal(out.n, 3);
  assert.ok(Math.abs(out.coverage - 2 / 3) < 1e-12);
  assert.ok(Math.abs(out.meanSizeFraction - (2 + 4 + 6) / 3 / 10) < 1e-12);
  assert.deepEqual(m.coverageVsSize([], 10), { n: 0, coverage: null, meanSizeFraction: null });
});

test('curveAUC is the exact trapezoidal area under (size, coverage) points, deduping repeated x by averaging y', () => {
  // Two points: (0,0.2) and (1,0.8) -> trapezoid area = (1-0)*(0.2+0.8)/2 = 0.5.
  assert.ok(Math.abs(m.curveAUC([{ x: 0, y: 0.2 }, { x: 1, y: 0.8 }]) - 0.5) < 1e-12);
  // Duplicate x=0.5 averaged to 0.6 before integrating.
  const area = m.curveAUC([{ x: 0, y: 0 }, { x: 0.5, y: 0.4 }, { x: 0.5, y: 0.8 }, { x: 1, y: 1 }]);
  const expected = 0.5 * (0 + 0.6) / 2 + 0.5 * (0.6 + 1) / 2;
  assert.ok(Math.abs(area - expected) < 1e-12);
  assert.equal(m.curveAUC([{ x: 0, y: 1 }]), null); // needs >= 2 distinct points
  assert.equal(m.curveAUC([{ x: 0, y: null }]), null);
});

test('matchedComparison finds the nearest-size (R1, R2) pair and runs a paired sign test over shared commit hashes', () => {
  const configs = [
    { thetaQ: 0.3, thetaF: 0.5, r1: { meanSizeFraction: 0.20, coverage: 0.6 },
      perQuery: [{ hash: 'c1', r1: { hit: true } }, { hash: 'c2', r1: { hit: false } }, { hash: 'c3', r1: { hit: true } }] },
    { thetaQ: 0.7, thetaF: 0.7, r1: { meanSizeFraction: 0.05, coverage: 0.3 },
      perQuery: [{ hash: 'c1', r1: { hit: false } }, { hash: 'c2', r1: { hit: false } }, { hash: 'c3', r1: { hit: false } }] },
  ];
  const r2Points = [{ thetaQ: 0.5, meanSizeFraction: 0.19, coverage: 0.4 }];
  const perQueryByConfigKey = (thetaQ, thetaF, arm) => {
    if (arm === 'r1') return configs.find((c) => c.thetaQ === thetaQ && c.thetaF === thetaF).perQuery.map((q) => ({ hash: q.hash, hit: q.r1.hit }));
    return [{ hash: 'c1', hit: false }, { hash: 'c2', hit: true }, { hash: 'c3', hit: false }];
  };
  const result = m.matchedComparison(configs, r2Points, perQueryByConfigKey);
  assert.deepEqual(result.r1Config, { thetaQ: 0.3, thetaF: 0.5 }); // closer size (0.20 vs 0.19) than the 0.05 config
  assert.equal(result.r2ThetaQ, 0.5);
  // c1: r1 hit, r2 miss -> r1 better. c2: r1 miss, r2 hit -> r2 better. c3: r1 hit, r2 miss -> r1 better.
  assert.equal(result.signTest.r1Better, 2);
  assert.equal(result.signTest.r2Better, 1);
  assert.equal(result.signTest.tied, 0);
  assert.equal(result.signTest.p, m.signTest(2, 1));
});

// ---------------------------------------------------------------------------
// Corpus: end-to-end on a throwaway git repo (never touches /root/sextant).
// ---------------------------------------------------------------------------

test('buildRepoCorpus picks the 60th-percentile non-merge commit, filters scope, redacts, and removes its worktree', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'role-map-corpus-'));
  try {
    const bareSource = path.join(scratch, 'source');
    fs.mkdirSync(bareSource);
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
    git(bareSource, 'init', '-q');
    git(bareSource, '-c', 'user.email=t@t', '-c', 'user.name=t', 'config', 'commit.gpgsign', 'false');
    fs.mkdirSync(path.join(bareSource, 'lib'));
    fs.mkdirSync(path.join(bareSource, 'test'));
    const commitAt = (n, write) => {
      write();
      git(bareSource, 'add', '.');
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', `commit ${n}`], {
        cwd: bareSource, encoding: 'utf8',
        env: { ...process.env, GIT_AUTHOR_DATE: `2026-01-0${n}T00:00:00`, GIT_COMMITTER_DATE: `2026-01-0${n}T00:00:00` },
      });
    };
    const bigEnough = (name, seed) => Array.from({ length: 15 }, (_, i) => `${name}_line_${i} = ${seed + i};`).join('\n') + '\n';
    commitAt(1, () => fs.writeFileSync(path.join(bareSource, 'lib/a.js'), bigEnough('a', 1)));
    commitAt(2, () => fs.writeFileSync(path.join(bareSource, 'lib/b.js'), bigEnough('b', 2)));
    commitAt(3, () => fs.writeFileSync(path.join(bareSource, 'lib/c.js'), `const SECRET = "sk_live_ABCDEFGHIJKL1234";\n${bigEnough('c', 3)}`));
    commitAt(4, () => fs.writeFileSync(path.join(bareSource, 'test/a.test.js'), bigEnough('t', 4))); // excluded: test path
    commitAt(5, () => fs.writeFileSync(path.join(bareSource, 'lib/tiny.js'), 'const x = 1;\n')); // excluded: < 10 lines
    // Non-merge commits ascending: [1,2,3,4,5] (0-indexed). floor(0.6*4) = 2 -> commit 3 (adds lib/c.js).
    const cloneDir = path.join(scratch, 'clone.git');
    execFileSync('git', ['clone', '--no-checkout', '--shared', bareSource, cloneDir], { encoding: 'utf8' });

    const corpus = m.buildRepoCorpus('clone', scratch, { maxFiles: Infinity });
    assert.equal(corpus.cutoff.subject, 'commit 3');
    assert.equal(corpus.totalNonMergeCommits, 5);
    const paths = corpus.files.map((f) => f.path).sort();
    assert.deepEqual(paths, ['lib/a.js', 'lib/b.js', 'lib/c.js']); // test/a.test.js and tiny.js excluded; b/c not yet committed by commit1 alone
    const c = corpus.files.find((f) => f.path === 'lib/c.js');
    assert.equal(c.redactions, 1);
    assert.ok(!c.source.includes('sk_live_'));
    assert.ok(c.source.includes('[REDACTED:stripe_key]'));

    // Worktree removed; clone kept.
    const worktreeParent = path.join(scratch, 'worktrees');
    const leftoverWorktrees = fs.existsSync(worktreeParent) ? fs.readdirSync(worktreeParent) : [];
    assert.deepEqual(leftoverWorktrees, []);
    assert.ok(fs.existsSync(cloneDir));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('buildRepoCorpus seeded-samples down to maxFiles and records both the true and sampled counts', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'role-map-sample-'));
  try {
    const bareSource = path.join(scratch, 'source');
    fs.mkdirSync(bareSource);
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
    git(bareSource, 'init', '-q');
    const body = Array.from({ length: 15 }, (_, i) => `line_${i} = ${i};`).join('\n') + '\n';
    for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(bareSource, `f${i}.js`), body);
    git(bareSource, 'add', '.');
    git(bareSource, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'all files');
    const cloneDir = path.join(scratch, 'clone.git');
    execFileSync('git', ['clone', '--no-checkout', '--shared', bareSource, cloneDir], { encoding: 'utf8' });

    const corpus = m.buildRepoCorpus('clone', scratch, { maxFiles: 3, seed: 42 });
    assert.equal(corpus.eligibleFileCount, 8);
    assert.equal(corpus.sampledFileCount, 3);
    assert.equal(corpus.sampled, true);
    assert.equal(corpus.files.length, 3);
    const again = m.buildRepoCorpus('clone', scratch, { maxFiles: 3, seed: 42 });
    assert.deepEqual(again.files.map((f) => f.path), corpus.files.map((f) => f.path)); // deterministic for a fixed seed
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// End-to-end Stage A pipeline with a mocked client: freeze -> live -> report.
// ---------------------------------------------------------------------------

function mockJevClient(scorer) {
  let calls = 0;
  return {
    calls: () => calls,
    async systemOne(request) {
      calls += 1;
      const answers = {};
      for (const [key, q] of Object.entries(request.questions)) {
        if (q.type === 'noul') {
          answers[key] = { type: 'noul', noul: scorer(key, request) };
        } else if (q.type === 'choice') {
          const keys = Object.keys(q.criteria);
          const scored = keys.map((k) => ({ k, s: scorer(`${key}.${k}`, request) }));
          const total = scored.reduce((s, x) => s + x.s, 0) || 1;
          const probabilities = Object.fromEntries(scored.map((x) => [x.k, x.s / total]));
          const best = scored.slice().sort((a, b) => b.s - a.s)[0];
          answers[key] = { type: 'choice', choice: best.k, confidence: 0.9, probabilities };
        }
      }
      return { model: 'jev-1.13.0', usage: { input_tokens: 42, output_tokens: 2 }, answers };
    },
  };
}

test('Stage A pipeline (freeze -> live -> report) tags a persistence-shaped file correctly end to end with a mocked client', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'role-map-stageA-'));
  try {
    const persistenceSrc = Array.from({ length: 12 }, (_, i) => `# line ${i}`).join('\n')
      + '\nimport sqlite3\ndef save(row):\n    conn = sqlite3.connect("x.db")\n    conn.execute("INSERT INTO t VALUES (?)", (row,))\n';
    const corpus = {
      repo: 'testrepo', cutoff: { hash: 'deadbeef', unixSeconds: 1, subject: 'test' },
      totalNonMergeCommits: 1, eligibleFileCount: 1, sampledFileCount: 1, sampled: false, seed: 20260925, totalRedactions: 0, oversizedExcluded: 0,
      files: [{ path: 'app/store.py', ext: 'py', lines: persistenceSrc.split('\n').length, bytes: Buffer.byteLength(persistenceSrc),
        sha256: 'x', redactions: 0, source: persistenceSrc }],
    };
    fs.mkdirSync(path.join(dir, 'corpus'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'corpus', 'testrepo.json'), JSON.stringify(corpus));

    await m.stageAFreezeMode(dir, { repo: 'testrepo' });
    // Scorer: strongly favors "persistence" (both as a Noul role and as a Choice option), weakly everything else.
    const scorer = (key) => {
      if (key === 'role_persistence') return 0.95;
      if (key.startsWith('role_')) return 0.05;
      if (key === 'group.infrastructure') return 0.7;
      if (key.startsWith('group.')) return 0.1;
      if (key === 'leaf_infrastructure.persistence') return 0.8;
      if (key.startsWith('leaf_infrastructure.')) return 0.05;
      return 0.1;
    };
    const client = mockJevClient(scorer);
    const liveResult = await m.stageALiveMode(dir, { repo: 'testrepo', client, concurrency: 2 });
    assert.equal(liveResult.testrepo.jobs, 1);
    assert.equal(liveResult.testrepo.clientRejections, 0);
    assert.equal(liveResult.testrepo.providerFailures, 0);
    assert.equal(client.calls(), 2); // one combined tagging call + one leaf call

    const report = m.stageAReportMode(dir, { repo: 'testrepo' });
    const repoReport = report.repos[0];
    assert.equal(repoReport.withA1, 1);
    assert.equal(repoReport.withA2, 1);
    assert.equal(repoReport.roleTable.persistence.detectorPositives, 1); // sqlite3 + .execute(SQL)
    assert.equal(repoReport.roleTable.persistence.a1RecallOnPositives, 1); // Jev's role_persistence (0.95) >= 0.5
    assert.equal(repoReport.agreement.pairs, 1);
    assert.equal(repoReport.agreement.a2LeafInA1Positives, 1); // A2 chose infrastructure/persistence, which A1 also flags positive

    const review = JSON.parse(fs.readFileSync(path.join(dir, 'review.json'), 'utf8'));
    assert.equal(review.files.length, 1);
    assert.equal(review.files[0].a2.leaf, 'persistence');

    // Resuming stageA-live with a client that would throw makes no new calls.
    const throwingClient = { systemOne: async () => { throw new Error('should not be called'); } };
    const resumed = await m.stageALiveMode(dir, { repo: 'testrepo', client: throwingClient });
    assert.equal(resumed.testrepo.jobs, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stageALiveMode records a client rejection separately from a provider failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'role-map-stageA-fail-'));
  try {
    const src = Array.from({ length: 12 }, (_, i) => `x${i} = ${i}`).join('\n');
    const corpus = { repo: 'testrepo', cutoff: { hash: 'deadbeef', unixSeconds: 1, subject: 'test' },
      totalNonMergeCommits: 1, eligibleFileCount: 1, sampledFileCount: 1, sampled: false, seed: 1, totalRedactions: 0, oversizedExcluded: 0,
      files: [{ path: 'a.js', ext: 'js', lines: 12, bytes: Buffer.byteLength(src), sha256: 'x', redactions: 0, source: src }] };
    fs.mkdirSync(path.join(dir, 'corpus'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'corpus', 'testrepo.json'), JSON.stringify(corpus));
    await m.stageAFreezeMode(dir, { repo: 'testrepo' });
    const { JevError } = require('./client');
    const client = { systemOne: async () => { throw new JevError('bad contract', { code: 'invalid_contract' }); } };
    const result = await m.stageALiveMode(dir, { repo: 'testrepo', client });
    assert.equal(result.testrepo.clientRejections, 1);
    assert.equal(result.testrepo.providerFailures, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// End-to-end Stage B pipeline smoke test (real disposable git repo + mocked client).
// ---------------------------------------------------------------------------

test('Stage B pipeline (freeze -> live -> report) wires corpus + git history + arms into a coverage-vs-size report', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'role-map-stageB-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'role-map-stageB-dir-'));
  try {
    const bareSource = path.join(scratch, 'source');
    fs.mkdirSync(bareSource);
    const git = (...args) => execFileSync('git', args, { cwd: bareSource, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'commit.gpgsign', 'false');
    fs.mkdirSync(path.join(bareSource, 'lib'));
    fs.mkdirSync(path.join(bareSource, 'commands'));
    const body = (name, n) => Array.from({ length: 12 }, (_, i) => `${name}_${i} = ${n + i}`).join('\n') + '\n';
    const commitAt = (n, write) => {
      write();
      git('add', '.');
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', `commit ${n}`], {
        cwd: bareSource, encoding: 'utf8',
        env: { ...process.env, GIT_AUTHOR_DATE: `2026-01-0${n}T00:00:00`, GIT_COMMITTER_DATE: `2026-01-0${n}T00:00:00` },
      });
    };
    // Pre-cutoff: establishes the corpus. Post-cutoff: the query dataset.
    commitAt(1, () => fs.writeFileSync(path.join(bareSource, 'lib/store.js'), body('store', 1)));
    commitAt(2, () => fs.writeFileSync(path.join(bareSource, 'lib/scoring.js'), body('scoring', 2)));
    commitAt(3, () => fs.writeFileSync(path.join(bareSource, 'commands/cli.js'), body('cli', 3))); // T = floor(0.6*2)=1 -> commit 2
    commitAt(4, () => fs.writeFileSync(path.join(bareSource, 'lib/store.js'), body('store', 40))); // post-cutoff query 1
    commitAt(5, () => fs.writeFileSync(path.join(bareSource, 'commands/cli.js'), body('cli', 50))); // post-cutoff query 2 (in-scope at T)
    // Rewrite commit subjects to be clean, leak-free prose (git commit -m used the templated subject already).
    const cloneDir = path.join(scratch, 'testrepo.git');
    execFileSync('git', ['clone', '--no-checkout', '--shared', bareSource, cloneDir], { encoding: 'utf8' });

    const corpus = m.buildRepoCorpus('testrepo', scratch, {});
    assert.equal(corpus.cutoff.subject, 'commit 3'); // floor(0.6*(5-1))=2 -> 0-indexed 3rd non-merge commit
    fs.mkdirSync(path.join(dir, 'corpus'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'corpus', 'testrepo.json'), JSON.stringify(corpus));

    await m.stageAFreezeMode(dir, { repo: 'testrepo' });
    const scorer = (key) => {
      if (key === 'role_persistence') return 0.9;
      if (key.startsWith('role_')) return 0.05;
      if (key === 'group.infrastructure') return 0.7;
      if (key.startsWith('group.')) return 0.1;
      if (key.startsWith('leaf_infrastructure.persistence')) return 0.8;
      if (key.startsWith('leaf_')) return 0.05;
      return 0.1;
    };
    await m.stageALiveMode(dir, { repo: 'testrepo', client: mockJevClient(scorer), concurrency: 2 });

    const freezeResult = await m.stageBFreezeMode(dir, { repo: 'testrepo', scratch });
    assert.ok(freezeResult.testrepo.postCutoffCommits >= 2);

    const roleDirScorer = (key) => {
      if (key === 'role_persistence') return 0.8;
      if (key.startsWith('role_')) return 0.05;
      if (key.startsWith('dir_')) return 0.6;
      return 0.1;
    };
    const liveResult = await m.stageBLiveMode(dir, { repo: 'testrepo', client: mockJevClient(roleDirScorer), concurrency: 2 });
    assert.equal(liveResult.testrepo.clientRejections, 0);
    assert.equal(liveResult.testrepo.providerFailures, 0);

    const report = m.stageBReportMode(dir, { repo: 'testrepo' });
    const repoReport = report.perRepo[0];
    assert.equal(repoReport.repo, 'testrepo');
    assert.ok(repoReport.queriesScored >= 1);
    assert.equal(repoReport.curve.length, 6); // 3 thetaQ x 2 thetaF
    assert.equal(repoReport.r2Curve.length, 3);
    for (const c of repoReport.curve) {
      assert.ok(c.r1.meanSizeFraction === null || (c.r1.meanSizeFraction >= 0 && c.r1.meanSizeFraction <= 1));
    }
    // matched comparison exists and its sign test is internally consistent
    if (repoReport.matched) {
      const { r1Better, r2Better, tied } = repoReport.matched.signTest;
      assert.equal(r1Better + r2Better + tied <= repoReport.queriesScored, true);
    }
    assert.ok(fs.existsSync(path.join(dir, 'stageB-report.json')));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
