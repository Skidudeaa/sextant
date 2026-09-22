'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cases } = require('./cases');
const { BaselineError, buildBaselineRequest, parseDecisionResponse, queryBaseline, selectCases, summarizeBaseline, replayBaseline, runBaseline, parseArgs } = require('./openai-baseline');

function response(text = '{"flag":true}') {
  return { model: 'gpt-5.4-mini-2026-03-17', status: 'completed',
    usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 20 } },
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] };
}

test('request preserves state and questions, withholds labels and provenance, pins explicit model and spend limits', () => {
  const c = { ...cases[0], expected: { flag: 'secret-label-canary' }, rationale: 'secret-rationale-canary', provenance: { private: 'secret-provenance-canary' } };
  const request = buildBaselineRequest(c, 'gpt-5.4-mini');
  assert.deepEqual(JSON.parse(request.input), { state: c.state, questions: c.questions });
  assert.doesNotMatch(JSON.stringify(request), /secret-label-canary|secret-rationale-canary|secret-provenance-canary/);
  assert.equal(request.store, false);
  assert.equal(request.max_output_tokens, 256);
  assert.deepEqual(request.reasoning, { effort: 'none' });
  assert.throws(() => buildBaselineRequest(c), /explicit_model_required/);
});

test('closed boolean parser accepts exact labels and rejects self-reported probabilities, extras, missing ids, and markdown', () => {
  const parsed = parseDecisionResponse(response(), ['flag']);
  assert.deepEqual(parsed.labels, { flag: true });
  assert.equal(parsed.rawDecisionText, '{"flag":true}');
  for (const text of ['{"flag":0.98}', '{"flag":"yes"}', '{}', '{"flag":true,"flag":false}', '{"flag":true,"extra":false}', '```json\n{"flag":true}\n```', 'not JSON']) {
    assert.throws(() => parseDecisionResponse(response(text), ['flag']), BaselineError);
  }
  assert.throws(() => parseDecisionResponse(response(' '.repeat(8193)), ['flag']), /decision_too_large/);
});

test('requires completed provider status and trustworthy token metadata', () => {
  for (const mutate of [
    r => { r.status = 'incomplete'; }, r => { delete r.model; }, r => { delete r.usage; },
    r => { r.usage.input_tokens = -1; }, r => { r.usage.total_tokens = 4; },
    r => { r.usage.input_tokens_details.cached_tokens = 101; },
    r => { r.output[0].content = [{ type: 'refusal', refusal: 'hidden-private-refusal' }]; },
  ]) {
    const wire = response(); mutate(wire);
    assert.throws(() => parseDecisionResponse(wire, ['flag']), error => {
      assert.doesNotMatch(error.stack + JSON.stringify(error), /hidden-private-refusal/);
      return error instanceof BaselineError;
    });
  }
});

test('transport uses documented endpoint and preserves exact body without a retry', async () => {
  let calls = 0;
  const request = buildBaselineRequest(cases[0], 'gpt-5.4-mini');
  const result = await queryBaseline(request, { apiKey: 'test-key', fetch: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), request);
    return Response.json(response());
  } });
  assert.equal(calls, 1);
  assert.equal(result.labels.flag, true);
  assert.ok(Number.isFinite(result.latencyMs));
});

test('credential, HTTP, network, and JSON failures are explicit and never expose raw provider text or keys', async () => {
  const request = buildBaselineRequest(cases[0], 'gpt-5.4-mini');
  await assert.rejects(queryBaseline(request, { apiKey: '' }), /OPENAI_API_KEY_required/);
  for (const fetch of [
    async () => new Response('private-key-and-source', { status: 401 }),
    async () => { throw Error('private-key-and-source'); },
    async () => new Response('private-key-and-source'),
  ]) {
    let calls = 0;
    await assert.rejects(queryBaseline(request, { apiKey: 'private-key-and-source', fetch: async (...args) => { calls++; return fetch(...args); } }), error => {
      assert.doesNotMatch(error.stack + JSON.stringify(error), /private-key-and-source/);
      return error instanceof BaselineError;
    });
    assert.equal(calls, 1);
  }
});

test('finite deadline covers a stalled response body', async () => {
  await assert.rejects(queryBaseline(buildBaselineRequest(cases[0], 'gpt-5.4-mini'), {
    apiKey: 'test', timeoutMs: 10, fetch: async () => new Response(new ReadableStream({ start() {} })),
  }), /timeout/);
});

test('balanced smoke selection is reproducible, authored, development-only, and broad across families', () => {
  const selected = selectCases(cases);
  assert.equal(selected.length, 8);
  assert.equal(selected.filter(c => c.expected.flag).length, 4);
  assert.equal(new Set(selected.map(c => c.family)).size, 4);
  assert.ok(selected.every(c => c.split === 'development' && c.provenance.kind === 'synthetic'));
  assert.deepEqual(selectCases(cases), selected);
  assert.notDeepEqual(selectCases(cases, { seed: 12 }), selected);
  for (const limit of [0, 1, 3, Infinity]) assert.throws(() => selectCases(cases, { limit }), /limit/);
});

