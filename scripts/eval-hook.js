#!/usr/bin/env node
"use strict";

// WHY: Eval harness for the hook retrieval path (shouldRetrieve → graphRetrieve
// → zoekt.searchFast → mergeResults). Complements eval-retrieve.js which covers
// the CLI path (lib/retrieve.js). The CLI path's MRR/nDCG numbers say nothing
// about what Claude sees on every UserPromptSubmit — this harness gives an honest
// baseline for that path and a regression gate going forward.

const fs   = require("fs");
const path = require("path");

const { loadDb, countFiles }              = require("../lib/graph");
const { graphRetrieve }                   = require("../lib/graph-retrieve");
const { mergeResults }                    = require("../lib/merge-results");
const { searchFast }                      = require("../lib/zoekt");
const { shouldRetrieve, hasIdentifierShape } = require("../lib/classifier");
const viz                                 = require("../lib/terminal-viz");

// ── Path helpers ──

// WHY: graph-retrieve and Zoekt may return paths with "./" prefix. Normalize
// both sides to prevent false precision=0 from path mismatch.
function normalizePath(p) {
  return String(p).replace(/^\.\//, "");
}

// WHY: The eval dataset, this script, and eval-retrieve.js all contain query
// terms and would pollute results with self-referential matches.
const EVAL_NOISE_PATTERNS = [
  /eval-dataset\.json$/,
  /eval-hook\.js$/,
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

// ── Zoekt Availability ──

// WHY: searchFast returns durationMs: 0 (hardcoded in the empty sentinel) when
// daemon.json is absent or the probe fails. A live daemon always takes >0ms to
// respond. This is the cleanest available signal without touching zoekt internals.
async function checkZoektAvailable(root) {
  try {
    const result = await searchFast(root, "file:.", { totalMaxMatchCount: 1 });
    return result.durationMs > 0;
  } catch {
    return false;
  }
}

// ── Hook Pipeline Runner ──

// WHY: Replicates commands/hook-refresh.js exactly — same identifier filter before
// Zoekt query construction, same graphRetrieve → mergeResults sequence.
// Does NOT call intel.init() — the hook bypasses it to stay under 200ms;
// the eval replicates that bypass.
async function runHookCase(db, root, evalCase, zoektAvailable) {
  const start = Date.now();

  const classification = shouldRetrieve(evalCase.query);
  const queryTerms = classification.retrieve ? classification.terms : [];

  let graphResults = { files: [], warnings: [] };
  let zoektHits = [];

  if (queryTerms.length > 0) {
    try {
      graphResults = graphRetrieve(db, queryTerms);
    } catch (e) {
      graphResults = { files: [], warnings: [String(e.message)] };
    }

    if (zoektAvailable) {
      try {
        const identifierTerms = queryTerms.filter(hasIdentifierShape);
        const zoektQuery = (identifierTerms.length > 0 ? identifierTerms : queryTerms).join(" ");
        const res = await searchFast(root, zoektQuery);
        zoektHits = (res && res.hits) || [];
      } catch {
        zoektHits = [];
      }
    }
  }

  let merged = { files: [] };
  try {
    merged = mergeResults(graphResults, zoektHits, { queryTerms });
  } catch {
    merged = { files: [] };
  }

  return {
    merged,
    queryTerms,
    classifiedForRetrieval: classification.retrieve,
    zoektHitCount: zoektHits.length,
    graphWarnings: graphResults.warnings || [],
    durationMs: Date.now() - start,
  };
}

// ── Result Extraction ──

function extractRankedFiles(merged) {
  return ((merged && merged.files) || [])
    .map((f) => normalizePath(f.path))
    .filter((p) => !isEvalNoise(p));
}

// WHY: Only files with a non-null zoektHit have line content for hit quality checks.
function extractZoektHits(merged) {
  return ((merged && merged.files) || [])
    .filter((f) => f.zoektHit !== null && !isEvalNoise(f.path))
    .map((f) => ({ path: f.path, line: f.zoektHit?.line ?? null }));
}

// ── Metric Functions (copied from eval-retrieve.js, not factored out) ──

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

// WHY: nDCG captures rank-ordering quality that P@k misses. Three-tier relevance
// (2/1/0.5): primary file gets highest gain, other relevant files get 1,
// acceptable files get 0.5.
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

  let dcg = 0;
  const topK = rankedFiles.slice(0, k);
  for (let i = 0; i < topK.length; i++) {
    dcg += relScore(topK[i]) / Math.log2(i + 2);
  }

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

// ── Case Evaluation ──

function evaluateHookCase(evalCase, caseRun, zoektAvailable) {
  const { merged, queryTerms, classifiedForRetrieval, zoektHitCount, graphWarnings, durationMs } = caseRun;
  const isNegative = !evalCase.relevantFiles || evalCase.relevantFiles.length === 0;
  const k = evalCase.topK || 5;

  const rankedFiles = extractRankedFiles(merged);
  const zoektHits   = extractZoektHits(merged);
  const primary     = isNegative ? null : evalCase.relevantFiles[0];
  const acceptable  = evalCase.acceptableFiles || [];

  const precision = computePrecisionAtK(rankedFiles, evalCase.relevantFiles, k, acceptable);
  const recall    = computeRecall(rankedFiles, evalCase.relevantFiles);
  const mrr       = computeMRR(rankedFiles, primary);
  const ndcg      = computeNDCG(rankedFiles, evalCase.relevantFiles, k, acceptable);

  // WHY: Hit quality only when Zoekt is available. In graph-only mode there are
  // no zoektHit.line fields, so checkHitQuality would always return false —
  // penalizing cases unfairly for infrastructure absence, not pipeline quality.
  const hitQuality = zoektAvailable
    ? checkHitQuality(zoektHits, evalCase.relevantHitPatterns)
    : null;

  // Pass/fail:
  // - Negative case: must return zero ranked files.
  // - Positive case: rank-weighted usefulness >= minUsefulnessScore.
  // WHY: hitQuality is informational only — the hook path keeps only the highest
  // Zoekt line per file, which often isn't the definition line. Gating on it
  // would fail cases where the file ranks perfectly but the captured line isn't
  // the canonical definition. File rank is the meaningful production signal here.
  let pass;
  if (isNegative) {
    pass = rankedFiles.length === 0;
  } else {
    const minUsefulness = evalCase.minUsefulnessScore ?? 0.5;
    const rank = primary ? rankedFiles.indexOf(primary) : -1;
    const fileScore = rank === 0 ? 1.0 : (rank >= 1 && rank <= 2 ? 0.7 : (rank >= 3 && rank <= 9 ? 0.4 : 0.0));
    const usefulness = 0.50 * fileScore + 0.50 * (precision ?? 0);
    pass = usefulness >= minUsefulness;
  }

  return {
    id: evalCase.id,
    category: evalCase.category,
    query: evalCase.query,
    isNegative,
    k,
    pass,
    classifiedForRetrieval,
    queryTerms,
    zoektAvailable,
    zoektHitCount,
    graphWarnings,
    precision,
    recall,
    mrr,
    ndcg,
    hitQuality,
    rankedFiles,
    fileCount: rankedFiles.length,
    durationMs,
  };
}

// ── Aggregation ──

function computeAggregates(allMetrics) {
  const nonNeg = allMetrics.filter((m) => !m.isNegative);
  const mean = (arr) => {
    const valid = arr.filter((v) => v != null);
    return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
  };
  return {
    totalCases:    allMetrics.length,
    passed:        allMetrics.filter((m) => m.pass).length,
    failed:        allMetrics.filter((m) => !m.pass).length,
    meanPrecision: mean(nonNeg.map((m) => m.precision)),
    meanMRR:       mean(nonNeg.map((m) => m.mrr)),
    meanNDCG:      mean(nonNeg.map((m) => m.ndcg)),
    meanRecall:    mean(nonNeg.map((m) => m.recall)),
    failedIds:     allMetrics.filter((m) => !m.pass).map((m) => m.id),
    passedIds:     allMetrics.filter((m) => m.pass).map((m) => m.id),
  };
}

// ── Output ──

const FMT = {
  bar: (v, width = 20) => {
    if (v == null) return " ".repeat(width);
    const filled = Math.round(v * width);
    return "█".repeat(filled) + "░".repeat(width - filled);
  },
  pct: (v) => (v == null ? " n/a " : `${(v * 100).toFixed(1).padStart(5)}%`),
  f3: (v) => (v == null ? " n/a " : v.toFixed(3)),
};

function printHeader(dataset, root, zoektAvailable, dbFileCount) {
  process.stdout.write("\n# sextant hook-path eval\n");
  process.stdout.write(`  Root:   ${root}\n`);
  process.stdout.write(`  Cases:  ${dataset.cases.length}\n`);

  if (dbFileCount === 0) {
    process.stdout.write(`  Graph:  [warn] 0 files — run: sextant scan\n`);
  } else {
    process.stdout.write(`  Graph:  [ok] ${dbFileCount} files indexed\n`);
  }

  if (zoektAvailable) {
    process.stdout.write(`  Zoekt:  [ok] available\n`);
    process.stdout.write(`  Mode:   graph+zoekt\n`);
  } else {
    process.stdout.write(`  Zoekt:  [warn] unavailable (graph-only mode)\n`);
    process.stdout.write(`  Mode:   graph-only\n`);
  }
  process.stdout.write("\n");
}

function printCaseResult(metrics, { verbose = false } = {}) {
  const { id, category, query, pass, durationMs, precision, mrr, ndcg, hitQuality, zoektAvailable,
          rankedFiles, queryTerms, zoektHitCount, graphWarnings, classifiedForRetrieval, fileCount } = metrics;

  const status = pass ? "PASS" : "FAIL";
  process.stdout.write(`[${id}] "${query}"  ${category}  ${durationMs}ms\n`);

  const pBar = FMT.bar(precision, 12);
  const hitNote = zoektAvailable
    ? (hitQuality === true ? "hit✓" : "hit✗")
    : "(graph-only — hit quality skipped)";
  process.stdout.write(
    `  P@${metrics.k}: [${pBar}] ${FMT.pct(precision)}  MRR: ${FMT.f3(mrr)}  nDCG: ${FMT.f3(ndcg)}  ${status}  ${hitNote}\n`
  );

  if (!classifiedForRetrieval) {
    process.stdout.write(`  [warn] classifier rejected this query — hook would have skipped retrieval\n`);
  }

  if (verbose) {
    if (queryTerms.length) {
      process.stdout.write(`  Terms: ${JSON.stringify(queryTerms)}\n`);
    }
    if (rankedFiles.length) {
      const ranked = rankedFiles.slice(0, 8).map((f, i) => `${i + 1}.${f}`).join("  ");
      process.stdout.write(`  Ranked: ${ranked}\n`);
    } else {
      process.stdout.write(`  Ranked: (none)\n`);
    }
    if (zoektAvailable) {
      process.stdout.write(`  Zoekt hits: ${zoektHitCount}\n`);
    }
    if (graphWarnings.length) {
      for (const w of graphWarnings) {
        process.stdout.write(`  [graph warn] ${w}\n`);
      }
    }
  }
}

function printSummary(agg, zoektAvailable) {
  process.stdout.write("\n" + "═".repeat(60) + "\n");
  process.stdout.write(
    `  Hook Eval Summary  (${agg.totalCases} cases, ${agg.passed} passed, ${agg.failed} failed)\n`
  );
  const modeLabel = zoektAvailable ? "graph+zoekt [ok]" : "graph-only [warn]";
  process.stdout.write(`  Mode: ${modeLabel}\n\n`);

  process.stdout.write(`  Mean P@k:   [${FMT.bar(agg.meanPrecision)}] ${FMT.f3(agg.meanPrecision)}\n`);
  process.stdout.write(`  Mean MRR:   [${FMT.bar(agg.meanMRR)}]       ${FMT.f3(agg.meanMRR)}\n`);
  process.stdout.write(`  Mean nDCG:  [${FMT.bar(agg.meanNDCG)}]      ${FMT.f3(agg.meanNDCG)}\n`);
  process.stdout.write(`  Mean Recall:[${FMT.bar(agg.meanRecall)}]     ${FMT.f3(agg.meanRecall)}\n`);

  if (agg.failedIds.length) {
    process.stdout.write(`\n  Failed: ${agg.failedIds.join("  ")}\n`);
  } else {
    process.stdout.write(`\n  All cases passed.\n`);
  }
  process.stdout.write("═".repeat(60) + "\n\n");
}

// ── Main ──

async function main() {
  const args = process.argv.slice(2);
  const datasetIdx  = args.indexOf("--dataset");
  const datasetPath = datasetIdx >= 0 && args[datasetIdx + 1]
    ? path.resolve(args[datasetIdx + 1])
    : path.join(__dirname, "eval-dataset.json");
  const jsonOutput = args.includes("--json");
  const verbose    = args.includes("--verbose") || args.includes("-v");

  const root = path.resolve(__dirname, "..");

  const dataset = loadDataset(datasetPath);
  const validationWarnings = validateDataset(dataset, root);

  let db;
  try {
    db = await loadDb(root);
  } catch (e) {
    process.stderr.write(`[eval-hook] Failed to load graph.db: ${e.message}\n`);
    process.exitCode = 1;
    return;
  }

  const dbFileCount = countFiles(db);
  const zoektAvailable = await checkZoektAvailable(root);

  if (!jsonOutput) {
    printHeader(dataset, root, zoektAvailable, dbFileCount);
    for (const w of validationWarnings) {
      process.stdout.write(`  [warn] ${w}\n`);
    }
    if (validationWarnings.length) process.stdout.write("\n");
  }

  const allMetrics = [];
  for (const evalCase of dataset.cases) {
    const caseRun = await runHookCase(db, root, evalCase, zoektAvailable);
    const metrics = evaluateHookCase(evalCase, caseRun, zoektAvailable);
    allMetrics.push(metrics);
    if (!jsonOutput) {
      printCaseResult(metrics, { verbose });
    }
  }

  const agg = computeAggregates(allMetrics);

  if (jsonOutput) {
    process.stdout.write(JSON.stringify({ aggregates: agg, cases: allMetrics }, null, 2) + "\n");
  } else {
    printSummary(agg, zoektAvailable);
  }

  if (agg.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exitCode = 1;
});
