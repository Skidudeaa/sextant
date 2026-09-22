#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { isDeepStrictEqual } = require('node:util');
const { execFileSync } = require('node:child_process');
const lab = require('./lab');
const { JevClient } = require('./client');

const MODEL = 'jev-1.13.0';
const SEED = 20260922;
const definitions = [];

function family(name, inputLiteral, producer, consumer, edits) {
  for (const [scenario, producerA, consumerB] of edits) definitions.push({
    id: `coordination/${name}/${scenario}`, family: name, inputLiteral,
    producer, consumer, producerA, consumerB,
  });
}

family('field_names', '7', 'x => ({ value: x })', 'r => r.value', [
  ['mutual-repair', 'x => ({ payload: x })', 'r => r.payload'],
  ['emergent-conflict', 'x => ({ value: x, legacy: x + 1 })', 'r => r.legacy ?? r.value'],
  ['one-sided-regression', 'x => ({ payload: x })', 'r => { return r.value; }'],
  ['benign-pair', 'x => ({ value: x, meta: "ok" })', 'r => Number(r.value)'],
]);
family('units', '2', 'x => ({ seconds: x })', 'r => r.seconds * 1000', [
  ['mutual-repair', 'x => ({ milliseconds: x * 1000 })', 'r => r.milliseconds'],
  ['emergent-conflict', 'x => ({ seconds: x, milliseconds: x * 1000 })', 'r => r.milliseconds === undefined ? r.seconds * 1000 : r.milliseconds * 1000'],
  ['one-sided-regression', 'x => ({ seconds: x * 1000 })', 'r => 1000 * r.seconds'],
  ['benign-pair', 'x => ({ seconds: x, unit: "s" })', 'r => 1000 * r.seconds'],
]);
family('enum_validation', '"ready"', 'x => ({ status: x })', 'r => ({ ready: 1, done: 2 }[r.status] ?? -1)', [
  ['mutual-repair', 'x => ({ status: x.toUpperCase() })', 'r => ({ READY: 1, DONE: 2 }[r.status] ?? -1)'],
  ['emergent-conflict', 'x => ({ status: x, format: "v2" })', 'r => r.format === "v2" ? ({ READY: 1, DONE: 2 }[r.status] ?? -1) : ({ ready: 1, done: 2 }[r.status] ?? -1)'],
  ['one-sided-regression', 'x => ({ status: "queued" })', 'r => r.status === "ready" ? 1 : r.status === "done" ? 2 : -1'],
  ['benign-pair', 'x => ({ status: x, allowed: ["ready", "done", "queued"] })', 'r => ({ ready: 1, done: 2, queued: 3 }[r.status] ?? -1)'],
]);
family('metadata_validation', '9', 'x => ({ value: x })', 'r => r.value', [
  ['mutual-repair', 'x => ({ data: { value: x } })', 'r => r.data.value'],
  ['emergent-conflict', 'x => ({ value: x, debug: true })', 'r => Object.keys(r).length === 1 ? r.value : "reject-extra"'],
  ['one-sided-regression', 'x => ({ value: x, debug: true })', 'r => r.value + 1'],
  ['benign-pair', 'x => ({ value: x, debug: true })', 'r => { const { value } = r; return value; }'],
]);
family('ordering', '[3, 1, 2]', 'x => ({ items: [...x] })', 'r => r.items[0]', [
  ['mutual-repair', 'x => ({ items: [...x].reverse() })', 'r => r.items[r.items.length - 1]'],
  ['emergent-conflict', 'x => ({ items: [...x], display: [...x].reverse() })', 'r => (r.display ?? r.items)[0]'],
  ['one-sided-regression', 'x => ({ items: [...x].sort((a, b) => a - b) })', 'r => r.items.at(0)'],
  ['benign-pair', 'x => ({ items: x.slice(), length: x.length })', 'r => r.items.at(0)'],
]);
family('nullability', 'null', 'x => ({ value: x })', 'r => r.value === null ? "absent" : String(r.value)', [
  ['mutual-repair', 'x => ({ value: x === null ? "" : x })', 'r => r.value === "" ? "absent" : String(r.value)'],
  ['emergent-conflict', 'x => ({ value: x, display: "" })', 'r => Object.hasOwn(r, "display") ? String(r.display) : r.value === null ? "absent" : String(r.value)'],
  ['one-sided-regression', 'x => ({ value: x === null ? undefined : x })', 'r => r.value === null ? "absent" : `${r.value}`'],
  ['benign-pair', 'x => ({ value: x, source: "db" })', 'r => r.value == null ? "absent" : String(r.value)'],
]);
family('cache_keys', '({ tenant: "acme", id: 7 })', 'x => ({ key: String(x.id), value: "entry" })', 'r => r.key === "7" ? r.value : null', [
  ['mutual-repair', 'x => ({ key: `${x.tenant}:${x.id}`, value: "entry" })', 'r => r.key === "acme:7" ? r.value : null'],
  ['emergent-conflict', 'x => ({ key: String(x.id), alternateKey: `${x.tenant}:${x.id}`, value: "entry" })', 'r => (r.alternateKey ?? r.key) === "7" ? r.value : null'],
  ['one-sided-regression', 'x => ({ key: String(x.id + 1), value: "entry" })', 'r => { return r.key === "7" ? r.value : null; }'],
  ['benign-pair', 'x => ({ key: String(x.id), value: "entry", tenant: x.tenant })', 'r => r.key === String(7) ? r.value : null'],
]);
family('fallback_precedence', '0', 'x => ({ value: x })', 'r => r.value === 0 ? "zero" : r.value', [
  ['mutual-repair', 'x => ({ value: String(x) })', 'r => r.value === "0" ? "zero" : r.value'],
  ['emergent-conflict', 'x => ({ value: x, fallback: 5 })', 'r => { const value = r.fallback ?? r.value; return value === 0 ? "zero" : value; }'],
  ['one-sided-regression', 'x => ({ value: x || 5 })', 'r => r.value === 0 ? ("zero") : r.value'],
  ['benign-pair', 'x => ({ value: x ?? 5 })', 'r => r.value === 0 ? ("zero") : r.value'],
]);

