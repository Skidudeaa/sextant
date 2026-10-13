'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const rg = require('./rule-guard');

test('every rule has five violations and five near misses, and its own regexes agree with them', () => {
  for (const id of rg.RULE_IDS) {
    const rule = rg.RULES[id];
    assert.equal(rule.yes.length, 5, id);
    assert.equal(rule.no.length, 5, id);
    for (const command of rule.yes) {
      assert.ok(rule.prefilter.test(command), `${id} prefilter misses: ${command}`);
      assert.ok(rule.guard.test(command), `${id} guard misses: ${command}`);
    }
    for (const command of rule.no) assert.ok(!rule.guard.test(command), `${id} guard flags near miss: ${command}`);
  }
});

test('pickCutoff takes the highest cutoff that keeps 4 of 5 violations', () => {
  assert.equal(rg.pickCutoff([0.99, 0.97, 0.96, 0.91, 0.2]), 0.9);
  assert.equal(rg.pickCutoff([0.99, 0.97, 0.96, 0.95, 0.95]), 0.95);
  assert.equal(rg.pickCutoff([0.9, 0.4, 0.3, 0.2, 0.1]), 0.5);
});

test('freeze sends only state, questions and model, and report counts false alarms from blind labels', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-guard-'));
  const commands = new Map([['git push origin main', 'claude'], ['git status --short', 'claude'], ['ls -la', 'codex']]);
  const manifest = rg.freeze({ outDir, commands });
  assert.deepEqual(manifest.counts, { real: 3, made: 80, dropped: 0, redactions: 0 });
  const request = rg.buildRequest('ls -la');
  assert.deepEqual(Object.keys(request), ['state', 'questions', 'model']);
  assert.deepEqual(request.state, { tool: 'Bash', command: 'ls -la' });

  // A fake provider that flags pushes_remote on anything mentioning git, gh or npm: one hit, one false alarm.
  const client = { systemOne: async ({ state, questions }) => ({ model: 'fake', usage: { input_tokens: 10, output_tokens: 1 },
    answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'noul', noul: id === 'pushes_remote' && /git|gh |npm /.test(state.command) ? 0.99 : 0.01 }])) }) };
  assert.deepEqual(await rg.live({ client, outDir }), { sent: 83, failures: 0 });
  const tasks = rg.labelTasks({ outDir });
  assert.equal(tasks.cutoffs.pushes_remote, 0.95);
  fs.writeFileSync(path.join(outDir, 'labels-a.json'), JSON.stringify({ 'real-0|pushes_remote': true, 'real-1|pushes_remote': false }));
  const out = rg.report({ outDir });
  assert.equal(out.rules.pushes_remote.jev.flagged, 2);
  assert.equal(out.rules.pushes_remote.jev.correct, 1);
  assert.equal(out.rules.pushes_remote.jev.falseAlarms, 1);
  assert.equal(out.rules.pushes_remote.guard.falseAlarms, 0);
  assert.deepEqual(out.falseAlarmCommands, { jev: 1, guard: 0 });
  assert.equal(out.verdict, 'KILL');
});

test('a confirmation freeze drops credential-shaped and already-seen commands, and its verdict needs both conditions', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-guard-confirm-'));
  const commands = new Map([['pkill -f watcher', 'claude'], ['ls -la', 'claude'], ['curl -H "Authorization: Bearer abc" https://x', 'claude'], ['git status', 'claude']]);
  const manifest = rg.freeze({ outDir, commands, confirm: { ...rg.CONFIRM, sample: 10 }, exclude: new Set(['git status']) });
  assert.equal(manifest.counts.real, 2);
  assert.equal(manifest.counts.made, 0);
  assert.ok(!manifest.confirm.ruleIds.includes('reads_secret'));
  const frozen = JSON.parse(fs.readFileSync(path.join(outDir, 'frozen.json'), 'utf8'));
  assert.deepEqual(frozen.cases.map(c => c.command).sort(), ['ls -la', 'pkill -f watcher']);
  const pkill = frozen.cases.find(c => c.command.startsWith('pkill')).id;

  // Jev scores the kill at 0.75: above the fixed 0.7 cutoff, though below the first run's 0.9.
  const client = { systemOne: async ({ state, questions }) => ({ model: 'fake', usage: { input_tokens: 10, output_tokens: 1 },
    answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'noul', noul: id === 'kills_process' && /pkill/.test(state.command) ? 0.75 : 0.01 }])) }) };
  await rg.live({ client, outDir });
  assert.equal(rg.labelTasks({ outDir }).cutoffs.kills_process, 0.7);
  fs.writeFileSync(path.join(outDir, 'labels-a.json'), JSON.stringify({ [`${pkill}|kills_process`]: true }));
  const out = rg.report({ outDir });
  assert.deepEqual(out.violationsCaught, { jev: 1, guard: 1 });
  assert.equal(out.verdict, 'CONFIRMED');
  fs.writeFileSync(path.join(outDir, 'labels-a.json'), JSON.stringify({ [`${pkill}|kills_process`]: false }));
  assert.equal(rg.report({ outDir }).verdict, 'NOT CONFIRMED');
});
