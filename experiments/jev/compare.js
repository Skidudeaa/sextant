#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { hash, replay } = require('./lab');
const { replayBaseline } = require('./openai-baseline');

function gateMetrics(rows, threshold) {
  const retained = rows.filter(r => r.risk <= threshold);
  const wrongRetained = retained.filter(r => r.miniWrong).length;
  return { threshold, n: rows.length, escalations: rows.length - retained.length,
    retained: retained.length, retainedWrong: wrongRetained,
    retainedCoverage: rows.length ? retained.length / rows.length : null,
    retainedErrorRate: retained.length ? wrongRetained / retained.length : null,
    oracleEscalationAccuracyUpperBound: rows.length ? 1 - wrongRetained / rows.length : null };
}

function compare(baselineRecords, jevRecords) {
  const baseline = replayBaseline(baselineRecords);
  const jev = replay(jevRecords);
  const baseResults = baseline.filter(r => r.kind === 'result');
  const jevResults = jev.filter(r => r.kind === 'result' && r.variant === 'original');
  const baseModels = [...new Set(baseResults.map(r => r.response.model))];
  const jevModels = [...new Set(jevResults.map(r => r.response.model))];
  if (baseModels.length > 1 || jevModels.length > 1) throw new Error('Comparison requires one returned model per provider; partition mixed-model runs first');
  const baseCases = new Map(baseline[0].corpusSnapshot.map(c => [c.id, c]));
  const jevCases = new Map(jev[0].corpusSnapshot.map(c => [c.id, c]));
  const baseById = new Map(baseResults.map(r => [r.caseId, r]));
  const rows = [];
  for (const result of jevResults) {
    const mini = baseById.get(result.caseId);
    if (!mini) continue;
    const a = baseCases.get(result.caseId);
    const b = jevCases.get(result.caseId);
    const contract = c => ({ state: c.state, questions: c.questions, expected: c.expected, split: c.split, groupId: c.groupId });
    if (hash(contract(a)) !== hash(contract(b))) throw new Error(`Mismatched task evidence or labels: ${result.caseId}`);
    for (const prediction of result.predictions) {
      const label = mini.response.labels[prediction.qid];
      if (typeof label !== 'boolean') throw new Error('Baseline answer missing at comparison');
      // Jev estimates P(original proposition). Complement when mini answered yes
      // to obtain estimated P(mini is wrong), without inventing another API call.
      rows.push({ caseId: result.caseId, qid: prediction.qid, family: a.family, split: a.split,
        miniWrong: label !== prediction.expected, jevWrong: (prediction.p > 0.5) !== prediction.expected,
        risk: label ? 1 - prediction.p : prediction.p });
    }
  }
  const dev = rows.filter(r => r.split === 'development');
  const holdout = rows.filter(r => r.split === 'holdout');
  const cuts = Array.from({ length: 21 }, (_, i) => i / 20);
  const devSweep = cuts.map(t => gateMetrics(dev, t));
  // This is an empirical operating point, not a guarantee on unseen tasks.
  const zeroError = devSweep.filter(m => m.retained > 0 && m.retainedWrong === 0);
  const selected = zeroError.length ? zeroError.reduce((best, m) => m.retained > best.retained ? m : best).threshold : null;
  return { status: rows.length ? 'paired-provider-observations' : 'no-paired-provider-observations',
    models: { baseline: baseModels, jev: jevModels }, baselineCompletedCases: baseResults.length,
    jevOriginalCompletedCases: jevResults.length, joinedCases: new Set(rows.map(r => r.caseId)).size,
    decisions: rows.length, miniErrors: rows.filter(r => r.miniWrong).length, jevErrorsAtHalf: rows.filter(r => r.jevWrong).length,
    developmentSweep: devSweep, descriptiveHoldoutSweep: cuts.map(t => gateMetrics(holdout, t)),
    thresholdSelectedOnDevelopmentOnly: selected,
    holdoutAtSelectedThreshold: selected === null ? null : gateMetrics(holdout, selected),
    limitations: ['Only identical frozen tasks are paired; missing provider results are excluded and counts remain visible.',
      'No strong-model escalation is executed here. Oracle upper bound assumes every escalated answer is corrected, which is optimistic.',
      'Zero observed development errors does not guarantee zero held-out or production errors.',
      'Noul probabilities are observed model outputs, not established calibration for code tasks.'] };
}

function main(argv) {
  if (argv.length !== 2) throw new Error('Usage: node experiments/jev/compare.js OPENAI.jsonl JEV.jsonl');
  const read = file => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  console.log(JSON.stringify(compare(read(argv[0]), read(argv[1])), null, 2));
}

if (require.main === module) { try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { gateMetrics, compare };
