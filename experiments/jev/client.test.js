'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { JevClient, JevError, validateResponse } = require('./client');

const questions = {
  wrong: { type: 'noul', instructions: 'Does the claim conflict with the source?', criteria: { true: 'Conflict', false: 'Supported' } },
  file: { type: 'choice', instructions: 'Which file defines the symbol?', criteria: { a: 'Definition', b: null } },
  relevance: { type: 'score', instructions: 'How relevant is this source?', criteria: ['Irrelevant', 'Related', 'Direct'] },
};

function validResponse() {
  return {
    model: 'jev-1.13.0',
    usage: { input_tokens: 312, output_tokens: 44 },
    answers: {
      wrong: { type: 'noul', noul: 0.1 },
      file: { type: 'choice', choice: 'a', probabilities: { a: 0.8, b: 0.2 }, confidence: 0.6 },
      relevance: { type: 'score', score: 1.05, legend: { 0: 'Irrelevant', 1: 'Related', 2: 'Direct' }, probabilities: { 0: 0, 1: 0.95, 2: 0.05 }, confidence: 0.92 },
    },
  };
}

function clientWithResponse(response, options = {}) {
  return new JevClient({ apiKey: 'unit-test-key', fetch: async () => Response.json(response), ...options });
}

test('actual local HTTP transport sends documented methods, bearer headers, and wire payload without retries', async t => {
  const seen = [];
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    seen.push({ method: request.method, url: request.url, authorization: request.headers.authorization, contentType: request.headers['content-type'], body });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(request.url === '/v1/models'
      ? { models: [{ name: 'jev-1.13.0', description: 'fixture', release_date: '2026-09-18' }] }
      : validResponse()));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const localRoot = `http://127.0.0.1:${server.address().port}`;
  const client = new JevClient({
    apiKey: 'fixture-key',
    fetch: (url, options) => {
      assert.equal(new URL(url).origin, 'https://api.typesafe.ai');
      assert.equal(options.redirect, 'error');
      return fetch(`${localRoot}${new URL(url).pathname}`, options);
    },
  });
  assert.deepEqual(await client.listModels(), [{ name: 'jev-1.13.0', description: 'fixture', release_date: '2026-09-18' }]);
  const request = { state: { source: 'function target() {}' }, questions, model: 'jev-1.13' };
  assert.deepEqual(await client.systemOne(request), validResponse());
  assert.equal(seen.length, 2);
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].url, '/v1/models');
  assert.equal(seen[0].body, '');
  assert.equal(seen[1].method, 'POST');
  assert.equal(seen[1].url, '/v1/systemone');
  assert.equal(seen[1].authorization, 'Bearer fixture-key');
  assert.equal(seen[1].contentType, 'application/json');
  assert.deepEqual(JSON.parse(seen[1].body), request);
});

test('credentials, explicit models, and finite deadlines are required before any transport', async () => {
  for (const apiKey of ['', ' ', null, 7]) assert.throws(() => new JevClient({ apiKey }), /TYPESAFE_API_KEY/);
  for (const timeoutMs of [0, -1, Infinity, NaN, 0.5, 2147483648]) {
    assert.throws(() => new JevClient({ apiKey: 'test', timeoutMs }), /timeoutMs/);
  }
  let calls = 0;
  const client = new JevClient({ apiKey: 'test', fetch: async () => { calls++; throw Error('must not run'); } });
  for (const model of [undefined, null, '', ' ']) {
    await assert.rejects(client.systemOne({ state: 'source', questions, model }), /explicit TypeSafe model/);
  }
  assert.equal(calls, 0);
});

test('rejects missing, surplus, and wrong primitive answers', () => {
  const missing = validResponse();
  delete missing.answers.wrong;
  assert.throws(() => validateResponse(missing, questions), /exactly one answer/);
  const extra = validResponse();
  extra.answers.unrequested = { type: 'noul', noul: 0.5 };
  assert.throws(() => validateResponse(extra, questions), /exactly one answer/);
  const wrong = validResponse();
  wrong.answers.wrong = { type: 'choice', noul: 0.1 };
  assert.throws(() => validateResponse(wrong, questions), /primitive/);
});

for (const value of [NaN, Infinity, -Infinity, -0.001, 1.001, '0.4', null, undefined]) {
  test(`rejects invalid probability ${String(value)}`, () => {
    for (const mutate of [
      r => { r.answers.wrong.noul = value; },
      r => { r.answers.file.confidence = value; },
      r => { r.answers.file.probabilities.a = value; },
      r => { r.answers.relevance.confidence = value; },
    ]) {
      const response = validResponse();
      mutate(response);
      assert.throws(() => validateResponse(response, questions), JevError);
    }
  });
}

test('distributions require complete exact coverage, normalization, and selected maximum', () => {
  for (const distribution of [{ a: 0.8 }, { a: 0.8, b: 0.2, c: 0 }, { a: 0.8, b: 0.1 }, [0.8, 0.2]]) {
    const response = validResponse();
    response.answers.file.probabilities = distribution;
    assert.throws(() => validateResponse(response, questions), /distribution|sum/);
  }
  const inconsistent = validResponse();
  inconsistent.answers.file.choice = 'b';
  assert.throws(() => validateResponse(inconsistent, questions), /highest-probability/);
  inconsistent.answers.file.choice = 'c';
  assert.throws(() => validateResponse(inconsistent, questions), /requested option/);
  const tied = validResponse();
  tied.answers.file.probabilities = { a: 0.5, b: 0.5 };
  assert.equal(validateResponse(tied, questions), tied);
  const rounded = validResponse();
  rounded.answers.file.probabilities = { a: 0.7999, b: 0.2 };
  assert.equal(validateResponse(rounded, questions), rounded);
});