// Preserve undefined, NaN and signed zero without conflating them with null.
// Object key order and allocation identity are outside this experiment's contract.
function encode(value) {
  if (value === undefined) return { type: 'undefined' };
  if (value === null) return { type: 'null' };
  if (typeof value === 'number') return { type: 'number', value: Number.isNaN(value) ? 'NaN' : Object.is(value, -0) ? '-0' : Number.isFinite(value) ? value : String(value) };
  if (Array.isArray(value)) return { type: 'array', values: Array.from(value, encode) };
  if (typeof value === 'object') return { type: 'object', entries: Object.keys(value).sort().map(key => [key, encode(value[key])]) };
  if (typeof value === 'string' || typeof value === 'boolean') return { type: typeof value, value };
  throw new Error('Unsupported fixture return value');
}

function evaluate(producer, consumer, inputLiteral) {
  // Only the fixed authored definitions above are executed. VM is not a
  // security boundary and this helper is deliberately not exported.
  let value;
  try {
    value = vm.runInNewContext(`const input = (${inputLiteral}); const produce = (${producer}); const consume = (${consumer}); consume(produce(input));`, Object.create(null), { timeout: 100 });
  } catch (error) {
    if (!['TypeError', 'RangeError'].includes(error.name)) throw error;
    return { kind: 'throw', name: error.name };
  }
  return { kind: 'return', value: encode(value) };
}

const heads = {
  joint_regression: ['Does merged differ from baseline under comparison_contract for the exact supplied input?', 'The merged outcome differs from baseline.', 'The merged outcome equals baseline.'],
  emergent_conflict: ['Are A_only and B_only each equal to baseline, while merged differs from baseline, under comparison_contract for this exact input?', 'Each edit alone preserves baseline, but merging them changes the outcome.', 'This exact three-part interaction condition does not hold.'],
  mutual_repair: ['Do A_only and B_only each differ from baseline, while merged equals baseline, under comparison_contract for this exact input?', 'Each edit alone changes baseline, but their merge restores it.', 'This exact three-part repair condition does not hold.'],
};

