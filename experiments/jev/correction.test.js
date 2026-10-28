'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const co = require('./correction');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'correction-'));
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n');
const user = (text, cwd = '/r/a') => ({ type: 'user', cwd, message: { content: text } });
const said = text => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

test('units are typed messages after assistant text, inside the allowed roots, never from somaNotes or subagents', () => {
  const root = tmp();
  const session = reply => jsonl([
    user('start the parser work'),
    said('I edited x.js'),
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } },
    user(reply),
    { type: 'user', cwd: '/r/a', message: { content: [{ type: 'tool_result', content: 'Your questions have been answered: "Which?"="A"' }] } },
    user('now run the tests', '/elsewhere'),
  ]);
  // Each file says something different, so a leak cannot hide behind de-duplication.
  for (const [dir, reply] of [['-r-a', 'no, the other file'], ['-root-somaNotes', 'no, the third file'], [path.join('-r-a', 's', 'subagents'), 'no, the fourth file']]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, 's.jsonl'), session(reply));
  }
  assert.deepEqual(co.units({ projectsRoot: root, roots: ['/r/a'] }), [{ assistant: 'I edited x.js', user: 'no, the other file' }]);
});

test('the confirmation reads only messages after its start and drops relayed and harness turns', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '-r-a'));
  fs.writeFileSync(path.join(root, '-r-a', 's.jsonl'), jsonl([
    said('I edited x.js'),
    { ...user('no, before the start'), timestamp: '2026-10-28T15:00:00.000Z' },
    { ...user('Another Claude session sent a message: the fix is wrong'), timestamp: '2026-10-29T10:00:00.000Z' },
    { ...user('no, after the start'), timestamp: '2026-10-29T10:01:00.000Z' },
  ]));
  const opts = { projectsRoot: root, roots: ['/r/a'], since: co.CONFIRM.since, dropNonHuman: true, now: Date.parse('2026-11-11T00:00:00Z') + 0 };
  fs.utimesSync(path.join(root, '-r-a', 's.jsonl'), new Date('2026-11-10'), new Date('2026-11-10'));
  assert.deepEqual(co.units(opts).map(u => u.user), ['no, after the start']);
});

test('freeze drops credential-shaped units and gives labelers texts only', () => {
  const outDir = tmp();
  const manifest = co.freeze({ outDir, all: [{ assistant: 'done', user: 'no, revert that' }, { assistant: 'done', user: 'use the api_key from before' }] });
  assert.deepEqual(manifest.counts, { units: 2, droppedSensitive: 1, sampled: 1, redactions: 0 });
  const tasks = JSON.parse(fs.readFileSync(path.join(outDir, 'label-tasks.json'), 'utf8'));
  assert.deepEqual(tasks, [{ id: 'c-0', assistant: 'done', user: 'no, revert that' }]);
});

test('report scores only units both labelers agree on and tests Jev against the regex on disagreements', () => {
  const outDir = tmp();
  const cases = [
    ['c-0', 'no, revert that', true, true, 0.9], // both right
    ['c-1', 'you missed the second file', true, true, 0.8], // Jev only right
    ['c-2', 'the header is still wrong', true, true, 0.7], // Jev only right
    ['c-3', 'great, now the tests', false, false, 0.1], // both right
    ['c-4', 'no rush, do the docs next', false, false, 0.2], // Jev only right (regex fires on "no ")
    ['c-5', 'that is off', true, false, 0.9], // labelers disagree: unclear
    ['c-6', 'Another Claude session sent a message: the fix is wrong', false, false, 0.9], // not typed by the person; Jev wrong
  ];
  fs.writeFileSync(path.join(outDir, 'frozen.json'), JSON.stringify({ manifest: { prereg: {}, counts: {} }, cases: cases.map(([id, text]) => ({ id, assistant: 'x', user: text })) }));
  fs.writeFileSync(path.join(outDir, 'labels-a.json'), JSON.stringify(Object.fromEntries(cases.map(([id, , a]) => [id, a]))));
  fs.writeFileSync(path.join(outDir, 'labels-b.json'), JSON.stringify(Object.fromEntries(cases.map(([id, , , b]) => [id, b]))));
  fs.writeFileSync(path.join(outDir, 'jev.jsonl'), jsonl(cases.map(([id, , , , noul]) => ({ id, response: { answers: { correction: { noul } }, usage: { input_tokens: 10 } } }))));
  const r = co.report({ outDir });
  assert.equal(r.n, 6);
  assert.deepEqual(r.labels, { bothBoolean: 7, agreed: 6, kappa: r.labels.kappa, unclear: 1, corrections: 3 });
  assert.deepEqual([r.jev.correct, r.regex.correct, r.jevOnlyRight, r.regexOnlyRight], [5, 3, 3, 1]);
  assert.equal(r.signTestP, 0.625);
  assert.equal(r.verdict, 'NOT ESTABLISHED');
  // Without the relayed message: Jev 5 of 5, the regex 2 of 5.
  assert.deepEqual([r.humanTyped.n, r.humanTyped.jev.correct, r.humanTyped.regex.correct, r.humanTyped.signTestP], [5, 5, 2, 0.25]);
});

test('kappa is 1 for identical labels and 0 when agreement is what chance gives', () => {
  assert.equal(co.kappa([[true, true], [false, false]]), 1);
  assert.equal(co.kappa([[true, true], [true, false], [false, true], [false, false]]), 0);
});

test('the held-out snapshot keeps only units the first freeze never sampled, and is written once', () => {
  const firstDir = tmp();
  const file = path.join(tmp(), 'heldout.json');
  fs.writeFileSync(path.join(firstDir, 'frozen.json'), JSON.stringify({ cases: [{ id: 'c-0', assistant: 'done', user: 'no, revert that' }] }));
  const all = [{ assistant: 'done', user: 'no, revert that' }, { assistant: 'done', user: 'wrong file' }, { assistant: 'done', user: 'my api_key is x' }];
  assert.deepEqual(co.snapshotHeldout({ firstDir, file, all }), { written: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [{ assistant: 'done', user: 'wrong file' }]);
  assert.deepEqual(co.snapshotHeldout({ firstDir, file, all: [] }), { kept: 1 });
});
