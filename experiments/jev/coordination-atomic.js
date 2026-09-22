#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const coordination = require('./coordination');
const lab = require('./lab');
const { JevClient, validateResponse } = require('./client');
const MODEL = 'jev-1.13.0';
const SEED = 20260922;
const directHeads = ['joint_regression', 'emergent_conflict', 'mutual_repair'];
const baseSourcePath = require.resolve('./coordination');

function buildCases() {
  return coordination.buildCases().map(c => ({ ...c,
    questions: { ...c.questions,
      A_regression: { type: 'noul', instructions: 'Does A_only differ from baseline under comparison_contract for the exact supplied input? A_only combines agent_A.edited_function with agent_B.baseline_function.', criteria: { true: 'A_only differs from baseline.', false: 'A_only equals baseline.' } },
      B_regression: { type: 'noul', instructions: 'Does B_only differ from baseline under comparison_contract for the exact supplied input? B_only combines agent_A.baseline_function with agent_B.edited_function.', criteria: { true: 'B_only differs from baseline.', false: 'B_only equals baseline.' } },
    },
    expected: { ...c.expected,
      A_regression: !isDeepStrictEqual(c.oracle.A_only, c.oracle.baseline),
      B_regression: !isDeepStrictEqual(c.oracle.B_only, c.oracle.baseline),
    },
  }));
}

function plan({ seed = SEED, model = MODEL } = {}) {
  // The original planner supplies the identical 32 executable states and seeded order.
  const original = coordination.plan({ seed, model }).manifest;
  const cases = buildCases();
  const ordered = lab.shuffle(cases, seed);
  return { ordered, manifest: { ...original, experiment: 'disjoint-agent-coordination-atomic', version: 1,
    sourceHash: lab.hash(fs.readFileSync(__filename, 'utf8')),
    baseSourceHash: lab.hash(fs.readFileSync(baseSourcePath, 'utf8')),
    corpusSnapshot: cases, corpusHash: lab.hash(cases),
    plannedTasks: ordered.map(c => ({ caseId: c.id, variant: 'original', requestHash: lab.hash(lab.buildRequest(c, 'original', model).request) })),
  } };
}

function replay(records) {
  const m = records[0];
  if (m?.experiment !== 'disjoint-agent-coordination-atomic' || m.version !== 1) throw new Error('Wrong atomic experiment manifest');
  if (m.sourceHash !== lab.hash(fs.readFileSync(__filename, 'utf8')) || m.baseSourceHash !== lab.hash(fs.readFileSync(baseSourcePath, 'utf8'))) throw new Error('Source fingerprint differs');
  if (m.requests !== 32 || m.corpusSnapshot?.length !== 32 || !isDeepStrictEqual(m.variants, ['original'])) throw new Error('Expected full atomic plan');
  const trusted = new Map(buildCases().map(c => [c.id, c]));
  for (const frozen of m.corpusSnapshot) {
    const current = trusted.get(frozen.id);
    if (!current || ['state', 'questions', 'expected', 'oracle', 'family', 'groupId', 'split', 'pathOverlap'].some(k => !isDeepStrictEqual(frozen[k], current[k]))
      || frozen.provenance.sourceHash !== lab.hash(frozen.state)) throw new Error('Frozen fixture differs from executable source');
  }
  if (!Number.isSafeInteger(m.seed) || m.seed < 0 || m.seed > 0xffffffff) throw new Error('Invalid seed');
  if (!isDeepStrictEqual(lab.shuffle(m.corpusSnapshot, m.seed).map(c => c.id), m.plannedTasks?.map(t => t.caseId))) throw new Error('Frozen order differs from seed');
  return lab.replay(records);
}

function decisions(r) {
  const raw = Object.fromEntries(r.predictions.map(p => [p.qid, p.p > 0.5]));
  const joint = raw.joint_regression;
  return { direct: Object.fromEntries(directHeads.map(h => [h, raw[h]])), derived: {
    joint_regression: joint,
    emergent_conflict: !raw.A_regression && !raw.B_regression && joint,
    mutual_repair: raw.A_regression && raw.B_regression && !joint,
  } };
}

