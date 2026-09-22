#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const parser = require('@babel/parser');
const refutation = require('./refutation');
const { JevClient, JevError, validateResponse } = require('./client');

const ROOT = path.resolve(__dirname, '../..');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const fingerprint = value => digest(JSON.stringify(value));
const definitions = [
  { id: 'entity-boundary', path: 'lib/summary.js', symbol: 'clampChars', input: ['A &amp; B', 6], output: 'A ', mutantOutput: 'A &amp', control: ['abcdef', 3],
    from: 'if (lastAmp !== -1 && !cut.slice(lastAmp).includes(";")) {', to: 'if (false) {' },
  { id: 'unknown-provenance', path: 'lib/claims.js', symbol: 'provenanceOf', input: ['not-a-known-source'], output: 'live_text', mutantOutput: 'direct', control: ['path_match'],
    from: 'return "live_text";', to: 'return "direct";' },
  { id: 'pytest-filename', path: 'lib/retrieve.js', symbol: 'isTestPath', input: ['test_token.py'], output: true, mutantOutput: false, control: ['tests/token.js'],
    from: String.raw`/(^|\/)test_[^/]*\.[a-z0-9]+$/i.test(p)`, to: String.raw`/(^|\/)check_[^/]*\.[a-z0-9]+$/i.test(p)` },
  { id: 'python-definition', path: 'lib/retrieve.js', symbol: 'looksLikeDefinitionLine', input: ['def run():'], output: true, mutantOutput: false, control: ['function run() {}'],
    from: String.raw`/^\s*(async\s+)?def\s+\w+/.test(line)`, to: String.raw`/^\s*(async\s+)?func\s+\w+/.test(line)` },
];

function mutate(text, definition) {
  if (text.split(definition.from).length !== 2) throw new Error('Mutation anchor must occur exactly once');
  return text.replace(definition.from, definition.to);
}

function stripComments(text) {
  const comments = parser.parse(text, { sourceType: 'script' }).comments;
  if (!comments.length) throw new Error('Comment treatment requires actual existing source comments');
  let result = text;
  for (const comment of [...comments].reverse()) {
    result = result.slice(0, comment.start) + result.slice(comment.start, comment.end).replace(/[^\r\n]/g, ' ') + result.slice(comment.end);
  }
  return result;
}

function execute(text, symbol, input) {
  // These four captured functions are self-contained. No source imports, fs, or process enter the context.
  return JSON.parse(vm.runInNewContext(`${text}\nJSON.stringify(${symbol}(...input))`, { input: structuredClone(input) },
    { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }));
}

function taskClaim(definition) {
  return `For the concrete arguments ${JSON.stringify(definition.input)}, ${definition.symbol} returns ${JSON.stringify(definition.output)}.`;
}

function buildTasks(root = ROOT) {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const distractors = [
    refutation.readScope(root, { path: 'lib/closure.js', symbol: 'foldObservedPair' }),
    refutation.readScope(root, { path: 'lib/freshness.js', symbol: 'sameRepoState' }),
  ];
  const tasks = [];
  definitions.forEach((definition, index) => {
    const original = refutation.readScope(root, definition);
    const mutant = mutate(original.text, definition);
    const originalOutput = execute(original.text, definition.symbol, definition.input);
    const mutantOutput = execute(mutant, definition.symbol, definition.input);
    if (originalOutput !== definition.output || mutantOutput !== definition.mutantOutput || originalOutput === mutantOutput) throw new Error('Counterfactual does not meet its independently specified output oracle');
    const controlOriginal = execute(original.text, definition.symbol, definition.control);
    const controlMutant = execute(mutant, definition.symbol, definition.control);
    if (controlOriginal !== controlMutant) throw new Error('Mutation changed the unaffected control input');
    for (const codeState of ['original', 'mutant']) for (const commentTreatment of ['preserved', 'stripped']) {
      const code = codeState === 'original' ? original.text : mutant;
      const text = commentTreatment === 'preserved' ? code : stripComments(code);
      const actualOutput = execute(text, definition.symbol, definition.input);
      const expectedOutput = codeState === 'original' ? originalOutput : mutantOutput;
      if (actualOutput !== expectedOutput) throw new Error('Comment treatment changed executable behavior');
      const target = { ...original, text, scopeSha256: digest(text),
        origin: { ...original }, transformation: { codeState, commentTreatment,
          semanticEdit: codeState === 'mutant' ? { from: definition.from, to: definition.to } : null,
          comments: commentTreatment === 'preserved' ? 'Actual existing comments retained verbatim, including comments stale under mutation.' : 'Actual comment spans replaced with whitespace; line count preserved.' },
        evidenceStatus: codeState === 'original' && commentTreatment === 'preserved' ? 'verbatim-repository-scope' : 'request-only-transformed-scope' };
      const ordered = [target, ...distractors];
      const offset = index % ordered.length;
      const scopes = [...ordered.slice(offset), ...ordered.slice(0, offset)].map((item, position) => ({ ...item, id: `scope_${position}` }));
      const targetId = scopes.find(item => item.symbol === definition.symbol && item.path === definition.path).id;
      const verdict = actualOutput === definition.output ? 'supports' : 'contradicts';
      tasks.push({ id: `${definition.id}:${codeState}:${commentTreatment}`, groupId: definition.id, split: 'development',
        codeState, commentTreatment, claim: taskClaim(definition), scopes,
        provenance: { revision, experiment: 'source-counterfactual-v1', corpus: 'Four real tracked functions with request-only semantic edits and preserved or removed original comments.',
          sourceKind: 'Original file hash and line coordinates describe origin; transformed scope hash describes the supplied request bytes.' },
        oracle: { engine: 'node:vm', input: definition.input, expectedClaimOutput: definition.output, actualOutput,
          originalOutput, mutantOutput, unaffectedControl: { input: definition.control, originalOutput: controlOriginal, mutantOutput: controlMutant } },
        expected: { verdict, bestRefutation: verdict === 'contradicts' ? targetId : 'none' },
        rationale: 'Concrete input/output label established by executing exactly the displayed target function; no general behavioral equivalence claim.' });
    }
  });
  return tasks;
}

