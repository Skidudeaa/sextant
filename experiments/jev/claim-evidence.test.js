'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  isUserPromptRecord, segmentTurns, extractFinalMessage, splitSentences, isSensitiveSentence,
  heuristicLabel, extractTurnToolEvents, computeTurnContext, evidenceForSentence,
  buildTasksFromTurn, buildRequest, discoverSessionFiles, buildTasksFromCorpus,
  selectSessionsWithinBudget, estimateTokensForTasks, freezeTasks, validateFrozen,
  runFrozen, report, seededSample, main, CLAIM_KIND_CRITERIA, EVIDENCE_KINDS, MODEL,
  // Codex CLI platform
  scanJsString, decodeJsString, extractOrderedInvocations, extractPatchPaths,
  codexOutputChunks, codexChunkIndicatesFailure, parseStandardShellArguments,
  parseStandardApplyPatchArguments, computeCodexTurnContext, codexMessageText,
  isCodexUserPromptRecord, segmentCodexTurns, isCodexFinalMessageCandidate,
  extractCodexFinalMessage, codexCwdMatches, discoverCodexSessionFiles,
  buildCodexTasksFromCorpus,
} = require('./claim-evidence');

// ---------------------------------------------------------------------------
// Synthetic transcript record builders (shapes verified against real
// ~/.claude/projects/-root-sextant/*.jsonl records).
// ---------------------------------------------------------------------------
function userPrompt(text, ts) {
  return { type: 'user', message: { role: 'user', content: text }, timestamp: ts };
}
function userTextBlock(text, ts) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, timestamp: ts };
}
function assistantText(text, ts) {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: ts };
}
function assistantThinking(text, ts) {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }] }, timestamp: ts };
}
function assistantToolUse(id, name, input, ts) {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }, timestamp: ts };
}
function toolResult(id, content, { isError = false, stdout, stderr } = {}, ts) {
  const rec = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }, timestamp: ts };
  if (stdout !== undefined) rec.toolUseResult = { stdout, stderr: stderr || '' };
  return rec;
}
function bullets(lines) { return lines.map(l => `- ${l}`).join('\n'); }

// ---------------------------------------------------------------------------
// Turn segmentation
// ---------------------------------------------------------------------------
test('isUserPromptRecord distinguishes real prompts from tool-result deliveries', () => {
  assert.equal(isUserPromptRecord(userPrompt('fix the bug', 't1')), true);
  assert.equal(isUserPromptRecord(userTextBlock('interrupted', 't2')), true);
  assert.equal(isUserPromptRecord(userPrompt('   ', 't3')), false);
  assert.equal(isUserPromptRecord(toolResult('id1', 'ok', {}, 't4')), false);
  assert.equal(isUserPromptRecord(assistantText('hi', 't5')), false);
  assert.equal(isUserPromptRecord(null), false);
  assert.equal(isUserPromptRecord({ type: 'user', message: { role: 'user' } }), false);
});

test('segmentTurns finds boundaries only at real prompts and runs the last turn to EOF', () => {
  const records = [
    userPrompt('first', 't0'),
    assistantToolUse('a', 'Bash', { command: 'ls' }, 't1'),
    toolResult('a', 'file1', {}, 't2'),
    assistantText('done with first', 't3'),
    userPrompt('second', 't4'),
    assistantText('done with second', 't5'),
  ];
  const turns = segmentTurns(records);
  assert.deepEqual(turns, [{ turnIndex: 0, start: 0, end: 4 }, { turnIndex: 1, start: 4, end: 6 }]);
});

test('extractFinalMessage takes the LAST assistant text block, ignoring thinking and tool-only messages', () => {
  const records = [
    userPrompt('go', 't0'),
    assistantThinking('planning...', 't1'),
    assistantToolUse('a', 'Read', { file_path: '/x' }, 't2'),
    toolResult('a', 'contents', {}, 't3'),
    assistantText('interim update', 't4'),
    assistantToolUse('b', 'Bash', { command: 'ls' }, 't5'),
    toolResult('b', 'ok', {}, 't6'),
    assistantText('final answer', 't7'),
  ];
  const final = extractFinalMessage(records, { start: 0, end: records.length });
  assert.equal(final.text, 'final answer');
  assert.equal(final.timestamp, 't7');
  assert.equal(extractFinalMessage(records, { start: 0, end: 4 }), null); // no text block in range
});

// ---------------------------------------------------------------------------
// Sentence splitting
// ---------------------------------------------------------------------------
test('splitSentences strips fenced code, splits bullets and sentences, and caps length', () => {
  const text = [
    '- Updated foo.js to fix the null check.',
    '- All 3 tests pass. I also ran the linter.',
    '```',
    'const secret = "should not appear";',
    '```',
    'a'.repeat(650),
  ].join('\n');
  const sentences = splitSentences(text);
  assert.ok(sentences.includes('Updated foo.js to fix the null check.'));
  assert.ok(sentences.includes('All 3 tests pass.'));
  assert.ok(sentences.includes('I also ran the linter.'));
  assert.ok(!sentences.some(s => s.includes('should not appear')));
  const long = sentences.filter(s => /^a+$/.test(s));
  assert.equal(long.length, 2);
  assert.equal(long[0].length, 400);
  assert.equal(long[1].length, 250);
});

test('isSensitiveSentence drops email, phone-like, and banned-word sentences only', () => {
  assert.equal(isSensitiveSentence('Contact bob@example.com for details.'), true);
  assert.equal(isSensitiveSentence('Call 555-123-4567 if needed.'), true);
  assert.equal(isSensitiveSentence('The patient record was not touched.'), true);
  assert.equal(isSensitiveSentence('Do not query somaNotes for this.'), true);
  assert.equal(isSensitiveSentence('Updated foo.js to fix the null check.'), false);
  assert.equal(isSensitiveSentence('See docs/047-jev-mechanism-probes.md:120 for detail on commit c85cc9d4.'), false);
});