function conflicts(d) {
  return (d.emergent_conflict && !d.joint_regression) || (d.mutual_repair && d.joint_regression) || (d.emergent_conflict && d.mutual_repair);
}

// Boolean combinations are decisions, not calibrated joint probabilities.
function confusion(rows) {
  const result = { n: rows.length, tp: 0, fp: 0, tn: 0, fn: 0 };
  for (const r of rows) result[r.expected ? (r.decision ? 'tp' : 'fn') : (r.decision ? 'fp' : 'tn')]++;
  return { ...result, accuracy: rows.length ? (result.tp + result.tn) / rows.length : null };
}

function pairedComparison(before, after, truth) {
  const ids = [...after.keys()].filter(id => before.has(id));
  const perHead = Object.fromEntries(directHeads.map(head => {
    let corrected = 0, regressed = 0, bothCorrect = 0, bothWrong = 0;
    for (const id of ids) {
      const a = before.get(id)[head] === truth.get(id)[head], b = after.get(id)[head] === truth.get(id)[head];
      if (!a && b) corrected++; else if (a && !b) regressed++; else if (a) bothCorrect++; else bothWrong++;
    }
    return [head, { corrected, regressed, bothCorrect, bothWrong }];
  }));
  const allCorrect = map => ids.filter(id => directHeads.every(h => map.get(id)[h] === truth.get(id)[h])).length;
  return { matchedCases: ids.length, perHead, beforeAllThreeCorrect: allCorrect(before), afterAllThreeCorrect: allCorrect(after) };
}

function summarize(records, originalRecords = null) {
  const validated = replay(records), m = validated[0];
  const results = validated.filter(r => r.kind === 'result');
  const errors = validated.filter(r => r.kind === 'error').length;
  const truth = new Map(m.corpusSnapshot.map(c => [c.id, c.expected]));
  const models = [...new Set(results.map(r => r.response.model))];
  let original = null;
  if (originalRecords) {
    original = coordination.replay(originalRecords);
    const oldCases = new Map(original[0].corpusSnapshot.map(c => [c.id, c]));
    for (const c of m.corpusSnapshot) {
      const old = oldCases.get(c.id);
      if (!old || !isDeepStrictEqual(old.state, c.state) || !isDeepStrictEqual(old.oracle, c.oracle)) throw new Error('Original comparison uses different executable cases');
    }
  }
  function partition(rows) {
    const direct = new Map(rows.map(r => [r.caseId, decisions(r).direct]));
    const derived = new Map(rows.map(r => [r.caseId, decisions(r).derived]));
    const arm = map => ({ perHead: Object.fromEntries(directHeads.map(h => [h, confusion(rows.map(r => ({ expected: truth.get(r.caseId)[h], decision: map.get(r.caseId)[h] })))])),
      allThreeCorrect: rows.filter(r => directHeads.every(h => map.get(r.caseId)[h] === truth.get(r.caseId)[h])).length,
      contradictoryDecisions: [...map.values()].filter(conflicts).length });
    const latency = rows.map(r => r.latencyMs).sort((a, b) => a - b);
    const inputTokens = rows.reduce((sum, r) => sum + r.response.usage.input_tokens, 0);
    const result = { n: rows.length,
      rawHeads: Object.fromEntries(Object.keys(m.corpusSnapshot[0].questions).map(h => [h, lab.metrics(rows.flatMap(r => r.predictions.filter(p => p.qid === h)))])),
      direct: arm(direct), derived: arm(derived), sameRequestComparison: pairedComparison(direct, derived, truth),
      inputTokens, estimatedUSD: inputTokens * 0.042 / 1e6,
      latencyMs: { median: latency.length ? (latency[Math.floor((latency.length - 1) / 2)] + latency[Math.floor(latency.length / 2)]) / 2 : null, p95: latency.length ? latency[Math.ceil(latency.length * 0.95) - 1] : null },
      cases: rows.map(r => ({ caseId: r.caseId, expected: truth.get(r.caseId), probabilities: Object.fromEntries(r.predictions.map(p => [p.qid, p.p])), ...decisions(r) })),
    };
    if (original) {
      const previous = original.filter(r => r.kind === 'result');
      const oldModels = [...new Set(previous.map(r => r.response.model))];
      result.previousRunComparisonByModel = Object.fromEntries(oldModels.map(model => {
        const before = new Map(previous.filter(r => r.response.model === model).map(r => [r.caseId, Object.fromEntries(r.predictions.map(p => [p.qid, p.p > 0.5]))]));
        return [model, { originalDirectToNewDerived: pairedComparison(before, derived, truth), originalDirectToNewDirect: pairedComparison(before, direct, truth) }];
      }));
    }
    return result;
  }
  return { status: errors || results.length < 32 ? 'partial-provider-results' : 'completed-provider-results', plannedRequests: 32, completedRequests: results.length, errors,
    unattemptedRequests: 32 - results.length - errors, models, threshold: 0.5,
    ...(models.length > 1 ? { byModel: Object.fromEntries(models.map(model => [model, partition(results.filter(r => r.response.model === model))])) } : partition(results)),
    limitations: ['Diagnostic development fixtures in eight related families; no unseen-case generalization.', 'Derived decisions are Boolean functions of three thresholded atomic answers; no calibrated joint probability is claimed.', 'Derived logical coherence follows by construction and does not prove accuracy.', 'Adding questions also changes the direct-head request context; prior-run comparison is not a randomized causal estimate.'],
  };
}