function validateExperiment(frozen) {
  refutation.validateFrozen(frozen);
  if (frozen.tasks.length !== 16) throw new Error('Counterfactual experiment requires exactly sixteen tasks');
  const expectedIds = new Set();
  for (const definition of definitions) for (const code of ['original', 'mutant']) for (const comments of ['preserved', 'stripped']) expectedIds.add(`${definition.id}:${code}:${comments}`);
  for (const task of frozen.tasks) {
    if (!expectedIds.delete(task.id) || task.split !== 'development' || task.provenance.experiment !== 'source-counterfactual-v1') throw new Error('Unexpected counterfactual task');
    const definition = definitions.find(item => item.id === task.groupId);
    if (!definition || task.claim !== taskClaim(definition) || !['original', 'mutant'].includes(task.codeState)
      || !['preserved', 'stripped'].includes(task.commentTreatment) || task.id !== `${definition.id}:${task.codeState}:${task.commentTreatment}`) throw new Error('Fixed claim or treatment differs from predefined task');
    const target = task.scopes.find(scope => scope.path === definition.path && scope.symbol === definition.symbol);
    if (!target?.origin || target.origin.path !== definition.path || target.origin.symbol !== definition.symbol || digest(target.origin.text) !== target.origin.scopeSha256
      || target.origin.fileSha256 !== target.fileSha256) throw new Error('Missing counterfactual source origin');
    let rebuilt = task.codeState === 'original' ? target.origin.text : mutate(target.origin.text, definition);
    if (task.commentTreatment === 'stripped') rebuilt = stripComments(rebuilt);
    if (rebuilt !== target.text) throw new Error('Displayed source does not match the declared transformation');
    const actualOutput = execute(target.text, definition.symbol, definition.input);
    const expectedOutput = task.codeState === 'original' ? definition.output : definition.mutantOutput;
    if (actualOutput !== expectedOutput || task.oracle.actualOutput !== actualOutput
      || task.expected.verdict !== (actualOutput === definition.output ? 'supports' : 'contradicts')
      || task.expected.bestRefutation !== (task.codeState === 'mutant' ? target.id : 'none')) throw new Error('Executable output does not establish frozen label');
  }
  return frozen;
}

function freeze(root = ROOT) {
  const { fingerprint: previousFingerprint, ...payload } = refutation.freezeTasks(buildTasks(root));
  payload.generatorSha256 = digest(fs.readFileSync(__filename));
  return validateExperiment({ ...payload, fingerprint: fingerprint(payload) });
}