// ---------------------------------------------------------------------------
// Heuristic labeler
// ---------------------------------------------------------------------------
test('heuristicLabel is a narrow high-precision regex, not a full classifier', () => {
  assert.equal(heuristicLabel('All 3 tests pass.'), 'tests_passed');
  assert.equal(heuristicLabel('12/12 tests passing.'), 'tests_passed');
  assert.equal(heuristicLabel('Next I will update the docs.'), 'hedged_or_planned');
  assert.equal(heuristicLabel("I'll run the tests next."), 'hedged_or_planned');
  assert.equal(heuristicLabel('What would you like to do next?'), null); // "next" mid-sentence, not anchored
  assert.equal(heuristicLabel('Updated foo.js to fix the null check.'), null);
  assert.equal(heuristicLabel('This fixes the bug.'), null);
});

// ---------------------------------------------------------------------------
// Deterministic evidence
// ---------------------------------------------------------------------------
test('evidenceForSentence: tests_passed requires a qualifying run AFTER the last edit that did not fail', () => {
  const turnRecords = [
    assistantToolUse('e1', 'Edit', { file_path: '/repo/lib/foo.js' }, 't1'),
    toolResult('e1', 'ok', {}, 't2'),
    assistantToolUse('b1', 'Bash', { command: 'node --test test/foo.test.js' }, 't3'),
    toolResult('b1', '# pass 3\n# fail 0', { stdout: '# pass 3\n# fail 0' }, 't4'),
  ];
  const ctx = computeTurnContext(extractTurnToolEvents(turnRecords));
  assert.deepEqual(evidenceForSentence('All 3 tests pass.', ctx).tests_passed, 'supported');

  // Test run BEFORE the edit does not count.
  const beforeEdit = [
    assistantToolUse('b1', 'Bash', { command: 'node --test test/foo.test.js' }, 't0'),
    toolResult('b1', '# pass 3\n# fail 0', { stdout: '# pass 3\n# fail 0' }, 't1'),
    assistantToolUse('e1', 'Edit', { file_path: '/repo/lib/foo.js' }, 't2'),
    toolResult('e1', 'ok', {}, 't3'),
  ];
  const ctx2 = computeTurnContext(extractTurnToolEvents(beforeEdit));
  assert.equal(evidenceForSentence('All 3 tests pass.', ctx2).tests_passed, 'unsupported');

  // Failing result -> unsupported.
  const failing = [
    assistantToolUse('e1', 'Edit', { file_path: '/repo/lib/foo.js' }, 't0'),
    toolResult('e1', 'ok', {}, 't1'),
    assistantToolUse('b1', 'Bash', { command: 'npm test' }, 't2'),
    toolResult('b1', '2 failed', { isError: false, stdout: '2 failed, 1 passed' }, 't3'),
  ];
  const ctx3 = computeTurnContext(extractTurnToolEvents(failing));
  assert.equal(evidenceForSentence('All tests pass.', ctx3).tests_passed, 'unsupported');

  // is_error true -> unsupported even without a text marker.
  const errored = [
    assistantToolUse('b1', 'Bash', { command: 'pytest' }, 't0'),
    toolResult('b1', 'boom', { isError: true }, 't1'),
  ];
  const ctx4 = computeTurnContext(extractTurnToolEvents(errored));
  assert.equal(evidenceForSentence('Tests pass.', ctx4).tests_passed, 'unsupported');

  // No edit at all in the turn: any qualifying run anywhere counts (idx > -1).
  const noEdit = [
    assistantToolUse('b1', 'Bash', { command: 'jest' }, 't0'),
    toolResult('b1', 'ok', { stdout: 'Tests: 5 passed, 5 total' }, 't1'),
  ];
  const ctx5 = computeTurnContext(extractTurnToolEvents(noEdit));
  assert.equal(evidenceForSentence('5 tests pass.', ctx5).tests_passed, 'supported');
});

test('evidenceForSentence: command_ran_ok is not_checkable without a backticked command, else substring match', () => {
  const turnRecords = [
    assistantToolUse('b1', 'Bash', { command: 'npm run build --silent' }, 't0'),
    toolResult('b1', 'built', {}, 't1'),
  ];
  const ctx = computeTurnContext(extractTurnToolEvents(turnRecords));
  assert.equal(evidenceForSentence('I ran `npm run build` successfully.', ctx).command_ran_ok, 'supported');
  assert.equal(evidenceForSentence('I ran `npm run lint` successfully.', ctx).command_ran_ok, 'unsupported');
  assert.equal(evidenceForSentence('The build succeeded.', ctx).command_ran_ok, 'not_checkable');
});

test('evidenceForSentence: file_changed matches an edited basename appearing in the sentence text', () => {
  const turnRecords = [
    assistantToolUse('e1', 'MultiEdit', { file_path: '/repo/lib/summary.js' }, 't0'),
    toolResult('e1', 'ok', {}, 't1'),
  ];
  const ctx = computeTurnContext(extractTurnToolEvents(turnRecords));
  assert.equal(evidenceForSentence('Updated summary.js to fix the clamp.', ctx).file_changed, 'supported');
  assert.equal(evidenceForSentence('Updated retrieve.js instead.', ctx).file_changed, 'unsupported');
  const ctxNoEdits = computeTurnContext(extractTurnToolEvents([]));
  assert.equal(evidenceForSentence('Updated summary.js.', ctxNoEdits).file_changed, 'unsupported');
});

test('evidenceForSentence: verified_behavior is weak — any Bash/Read after the last edit, or anywhere if no edit', () => {
  const withRead = [
    assistantToolUse('e1', 'Edit', { file_path: '/repo/x.js' }, 't0'),
    toolResult('e1', 'ok', {}, 't1'),
    assistantToolUse('r1', 'Read', { file_path: '/repo/x.js' }, 't2'),
    toolResult('r1', 'contents', {}, 't3'),
  ];
  assert.equal(evidenceForSentence('This is now verified.', computeTurnContext(extractTurnToolEvents(withRead))).verified_behavior, 'supported');

  const editOnly = [assistantToolUse('e1', 'Edit', { file_path: '/repo/x.js' }, 't0'), toolResult('e1', 'ok', {}, 't1')];
  assert.equal(evidenceForSentence('This is now verified.', computeTurnContext(extractTurnToolEvents(editOnly))).verified_behavior, 'unsupported');

  const noEditWithBash = [assistantToolUse('b1', 'Bash', { command: 'ls' }, 't0'), toolResult('b1', 'ok', {}, 't1')];
  assert.equal(evidenceForSentence('Confirmed the existing behavior.', computeTurnContext(extractTurnToolEvents(noEditWithBash))).verified_behavior, 'supported');
});

