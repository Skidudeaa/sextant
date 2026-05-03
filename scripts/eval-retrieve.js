#!/usr/bin/env node
"use strict";

// WHY: Self-referential retrieval evaluation harness. Runs a battery of queries
// against this repo's own sextant index and measures precision, MRR, and
// a composite usefulness score. Compares results with and without graph boosts
// to quantify their lift.

const fs = require("fs");
const path = require("path");

const { retrieve } = require("../lib/retrieve");
const intel = require("../lib/intel");
const viz = require("../lib/terminal-viz");

// WHY: rg returns paths with "./" prefix (e.g. "./lib/retrieve.js") but the
// eval dataset uses bare relative paths ("lib/retrieve.js"). Normalize both
// sides to prevent false precision=0 from path mismatch.
function normalizePath(p) {
  return String(p).replace(/^\.\//, "");
}

// WHY: The eval dataset and harness script themselves contain query terms,
// and rawCode2026-1-25.md is a large code dump. All would pollute results
// with self-referential matches. Filter them out before scoring.
const EVAL_NOISE_PATTERNS = [
  /eval-dataset\.json$/,
  /eval-retrieve\.js$/,
  /rawCode.*\.md$/,
];

function isEvalNoise(filePath) {
  const p = normalizePath(filePath);
  return EVAL_NOISE_PATTERNS.some((re) => re.test(p));
}

// ── Dataset Loading ──

function loadDataset(datasetPath) {
  if (!fs.existsSync(datasetPath)) {
    throw new Error(`Dataset not found: ${datasetPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
  if (!raw || !Array.isArray(raw.cases) || raw.cases.length === 0) {
    throw new Error("Dataset must have a non-empty 'cases' array");
  }
  return raw;
}

function validateDataset(dataset, root) {
  const warnings = [];
  for (const c of dataset.cases) {
    if (!c.id || !c.query) {
      warnings.push(`Case missing id or query: ${JSON.stringify(c).slice(0, 80)}`);
      continue;
    }
    for (const f of [...(c.relevantFiles || []), ...(c.acceptableFiles || [])]) {
      const abs = path.join(root, f);
      if (!fs.existsSync(abs)) {
        warnings.push(`[${c.id}] expected file not found: ${f}`);
      }
    }
  }
  return warnings;
}

// ── Retrieve Runners ──

async function runOnce(root, query, opts) {
  const start = Date.now();
  try {
    const result = await retrieve(root, query, opts);
    return { ok: true, result, durationMs: Date.now() - start };
  } catch (e) {
    return {
      ok: false,
      error: e.message,
      result: {
        results: { files: [], hits: [], related: [] },
        warnings: [e.message],
      },
      durationMs: Date.now() - start,
    };
  }
}

// ARCHITECTURE: Graph-ON forces rerankMinResolutionPct: 0 to enable boosts
// regardless of actual resolution. Graph-OFF forces rerankMinResolutionPct: 101
// to guarantee boosts are disabled. This isolates the graph boost effect even
// when real resolution is below the default 90% threshold.
async function runCase(evalCase, root, baseOpts) {
  const caseOpts = { ...baseOpts, ...(evalCase.retrieveOpts || {}) };

  const withGraph = await runOnce(root, evalCase.query, {
    ...caseOpts,
    explainHits: true,
    rerankMinResolutionPct: 0,
  });

  const withoutGraph = await runOnce(root, evalCase.query, {
    ...caseOpts,
    explainHits: true,
    rerankMinResolutionPct: 101,
  });

  return { evalCase, withGraph, withoutGraph };
}

// ── Metric Computation ──

function extractFileRanking(runResult) {
  const files = runResult?.result?.results?.files;
  if (!Array.isArray(files)) return [];
  return files.map((f) => normalizePath(f.path)).filter((p) => !isEvalNoise(p));
}

function extractHits(runResult) {
  const hits = runResult?.result?.results?.hits;
  if (!Array.isArray(hits)) return [];
  return hits.filter((h) => !isEvalNoise(h.path));
}

function extractRelated(runResult) {
  const related = runResult?.result?.results?.related;
  if (!Array.isArray(related)) return [];
  return related.filter((r) => !isEvalNoise(r.path));
}

// WHY: Standard P@k uses min(k, |retrieved|) as denominator. Using plain k
// penalizes cases where the system correctly returns a tight, fully-relevant
// result set smaller than k. acceptableFiles get 0.5 credit each.
function computePrecisionAtK(rankedFiles, relevantFiles, k, acceptableFiles) {
  if (!relevantFiles || relevantFiles.length === 0) return null;
  const topK = rankedFiles.slice(0, k);
  const relevantSet = new Set(relevantFiles);
  const acceptableSet = new Set(acceptableFiles || []);
  let score = 0;
  for (const f of topK) {
    if (relevantSet.has(f)) score += 1.0;
    else if (acceptableSet.has(f)) score += 0.5;
  }
  return score / Math.max(1, Math.min(k, rankedFiles.length));
}

function computeRecall(rankedFiles, relevantFiles) {
  if (!relevantFiles || relevantFiles.length === 0) return null;
  const rankedSet = new Set(rankedFiles);
  const found = relevantFiles.filter((f) => rankedSet.has(f)).length;
  return found / relevantFiles.length;
}

function computeMRR(rankedFiles, primaryRelevant) {
  if (!primaryRelevant) return null;
  const rank = rankedFiles.indexOf(primaryRelevant);
  if (rank === -1 || rank >= 10) return 0;
  return 1 / (rank + 1);
}

// WHY: nDCG captures rank-ordering quality that P@k misses. When graph boosts
// reorder results within the top-k (e.g., promoting a relevant file from rank 3
// to rank 2), P@k stays the same but nDCG improves. This makes it the right
// metric for measuring graph boost lift.
// TRADEOFF: Three-tier relevance (2/1/0.5) instead of binary. Primary file gets
// highest gain, secondary relevant files get 1, acceptable files get 0.5. This
// captures "useful but not ideal" results without full nDCG labeling overhead.
function computeNDCG(rankedFiles, relevantFiles, k, acceptableFiles) {
  if (!relevantFiles || relevantFiles.length === 0) return null;
  const relevantSet = new Set(relevantFiles);
  const acceptableSet = new Set(acceptableFiles || []);
  const allScorable = [...relevantFiles, ...(acceptableFiles || [])];

  const relScore = (file) => {
    if (file === relevantFiles[0]) return 2;
    if (relevantSet.has(file)) return 1;
    if (acceptableSet.has(file)) return 0.5;
    return 0;
  };

  // DCG of actual ranking
  let dcg = 0;
  const topK = rankedFiles.slice(0, k);
  for (let i = 0; i < topK.length; i++) {
    dcg += relScore(topK[i]) / Math.log2(i + 2);
  }

  // Ideal DCG: all scorable files sorted by relevance, best first
  const idealScores = allScorable
    .map((f) => relScore(f))
    .sort((a, b) => b - a)
    .slice(0, k);
  let idcg = 0;
  for (let i = 0; i < idealScores.length; i++) {
    idcg += idealScores[i] / Math.log2(i + 2);
  }

  return idcg > 0 ? dcg / idcg : 0;
}

function checkHitQuality(hits, patterns) {
  if (!patterns || patterns.length === 0) return true;
  for (const p of patterns) {
    let re;
    try {
      re = new RegExp(p);
    } catch {
      continue;
    }
    for (const h of hits) {
      if (re.test(h.line || "")) return true;
    }
  }
  return false;
}

function computeFileScore(rankedFiles, primaryRelevant) {
  if (!primaryRelevant) return 0;
  const rank = rankedFiles.indexOf(primaryRelevant);
  if (rank === 0) return 1.0;
  if (rank >= 1 && rank <= 2) return 0.7;
  if (rank >= 3 && rank <= 9) return 0.4;
  return 0.0;
}

function computeHitScore(hits, patterns, warnings) {
  let score = checkHitQuality(hits, patterns) ? 1.0 : 0.2;
  // Penalty per warning
  const warnCount = Array.isArray(warnings) ? warnings.length : 0;
  score -= warnCount * 0.1;
  // Bonus for exact symbol match in signals
  const hasExactSymbol = hits.some(
    (h) => Array.isArray(h.signals) && h.signals.some((s) => s.startsWith("exact_symbol"))
  );
  if (hasExactSymbol) score += 0.1;
  return Math.max(0, Math.min(1, score));
}

function computeRelatedScore(related, graphAvailable) {
  if (!graphAvailable) return 0.5;
  if (!related || related.length === 0) return 0.0;
  const hasLibRelated = related.some(
    (r) => r.path && !/(test|spec|__test__|vendor|node_modules)/.test(r.path)
  );
  return hasLibRelated ? 1.0 : 0.5;
}

function computeUsefulness(evalCase, runResult) {
  const isNegative = !evalCase.relevantFiles || evalCase.relevantFiles.length === 0;
  if (isNegative) {
    const files = extractFileRanking(runResult);
    return files.length === 0 ? 1.0 : 0.0;
  }

  const rankedFiles = extractFileRanking(runResult);
  const hits = extractHits(runResult);
  const related = extractRelated(runResult);
  const warnings = runResult?.result?.warnings || [];
  const graphAvailable = runResult?.result?.providers?.graph?.available !== false;
  const k = evalCase.topK || 5;

  const primary = evalCase.relevantFiles[0];
  const fileScore = computeFileScore(rankedFiles, primary);
  const hitScore = computeHitScore(hits, evalCase.relevantHitPatterns, warnings);
  const relatedScore = computeRelatedScore(related, graphAvailable);
  // WHY: Precision captures how many of the top-k results are actually relevant,
  // which fileScore alone misses (fileScore only checks the primary file's rank).
  const precisionScore = computePrecisionAtK(rankedFiles, evalCase.relevantFiles, k, evalCase.acceptableFiles) ?? 0;

  return 0.30 * fileScore + 0.30 * hitScore + 0.20 * precisionScore + 0.20 * relatedScore;
}

function evaluateCase(caseRun) {
  const { evalCase, withGraph, withoutGraph } = caseRun;
  const isNegative = !evalCase.relevantFiles || evalCase.relevantFiles.length === 0;
  const k = evalCase.topK || 5;

  const gFiles = extractFileRanking(withGraph);
  const ngFiles = extractFileRanking(withoutGraph);
  const gHits = extractHits(withGraph);
  const primary = isNegative ? null : evalCase.relevantFiles[0];

  const acceptable = evalCase.acceptableFiles || [];
  const gPrecision = computePrecisionAtK(gFiles, evalCase.relevantFiles, k, acceptable);
  const ngPrecision = computePrecisionAtK(ngFiles, evalCase.relevantFiles, k, acceptable);
  const gRecall = computeRecall(gFiles, evalCase.relevantFiles);
  const gMRR = computeMRR(gFiles, primary);
  const ngMRR = computeMRR(ngFiles, primary);
  const gNDCG = computeNDCG(gFiles, evalCase.relevantFiles, k, acceptable);
  const ngNDCG = computeNDCG(ngFiles, evalCase.relevantFiles, k, acceptable);
  const hitQuality = checkHitQuality(gHits, evalCase.relevantHitPatterns);
  const gUsefulness = computeUsefulness(evalCase, withGraph);
  const ngUsefulness = computeUsefulness(evalCase, withoutGraph);

  let pass;
  if (isNegative) {
    pass = gFiles.length === 0;
  } else {
    const minUsefulness = evalCase.minUsefulnessScore ?? 0.5;
    pass = gUsefulness >= minUsefulness && hitQuality;
  }

  return {
    id: evalCase.id,
    category: evalCase.category,
    query: evalCase.query,
    isNegative,
    k,
    pass,
    withGraph: {
      precision: gPrecision,
      recall: gRecall,
      mrr: gMRR,
      ndcg: gNDCG,
      usefulness: gUsefulness,
      hitQuality,
      files: gFiles,
      fileCount: gFiles.length,
      hitCount: gHits.length,
      durationMs: withGraph.durationMs,
    },
    withoutGraph: {
      precision: ngPrecision,
      mrr: ngMRR,
      ndcg: ngNDCG,
      usefulness: ngUsefulness,
      files: ngFiles,
      fileCount: ngFiles.length,
      durationMs: withoutGraph.durationMs,
    },
  };
}

// ── Aggregation ──

function computeAggregates(allMetrics) {
  const nonNeg = allMetrics.filter((m) => !m.isNegative);

  const mean = (arr) => {
    const valid = arr.filter((v) => v != null);
    return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
  };

  const gPrecisions = nonNeg.map((m) => m.withGraph.precision);
  const ngPrecisions = nonNeg.map((m) => m.withoutGraph.precision);
  const gMRRs = nonNeg.map((m) => m.withGraph.mrr);
  const gNDCGs = nonNeg.map((m) => m.withGraph.ndcg);
  const ngNDCGs = nonNeg.map((m) => m.withoutGraph.ndcg);
  const gUsefulness = nonNeg.map((m) => m.withGraph.usefulness);

  const meanGPrecision = mean(gPrecisions);
  const meanNGPrecision = mean(ngPrecisions);
  const meanGNDCG = mean(gNDCGs);
  const meanNGNDCG = mean(ngNDCGs);
  const graphLiftPrecision = meanGPrecision - meanNGPrecision;
  const graphLiftNDCG = meanGNDCG - meanNGNDCG;

  return {
    totalCases: allMetrics.length,
    passed: allMetrics.filter((m) => m.pass).length,
    failed: allMetrics.filter((m) => !m.pass).length,
    meanPrecision: meanGPrecision,
    meanMRR: mean(gMRRs),
    meanNDCG: meanGNDCG,
    meanUsefulness: mean(gUsefulness),
    graphLiftPrecision,
    graphLiftNDCG,
    graphLiftDirection: graphLiftNDCG > 0.01 ? "positive" : graphLiftNDCG < -0.01 ? "negative" : "neutral",
    failedIds: allMetrics.filter((m) => !m.pass).map((m) => m.id),
    passedIds: allMetrics.filter((m) => m.pass).map((m) => m.id),
  };
}

// ── Output Formatting ──

function printHeader(dataset, root, healthInfo) {
  const lines = [];
  lines.push("");
  lines.push(viz.c("# sextant retrieval eval", viz.colors.bold, viz.colors.cyan));
  lines.push("");

  const resPct = healthInfo?.resolutionPct ?? healthInfo?.metrics?.resolutionPct ?? "?";
  const indexedFiles = healthInfo?.index?.files ?? healthInfo?.metrics?.indexedFiles ?? "?";
  const graphStatus = (indexedFiles > 0)
    ? viz.status("ok", `available (${indexedFiles} files, ${resPct}% resolution)`)
    : viz.status("warn", "empty — run: sextant scan");

  lines.push(`  ${viz.dim("Root:")}      ${root}`);
  lines.push(`  ${viz.dim("Cases:")}     ${dataset.cases.length}`);
  lines.push(`  ${viz.dim("Graph:")}     ${graphStatus}`);
  lines.push("");
  lines.push(viz.c("─".repeat(70), viz.colors.dim));

  process.stdout.write(lines.join("\n") + "\n");
}

function printCaseResult(metrics, { verbose = false, hits = [] } = {}) {
  const lines = [];
  const passStr = metrics.pass
    ? viz.status("ok", "PASS")
    : viz.status("error", "FAIL");

  const idStr = viz.c(`[${metrics.id}]`, viz.colors.bold);
  const catStr = viz.dim(metrics.category);
  const queryStr = viz.c(`"${metrics.query}"`, viz.colors.cyan);
  const timeStr = viz.dim(`${metrics.withGraph.durationMs}ms`);

  lines.push("");
  lines.push(`${idStr} ${queryStr}  ${catStr}  ${timeStr}`);

  if (metrics.isNegative) {
    const count = metrics.withGraph.fileCount;
    if (count === 0) {
      lines.push(`  Results: 0 files, 0 hits   ${passStr}  ${viz.dim("(expected: no results)")}`);
    } else {
      lines.push(`  Results: ${count} files   ${passStr}  ${viz.dim("(expected: 0)")}`);
    }
  } else {
    const gp = metrics.withGraph.precision;
    const gm = metrics.withGraph.mrr;
    const gu = metrics.withGraph.usefulness;
    const k = metrics.k;

    const gn = metrics.withGraph.ndcg;
    const pBar = viz.bar(Math.round((gp ?? 0) * 100), 12, { showPercent: false, thresholds: { warn: 0, danger: 0 } });
    const pStr = (gp ?? 0).toFixed(2);
    const mStr = (gm ?? 0).toFixed(3);
    const nStr = (gn ?? 0).toFixed(2);
    const uStr = gu.toFixed(2);

    lines.push(`  P@${k}: ${pBar} ${pStr}  MRR: ${mStr}  nDCG: ${nStr}  Useful: ${uStr}  ${passStr}`);

    // Show file rankings
    const gTopFiles = metrics.withGraph.files.slice(0, 5);
    const ngTopFiles = metrics.withoutGraph.files.slice(0, 5);

    const formatFiles = (files) =>
      files
        .map((f, i) => {
          const base = path.basename(f);
          return viz.dim(`${i + 1}.`) + base;
        })
        .join("  ");

    lines.push(`  ${viz.dim("Graph ON:")}  ${formatFiles(gTopFiles)}`);
    lines.push(`  ${viz.dim("Graph OFF:")} ${formatFiles(ngTopFiles)}`);

    // Graph lift for this case
    const gPrecision = gp ?? 0;
    const ngPrecision = metrics.withoutGraph.precision ?? 0;
    const lift = gPrecision - ngPrecision;
    if (Math.abs(lift) > 0.001) {
      const liftStr = lift > 0
        ? viz.c(`+${lift.toFixed(2)}`, viz.colors.green)
        : viz.c(`${lift.toFixed(2)}`, viz.colors.red);
      lines.push(`  ${viz.dim("Lift:")}      ${liftStr}`);
    }

    // Verbose: show top hits with signals
    if (verbose && hits.length > 0) {
      lines.push(`  ${viz.dim("Top hits:")}`);
      for (const h of hits.slice(0, 5)) {
        const ln = h.lineNumber != null ? `:${h.lineNumber}` : "";
        const lineText = (h.line || "").trim().slice(0, 55);
        const sigs = Array.isArray(h.signals) && h.signals.length
          ? viz.dim(` [${h.signals.join(", ")}]`)
          : "";
        lines.push(`    ${viz.dim(normalizePath(h.path) + ln)} ${lineText}${sigs}`);
      }
    }
  }

  process.stdout.write(lines.join("\n") + "\n");
}

function printSummary(agg) {
  const lines = [];
  const divider = viz.c("═".repeat(70), viz.colors.dim);

  lines.push("");
  lines.push(divider);
  lines.push(viz.c(`  Eval Summary  (${agg.totalCases} cases, ${agg.passed} passed, ${agg.failed} failed)`, viz.colors.bold));
  lines.push("");

  const pctBar = (v) => viz.bar(Math.round(v * 100), 20, { showPercent: false, thresholds: { warn: 0, danger: 0 } });

  lines.push(`  ${viz.dim("Mean P@k:")}     ${pctBar(agg.meanPrecision)}  ${agg.meanPrecision.toFixed(3)}`);
  lines.push(`  ${viz.dim("Mean MRR:")}     ${pctBar(agg.meanMRR)}  ${agg.meanMRR.toFixed(3)}`);
  lines.push(`  ${viz.dim("Mean nDCG:")}    ${pctBar(agg.meanNDCG)}  ${agg.meanNDCG.toFixed(3)}`);
  lines.push(`  ${viz.dim("Mean Useful:")}  ${pctBar(agg.meanUsefulness)}  ${agg.meanUsefulness.toFixed(3)}`);
  lines.push("");

  // Graph lift
  const liftVal = agg.graphLiftNDCG;
  let liftDisplay;
  if (agg.graphLiftDirection === "positive") {
    liftDisplay = viz.c(`+${liftVal.toFixed(3)}`, viz.colors.green) + viz.dim("  (graph boosts help)");
  } else if (agg.graphLiftDirection === "negative") {
    liftDisplay = viz.c(`${liftVal.toFixed(3)}`, viz.colors.red) + viz.dim("  (graph boosts hurt!)");
  } else {
    liftDisplay = viz.dim(`${liftVal.toFixed(3)}  (neutral)`);
  }
  const pLiftVal = agg.graphLiftPrecision;
  const pLiftStr = pLiftVal > 0.001
    ? viz.c(`+${pLiftVal.toFixed(3)}`, viz.colors.green)
    : pLiftVal < -0.001
      ? viz.c(`${pLiftVal.toFixed(3)}`, viz.colors.red)
      : viz.dim(`${pLiftVal.toFixed(3)}`);
  lines.push(`  ${viz.dim("Graph Lift P@k:")}    ${pLiftStr}`);
  lines.push(`  ${viz.dim("Graph Lift nDCG:")}   ${liftDisplay}`);
  lines.push("");

  if (agg.passedIds.length) {
    lines.push(`  ${viz.c("Passed:", viz.colors.green)}  ${agg.passedIds.join("  ")}`);
  }
  if (agg.failedIds.length) {
    lines.push(`  ${viz.c("Failed:", viz.colors.red)}  ${agg.failedIds.join("  ")}`);
  }

  lines.push("");
  lines.push(divider);
  lines.push("");

  process.stdout.write(lines.join("\n") + "\n");
}

// ── Main ──

async function main() {
  const args = process.argv.slice(2);
  const datasetFlag = args.indexOf("--dataset");
  const datasetPath = datasetFlag >= 0 && args[datasetFlag + 1]
    ? path.resolve(args[datasetFlag + 1])
    : path.join(__dirname, "eval-dataset.json");
  const jsonOutput = args.includes("--json");
  const verbose = args.includes("--verbose") || args.includes("-v");

  // WHY --root: lets the eval harness run against external corpora
  // (fixtures/swift-eval, fixtures/mixed-eval) instead of the self-eval.
  // Default keeps the existing self-eval behavior.
  const rootFlag = args.indexOf("--root");
  const root = rootFlag >= 0 && args[rootFlag + 1]
    ? path.resolve(args[rootFlag + 1])
    : path.resolve(__dirname, "..");

  // Load and validate dataset
  const dataset = loadDataset(datasetPath);
  const validationWarnings = validateDataset(dataset, root);

  // Initialize and check health
  await intel.init(root);
  const healthInfo = await intel.health(root);

  if (!jsonOutput) {
    printHeader(dataset, root, healthInfo);

    if (validationWarnings.length) {
      for (const w of validationWarnings) {
        process.stdout.write(`  ${viz.status("warn", w)}\n`);
      }
      process.stdout.write("\n");
    }

    const indexedFiles = healthInfo?.index?.files ?? 0;
    if (indexedFiles === 0) {
      process.stdout.write(
        `  ${viz.status("warn", "Graph not indexed (0 files). Run: node bin/intel.js scan")}\n`
      );
      process.stdout.write(
        `  ${viz.dim("Graph-based metrics will not reflect real lift.")}\n\n`
      );
    }
  }

  // Run all cases.
  // WHY backend "auto": production hooks and the MCP server use the auto
  // path (zoekt when installed and indexed, else rg). Pinning the eval to
  // "rg" measured an inferior code path — common-name def lookups in
  // multi-thousand-file repos like Vapor came out at MRR 0.20 because
  // rg's text-frequency ranking buries the canonical class def behind
  // higher-fan-in consumer files.  Auto with zoekt restores rank-1 on
  // those (Application/Request/Response 0.20 → 1.00).  Eval-as-production
  // is the right framing; if zoekt is unavailable in the eval environment,
  // pickBackend() falls back to rg and behavior matches the old baseline.
  const baseOpts = {
    backend: "auto",
    maxHits: 50,
    contextLines: 1,
    contextMode: "lines",
    hitsPerFileCap: 5,
  };

  const allMetrics = [];

  for (const evalCase of dataset.cases) {
    const caseRun = await runCase(evalCase, root, baseOpts);
    const metrics = evaluateCase(caseRun);
    allMetrics.push(metrics);
    if (!jsonOutput) {
      const hits = extractHits(caseRun.withGraph);
      printCaseResult(metrics, { verbose, hits });
    }
  }

  // Aggregates and summary
  const agg = computeAggregates(allMetrics);

  if (jsonOutput) {
    process.stdout.write(JSON.stringify({ aggregates: agg, cases: allMetrics }, null, 2) + "\n");
  } else {
    printSummary(agg);
  }

  // Exit code
  if (agg.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exitCode = 1;
});