async function live(out, { client, seed = SEED, model = MODEL } = {}) {
  const { manifest, ordered } = plan({ seed, model });
  const api = client || new JevClient();
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const fd = fs.openSync(out, 'wx', 0o600), records = [];
  const append = r => { fs.writeSync(fd, JSON.stringify(r) + '\n'); fs.fsyncSync(fd); records.push(r); };
  try {
    append(manifest);
    console.log(`seed=${seed}; requests=32; questions=160; model=${model}`);
    for (const c of ordered) {
      const { request, targets } = lab.buildRequest(c, 'original', model);
      const start = performance.now();
      try {
        const response = await api.systemOne(request);
        validateResponse(response, request.questions);
        append({ kind: 'result', caseId: c.id, variant: 'original', family: c.family, groupId: c.groupId, split: c.split,
          requestHash: lab.hash(request), latencyMs: performance.now() - start, response, predictions: lab.predictions(response, targets) });
      } catch (error) {
        append({ kind: 'error', caseId: c.id, variant: 'original', requestHash: lab.hash(request), error: error.name, status: error.status ?? null });
        append({ kind: 'summary', ...summarize(records) });
        throw error;
      }
    }
    const summary = summarize(records);
    append({ kind: 'summary', ...summary });
    return summary;
  } finally { fs.closeSync(fd); }
}

async function main(argv) {
  const options = { mode: 'inspect', seed: SEED, model: MODEL };
  const keys = { '--seed': 'seed', '--model': 'model', '--out': 'out', '--input': 'input', '--baseline': 'baseline' };
  for (let i = 0; i < argv.length; i++) {
    if (['inspect', 'live', 'report'].includes(argv[i])) options.mode = argv[i];
    else if (keys[argv[i]] && argv[i + 1] && !argv[i + 1].startsWith('--')) options[keys[argv[i]]] = argv[++i];
    else throw new Error('Unknown argument or missing value');
  }
  options.seed = Number(options.seed);
  const read = file => fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  if (options.mode === 'live') {
    if (!options.out) throw new Error('live requires --out new-jsonl');
    console.log(JSON.stringify(await live(options.out, options), null, 2));
  } else if (options.mode === 'report') {
    if (!options.input) throw new Error('report requires --input');
    console.log(JSON.stringify(summarize(read(options.input), options.baseline ? read(options.baseline) : null), null, 2));
  } else {
    const { manifest } = plan(options);
    console.log(JSON.stringify({ requests: 32, questions: 160, model: options.model, seed: options.seed, sourceHash: manifest.sourceHash, corpusHash: manifest.corpusHash, providerCalls: 0 }));
  }
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildCases, plan, replay, summarize, live, main };