// ---------------------------------------------------------------------------
// Task / request construction
// ---------------------------------------------------------------------------
test('buildTasksFromTurn chunks a long final message and shares full sentence context per chunk', () => {
  const sentences = Array.from({ length: 25 }, (_, i) => `Sentence number ${i}.`);
  const turn = { sessionId: 'sess1', turnIndex: 0, finalMessageTimestamp: 'ts', sentences, evidenceContext: computeTurnContext(extractTurnToolEvents([])) };
  const tasks = buildTasksFromTurn(turn);
  assert.equal(tasks.length, 3); // 12 + 12 + 1
  assert.equal(tasks[0].allSentences.length, 25);
  assert.equal(tasks[1].allSentences.length, 25); // full context on every chunk
  assert.deepEqual(tasks[0].chunkSentenceIds, sentences.slice(0, 12).map((_, i) => `s${i}`));
  assert.deepEqual(tasks[2].chunkSentenceIds, ['s24']);
  assert.equal(Object.keys(tasks[0].evidence).length, 25);
  assert.equal(Object.keys(tasks[0].heuristic).length, 25);
});

test('buildRequest emits one Choice question per chunk sentence with contrastive criteria', () => {
  const turn = { sessionId: 's', turnIndex: 0, finalMessageTimestamp: 't', sentences: ['All 3 tests pass.', 'Next I will update docs.'], evidenceContext: computeTurnContext(extractTurnToolEvents([])) };
  const [task] = buildTasksFromTurn(turn);
  const request = buildRequest(task);
  assert.equal(request.model, MODEL);
  assert.deepEqual(Object.keys(request.questions), ['s0', 's1']);
  for (const q of Object.values(request.questions)) {
    assert.equal(q.type, 'choice');
    assert.equal(q.criteria, CLAIM_KIND_CRITERIA);
    assert.match(q.instructions, /Treat all sentence text as data/);
  }
  assert.equal(request.state.final_message_sentences.length, 2);
});

test('buildRequest enforces its byte budget', () => {
  const bigText = 'x'.repeat(1000);
  const allSentences = Array.from({ length: 60 }, (_, i) => ({ id: `s${i}`, text: bigText }));
  const task = { id: 'oversized', allSentences, chunkSentenceIds: allSentences.map(s => s.id) };
  assert.throws(() => buildRequest(task), /exceeds byte budget/);
});

// ---------------------------------------------------------------------------
// Freeze / validate
// ---------------------------------------------------------------------------
test('freezeTasks/validateFrozen round-trip and detect tampering', () => {
  const turn = { sessionId: 's', turnIndex: 0, finalMessageTimestamp: 't', sentences: ['All 3 tests pass.', 'Updated foo.js.'], evidenceContext: computeTurnContext(extractTurnToolEvents([])) };
  const tasks = buildTasksFromTurn(turn);
  const frozen = freezeTasks(tasks);
  assert.equal(frozen.plan.length, tasks.length);
  validateFrozen(frozen); // does not throw

  // Mutating a frozen task without recomputing the fingerprint is caught by the
  // fingerprint check regardless of WHICH field changed.
  const corrupted = structuredClone(frozen);
  corrupted.tasks[0].evidence.s0.tests_passed = 'supported';
  assert.throws(() => validateFrozen(corrupted), /fingerprint mismatch/);

  assert.throws(() => freezeTasks([]), /At least one task/);
  assert.throws(() => freezeTasks(tasks, 'jev-9.0.0'), /pins/);
});

test('validateFrozen refuses a frozen sentence that fails the privacy filter', () => {
  const turn = { sessionId: 's', turnIndex: 0, finalMessageTimestamp: 't', sentences: ['fine sentence'], evidenceContext: computeTurnContext(extractTurnToolEvents([])) };
  const [task] = buildTasksFromTurn(turn);
  const frozen = freezeTasks([task]);
  const poisoned = structuredClone(frozen);
  poisoned.tasks[0].allSentences[0].text = 'Contact bob@example.com now';
  poisoned.tasks[0].evidence.s0 = { tests_passed: 'unsupported', command_ran_ok: 'not_checkable', file_changed: 'unsupported', verified_behavior: 'unsupported' };
  // Recompute fingerprint the same way freezeTasks does so we hit the PRIVACY check, not the hash check.
  const crypto = require('crypto');
  const jsonHash = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
  const { fingerprint: _drop, ...payload } = poisoned;
  poisoned.fingerprint = jsonHash(payload);
  assert.throws(() => validateFrozen(poisoned), /privacy filter/);
});

// ---------------------------------------------------------------------------
// Corpus discovery — synthetic transcripts on disk, fully offline
// ---------------------------------------------------------------------------
function writeSession(dir, sessionId, records) {
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), records.map(r => JSON.stringify(r)).join('\n') + '\n');
}

