'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cr = require('./context-rule');

test('keyword baselines: plain keyword, and the negation guard', () => {
  assert.equal(cr.keywordVerdict(['please commit this'], 'commit'), true);
  assert.equal(cr.keywordVerdict(["don't commit yet"], 'commit'), true);
  assert.equal(cr.keywordVerdict(["don't commit yet"], 'commit', { negationAware: true }), false);
  assert.equal(cr.keywordVerdict(["don't commit yet", 'ok commit it'], 'commit', { negationAware: true }), true);
  assert.equal(cr.keywordVerdict(['save this to git'], 'commit'), false);
  assert.equal(cr.keywordVerdict(['open a PR for this'], 'push'), true);
  assert.equal(cr.keywordVerdict(['fix the prompt'], 'push'), false);
});

test('userTexts keeps typed prompts and question answers, and drops harness noise', () => {
  const user = content => ({ type: 'user', message: { role: 'user', content } });
  assert.deepEqual(cr.userTexts(user('commit it <system-reminder>x</system-reminder>')), ['commit it']);
  assert.deepEqual(cr.userTexts(user([{ type: 'tool_result', content: 'Your questions have been answered: "Commit?"="Commit"' }])),
    ['[answer to a question the assistant asked] Your questions have been answered: "Commit?"="Commit"']);
  assert.deepEqual(cr.userTexts(user([{ type: 'tool_result', content: 'total 12\ndrwx' }])), []);
  assert.deepEqual(cr.userTexts(user('<task-notification><task-id>a</task-id></task-notification>')), []);
  assert.deepEqual(cr.userTexts({ ...user('hi'), isSidechain: true }), []);
});

test('windows are taken at Bash commands in allowlisted repos and marked when a commit follows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-rule-'));
  const line = record => JSON.stringify(record);
  const bash = (cwd, command) => ({ type: 'assistant', cwd, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
  fs.mkdirSync(path.join(root, 'p'));
  fs.writeFileSync(path.join(root, 'p', 's.jsonl'), [
    line({ type: 'user', message: { role: 'user', content: 'run the tests' } }), line(bash('/repo/a', 'npm test')),
    line({ type: 'user', message: { role: 'user', content: 'commit it' } }), line(bash('/repo/a', 'git commit -F m.txt')), line(bash('/elsewhere', 'git push')),
  ].join('\n'));
  const found = cr.windows({ projectsRoot: root, roots: ['/repo/a'] });
  assert.deepEqual(found, [{ messages: ['run the tests'], at: {} }, { messages: ['run the tests', 'commit it'], at: { commit: true } }]);
});

test('score counts each kind of error and runs the sign test against the better baseline', () => {
  const item = (gold, jev, keyword, keywordNeg) => ({ gold, jev, keyword, keywordNeg });
  const out = cr.score([item(true, 0.9, false, false), item(false, 0.1, true, false), item(false, 0.8, false, false)]);
  assert.deepEqual(out.jev, { correct: 2, wronglyAuthorized: 1, wronglyRefused: 0 });
  assert.equal(out.bestBaseline, 'keywordNeg');
  assert.deepEqual([out.jevOnlyRight, out.baselineOnlyRight], [1, 1]);
});
