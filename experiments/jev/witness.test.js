'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const w = require('./witness');

test('hitAtK is exact under random tie-breaking', () => {
  const tied = [{ score: 0, label: true }, { score: 0, label: false }, { score: 0, label: false }, { score: 0, label: false }];
  assert.equal(w.hitAtK(tied, 1), 0.25);
  assert.ok(Math.abs(w.hitAtK(tied, 3) - 0.75) < 1e-12);
  assert.equal(w.hitAtK(tied, 4), 1);
  const ordered = [{ score: 3, label: false }, { score: 2, label: true }, { score: 1, label: false }];
  assert.equal(w.hitAtK(ordered, 1), 0);
  assert.equal(w.hitAtK(ordered, 2), 1);
  // A strictly higher negative group fills the room before the tied group is drawn from.
  const mixed = [{ score: 5, label: false }, { score: 1, label: true }, { score: 1, label: false }];
  assert.equal(w.hitAtK(mixed, 2), 0.5);
  assert.equal(w.hitAtK([{ score: 1, label: false }], 1), 0);
});

test('reciprocal rank averages over tie orders', () => {
  const tied = Array.from({ length: 4 }, (_, i) => ({ score: 0, label: i === 0 }));
  assert.ok(Math.abs(w.reciprocalRank(tied) - (1 + 1 / 2 + 1 / 3 + 1 / 4) / 4) < 1e-12);
  assert.equal(w.reciprocalRank([{ score: 2, label: false }, { score: 1, label: true }]), 0.5);
});

test('sign test is the exact two-sided binomial', () => {
  assert.equal(w.signTest(0, 0), null);
  assert.equal(w.signTest(5, 5), 1);
  assert.ok(Math.abs(w.signTest(9, 1) - 22 / 1024) < 1e-12);
  assert.ok(Math.abs(w.signTest(1, 9) - 22 / 1024) < 1e-12);
});

test('auc counts ties as half and is null without both classes', () => {
  assert.equal(w.auc([{ score: 1, label: true }, { score: 0, label: false }]), 1);
  assert.equal(w.auc([{ score: 0, label: true }, { score: 0, label: false }]), 0.5);
  assert.equal(w.auc([{ score: 0, label: true }]), null);
});

test('site enumeration mutates only named-function operators, never require specifiers or commented gaps', () => {
  const src = [
    "const x = require('./a' + '');",
    'function keep(a, b) {',
    '  if (!a.ok) return a === b && true;',
    '  return a /* - */ - b + 2;',
    '}',
    'const top = 1 + 2;',
  ].join('\n');
  const sites = w.enumerateSites('lib/s.js', src);
  const ops = sites.map(s => s.op).sort();
  assert.deepEqual(ops, ['+->-', '2->3', '===->!==', '&&->||', 'drop-!', 'true->false'].sort());
  assert.ok(sites.every(s => s.fn === 'keep'));
  const drop = sites.find(s => s.op === 'drop-!');
  const mutated = w.applyMutant(src, { ...drop, id: 'd' });
  assert.match(mutated, /if \(\(a\.ok\)\) return/);
  // A stale mutant must not silently apply to different source.
  assert.throws(() => w.applyMutant(src.replace('keep', 'kept'), { ...drop, id: 'd' }), /no longer applies/);
});

test('coverage lookup uses the innermost enclosing range across processes', () => {
  const functions = [{ ranges: [{ startOffset: 0, endOffset: 100, count: 1 }, { startOffset: 40, endOffset: 60, count: 0 }] }];
  const index = new Map([['test/a.test.js', new Map([['lib/a.js', [functions]]])]]);
  assert.equal(w.executed(index, 'test/a.test.js', 'lib/a.js', 10), true);
  assert.equal(w.executed(index, 'test/a.test.js', 'lib/a.js', 50), false);
  const second = [{ ranges: [{ startOffset: 0, endOffset: 100, count: 1 }, { startOffset: 40, endOffset: 60, count: 2 }] }];
  index.get('test/a.test.js').set('lib/a.js', [functions, second]);
  assert.equal(w.executed(index, 'test/a.test.js', 'lib/a.js', 50), true);
  assert.equal(w.executed(index, 'test/b.test.js', 'lib/a.js', 50), false);
});