test('discoverSessionFiles reads only top-level *.jsonl, structurally excluding subagents/workflows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-claim-corpus-'));
  try {
    writeSession(dir, 'session-a', [userPrompt('hi', 't0')]);
    fs.mkdirSync(path.join(dir, 'session-a', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'session-a', 'subagents', 'agent-x.jsonl'), `${JSON.stringify(userPrompt('SECRET_CANARY', 't0'))}\n`);
    fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'memory', 'notes.md'), '# not jsonl');
    const files = discoverSessionFiles(dir);
    assert.deepEqual(files, [path.join(dir, 'session-a.jsonl')]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('buildTasksFromCorpus segments turns, filters sensitive sentences, and never leaks subagent content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-claim-corpus-'));
  try {
    const records = [
      userPrompt('please fix the bug', 't0'),
      assistantToolUse('e1', 'Edit', { file_path: '/repo/lib/foo.js' }, 't1'),
      toolResult('e1', 'ok', {}, 't2'),
      assistantToolUse('b1', 'Bash', { command: 'node --test test/foo.test.js' }, 't3'),
      toolResult('b1', '# pass 3\n# fail 0', { stdout: '# pass 3\n# fail 0' }, 't4'),
      assistantText(bullets([
        'Updated foo.js to fix the null check.',
        'All 3 tests pass.',
        'I ran `node --test test/foo.test.js` and it succeeded.',
        'This is now verified working.',
        'Contact bob@example.com if this regresses.',
        'The patient data path was never touched.',
      ]), 't5'),
      userPrompt('ok now clean up', 't6'),
      assistantText('```\njust code, no prose\n```', 't7'), // yields zero sentences -> turn excluded
    ];
    writeSession(dir, 'sess-real', records);
    fs.mkdirSync(path.join(dir, 'sess-real', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sess-real', 'subagents', 'agent-x.jsonl'),
      `${JSON.stringify(userPrompt('hi', 't0'))}\n${JSON.stringify(assistantText('SECRET_CANARY should never appear', 't1'))}\n`);

    const { tasks, stats } = buildTasksFromCorpus(dir);
    assert.equal(stats.sessionFilesFound, 1);
    assert.equal(stats.turnsScanned, 2);
    assert.equal(stats.turnsWithSentences, 1); // second turn's final message has no sentences
    assert.equal(stats.sentencesTotal, 4); // 6 bullets minus 2 sensitive ones
    const allText = tasks.flatMap(t => t.allSentences.map(s => s.text)).join(' ');
    assert.ok(!allText.includes('SECRET_CANARY'));
    assert.ok(!allText.includes('bob@example.com'));
    assert.ok(!allText.toLowerCase().includes('patient'));
    assert.ok(allText.includes('All 3 tests pass.'));
    const [task] = tasks;
    assert.equal(task.evidence.s1.tests_passed, 'supported'); // "All 3 tests pass." is sentence index 1 after filtering keeps order
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('selectSessionsWithinBudget deterministically drops whole sessions to fit a token budget', () => {
  const bySession = {
    small: [{ id: 'small:0:0', allSentences: [{ id: 's0', text: 'short claim here.' }], chunkSentenceIds: ['s0'], evidence: {}, heuristic: {} }],
    huge: Array.from({ length: 10 }, (_, i) => ({
      id: `huge:0:${i}`,
      allSentences: Array.from({ length: 12 }, (_, j) => ({ id: `s${j}`, text: 'x'.repeat(300) })),
      chunkSentenceIds: [`s${i % 12}`],
      evidence: {}, heuristic: {},
    })),
  };
  const full = estimateTokensForTasks([...bySession.small, ...bySession.huge], MODEL);
  const budget = estimateTokensForTasks(bySession.small, MODEL) + 10; // just enough for "small" alone
  assert.ok(full > budget);
  const a = selectSessionsWithinBudget(bySession, budget, 42);
  const b = selectSessionsWithinBudget(bySession, budget, 42);
  assert.deepEqual(a, b); // deterministic given the same seed
  assert.ok(a.usedTokens <= budget);
  assert.ok(a.droppedIds.length > 0);
});

test('buildTasksFromCorpus applies the token budget end to end and reports a sampled seed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-claim-corpus-'));
  try {
    const smallText = bullets(['Updated foo.js to fix the bug.']);
    writeSession(dir, 'small-session', [userPrompt('go', 't0'), assistantText(smallText, 't1')]);
    const hugeBullets = bullets(Array.from({ length: 40 }, (_, i) => `Claim number ${i} about some behavior that was allegedly verified and works now.`));
    writeSession(dir, 'huge-session', [userPrompt('go', 't0'), assistantText(hugeBullets, 't1')]);

    const unrestricted = buildTasksFromCorpus(dir);
    assert.equal(unrestricted.stats.sessionsUsed, 2);
    assert.equal(unrestricted.stats.sampledSeed, null);

    const restricted = buildTasksFromCorpus(dir, { budget: 1000, seed: 7 });
    assert.equal(restricted.stats.sessionsUsed, 1);
    assert.deepEqual(restricted.stats.sessionsDropped, ['huge-session']);
    assert.equal(restricted.stats.sampledSeed, 7);
    assert.ok(restricted.stats.estimatedInputTokens <= 1000);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Live run + report (mocked transport)
// ---------------------------------------------------------------------------
function mockAnswer(choice) {
  const criteria = Object.keys(CLAIM_KIND_CRITERIA);
  const probabilities = Object.fromEntries(criteria.map(k => [k, k === choice ? 0.9 : 0.1 / (criteria.length - 1)]));
  return { type: 'choice', choice, confidence: 0.9, probabilities };
}

test('report computes claims-per-kind, unsupported rates, heuristic agreement, and a seeded review sample', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-claim-live-'));
  try {
    const turnRecords = [
      assistantToolUse('e1', 'Edit', { file_path: '/repo/lib/foo.js' }, 't1'),
      toolResult('e1', 'ok', {}, 't2'),
      assistantToolUse('b1', 'Bash', { command: 'npm test' }, 't3'),
      toolResult('b1', 'ok', { stdout: '# pass 3\n# fail 0' }, 't4'),
    ];
    const ctx = computeTurnContext(extractTurnToolEvents(turnRecords));
    const turnSupported = { sessionId: 'sess-a', turnIndex: 0, finalMessageTimestamp: '2026-09-25T00:00:00Z',
      sentences: ['All 3 tests pass.', 'Updated foo.js to fix the null check.'], evidenceContext: ctx };
    const turnUnsupported = { sessionId: 'sess-b', turnIndex: 0, finalMessageTimestamp: '2026-09-25T01:00:00Z',
      sentences: ['All 9 tests pass.'], evidenceContext: computeTurnContext(extractTurnToolEvents([])) };
    const tasks = [...buildTasksFromTurn(turnSupported), ...buildTasksFromTurn(turnUnsupported)];
    const frozen = freezeTasks(tasks);

    const answersByTaskAndId = {
      [tasks[0].id]: { s0: 'tests_passed', s1: 'file_changed' },
      [tasks[1].id]: { s0: 'tests_passed' },
    };
    const client = {
      async systemOne(request) {
        const taskId = frozen.plan.find(p => p.requestHash === require('crypto').createHash('sha256').update(JSON.stringify(request)).digest('hex'))?.id
          ?? Object.keys(answersByTaskAndId).find(id => Object.keys(request.questions).every(q => Object.keys(answersByTaskAndId[id]).includes(q)));
        const answers = Object.fromEntries(Object.keys(request.questions).map(qid => [qid, mockAnswer(answersByTaskAndId[taskId][qid])]));
        return { model: 'jev-test', usage: { input_tokens: 50, output_tokens: 10 }, answers };
      },
    };
    const out = path.join(dir, 'results.jsonl');
    const result = await runFrozen(frozen, out, { client });

    assert.equal(result.status, 'complete');
    assert.equal(result.corpus.sentencesClassified, 3);
    assert.equal(result.claimsPerKind.tests_passed, 2);
    assert.equal(result.claimsPerKind.file_changed, 1);
    assert.equal(result.evidenceByKind.tests_passed.n, 2);
    assert.equal(result.evidenceByKind.tests_passed.supported, 1);
    assert.equal(result.evidenceByKind.tests_passed.unsupported, 1);
    assert.equal(result.evidenceByKind.tests_passed.unsupportedRate, 0.5);
    assert.equal(result.evidenceByKind.file_changed.supported, 1);
    assert.equal(result.unsupportedTestsPassedExamples.length, 1);
    assert.equal(result.unsupportedTestsPassedExamples[0].sessionId, 'sess-b');
    assert.equal(result.unsupportedTestsPassedExamples[0].timestamp, '2026-09-25T01:00:00Z');
    assert.ok(result.unsupportedTestsPassedExamples[0].excerpt.length <= 200);
    // Only the two "N tests pass." sentences match the heuristic; "Updated foo.js..." does not.
    assert.equal(result.heuristicAgreement.n, 2);
    assert.equal(result.heuristicAgreement.agree, 2); // Jev also called both of those tests_passed
    assert.equal(result.heuristicAgreement.agreementRate, 1);
    assert.equal(result.reviewSample.n, 3);

    const fromFile = report(fs.readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse));
    assert.deepEqual(fromFile.claimsPerKind, result.claimsPerKind);
    assert.deepEqual(fromFile.reviewSample, result.reviewSample); // same seed -> same sample, reproducibly

    assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('runFrozen records an error row and a partial summary without leaking the failure detail, and refuses to clobber an existing out file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-claim-live-'));
  try {
    const turn = { sessionId: 's', turnIndex: 0, finalMessageTimestamp: 't', sentences: ['All tests pass.', 'Updated foo.js.'], evidenceContext: computeTurnContext(extractTurnToolEvents([])) };
    const tasks = buildTasksFromTurn(turn);
    const frozen = freezeTasks(tasks);
    let calls = 0;
    const client = { async systemOne() { calls++; throw new Error('SECRET_CANARY_DETAIL'); } };
    const out = path.join(dir, 'r.jsonl');
    await assert.rejects(runFrozen(frozen, out, { client }), /partial evidence retained/);
    const text = fs.readFileSync(out, 'utf8');
    assert.doesNotMatch(text, /SECRET_CANARY_DETAIL/);
    const rows = text.trim().split('\n').map(JSON.parse);
    assert.equal(rows[1].kind, 'error');
    assert.equal(rows.at(-1).kind, 'summary');
    assert.equal(rows.at(-1).status, 'failed-partial');
    assert.equal(calls, 1);
    await assert.rejects(runFrozen(frozen, out, { client }), error => error.code === 'EEXIST');
    assert.equal(calls, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// seededSample determinism
// ---------------------------------------------------------------------------
test('seededSample is deterministic under the same seed and bounded by array length', () => {
  const items = Array.from({ length: 10 }, (_, i) => i);
  assert.deepEqual(seededSample(items, 4, 1), seededSample(items, 4, 1));
  assert.notDeepEqual(seededSample(items, 4, 1), seededSample(items, 4, 2));
  assert.equal(seededSample(items, 100, 1).length, 10);
});

// ---------------------------------------------------------------------------
// CLI argv validation (offline — fails before touching the filesystem)
// ---------------------------------------------------------------------------
test('main rejects an unknown mode and malformed arguments without touching disk', async () => {
  await assert.rejects(main(['bogus']), /Mode must be inspect, freeze, live, or report/);
  await assert.rejects(main(['report']), /report requires --input/);
  await assert.rejects(main(['report', '--input']), /Unknown argument or missing value/);
  await assert.rejects(main(['report', '--input', 'a', '--input', 'b']), /Duplicate argument/);
});

// =============================================================================
// Codex CLI platform (rollout-*.jsonl) — synthetic fixtures mirroring the REAL
// schema inspected against ~/.codex/sessions/**/rollout-*.jsonl (session_meta,
// response_item message/agent_message/custom_tool_call/custom_tool_call_output).
// =============================================================================

// codexExecInput builds payload.input EXACTLY as it appears after Codex's own JSONL
// round-trip: each tools.X("...") argument is a JS double-quoted string literal, so
// content newlines/quotes/backslashes must be escaped ONE level (matching what
// scanJsString/decodeJsString expect to decode back out). Real statements are
// separated by actual newlines (already decoded by the outer JSON.parse), which this
// mirrors by joining with '\n'.
function jsStringEscape(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
function codexExecInput(parts) {
  return parts.map(p => p.kind === 'exec'
    ? `text(await tools.exec_command({cmd:"${jsStringEscape(p.cmd)}","max_output_tokens":3000}));`
    : `text(await tools.apply_patch("${jsStringEscape(p.text)}"));`).join('\n');
}
function codexHeaderItem() { return { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' }; }
function codexOutputItem(obj) { return { type: 'input_text', text: JSON.stringify(obj) }; }

function codexSessionMeta(cwd, ts) {
  return { timestamp: ts, ordinal: 0, type: 'session_meta', payload: { session_id: 'sid', cwd, timestamp: ts } };
}
function codexUserMessage(text, ts) {
  return { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } };
}
function codexDeveloperMessage(text, ts) {
  return { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] } };
}
function codexAgentMessage(text, ts) {
  return { timestamp: ts, type: 'response_item', payload: { type: 'agent_message', content: [{ type: 'input_text', text }] } };
}
function codexAssistantMessage(text, ts) {
  return { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } };
}
function codexExecCall(callId, parts, ts) {
  return { timestamp: ts, type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input: codexExecInput(parts) } };
}
function codexExecOutput(callId, chunkItems, ts) {
  return { timestamp: ts, type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output: [codexHeaderItem(), ...chunkItems] } };
}
function codexBullets(lines) { return lines.map(l => `- ${l}`).join('\n'); }

test('scanJsString/decodeJsString recover a JS double-quoted literal including escaped quotes, backslashes, and newlines', () => {
  const raw = jsStringEscape('line one\nline "two"\nback\\slash');
  const text = `{cmd:"${raw}"}`;
  const quoteIdx = text.indexOf('"');
  const scanned = scanJsString(text, quoteIdx);
  assert.equal(text.slice(scanned.endIdx), '}');
  assert.equal(decodeJsString(scanned.raw), 'line one\nline "two"\nback\\slash');
  assert.equal(scanJsString('"unterminated', 0), null);
});

test('extractOrderedInvocations merges exec_command and apply_patch calls in textual order and flags decode failures', () => {
  const input = codexExecInput([
    { kind: 'patch', text: '*** Begin Patch\n*** Update File: /repo/lib/foo.js\n@@\n-old\n+new\n*** End Patch\n' },
    { kind: 'exec', cmd: 'node --test test/foo.test.js' },
  ]);
  const { invocations, allDecoded } = extractOrderedInvocations(input);
  assert.equal(allDecoded, true);
  assert.deepEqual(invocations.map(i => i.kind), ['patch', 'exec']);
  assert.match(invocations[0].patchText, /Update File: \/repo\/lib\/foo\.js/);
  assert.equal(invocations[1].command, 'node --test test/foo.test.js');

  const broken = `text(await tools.exec_command({cmd:"unterminated`; // no closing quote
  const result = extractOrderedInvocations(broken);
  assert.equal(result.allDecoded, false);
  assert.equal(result.invocations.length, 0);
  assert.deepEqual(extractOrderedInvocations(null), { invocations: [], allDecoded: true });
});

test('extractPatchPaths reads Add/Update/Delete File headers', () => {
  const patch = [
    '*** Begin Patch',
    '*** Add File: /repo/lib/new.js',
    '+content',
    '*** Update File: /repo/lib/existing.js',
    '@@',
    '*** Delete File: /repo/lib/old.js',
    '*** End Patch',
  ].join('\n');
  assert.deepEqual(extractPatchPaths(patch), ['/repo/lib/new.js', '/repo/lib/existing.js', '/repo/lib/old.js']);
  assert.deepEqual(extractPatchPaths(undefined), []);
});

test('codexOutputChunks drops the header item and codexChunkIndicatesFailure reads exit_code first, text markers second', () => {
  const out = { output: [codexHeaderItem(), codexOutputItem({ chunk_id: 'a', exit_code: 0, output: 'ok' }), codexOutputItem({ chunk_id: 'b', exit_code: 1, output: 'boom' })] };
  const chunks = codexOutputChunks(out);
  assert.equal(chunks.length, 2);
  assert.equal(codexChunkIndicatesFailure(chunks[0]), false);
  assert.equal(codexChunkIndicatesFailure(chunks[1]), true);
  assert.equal(codexChunkIndicatesFailure(codexOutputItem({ exit_code: 0, output: '2 failed, 1 passed' }).text), true); // text marker fallback
  assert.equal(codexChunkIndicatesFailure(undefined), false);
  assert.deepEqual(codexOutputChunks(null), []);
  assert.deepEqual(codexOutputChunks({ output: [] }), []);
});

test('computeCodexTurnContext: apply_patch sets editedBasenames and gates test-runner "after the last edit"', () => {
  const turnRecords = [
    codexExecCall('c1', [
      { kind: 'exec', cmd: 'node --test test/foo.test.js' }, // BEFORE the patch — must not count
    ], 't0'),
    codexExecOutput('c1', [codexOutputItem({ chunk_id: '1', exit_code: 0, output: '# pass 3\n# fail 0' })], 't1'),
    codexExecCall('c2', [
      { kind: 'patch', text: '*** Begin Patch\n*** Update File: /repo/lib/foo.js\n@@\n-x\n+y\n*** End Patch\n' },
      { kind: 'exec', cmd: 'node --test test/foo.test.js' }, // AFTER the patch, same call — must count
    ], 't2'),
    codexExecOutput('c2', [codexOutputItem({}), codexOutputItem({ chunk_id: '2', exit_code: 0, output: '# pass 3\n# fail 0' })], 't3'),
  ];
  const ctx = computeCodexTurnContext(turnRecords);
  assert.deepEqual([...ctx.editedBasenames], ['foo.js']);
  assert.equal(ctx.testRunsAfterLastEdit.length, 1); // only the second exec_command qualifies
  assert.equal(ctx.testRunsAfterLastEdit[0].failed, false);
  assert.equal(ctx.bashCommands.length, 2); // both exec_commands are still recorded as commands
  assert.equal(evidenceForSentence('All 3 tests pass.', ctx).tests_passed, 'supported');
});

test('computeCodexTurnContext: a failing exit_code marks tests_passed unsupported', () => {
  const turnRecords = [
    codexExecCall('c1', [{ kind: 'exec', cmd: 'npm test' }], 't0'),
    codexExecOutput('c1', [codexOutputItem({ chunk_id: '1', exit_code: 1, output: 'not ok 1 - failed' })], 't1'),
  ];
  const ctx = computeCodexTurnContext(turnRecords);
  assert.equal(ctx.testRunsAfterLastEdit[0].failed, true);
  assert.equal(evidenceForSentence('All tests pass.', ctx).tests_passed, 'unsupported');
});

test('computeCodexTurnContext disables chunk-pairing (never invents a failure) when any invocation in the call fails to decode', () => {
  const brokenInput = `${codexExecInput([{ kind: 'exec', cmd: 'node --test test/foo.test.js' }])}\ntext(await tools.exec_command({cmd:"unterminated`;
  const turnRecords = [
    { timestamp: 't0', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: brokenInput } },
    codexExecOutput('c1', [codexOutputItem({ chunk_id: '1', exit_code: 1, output: 'not ok' })], 't1'), // would say "failed" if paired
  ];
  const ctx = computeCodexTurnContext(turnRecords);
  assert.equal(ctx.testRunsAfterLastEdit.length, 1);
  assert.equal(ctx.testRunsAfterLastEdit[0].failed, false); // pairing disabled -> never invents a failure
});

