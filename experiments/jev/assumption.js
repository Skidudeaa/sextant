#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readScope, buildRequest } = require('./refutation');
const { JevClient, validateResponse } = require('./client');

const MODEL = 'jev-1.13.0';
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function prepare({ root, claim, scopes, model = MODEL }) {
  if (typeof root !== 'string' || !root.trim()) throw new Error('An explicit repository root is required');
  root = path.resolve(root);
  if (fs.realpathSync(root) !== root) throw new Error('Repository root must not contain symlinks');
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (git(['rev-parse', '--show-toplevel']) !== root) throw new Error('root must name the repository root');
  if (typeof model !== 'string' || !model.trim()) throw new Error('Requested model is required');
  if (!Array.isArray(scopes) || scopes.length < 3 || scopes.length > 4) throw new Error('Select three or four source scopes');
  const seen = new Set();
  const evidence = scopes.map((descriptor, index) => {
    if (!descriptor || typeof descriptor.path !== 'string' || !descriptor.path.endsWith('.js')
      || typeof descriptor.symbol !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(descriptor.symbol)) throw new Error('Scopes require JavaScript paths and top-level declaration names');
    const key = `${descriptor.path}:${descriptor.symbol}`;
    if (seen.has(key)) throw new Error('Duplicate source scope');
    seen.add(key);
    return { id: `scope_${index}`, ...readScope(root, descriptor) };
  });
  const task = { claim, scopes: evidence };
  const request = buildRequest(task, model);
  const freshness = recheckFreshness(root, evidence);
  if (!freshness.unchanged) throw new Error('Source changed while evidence was collected');
  return { root, revision: git(['rev-parse', 'HEAD']), task, request,
    requestHash: fingerprint(request), requestBytes: Buffer.byteLength(JSON.stringify(request)), collectedAt: new Date().toISOString() };
}

function recheckFreshness(root, scopes) {
  const checks = scopes.map(original => {
    try {
      const current = readScope(root, original);
      const unchanged = ['fileSha256', 'scopeSha256', 'startLine', 'endLine', 'startOffset', 'endOffset'].every(key => original[key] === current[key]);
      return { id: original.id, path: original.path, symbol: original.symbol, unchanged,
        reason: unchanged ? 'same_source_bytes' : 'source_changed', currentFileSha256: current.fileSha256, currentScopeSha256: current.scopeSha256 };
    } catch {
      // A deleted, renamed, untracked, or newly excluded source is explicit stale evidence.
      return { id: original.id, path: original.path, symbol: original.symbol, unchanged: false, reason: 'source_unavailable_or_rejected' };
    }
  });
  return { root: path.resolve(root), checkedAt: new Date().toISOString(), unchanged: checks.every(check => check.unchanged), checks };
}

/** Present mutually checked model heads; source drift suppresses every refutation suggestion. */
function presentAssessment(prepared, response, freshness) {
  validateResponse(response, prepared.request.questions);
  const verdict = response.answers.verdict.choice;
  const selected = response.answers.best_refutation.choice;
  const answerable = response.answers.answerable.noul > 0.5;
  const reviewReasons = [];
  if ((verdict === 'insufficient') === answerable) reviewReasons.push('verdict_answerability_disagreement');
  if (verdict !== 'contradicts' && selected !== 'none') reviewReasons.push('refutation_scope_disagrees_with_verdict');
  if (verdict === 'contradicts' && selected === 'none') reviewReasons.push('contradiction_without_refutation_scope');
  if (response.model !== prepared.request.model) reviewReasons.push('returned_model_differs_from_requested');
  const checks = Array.isArray(freshness?.checks) ? freshness.checks : [];
  const checkedIds = checks.map(check => check.id);
  if (!freshness || typeof prepared.root !== 'string' || freshness.root !== prepared.root || typeof freshness.checkedAt !== 'string'
    || checkedIds.length !== prepared.task.scopes.length || new Set(checkedIds).size !== checkedIds.length
    || !prepared.task.scopes.every(scope => checkedIds.includes(scope.id))) throw new Error('A complete source freshness recheck is required');
  for (const scope of prepared.task.scopes) {
    const check = checks.find(item => item.id === scope.id);
    if (check.path !== scope.path || check.symbol !== scope.symbol
      || (check.unchanged && (check.currentFileSha256 !== scope.fileSha256 || check.currentScopeSha256 !== scope.scopeSha256))) {
      throw new Error('Freshness check does not match the selected source evidence');
    }
  }
  if (!freshness.unchanged || freshness.checks.some(check => !check.unchanged)) reviewReasons.push('source_changed_after_request');
  const status = reviewReasons.length ? 'needs_review' : verdict === 'contradicts' ? 'refutation_candidate'
    : verdict === 'supports' ? 'model_supports' : 'insufficient_evidence';
  const source = status === 'refutation_candidate' ? prepared.task.scopes.find(scope => scope.id === selected) : null;
  return { status, reviewReasons, suggestedRefutation: source ? {
    scopeId: source.id, path: source.path, symbol: source.symbol, startLine: source.startLine, endLine: source.endLine,
    fileSha256: source.fileSha256, scopeSha256: source.scopeSha256,
  } : null,
  interpretation: 'Model assessment of the supplied source scopes; no action is taken and correctness is not certified.' };
}

