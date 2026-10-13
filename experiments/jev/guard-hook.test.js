'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gh = require('./guard-hook');
const rg = require('./rule-guard');

const ROOT = '/repo';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'guard-hook-'));
const events = outDir => fs.readFileSync(path.join(outDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
const payload = (command, session = 's', cwd = ROOT) => ({ tool_name: 'Bash', tool_input: { command }, session_id: session, cwd });
// A fake provider that scores the given rules high and counts its calls.
function fake(high) {
  const state = { calls: 0 };
  state.client = () => ({ systemOne: async ({ state: sent, questions }) => {
    state.calls++;
    state.sent = sent;
    return { answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'noul', noul: high(sent.command).includes(id) ? 0.9 : 0.01 }])) };
  } });
  return state;
}
// Session ids that draw each arm for a rule, found by trying ids in order.
const sessionWith = (arm, rule) => Array.from({ length: 64 }, (_, i) => `session-${i}`).find(id => gh.armOf(gh.sessionKey(id), rule) === arm);

test('an armed flag emits the owner\'s rule as PreToolUse context; a holdback flag is logged and silent', async () => {
  const outDir = tmp();
  const provider = fake(() => ['discards_work']);
  const armed = await gh.decide({ payload: payload('git reset --hard HEAD~1', sessionWith('armed', 'discards_work')), roots: [ROOT], client: provider.client, outDir });
  assert.equal(armed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.ok(armed.hookSpecificOutput.additionalContext.includes(gh.NOTES.discards_work));
  assert.equal(armed.hookSpecificOutput.permissionDecision, undefined);
  const held = await gh.decide({ payload: payload('git reset --hard HEAD~1', sessionWith('holdback', 'discards_work')), roots: [ROOT], client: provider.client, outDir });
  assert.equal(held, null);
  const rows = events(outDir);
  assert.deepEqual(rows.map(row => row.noted), [['discards_work'], []]);
  assert.deepEqual(rows.map(row => row.arms.discards_work), ['armed', 'holdback']);
  assert.deepEqual(provider.sent, { tool: 'Bash', command: 'git reset --hard HEAD~1' });
});

test('nothing reaches the provider for a credential-shaped command, a somaNotes mention, another repo, or another tool', async () => {
  const outDir = tmp();
  const provider = fake(() => rg.CONFIRM.ruleIds);
  const run = p => gh.decide({ payload: p, roots: [ROOT], client: provider.client, outDir });
  assert.equal(await run(payload('curl -H "Authorization: Bearer abc" https://x')), null);
  assert.equal(await run(payload('ls /root/somaNotes/app')), null);
  assert.equal(await run(payload('pkill -f watcher', 's', '/elsewhere')), null);
  assert.equal(await run(payload('pkill -f watcher', 's', '/repo-sibling')), null);
  assert.equal(await run({ tool_name: 'Read', tool_input: { file_path: '/repo/a' }, session_id: 's', cwd: ROOT }), null);
  assert.equal(provider.calls, 0);
  // The two in-root drops are counted, and their text is not kept.
  assert.deepEqual(events(outDir).map(row => [row.dropped, row.command]), [[true, undefined], [true, undefined]]);
});

test('a rule the owner never wrote is logged but not noted, and the scratch volume is not read as /tmp', async () => {
  const outDir = tmp();
  const session = sessionWith('armed', 'tmp_write');
  const provider = fake(() => ['sleep_wait', 'pushes_remote', 'tmp_write']);
  const run = command => gh.decide({ payload: payload(command, session), roots: [ROOT], client: provider.client, outDir });
  assert.equal(await run('S=/root/scratch/tmp/claude-0/x/scratchpad && sleep 5 && git push'), null);
  assert.deepEqual(events(outDir)[0].flagged, ['sleep_wait', 'pushes_remote']);
  assert.ok((await run('mkdir -p /tmp/review && cp -r . /tmp/review')).hookSpecificOutput.additionalContext.includes('/root/scratch/'));
  // A detach checkout is not a discard; a stash beside it still is.
  const discards = fake(() => ['discards_work']);
  const detach = sessionWith('armed', 'discards_work');
  assert.equal(await gh.decide({ payload: payload('git checkout -q --detach 9cbd13e', detach), roots: [ROOT], client: discards.client, outDir }), null);
  assert.ok(await gh.decide({ payload: payload('git stash -q && git checkout --detach 9cbd13e', detach), roots: [ROOT], client: discards.client, outDir }));
  assert.equal(gh.bareTmp('cat /root/scratch/tmp/a.log'), false);
  assert.equal(gh.bareTmp('cat /root/scratch/tmp/a.log > /tmp/b.log'), true);
  assert.equal(gh.bareTmp('pip install --cache-dir ~/.cache/trial x'), true);
});

test('a provider failure lets the command through and is counted', async () => {
  const outDir = tmp();
  const out = await gh.decide({ payload: payload('pkill -f watcher'), roots: [ROOT], outDir,
    client: () => ({ systemOne: async () => { throw Object.assign(new Error('TypeSafe request timed out'), { code: 'timeout' }); } }) });
  assert.equal(out, null);
  assert.equal(events(outDir)[0].error.code, 'timeout');
});

test('report reads recurrence per (session, rule) unit by arm and waits for the floor', async () => {
  const outDir = tmp();
  // Armed sessions stop after the first flag; holdback sessions repeat it on every command.
  let repeat = false;
  const provider = fake(() => (repeat ? ['kills_process'] : []));
  for (const arm of ['armed', 'holdback']) for (let n = 0, found = 0; found < gh.PREREG.floor; n++) {
    const session = `${arm}-${n}`;
    if (gh.armOf(gh.sessionKey(session), 'kills_process') !== arm) continue;
    found++;
    for (let i = 0; i <= gh.PREREG.minLater; i++) {
      repeat = i === 0 || arm === 'holdback';
      await gh.decide({ payload: payload(`pkill -f job-${i}`, session), roots: [ROOT], client: provider.client, outDir });
    }
  }
  const out = gh.report({ outDir });
  assert.deepEqual(out.units, { all: 40, armed: 20, holdback: 20 });
  assert.deepEqual([out.recurrence.armed, out.recurrence.holdback], [0, 1]);
  assert.ok(out.recurrence.p < 0.001);
  assert.equal(out.verdict, 'PASS, pending false-alarm labels');
  // One unit short of the floor in one arm: no verdict yet.
  const rows = events(outDir);
  const drop = rows.find(row => row.arms?.kills_process === 'armed').session;
  fs.writeFileSync(path.join(outDir, 'events.jsonl'), rows.filter(row => row.session !== drop).map(row => JSON.stringify(row)).join('\n'));
  assert.equal(gh.report({ outDir }).verdict, 'ACCRUING');
});