test('computeCodexTurnContext: file_changed evidence follows the same basename-in-sentence rule as Claude', () => {
  const turnRecords = [
    codexExecCall('c1', [{ kind: 'patch', text: '*** Begin Patch\n*** Add File: /repo/lib/jev-sieve.js\n+x\n*** End Patch\n' }], 't0'),
    codexExecOutput('c1', [codexOutputItem({})], 't1'),
  ];
  const ctx = computeCodexTurnContext(turnRecords);
  assert.equal(evidenceForSentence('Added jev-sieve.js for the sieve pass.', ctx).file_changed, 'supported');
  assert.equal(evidenceForSentence('Added telemetry.js instead.', ctx).file_changed, 'unsupported');
});

test('computeCodexTurnContext falls back to the standard function_call shape (shell/apply_patch) — unverified against real data, but the code path works', () => {
  const turnRecords = [
    { timestamp: 't0', type: 'response_item', payload: { type: 'function_call', name: 'apply_patch', call_id: 'p1', arguments: JSON.stringify({ input: '*** Begin Patch\n*** Update File: /repo/lib/bar.js\n@@\n*** End Patch\n' }) } },
    { timestamp: 't1', type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 's1', arguments: JSON.stringify({ command: ['bash', '-lc', 'npm test'] }) } },
    { timestamp: 't2', type: 'response_item', payload: { type: 'function_call_output', call_id: 's1', output: '# pass 2\n# fail 0' } },
  ];
  const ctx = computeCodexTurnContext(turnRecords);
  assert.deepEqual([...ctx.editedBasenames], ['bar.js']);
  assert.equal(ctx.testRunsAfterLastEdit.length, 1);
  assert.equal(ctx.testRunsAfterLastEdit[0].failed, false);
  assert.equal(parseStandardShellArguments('not json'), null);
  assert.equal(parseStandardShellArguments(JSON.stringify({ cmd: 'ls' })), 'ls');
  assert.equal(parseStandardApplyPatchArguments(JSON.stringify({ patch: 'p' })), 'p');
});