function buildCases() {
  return definitions.map(d => {
    const state = {
      language: 'JavaScript', input_literal: d.inputLiteral,
      agent_A: { path: 'src/producer.js', baseline_function: d.producer, edited_function: d.producerA },
      agent_B: { path: 'src/consumer.js', baseline_function: d.consumer, edited_function: d.consumerB },
      execution_contract: 'Evaluate input_literal as a JavaScript expression. Call consumer(producer(input)). A_only uses edited A and baseline B; B_only uses baseline A and edited B; merged uses both edits; baseline uses both baseline functions. Use a fresh input for each evaluation.',
      comparison_contract: 'Compare the returned values for exactly this input, or the thrown exception type. Ignore allocation identity, object key order and exception messages. Array order matters. undefined differs from null. NaN equals NaN; negative zero differs from positive zero. No universal equivalence claim is requested.',
    };
    const oracle = {
      baseline: evaluate(d.producer, d.consumer, d.inputLiteral),
      A_only: evaluate(d.producerA, d.consumer, d.inputLiteral),
      B_only: evaluate(d.producer, d.consumerB, d.inputLiteral),
      merged: evaluate(d.producerA, d.consumerB, d.inputLiteral),
    };
    if (oracle.baseline.kind !== 'return') throw new Error(`Invalid baseline: ${d.id}`);
    const a = !isDeepStrictEqual(oracle.A_only, oracle.baseline);
    const b = !isDeepStrictEqual(oracle.B_only, oracle.baseline);
    const merged = !isDeepStrictEqual(oracle.merged, oracle.baseline);
    return { id: d.id, family: `coordination_${d.family}`, groupId: `coordination/${d.family}`, split: 'development',
      provenance: { kind: 'executable-synthetic', source: 'experiments/jev/coordination.js', sourceHash: lab.hash(state), runtime: process.version },
      rationale: 'Labels derive from four actual executions of trusted fixture code. Disjoint edit paths do not prove compatible protocol behavior.',
      state, questions: Object.fromEntries(Object.entries(heads).map(([id, [instructions, yes, no]]) => [id, { type: 'noul', instructions, criteria: { true: yes, false: no } }])),
      expected: { joint_regression: merged, emergent_conflict: !a && !b && merged, mutual_repair: a && b && !merged }, oracle,
      pathOverlap: state.agent_A.path === state.agent_B.path };
  });
}

function plan({ seed = SEED, model = MODEL } = {}) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Seed must be a uint32');
  if (typeof model !== 'string' || !model.trim()) throw new Error('Model must be explicit');
  const cases = buildCases();
  lab.validateCases(cases);
  const ordered = lab.shuffle(cases, seed);
  const manifest = { kind: 'manifest', experiment: 'disjoint-agent-coordination', version: 1,
    seed, model, variants: ['original'], requests: ordered.length, corpusSnapshot: cases, corpusHash: lab.hash(cases),
    plannedTasks: ordered.map(c => ({ caseId: c.id, variant: 'original', requestHash: lab.hash(lab.buildRequest(c, 'original', model).request) })),
    sourceHash: lab.hash(fs.readFileSync(__filename, 'utf8')), revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname, encoding: 'utf8' }).trim(),
    timestamp: new Date().toISOString(), evaluationScope: 'diagnostic-development-only; no held-out generalization claim' };
  return { manifest, ordered };
}

function replay(records) {
  const manifest = records[0];
  if (manifest?.experiment !== 'disjoint-agent-coordination' || manifest.version !== 1) throw new Error('Wrong coordination experiment manifest');
  if (manifest.sourceHash !== lab.hash(fs.readFileSync(__filename, 'utf8'))) throw new Error('Coordination source fingerprint differs; replay with its matching source revision');
  if (!Array.isArray(manifest.corpusSnapshot) || manifest.corpusSnapshot.length !== 32 || manifest.requests !== 32) throw new Error('Coordination requires the complete 32-fixture plan');
  const trusted = new Map(buildCases().map(c => [c.id, c]));
  for (const frozen of manifest.corpusSnapshot) {
    const current = trusted.get(frozen.id);
    if (!current || !isDeepStrictEqual(current.state, frozen.state) || !isDeepStrictEqual(current.questions, frozen.questions)
      || !isDeepStrictEqual(current.expected, frozen.expected) || !isDeepStrictEqual(current.oracle, frozen.oracle)
      || frozen.provenance.sourceHash !== lab.hash(frozen.state) || frozen.pathOverlap !== false || frozen.split !== 'development'
      || frozen.family !== current.family || frozen.groupId !== current.groupId) throw new Error('Fixture source or execution labels differ; replay with its matching source revision');
  }
  const expectedOrder = lab.shuffle(manifest.corpusSnapshot, manifest.seed).map(c => c.id);
  if (!isDeepStrictEqual(expectedOrder, manifest.plannedTasks?.map(t => t.caseId))) throw new Error('Frozen request order does not match seed');
  return lab.replay(records);
}