// End to end on a throwaway repo: execution labels, restore, frozen requests, mocked live, report.
test('pipeline labels real kills, restores the worktree, and scores arms from execution', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-'));
  const dir = path.join(work, '.out');
  const git = (...args) => execFileSync('git', args, { cwd: work, encoding: 'utf8' });
  fs.mkdirSync(path.join(work, 'lib'));
  fs.mkdirSync(path.join(work, 'test'));
  fs.writeFileSync(path.join(work, 'lib/a.js'), 'function isBig(n) {\n  return n > 10;\n}\nmodule.exports = { isBig };\n');
  fs.writeFileSync(path.join(work, 'test/a.test.js'), "const t = require('node:test');\nconst assert = require('node:assert');\nconst { isBig } = require('../lib/a');\nt('big', () => { assert.equal(isBig(11), true); assert.equal(isBig(10), false); });\n");
  fs.writeFileSync(path.join(work, 'test/b.test.js'), "const t = require('node:test');\nt('unrelated', () => {});\n");
  fs.writeFileSync(path.join(work, '.gitignore'), '.out/\n');
  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');

  const base = await w.main(['baseline', '--work', work, '--dir', dir, '--concurrency', '2']);
  assert.equal(base.eligible, 2);
  const m = await w.main(['mutants', '--work', work, '--dir', dir, '--n', '5']);
  assert.equal(m.chosen, 1); // one site per function
  const mutants = JSON.parse(fs.readFileSync(path.join(dir, 'mutants.json'), 'utf8')).mutants;
  assert.equal(mutants[0].fn, 'isBig');
  await w.main(['label', '--work', work, '--dir', dir, '--concurrency', '2']);
  const labels = fs.readFileSync(path.join(dir, 'labels.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  // `>` -> `>=` and `10` -> `11` are both caught by isBig(10) / isBig(11); the unrelated file never fails.
  assert.deepEqual(labels[0].kills, ['test/a.test.js']);
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '');
  assert.equal(fs.readFileSync(path.join(work, 'lib/a.js'), 'utf8').includes('n > 10'), true);

  const collected = await w.main(['collect', '--work', work, '--dir', dir]);
  assert.equal(collected.killed, 1);
  assert.equal(collected.shortlistRecall, 1);
  const frozen = JSON.parse(fs.readFileSync(path.join(dir, 'frozen.json'), 'utf8'));
  const task = frozen.tasks[0];
  const feature = task.features.find(f => f.file === 'test/a.test.js');
  assert.equal(feature.direct, true);
  assert.equal(feature.covered, true);
  assert.equal(task.features.find(f => f.file === 'test/b.test.js').covered, false);
  assert.ok(task.request.questions.fails_t01);
  assert.equal(task.request.state.test_files.t01.path, 'test/a.test.js');

  // Mocked provider: the first shortlisted file gets p = 0.9, every other 0.1.
  const responses = [];
  for (const t of frozen.tasks) {
    const answers = Object.fromEntries(Object.keys(t.request.questions).map(k => [k, { type: 'noul', noul: k === 'fails_t01' ? 0.9 : 0.1 }]));
    responses.push({ id: t.id, ms: 5, response: { model: 'jev-1.13.0', usage: { input_tokens: 50, output_tokens: 1 }, answers } });
  }
  fs.writeFileSync(path.join(dir, 'jev.jsonl'), responses.map(r => JSON.stringify(r)).join('\n') + '\n');
  const report = await w.main(['report', '--dir', dir]);
  assert.equal(report.killedMutants, 1);
  assert.equal(report.arms.jev.hit1, 1);
  assert.equal(report.arms.random.hit1, 0.5);
  assert.equal(report.arms.coverage.hit1, 1);
  assert.equal(report.inputTokens, 50);
  fs.rmSync(work, { recursive: true, force: true });
});

test('the live checkout is never accepted as a mutation worktree', async () => {
  await assert.rejects(w.main(['label', '--work', path.resolve(__dirname, '../..')]), /Refusing to mutate the live checkout/);
});

test('operator sites check execution at the expression start, where V8 counts the left operand', () => {
  const src = 'function f(r) {\n  return Number(r.c || 0);\n}\n';
  const site = w.enumerateSites('lib/f.js', src).find(s => s.op === '||->&&');
  assert.equal(src.slice(site.start, site.end), '||');
  assert.equal(src.slice(site.execAt, site.execAt + 3), 'r.c');
  const literal = w.enumerateSites('lib/f.js', src).find(s => s.op === '0->1');
  assert.equal(literal.execAt, literal.start);
});

test('excerpts spend their budget on the changed function before module mentions', () => {
  const filler = Array.from({ length: 200 }, (_, i) => `const x${i} = require('../lib/mod'); // padding padding padding`).join('\n');
  const src = `${filler}\nassert.equal(target(1), 2);\n`;
  const out = w.excerpt(src, 'target', '/mod');
  assert.match(out, /target\(1\)/);
  assert.ok(Buffer.byteLength(out) < 1600);
});