function report(records) {
  const frozen = validateExperiment(records[0]?.experiment);
  const summary = refutation.report(records);
  const results = records.filter(row => row.kind === 'result');
  for (const [model, metrics] of Object.entries(summary.byModel)) {
    const pairs = results.filter(row => row.response.model === model).map(row => ({ task: frozen.tasks.find(task => task.id === row.id), response: row.response }));
    metrics.byCommentTreatment = Object.fromEntries(['preserved', 'stripped'].map(treatment => {
      const matching = pairs.filter(pair => pair.task.commentTreatment === treatment);
      return [treatment, { n: matching.length, verdictCorrect: matching.filter(pair => pair.response.answers.verdict.choice === pair.task.expected.verdict).length }];
    }));
    const indexed = new Map(pairs.map(pair => [pair.task.id, pair]));
    const sensitivity = { completePairs: 0, verdictFlips: 0, bothCorrect: 0 };
    const comments = { completePairs: 0, sameVerdict: 0 };
    for (const definition of definitions) {
      for (const treatment of ['preserved', 'stripped']) {
        const a = indexed.get(`${definition.id}:original:${treatment}`), b = indexed.get(`${definition.id}:mutant:${treatment}`);
        if (!a || !b) continue;
        sensitivity.completePairs++;
        sensitivity.verdictFlips += Number(a.response.answers.verdict.choice !== b.response.answers.verdict.choice);
        sensitivity.bothCorrect += Number(a.response.answers.verdict.choice === 'supports' && b.response.answers.verdict.choice === 'contradicts');
      }
      for (const codeState of ['original', 'mutant']) {
        const a = indexed.get(`${definition.id}:${codeState}:preserved`), b = indexed.get(`${definition.id}:${codeState}:stripped`);
        if (!a || !b) continue;
        comments.completePairs++;
        comments.sameVerdict += Number(a.response.answers.verdict.choice === b.response.answers.verdict.choice);
      }
    }
    metrics.sourceChangeSensitivity = sensitivity;
    metrics.commentInvariance = comments;
  }
  return { ...summary, experiment: 'source-counterfactual-v1', evidence: summary.executionKind === 'mock-transport'
    ? 'Injected test transport; no provider intelligence measured.' : 'Observed provider assessments of executable input-specific counterfactual source tasks.',
  limitations: ['Development-only tasks with VM-executed concrete input/output labels; no held-out or general equivalence claim.',
    'Four functions and sixteen related requests are not sixteen independent samples.',
    'Only existing source comments are preserved or removed; no synthetic instructions were added.',
    'Source transformations exist only in requests and disposable VM contexts; repository runtime files remain unchanged.'] };
}

async function runFrozen(frozen, out, { client } = {}) {
  validateExperiment(frozen);
  const api = client || new JevClient();
  const fd = fs.openSync(out, 'wx', 0o600), records = [];
  const append = row => { fs.writeSync(fd, `${JSON.stringify(row)}\n`); fs.fsyncSync(fd); records.push(row); };
  try {
    append({ kind: 'manifest', experiment: frozen, executionKind: client ? 'mock-transport' : 'live-provider',
      evaluatorSha256: digest(fs.readFileSync(__filename)), timestamp: new Date().toISOString() });
    for (const planned of frozen.plan) {
      const started = performance.now();
      let response;
      try {
        response = await api.systemOne(structuredClone(planned.request));
        validateResponse(response, planned.request.questions);
      } catch (error) {
        const messages = { invalid_contract: 'Response failed the local typed contract.',
          invalid_json: 'Response was not valid JSON.', timeout: 'Request exceeded its deadline.',
          http_error: 'Provider returned an unsuccessful HTTP status.', connection_error: 'Connection did not complete.' };
        const code = error instanceof JevError && Object.hasOwn(messages, error.code) ? error.code : 'unknown_failure';
        append({ kind: 'error', id: planned.id, requestHash: planned.requestHash, reason: 'request_failed', code,
          message: messages[code] || 'Request failed without a recognized client error.',
          status: code === 'http_error' && Number.isSafeInteger(error.status) && error.status >= 100 && error.status <= 599 ? error.status : null });
        append({ kind: 'summary', ...report(records) });
        throw new Error('Counterfactual request failed; sanitized status recorded');
      }
      append({ kind: 'result', id: planned.id, requestHash: planned.requestHash, response, latencyMs: performance.now() - started });
    }
    const result = report(records); append({ kind: 'summary', ...result }); return result;
  } finally { fs.closeSync(fd); }
}

async function main(argv) {
  const [mode = 'inspect', ...rest] = argv;
  if (!['inspect', 'freeze', 'live', 'report'].includes(mode)) throw new Error('Mode must be inspect, freeze, live, or report');
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--input', '--out'].includes(rest[i]) || !rest[i + 1] || options[rest[i]]) throw new Error('Invalid or duplicate argument');
    options[rest[i]] = rest[i + 1];
  }
  let result;
  if (mode === 'inspect' || mode === 'freeze') {
    const frozen = freeze();
    result = { tasks: frozen.tasks.length, groups: definitions.length, seed: frozen.seed, providerCalls: 0,
      preservedCommentsTasks: 8, strippedCommentsTasks: 8, expected: { supports: 8, contradicts: 8 },
      maxRequestBytes: Math.max(...frozen.plan.map(row => Buffer.byteLength(JSON.stringify(row.request)))), fingerprint: frozen.fingerprint };
    if (mode === 'freeze') {
      if (!options['--out']) throw new Error('freeze requires --out');
      fs.writeFileSync(options['--out'], `${JSON.stringify(frozen, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      result.out = options['--out'];
    }
  } else {
    if (!options['--input']) throw new Error('input artifact is required');
    const text = fs.readFileSync(options['--input'], 'utf8');
    if (mode === 'live') {
      if (!options['--out']) throw new Error('live requires --out');
      result = await runFrozen(JSON.parse(text), options['--out']);
    } else {
      result = report(text.trim().split('\n').map(JSON.parse));
      if (options['--out']) fs.writeFileSync(options['--out'], `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    }
  }
  console.log(JSON.stringify(result, null, 2)); return result;
}

module.exports = { buildTasks, stripComments, execute, validateExperiment, freeze, runFrozen, report, main };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