function summarizeValidated(records) {
  const manifest = records.find(r => r.kind === 'manifest');
  const results = records.filter(r => r.kind === 'result');
  const errors = records.filter(r => r.kind === 'error').length;
  const models = [...new Set(results.map(r => r.response.model))];
  const accounting = { plannedRequests: manifest?.requests ?? null, completedRequests: results.length, errors,
    unattemptedRequests: manifest ? manifest.requests - results.length - errors : null };
  if (models.length > 1) return { status: 'mixed-model-results-partitioned', ...accounting, models,
    byModel: Object.fromEntries(models.map(model => [model, summarizeValidated(results.filter(r => r.response.model === model))])),
    limitations: ['No pooled quality across returned models.', 'All fixtures are diagnostic development cases.'] };
  const flat = results.flatMap(r => r.predictions.map(p => ({ ...p, caseId: r.caseId, family: r.family })));
  const perHead = Object.fromEntries(Object.keys(heads).map(head => [head, lab.metrics(flat.filter(p => p.qid === head))]));
  const joint = flat.filter(p => p.qid === 'joint_regression');
  return { status: !results.length ? 'no-provider-results' : manifest && results.length < manifest.requests ? 'partial-provider-results' : 'completed-provider-results',
    ...accounting, models, perHead,
    allThreeCorrect: results.filter(r => r.predictions.every(p => (p.p > 0.5) === p.expected)).length,
    contradictoryDecisions: results.filter(r => {
      const p = Object.fromEntries(r.predictions.map(p => [p.qid, p.p > 0.5]));
      return (p.emergent_conflict && !p.joint_regression) || (p.mutual_repair && p.joint_regression) || (p.emergent_conflict && p.mutual_repair);
    }).length,
    pathOverlapComparator: { description: 'Disjoint file paths always predict no joint regression. This is an intentionally limited structural comparator, not a semantic conflict detector.', ...lab.metrics(joint.map(p => ({ ...p, p: 0 }))) },
    inputTokens: results.reduce((sum, r) => sum + r.response.usage.input_tokens, 0),
    limitations: ['Synthetic protocol fixtures, not observed agent mistakes.', 'Labels concern only the specified input.', 'No held-out partition or threshold fitting; fixed p > 0.5 decisions.', 'Model judgments do not authorize edits or replace execution.'] };
}

function summarize(records) { return summarizeValidated(replay(records)); }

async function live(out, { client, seed = SEED, model = MODEL } = {}) {
  const { manifest, ordered } = plan({ seed, model });
  const api = client || new JevClient();
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const fd = fs.openSync(out, 'wx', 0o600);
  const records = [];
  const append = record => { fs.writeSync(fd, JSON.stringify(record) + '\n'); fs.fsyncSync(fd); records.push(record); };
  try {
    append(manifest);
    console.log(`seed=${seed}; requests=${ordered.length}; model=${model}`);
    for (const c of ordered) {
      const { request, targets } = lab.buildRequest(c, 'original', model);
      const start = performance.now();
      try {
        const response = await api.systemOne(request);
        // Transport injection is for offline tests; validate its responses too.
        require('./client').validateResponse(response, request.questions);
        append({ kind: 'result', caseId: c.id, family: c.family, groupId: c.groupId, split: c.split, variant: 'original',
          requestHash: lab.hash(request), latencyMs: performance.now() - start, response, predictions: lab.predictions(response, targets) });
      } catch (error) {
        append({ kind: 'error', caseId: c.id, variant: 'original', requestHash: lab.hash(request), error: error.name, status: error.status ?? null });
        append({ kind: 'summary', ...summarize(records) });
        throw error;
      }
    }
    const result = summarize(records);
    append({ kind: 'summary', ...result });
    return result;
  } finally { fs.closeSync(fd); }
}

async function main(argv) {
  const options = { mode: 'inspect', seed: SEED, model: MODEL };
  const keys = { '--seed': 'seed', '--model': 'model', '--out': 'out', '--input': 'input' };
  for (let i = 0; i < argv.length; i++) {
    if (['inspect', 'live', 'report'].includes(argv[i])) options.mode = argv[i];
    else if (keys[argv[i]] && argv[i + 1] && !argv[i + 1].startsWith('--')) options[keys[argv[i]]] = argv[++i];
    else throw new Error('Unknown argument or missing value');
  }
  options.seed = Number(options.seed);
  if (options.mode === 'report') {
    if (!options.input) throw new Error('report requires --input');
    const records = fs.readFileSync(options.input, 'utf8').trim().split('\n').map(JSON.parse);
    console.log(JSON.stringify(summarize(records), null, 2));
  } else if (options.mode === 'live') {
    if (!options.out) throw new Error('live requires --out new-jsonl');
    console.log(JSON.stringify(await live(options.out, options), null, 2));
  } else {
    const { manifest } = plan(options);
    console.log(JSON.stringify({ experiment: manifest.experiment, seed: manifest.seed, model: manifest.model, cases: manifest.requests, questions: manifest.requests * 3,
      positives: Object.fromEntries(Object.keys(heads).map(head => [head, manifest.corpusSnapshot.filter(c => c.expected[head]).length])),
      disjointPaths: manifest.corpusSnapshot.every(c => !c.pathOverlap), sourceHash: manifest.sourceHash, corpusHash: manifest.corpusHash, providerCalls: 0 }, null, 2));
  }
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildCases, plan, replay, summarize, live, main };