test('durable results use exclusive append-only 0600 file, cost accounting, and boolean metrics without calibration', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sextant-baseline-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'run.jsonl');
  const selected = selectCases(cases, { limit: 2 });
  let index = 0;
  const options = { model: 'gpt-5.4-mini', out, apiKey: 'test', fetch: async () => Response.json(response(JSON.stringify(selected[index++].expected))) };
  const summary = await runBaseline(selected, options);
  assert.equal(summary.accuracy, 1);
  assert.equal(summary.inputTokens, 200);
  assert.equal(summary.cachedInputTokens, 40);
  assert.equal(summary.outputTokens, 20);
  assert.equal(summary.plannedRequests, 2);
  assert.equal(summary.completedRequests, 2);
  assert.equal(summary.unattemptedRequests, 0);
  assert.equal(summary.bySplit.development.n, 2);
  assert.equal(summary.estimatedCostUsd, (160 * 0.75 + 40 * 0.075 + 20 * 4.5) / 1e6);
  assert.equal(Object.hasOwn(summary, 'brier'), false);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  const original = fs.readFileSync(out, 'utf8');
  const records = original.trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map(record => record.kind), ['manifest', 'result', 'result', 'summary']);
  assert.deepEqual(records[0].corpusSnapshot, selected);
  assert.equal(records[0].plannedTasks.length, 2);
  records[1].decisions = [{ qid: 'flag', expected: !selected[0].expected.flag, label: !selected[0].expected.flag }];
  records[1].response.labels.flag = !selected[0].expected.flag;
  assert.equal(summarizeBaseline(replayBaseline(records)).accuracy, 1);
  const tampered = structuredClone(records);
  tampered[0].corpusSnapshot[0].expected.flag = !tampered[0].corpusSnapshot[0].expected.flag;
  assert.throws(() => replayBaseline(tampered), /corpus_fingerprint_mismatch/);
  const reordered = structuredClone(records);
  [reordered[1], reordered[2]] = [reordered[2], reordered[1]];
  assert.throws(() => replayBaseline(reordered), /attempt_plan_mismatch/);
  await assert.rejects(runBaseline(selected, options), error => error.code === 'EEXIST');
  assert.equal(fs.readFileSync(out, 'utf8'), original);
});

test('first provider failure stops the run and leaves a sanitized error plus summary', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sextant-baseline-error-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'run.jsonl');
  let calls = 0;
  await assert.rejects(runBaseline(selectCases(cases), { model: 'gpt-5.4-mini', out, apiKey: 'test', fetch: async () => {
    calls++; return new Response('sensitive-provider-error', { status: 429 });
  } }), /http_error/);
  assert.equal(calls, 1);
  const contents = fs.readFileSync(out, 'utf8');
  assert.doesNotMatch(contents, /sensitive-provider-error/);
  const rows = contents.trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.kind), ['manifest', 'error', 'summary']);
  assert.equal(rows[1].status, 429);
  assert.equal(rows[2].unknownUsageRequests, 1);
  assert.equal(rows[2].plannedRequests, 8);
  assert.equal(rows[2].completedRequests, 0);
  assert.equal(rows[2].errors, 1);
  assert.equal(rows[2].unattemptedRequests, 7);
  assert.equal(Object.values(rows[2].byFamily).reduce((sum, cohort) => sum + cohort.plannedRequests, 0), 8);
});

test('parse failures retain known billed usage without retaining malformed generation', () => {
  let error;
  try { parseDecisionResponse(response('sensitive-bad-output'), ['flag']); } catch (caught) { error = caught; }
  assert.equal(error.code, 'invalid_decision_json');
  assert.equal(error.usage.input_tokens, 100);
  const summary = summarizeBaseline([{ kind: 'error', code: error.code, usage: error.usage }]);
  assert.equal(summary.inputTokens, 100);
  assert.equal(summary.unknownUsageRequests, 0);
  assert.equal(summary.estimatedCostUsd, null);
  assert.doesNotMatch(JSON.stringify(error), /sensitive-bad-output/);
});

test('CLI requires explicit model and rejects unknown arguments', () => {
  assert.equal(parseArgs(['inspect', '--model', 'gpt-5.4-mini', '--limit', '8']).limit, 8);
  assert.throws(() => parseArgs(['inspect']), /explicit_model_required/);
  assert.throws(() => parseArgs(['live', '--model', 'gpt-5.4-mini', '--retry']), /invalid_arguments/);
});

test('mixed actual model versions are partitioned instead of pooling quality', () => {
  const first = { kind: 'result', family: 'test', split: 'development', response: { model: 'gpt-5.4-mini-2026-03-17', usage: response().usage, latencyMs: 1 }, decisions: [{ expected: true, label: true }] };
  const second = structuredClone(first);
  second.response.model = 'different-model';
  second.decisions[0].label = false;
  const summary = summarizeBaseline([{ kind: 'manifest', model: 'gpt-5.4-mini', requests: 3 }, first, second]);
  assert.equal(summary.status, 'mixed-model-results-partitioned');
  assert.equal(Object.hasOwn(summary, 'accuracy'), false);
  assert.equal(summary.byModel['gpt-5.4-mini-2026-03-17'].accuracy, 1);
  assert.equal(summary.byModel['different-model'].accuracy, 0);
  assert.equal(summary.byModel['different-model'].estimatedCostUsd, null);
  assert.equal(summary.unattemptedRequests, 1);
});
