'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

// Contract checked against docs.typesafe.ai/api.md and the official JS SDK v0.6.0.
const API_ROOT = 'https://api.typesafe.ai';
const PROBABILITY_TOLERANCE = 0.001;

class JevError extends Error {
  constructor(message, { code = 'invalid_contract', status } = {}) {
    super(message);
    this.name = 'JevError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

function requireCondition(condition, message) {
  if (!condition) throw new JevError(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if ((!Array.isArray(value) && !isObject(value)) || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Reflect.ownKeys(value).every(key => typeof key === 'string')
    && Object.values(value).every(item => isJson(item, ancestors))
    && (!Array.isArray(value) || Object.keys(value).length === value.length);
  ancestors.delete(value);
  return valid;
}

function isEntry(value) {
  return (typeof value === 'string' || Array.isArray(value) || isObject(value)) && isJson(value);
}

function sameKeys(value, keys) {
  return isObject(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function probability(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateQuestions(questions) {
  requireCondition(isObject(questions) && Object.keys(questions).length > 0, 'Questions must be a nonempty object');
  for (const question of Object.values(questions)) {
    requireCondition(isObject(question) && isEntry(question.instructions), 'Each question requires JSON-compatible instructions');
    if (question.type === 'noul') {
      if (question.criteria !== undefined) {
        requireCondition(isObject(question.criteria)
          && Object.entries(question.criteria).every(([key, value]) => ['true', 'false'].includes(key) && isEntry(value)),
        'Noul criteria must describe true or false');
      }
    } else if (question.type === 'choice') {
      requireCondition(isObject(question.criteria) && Object.keys(question.criteria).length > 0
        && Object.keys(question.criteria).length <= 255
        && Object.values(question.criteria).every(value => value === null || isEntry(value)),
      'Choice requires 1 to 255 JSON-compatible criteria');
    } else if (question.type === 'score') {
      requireCondition(Array.isArray(question.criteria) && question.criteria.length >= 2 && question.criteria.length <= 10
        && question.criteria.every(isEntry), 'Score requires 2 to 10 JSON-compatible levels');
    } else {
      throw new JevError('Unsupported question primitive');
    }
  }
}

// jev-1.13.0 reports probabilities rounded to whole cents (observed 2026-09-25: a
// 6-option Choice summing to 0.99; a 45-option Choice summing to 0.99 in 5 of 8
// identical requests). n cent-rounded values can drift from their true sum by up
// to n * 0.005, so that is the bound when every value is cent-quantized.
const CENT_ROUNDING = 0.005;
const isCent = value => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9;

function validateDistribution(distribution, keys) {
  requireCondition(sameKeys(distribution, keys), 'Probability distribution does not match requested criteria');
  const values = Object.values(distribution);
  requireCondition(values.every(probability), 'Probabilities must be finite numbers in [0, 1]');
  const sum = values.reduce((total, value) => total + value, 0);
  const tolerance = values.every(isCent) ? Math.max(PROBABILITY_TOLERANCE, values.length * CENT_ROUNDING) : PROBABILITY_TOLERANCE;
  requireCondition(Math.abs(sum - 1) <= tolerance, `Probabilities must sum to one within ${tolerance}`);
}

function validateResponse(response, questions) {
  validateQuestions(questions);
  requireCondition(isObject(response) && sameKeys(response.answers, Object.keys(questions)),
    'Response must contain exactly one answer for every requested question');
  requireCondition(typeof response.model === 'string' && response.model.trim().length > 0, 'Response model must be nonempty');
  requireCondition(isObject(response.usage)
    && ['input_tokens', 'output_tokens'].every(key => Number.isSafeInteger(response.usage[key]) && response.usage[key] >= 0),
  'Response usage must contain nonnegative integer token counts');
  for (const [key, question] of Object.entries(questions)) {
    const answer = response.answers[key];
    requireCondition(isObject(answer) && answer.type === question.type, 'Answer primitive must match its question');
    if (question.type === 'noul') {
      requireCondition(probability(answer.noul), 'Noul answer must be a finite probability in [0, 1]');
      continue;
    }
    requireCondition(probability(answer.confidence), 'Answer confidence must be a finite number in [0, 1]');
    const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
    validateDistribution(answer.probabilities, keys);
    if (question.type === 'choice') {
      requireCondition(typeof answer.choice === 'string' && keys.includes(answer.choice), 'Choice answer must select a requested option');
      requireCondition(answer.probabilities[answer.choice] === Math.max(...Object.values(answer.probabilities)),
        'Choice answer must select a highest-probability option');
    } else {
      requireCondition(sameKeys(answer.legend, keys) && keys.every(index => isDeepStrictEqual(answer.legend[index], question.criteria[Number(index)])),
        'Score legend must preserve requested levels');
      requireCondition(typeof answer.score === 'number' && Number.isFinite(answer.score)
        && answer.score >= 0 && answer.score <= keys.length - 1, 'Score must be finite and within the requested rubric');
      const expected = keys.reduce((sum, index) => sum + Number(index) * answer.probabilities[index], 0);
      // The score is computed before the probabilities are rounded to cents; level i
      // can then shift the weighted sum by up to i * 0.005.
      const quantized = Object.values(answer.probabilities).every(isCent);
      const scoreTolerance = Math.max(PROBABILITY_TOLERANCE * keys.length,
        quantized ? CENT_ROUNDING * keys.reduce((sum, index) => sum + Number(index), 0) : 0);
      requireCondition(Math.abs(answer.score - expected) <= scoreTolerance,
        'Score must match the probability-weighted rubric');
    }
  }
  return response;
}

// The owner keeps the key in ~/.config/typesafe/api_key (mode 0600). Reading it here
// keeps `$(cat …)` out of every live command line. An env var still wins.
const KEY_FILE = path.join(os.homedir(), '.config', 'typesafe', 'api_key');
function keyFromFile(file = process.env.TYPESAFE_API_KEY_FILE || KEY_FILE) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

class JevClient {
  #apiKey;
  #fetch;
  #timeoutMs;

  constructor({ apiKey = process.env.TYPESAFE_API_KEY ?? keyFromFile(), fetch = globalThis.fetch, timeoutMs = 30000 } = {}) {
    requireCondition(typeof apiKey === 'string' && apiKey.trim().length > 0, 'TYPESAFE_API_KEY is required');
    requireCondition(typeof fetch === 'function', 'A fetch implementation is required');
    requireCondition(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2147483647,
      'timeoutMs must be a positive finite timer interval');
    this.#apiKey = apiKey;
    this.#fetch = fetch;
    this.#timeoutMs = timeoutMs;
  }

  async #request(method, route, body) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new JevError('TypeSafe request timed out', { code: 'timeout' }));
        controller.abort();
      }, this.#timeoutMs);
    });
    try {
      return await Promise.race([timeout, (async () => {
        const response = await this.#fetch(`${API_ROOT}${route}`, {
          method,
          headers: { Authorization: `Bearer ${this.#apiKey}`, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body }),
          signal: controller.signal,
          redirect: 'error',
        });
        // Provider errors can echo submitted code or credentials; retain only status.
        if (!response.ok) {
          if (response.body) await response.body.cancel();
          throw new JevError(`TypeSafe HTTP ${response.status}`, { code: 'http_error', status: response.status });
        }
        let parsed;
        try {
          parsed = await response.json();
        } catch {
          throw new JevError('TypeSafe returned invalid JSON', { code: 'invalid_json' });
        }
        return parsed;
      })()]);
    } catch (error) {
      if (error instanceof JevError) throw error;
      throw new JevError('TypeSafe connection failed', { code: 'connection_error' });
    } finally {
      clearTimeout(timer);
    }
  }

  async listModels() {
    const response = await this.#request('GET', '/v1/models');
    requireCondition(isObject(response) && Array.isArray(response.models), 'Model response must contain a models array');
    requireCondition(response.models.every(model => isObject(model)
      && typeof model.name === 'string' && model.name.trim().length > 0
      && typeof model.description === 'string' && typeof model.release_date === 'string'),
    'Model cards require name, description, and release_date strings');
    requireCondition(new Set(response.models.map(model => model.name)).size === response.models.length,
      'Model names must be unique');
    return response.models;
  }

  async systemOne({ state, questions, model }) {
    requireCondition(typeof model === 'string' && model.trim().length > 0, 'An explicit TypeSafe model is required');
    requireCondition(isEntry(state), 'State must be a JSON-compatible string, object, or array');
    validateQuestions(questions);
    const payload = { state, questions, model };
    requireCondition(isJson(payload), 'Request must be losslessly JSON-compatible');
    // Freeze the transmitted contract against caller mutation while the request is pending.
    const body = JSON.stringify(payload);
    const response = await this.#request('POST', '/v1/systemone', body);
    return validateResponse(response, JSON.parse(body).questions);
  }
}

module.exports = { JevClient, JevError, validateResponse, keyFromFile };