async function runAssessment(options, { client } = {}) {
  const prepared = prepare(options);
  if (typeof options.out !== 'string' || !options.out.trim()) throw new Error('live requires --out new-json-file');
  const api = client || new JevClient();
  const fd = fs.openSync(options.out, 'wx', 0o600);
  const base = { kind: 'sextant-assumption-assessment', executionKind: client ? 'injected-client' : 'live-provider',
    requestedModel: prepared.request.model, root: prepared.root, revision: prepared.revision, collectedAt: prepared.collectedAt,
    requestHash: prepared.requestHash, requestBytes: prepared.requestBytes, claim: prepared.task.claim, scopes: prepared.task.scopes };
  const write = result => { fs.writeSync(fd, `${JSON.stringify(result, null, 2)}\n`); fs.fsyncSync(fd); };
  try {
    const started = performance.now();
    let response;
    try {
      response = await api.systemOne(structuredClone(prepared.request));
      validateResponse(response, prepared.request.questions);
    } catch (error) {
      write({ ...base, status: 'provider_error', error: { code: 'request_failed', httpStatus: Number.isSafeInteger(error.status) ? error.status : null } });
      throw new Error('Assumption assessment request failed; sanitized status recorded in output');
    }
    const latencyMs = performance.now() - started;
    const freshness = recheckFreshness(prepared.root, prepared.task.scopes);
    const presentation = presentAssessment(prepared, response, freshness);
    const result = { ...base, ...presentation, returnedModel: response.model, latencyMs, usage: response.usage,
      modelAssessment: response.answers, freshness, completedAt: new Date().toISOString() };
    write(result);
    return result;
  } finally { fs.closeSync(fd); }
}

function parseArgs(argv) {
  const [mode = 'inspect', ...rest] = argv;
  if (!['inspect', 'live'].includes(mode)) throw new Error('Mode must be inspect or live');
  const options = { mode, scopes: [] };
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index], value = rest[index + 1];
    if (!['--root', '--claim', '--scope', '--out'].includes(name) || !value || value.startsWith('--')) throw new Error('Unknown argument or missing value');
    if (name === '--scope') {
      const separator = value.lastIndexOf(':');
      if (separator < 1) throw new Error('scope must be relative.js:declarationName');
      options.scopes.push({ path: value.slice(0, separator), symbol: value.slice(separator + 1) });
    } else {
      const field = name.slice(2);
      if (Object.hasOwn(options, field)) throw new Error('Duplicate argument');
      options[field] = value;
    }
  }
  if (!options.root || !options.claim) throw new Error('Explicit --root and --claim are required');
  if (mode === 'live' && !options.out) throw new Error('live requires --out new-json-file');
  if (mode === 'inspect' && options.out) throw new Error('--out is only used for live assessment');
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.mode === 'live') {
    const result = await runAssessment(options);
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  const prepared = prepare(options);
  const inspection = { executionKind: 'inspection', providerCalls: 0, requestedModel: prepared.request.model,
    root: prepared.root, revision: prepared.revision, claim: prepared.task.claim, scopes: prepared.task.scopes,
    requestHash: prepared.requestHash, requestBytes: prepared.requestBytes, collectedAt: prepared.collectedAt };
  console.log(JSON.stringify(inspection, null, 2));
  return inspection;
}

module.exports = { prepare, recheckFreshness, presentAssessment, runAssessment, parseArgs, main };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
