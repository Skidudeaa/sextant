'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const hr = require('./hunk-replay');

function repoWith(commits) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunk-replay-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_AUTHOR_DATE: git.date, GIT_COMMITTER_DATE: git.date } });
  git.date = '2026-01-01T00:00:00Z';
  git('init', '-q');
  git('config', 'user.email', 't@e.com'); git('config', 'user.name', 'T'); git('config', 'commit.gpgsign', 'false');
  commits.forEach(([subject, files], i) => {
    git.date = `2026-01-0${i + 1}T00:00:00Z`;
    for (const [file, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); }
    git('add', '-A'); git('commit', '-q', '-m', subject);
  });
  return dir;
}

const v1 = 'function price(n) {\n  return n * 2;\n}\n\nfunction label(n) {\n  return String(n);\n}\n';
const v2 = 'function price(n) {\n  const rate = n > 10 ? 3 : 2;\n  return n * rate;\n}\n\nfunction label(n) {\n  return `#${n}`;\n}\n\nfunction fresh() {\n  return 1;\n}\n';
const v3 = v2.replace('n > 10 ? 3 : 2', 'n >= 10 ? 3 : 2');

test('parseDiff is not fooled by a removed line that starts with "-- "', () => {
  const files = hr.parseDiff('--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1 @@\n--- old comment\n-select 1\n+select 2\n--- a/b.js\n+++ b/b.js\n@@ -3 +3,2 @@\n-x\n+y\n+z\n');
  assert.deepEqual([...files.keys()], ['q.sql', 'b.js']);
  assert.deepEqual(files.get('q.sql'), { added: false, deleted: false, old: [[1, 2]], new: [[1, 1]] });
  assert.deepEqual(files.get('b.js').new, [[3, 2]]);
});

test('SZZ labels the function a later fix rewrote, and only that one', () => {
  const dir = repoWith([
    ['feat: add pricing', { 'lib/shop.js': v1 }],
    ['feat: tiered rate', { 'lib/shop.js': v2 }],
    ['fix: boundary at ten', { 'lib/shop.js': v3 }],
    ['docs: note', { 'README.md': 'x\n' }],
  ]);
  const frozen = hr.freezeRepo({ name: 'fixture', src: dir }, { maxUnits: 10, repoIndex: 0, outDir: path.join(dir, '.out') });
  // 4 commits, cutoff floor(4 * 0.7) = 2: only the root (skipped) and commit 2 can introduce.
  const units = Object.fromEntries(frozen.units.map(unit => [unit.symbol, unit]));
  assert.deepEqual(Object.keys(units).sort(), ['fresh', 'label', 'price']);
  assert.equal(units.price.label, true);
  assert.equal(units.label.label, false);
  assert.equal(units.fresh.label, false);
  assert.equal(units.fresh.ineligible, 'new_function');
  assert.equal(units.price.changedLines, 2);
  assert.equal(units.price.fileChurn, 1);
  assert.deepEqual(units.price.state, { path: 'lib/shop.js', symbol: 'price', before_source: 'function price(n) {\n  return n * 2;\n}', after_source: 'function price(n) {\n  const rate = n > 10 ? 3 : 2;\n  return n * rate;\n}' });
  assert.equal(frozen.counts.eligible.units, 2);
  assert.equal(frozen.counts.eligible.fixed, 1);

  const request = hr.buildRequest('sieve', units.price.state);
  assert.deepEqual(Object.keys(request), ['state', 'questions', 'model']);
  assert.ok(!JSON.stringify(request).includes('label'.concat('":')), 'no label field reaches the provider');
  assert.equal(Object.keys(hr.QUESTIONS.sieve).length, 6);
});

test('a non-fix commit rewriting the same line does not label it', () => {
  const dir = repoWith([
    ['feat: add pricing', { 'lib/shop.js': v1 }],
    ['feat: tiered rate', { 'lib/shop.js': v2 }],
    ['refactor: boundary at ten', { 'lib/shop.js': v3 }],
    ['docs: note', { 'README.md': 'x\n' }],
  ]);
  const frozen = hr.freezeRepo({ name: 'fixture', src: dir }, { maxUnits: 10, repoIndex: 0, outDir: path.join(dir, '.out') });
  assert.equal(frozen.units.filter(unit => unit.label).length, 0);
});

test('stratified concordance compares only pairs in the same repo and size bin', () => {
  const unit = (repo, changedLines, label, score) => ({ repo, changedLines, label, score });
  const result = hr.stratifiedConcordance([
    unit('a', 1, true, 0.9), unit('a', 1, false, 0.1),   // concordant pair
    unit('a', 20, false, 0.99),                          // other size bin: ignored
    unit('b', 1, false, 0.99),                           // other repo: ignored
  ], u => u.score);
  assert.deepEqual(result, { pairs: 1, concordance: 1 });
});