test('score is the probability weighted rubric, preserving full legend and finite range', () => {
  for (const score of [NaN, Infinity, -0.1, 3, 0, '1.05']) {
    const response = validResponse();
    response.answers.relevance.score = score;
    assert.throws(() => validateResponse(response, questions), /Score/);
  }
  for (const legend of [{ 0: 'Irrelevant', 1: 'Related' }, { 0: 'Irrelevant', 1: 'Wrong', 2: 'Direct' }]) {
    const response = validResponse();
    response.answers.relevance.legend = legend;
    assert.throws(() => validateResponse(response, questions), /legend/);
  }
});

test('metadata is required and validated without inventing absent stamps', () => {
  const unstamped = { answers: validResponse().answers };
  assert.throws(() => validateResponse(unstamped, questions), /model/);
  assert.equal(Object.hasOwn(unstamped, 'model'), false);
  const noUsage = validResponse();
  delete noUsage.usage;
  assert.throws(() => validateResponse(noUsage, questions), /usage/);
  for (const model of [null, '', ' ', 12]) {
    assert.throws(() => validateResponse({ ...validResponse(), model }, questions), /model/);
  }
  for (const usage of [null, {}, { input_tokens: -1, output_tokens: 4 }, { input_tokens: 1.1, output_tokens: 4 }, { input_tokens: 1, output_tokens: Infinity }]) {
    assert.throws(() => validateResponse({ ...validResponse(), usage }, questions), /usage/);
  }
});

test('rejects malformed request primitives and lossy JSON before transport', async () => {
  const circular = {};
  circular.self = circular;
  const client = new JevClient({ apiKey: 'test', fetch: () => assert.fail('invalid request reached transport') });
  for (const state of [undefined, null, 3, { unsupported: undefined }, { number: NaN }, circular, new Date(), { secret: 2n }]) {
    await assert.rejects(client.systemOne({ state, questions, model: 'jev-1.13' }), JevError);
  }
  for (const bad of [
    {}, { x: { type: 'text', instructions: 'bad' } },
    { x: { type: 'noul' } },
    { x: { type: 'noul', instructions: 'x', criteria: { maybe: 'yes' } } },
    { x: { type: 'choice', instructions: 'x', criteria: {} } },
    { x: { type: 'score', instructions: 'x', criteria: ['only one'] } },
    { x: { type: 'score', instructions: 'x', criteria: Array(11).fill('too many') } },
  ]) await assert.rejects(client.systemOne({ state: 'source', questions: bad, model: 'jev-1.13' }), JevError);
});

test('HTTP errors preserve status without retaining echoed keys, prompts, or provider body', async () => {
  for (const status of [401, 422, 429, 529]) {
    let calls = 0;
    const client = new JevClient({ apiKey: 'secret-key', fetch: async () => {
      calls++;
      return new Response('secret-key private-source-text', { status });
    } });
    await assert.rejects(client.systemOne({ state: 'private-source-text', questions, model: 'jev-1.13' }), error => {
      assert.equal(error.status, status);
      assert.equal(error.code, 'http_error');
      assert.doesNotMatch(JSON.stringify(error) + error.stack, /secret-key|private-source-text/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('network and JSON parser errors do not expose raw response, URL, or credentials', async () => {
  for (const fakeFetch of [
    async () => { throw new Error('secret-key private-source-text https://leaky.example'); },
    async () => new Response('secret-key private-source-text'),
  ]) {
    const client = new JevClient({ apiKey: 'secret-key', fetch: fakeFetch });
    await assert.rejects(client.listModels(), error => {
      assert.doesNotMatch(error.stack + JSON.stringify(error), /secret-key|private-source-text|leaky/);
      return true;
    });
  }
});

test('timeout bounds transport even when an injected fetch ignores abort', async () => {
  let signal;
  let calls = 0;
  const client = new JevClient({ apiKey: 'test', timeoutMs: 15, fetch: async (_, options) => {
    signal = options.signal;
    calls++;
    return new Promise(() => {});
  } });
  await assert.rejects(client.listModels(), error => error.code === 'timeout');
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
});

test('timeout includes stalled response body reads', async () => {
  const client = new JevClient({ apiKey: 'test', timeoutMs: 15, fetch: async () => new Response(new ReadableStream({ start() {} })) });
  await assert.rejects(client.listModels(), error => error.code === 'timeout');
});

test('caller mutation cannot change the response contract after send', async () => {
  const mutableQuestions = structuredClone(questions);
  const client = new JevClient({ apiKey: 'test', fetch: async () => {
    delete mutableQuestions.wrong;
    return Response.json(validResponse());
  } });
  assert.deepEqual(await client.systemOne({ state: 'source', questions: mutableQuestions, model: 'jev-1.13' }), validResponse());
});

test('model discovery rejects malformed and duplicate cards', async () => {
  for (const response of [[], {}, { models: [{}] }, { models: [{ name: '', description: '', release_date: '' }] },
    { models: Array(2).fill({ name: 'jev', description: '', release_date: '' }) }]) {
    await assert.rejects(clientWithResponse(response).listModels(), JevError);
  }
});