test('codexMessageText / isCodexUserPromptRecord / segmentCodexTurns / final message: developer role never counts, agent_message and assistant message both do', () => {
  const records = [
    codexDeveloperMessage('system boilerplate, not a real turn', 't0'),
    codexUserMessage('please fix the bug', 't1'),
    codexExecCall('c1', [{ kind: 'exec', cmd: 'ls' }], 't2'),
    codexExecOutput('c1', [codexOutputItem({ chunk_id: '1', exit_code: 0, output: 'ok' })], 't3'),
    codexAgentMessage('interim update', 't4'),
    codexAssistantMessage('final answer for turn one', 't5'),
    codexUserMessage('now clean up', 't6'),
    codexAgentMessage('final answer for turn two', 't7'),
  ];
  assert.equal(isCodexUserPromptRecord(records[0]), false); // developer
  assert.equal(isCodexUserPromptRecord(records[1]), true);
  const turns = segmentCodexTurns(records);
  assert.deepEqual(turns, [{ turnIndex: 0, start: 1, end: 6 }, { turnIndex: 1, start: 6, end: 8 }]);
  assert.equal(extractCodexFinalMessage(records, turns[0]).text, 'final answer for turn one');
  assert.equal(extractCodexFinalMessage(records, turns[1]).text, 'final answer for turn two');
  assert.equal(extractCodexFinalMessage(records, { start: 0, end: 1 }), null);
});

