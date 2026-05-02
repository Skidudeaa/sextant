#!/usr/bin/env node
"use strict";

// Compare a fresh Vapor eval run against the committed baseline.
// Used by scripts/eval-swift-external.sh in `diff` mode.
//
// Two regression gates:
//   1. Mean MRR delta (current - baseline) must be >= -0.05.
//   2. For each case, the top-3 file set from baseline must be a subset of the
//      top-3 file set from current. Drops out of top-3 are regressions.
//
// Soft signal (informational, not a regression):
//   - Pathological-lift queries (id contains "uri" / "init" / "svc") report
//     graphLiftNDCG (case.withGraph.ndcg - case.withoutGraph.ndcg). Positive
//     lift is the headline Vapor result; neutral or negative lift is logged
//     but does not fail the gate (the graph layer can be neutral on common
//     names where rg already does a good job).

const fs = require("fs");

const MRR_DELTA_FAIL_THRESHOLD = -0.05;
const STARRED_PATHOLOGICAL_LIFT = ["vapor-uri-001", "vapor-init-001", "vapor-svc-001"];

function loadJson(path) {
  if (!fs.existsSync(path)) {
    console.error(`compare-vapor-eval: file not found: ${path}`);
    process.exit(2);
  }
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`compare-vapor-eval: invalid JSON in ${path}: ${e.message}`);
    process.exit(2);
  }
}

function topK(files, k) {
  return new Set((files || []).slice(0, k));
}

function setMinus(a, b) {
  const out = [];
  for (const x of a) if (!b.has(x)) out.push(x);
  return out;
}

function main() {
  const [, , baselinePath, currentPath] = process.argv;
  if (!baselinePath || !currentPath) {
    console.error("usage: compare-vapor-eval.js <baseline.json> <current.json>");
    process.exit(2);
  }

  const baseline = loadJson(baselinePath);
  const current = loadJson(currentPath);

  const failures = [];
  const warnings = [];

  // Gate 1: mean MRR delta.
  const baseMRR = baseline.aggregates?.meanMRR ?? 0;
  const curMRR = current.aggregates?.meanMRR ?? 0;
  const mrrDelta = curMRR - baseMRR;
  if (mrrDelta < MRR_DELTA_FAIL_THRESHOLD) {
    failures.push(
      `mean MRR regressed by ${(-mrrDelta).toFixed(4)} ` +
        `(baseline ${baseMRR.toFixed(4)} → current ${curMRR.toFixed(4)}, ` +
        `threshold ${MRR_DELTA_FAIL_THRESHOLD})`
    );
  }

  // Gate 2: top-3 retention per case.
  const baseCasesById = new Map();
  for (const c of baseline.cases || []) baseCasesById.set(c.id, c);

  for (const cur of current.cases || []) {
    const base = baseCasesById.get(cur.id);
    if (!base) {
      warnings.push(`case ${cur.id} present in current but not in baseline (new query?)`);
      continue;
    }
    const baseTop3 = topK(base.withGraph?.files, 3);
    const curTop3 = topK(cur.withGraph?.files, 3);
    const dropped = setMinus(baseTop3, curTop3);
    if (dropped.length > 0) {
      failures.push(
        `[${cur.id}] dropped from top-3: ${dropped.join(", ")} ` +
          `(was: ${[...baseTop3].join(", ")} | now: ${[...curTop3].join(", ")})`
      );
    }
  }

  for (const base of baseline.cases || []) {
    if (!current.cases?.some((c) => c.id === base.id)) {
      warnings.push(`case ${base.id} present in baseline but not in current (removed?)`);
    }
  }

  // Soft signal: pathological-lift queries.
  console.log("");
  console.log("Pathological-lift queries (graphLiftNDCG):");
  for (const id of STARRED_PATHOLOGICAL_LIFT) {
    const cur = current.cases?.find((c) => c.id === id);
    if (!cur) {
      console.log(`  ${id}: <missing>`);
      continue;
    }
    const lift = (cur.withGraph?.ndcg ?? 0) - (cur.withoutGraph?.ndcg ?? 0);
    const sign = lift > 0 ? "+" : "";
    const tag = lift > 0 ? "[positive lift]" : lift < 0 ? "[negative]" : "[neutral]";
    console.log(`  ${id} (query="${cur.query}"): ${sign}${lift.toFixed(4)} ${tag}`);
  }

  console.log("");
  console.log("Aggregate metrics:");
  console.log(`  baseline meanMRR=${baseMRR.toFixed(4)} meanNDCG=${(baseline.aggregates?.meanNDCG ?? 0).toFixed(4)}`);
  console.log(`  current  meanMRR=${curMRR.toFixed(4)} meanNDCG=${(current.aggregates?.meanNDCG ?? 0).toFixed(4)}`);
  console.log(`  delta    meanMRR=${mrrDelta >= 0 ? "+" : ""}${mrrDelta.toFixed(4)}`);

  if (warnings.length) {
    console.log("");
    console.log("Warnings:");
    for (const w of warnings) console.log(`  - ${w}`);
  }

  if (failures.length) {
    console.log("");
    console.log("FAIL:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }

  console.log("");
  console.log("PASS: no regressions vs baseline.");
}

main();