test('codexCwdMatches: exact match, worktree-nested prefix match, and a same-prefix-but-different-dir rejection', () => {
  assert.equal(codexCwdMatches('/root/sextant', '/root/sextant'), true);
  assert.equal(codexCwdMatches('/root/sextant/.omc/baselines/x/worktrees/worker-1', '/root/sextant'), true);
  assert.equal(codexCwdMatches('/root/sextant-other', '/root/sextant'), false); // string-prefix but NOT a subdirectory
  assert.equal(codexCwdMatches('/root/jan25', '/root/sextant'), false);
  assert.equal(codexCwdMatches(undefined, '/root/sextant'), false);
});

// End-to-end: a synthetic ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl tree with an
// exact-cwd file, a worktree-nested-cwd file, and a DIFFERENT PROJECT'S file carrying a
// PHI-shaped canary — proves discovery/segmentation/evidence/privacy-filter together,
// and that the non-matching project's content never reaches a built task.
function writeCodexRollout(root, relDir, filename, records) {
  const dir = path.join(root, relDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), records.map(r => JSON.stringify(r)).join('\n') + '\n');
}

test('buildCodexTasksFromCorpus discovers exact + worktree-nested sextant sessions, excludes other projects, and computes evidence end to end', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-codex-corpus-'));
  try {
    const exactRecords = [
      codexSessionMeta('/root/sextant', 't0'),
      codexUserMessage('please add jev-sieve.js and run its tests', 't1'),
      codexExecCall('c1', [
        { kind: 'patch', text: '*** Begin Patch\n*** Add File: /root/sextant/lib/jev-sieve.js\n+content\n*** End Patch\n' },
        { kind: 'exec', cmd: 'node --test test/jev-sieve.test.js' },
      ], 't2'),
      codexExecOutput('c1', [codexOutputItem({}), codexOutputItem({ chunk_id: '1', exit_code: 0, output: '# pass 5\n# fail 0' })], 't3'),
      codexAgentMessage(codexBullets([
        'Added jev-sieve.js for the sieve pass.',
        'All 5 tests pass.',
        'This is now verified.',
      ]), 't4'),
    ];
    writeCodexRollout(root, '2026/09/22', 'rollout-2026-09-22T00-00-00-exact.jsonl', exactRecords);

    const worktreeRecords = [
      codexSessionMeta('/root/sextant/.omc/baselines/jev-sieve/.omc/team/x/worktrees/worker-1', 't0'),
      codexUserMessage('claim tests pass without running them this turn', 't1'),
      codexAgentMessage(codexBullets(['All 9 tests pass.']), 't2'),
    ];
    writeCodexRollout(root, '2026/09/22', 'rollout-2026-09-22T01-00-00-worktree.jsonl', worktreeRecords);

    const otherProjectRecords = [
      codexSessionMeta('/root/somaNotes', 't0'),
      codexUserMessage('do not read me', 't1'),
      codexAgentMessage('patient record SECRET_CANARY should never appear', 't2'),
    ];
    writeCodexRollout(root, '2026/09/22', 'rollout-2026-09-22T02-00-00-other.jsonl', otherProjectRecords);

    const { tasks, stats } = buildCodexTasksFromCorpus(root, '/root/sextant');
    assert.equal(stats.sessionFilesFound, 2); // exact + worktree, NOT the other project
    assert.equal(stats.turnsWithSentences, 2);
    const allText = tasks.flatMap(t => t.allSentences.map(s => s.text)).join(' ');
    assert.ok(!allText.includes('SECRET_CANARY'));
    assert.ok(!allText.toLowerCase().includes('patient'));
    assert.ok(tasks.every(t => t.source === 'codex'));

    const exactTask = tasks.find(t => t.sessionId === 'rollout-2026-09-22T00-00-00-exact.jsonl');
    const testsPassedId = exactTask.allSentences.find(s => s.text === 'All 5 tests pass.').id;
    assert.equal(exactTask.evidence[testsPassedId].tests_passed, 'supported');
    const fileChangedId = exactTask.allSentences.find(s => s.text === 'Added jev-sieve.js for the sieve pass.').id;
    assert.equal(exactTask.evidence[fileChangedId].file_changed, 'supported');

    const worktreeTask = tasks.find(t => t.sessionId === 'rollout-2026-09-22T01-00-00-worktree.jsonl');
    const claimedId = worktreeTask.allSentences.find(s => s.text === 'All 9 tests pass.').id;
    assert.equal(worktreeTask.evidence[claimedId].tests_passed, 'unsupported'); // no exec_command in that turn at all
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('buildCodexTasksFromCorpus returns an empty result on a root with no matching sessions, without throwing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-codex-corpus-'));
  try {
    writeCodexRollout(root, '2026/01/01', 'rollout-none.jsonl', [codexSessionMeta('/root/other-project', 't0')]);
    const { tasks, stats } = buildCodexTasksFromCorpus(root, '/root/sextant');
    assert.deepEqual(tasks, []);
    assert.equal(stats.sessionFilesFound, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('freezeTasks refuses to pool Claude and Codex tasks together', () => {
  const claudeTurn = { sessionId: 'c-sess', turnIndex: 0, finalMessageTimestamp: 't', sentences: ['Updated foo.js.'], evidenceContext: computeTurnContext(extractTurnToolEvents([])) };
  const codexTurn = { sessionId: 'codex-sess.jsonl', turnIndex: 0, finalMessageTimestamp: 't', sentences: ['Updated bar.js.'], evidenceContext: computeCodexTurnContext([]) };
  const claudeTasks = buildTasksFromTurn(claudeTurn, 'claude');
  const codexTasks = buildTasksFromTurn(codexTurn, 'codex');
  assert.throws(() => freezeTasks([...claudeTasks, ...codexTasks]), /refuses to pool/);
  // Each platform alone still freezes fine.
  freezeTasks(claudeTasks);
  freezeTasks(codexTasks);
});

test('the generic report()/runFrozen() pipeline works unchanged on Codex-sourced tasks and tags corpus.source', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-codex-live-'));
  try {
    const turnRecords = [
      codexExecCall('c1', [
        { kind: 'patch', text: '*** Begin Patch\n*** Update File: /repo/lib/foo.js\n@@\n*** End Patch\n' },
        { kind: 'exec', cmd: 'npm test' },
      ], 't0'),
      codexExecOutput('c1', [codexOutputItem({}), codexOutputItem({ chunk_id: '1', exit_code: 0, output: '# pass 1\n# fail 0' })], 't1'),
    ];
    const ctx = computeCodexTurnContext(turnRecords);
    const turn = { sessionId: 'rollout-codex.jsonl', turnIndex: 0, finalMessageTimestamp: '2026-09-22T10-00-00Z', sentences: ['All 1 tests pass.'], evidenceContext: ctx };
    const tasks = buildTasksFromTurn(turn, 'codex');
    const frozen = freezeTasks(tasks);
    const client = {
      async systemOne(request) {
        const answers = Object.fromEntries(Object.keys(request.questions).map(qid => [qid, {
          type: 'choice', choice: 'tests_passed', confidence: 0.9,
          probabilities: Object.fromEntries(Object.keys(CLAIM_KIND_CRITERIA).map(k => [k, k === 'tests_passed' ? 0.9 : 0.02])),
        }]));
        return { model: 'jev-test', usage: { input_tokens: 10, output_tokens: 5 }, answers };
      },
    };
    const out = path.join(dir, 'codex-results.jsonl');
    const result = await runFrozen(frozen, out, { client });
    assert.equal(result.status, 'complete');
    assert.equal(result.corpus.source, 'codex');
    assert.equal(result.evidenceByKind.tests_passed.supported, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('main --platform validates against claude/codex and rejects other values', async () => {
  await assert.rejects(main(['inspect', '--platform', 'bogus']), /--platform must be claude or codex/);
});
