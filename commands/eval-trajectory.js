"use strict";

// `sextant eval-trajectory` — the offline BENEFIT harness.
//
// Every other sextant metric (MRR / nDCG / graphLiftNDCG / empty-injection-rate)
// is an offline fixture proxy: it proves no-regression on a synthetic corpus,
// never benefit on real agent behavior. This command closes that gap WITHOUT
// waiting for the live holdback arm to accumulate: it replays the user's own
// Claude Code session transcripts (~/.claude/projects/**/*.jsonl), finds every
// turn where sextant injected files, and measures whether the agent then OPENED
// them — and how early.
//
// The headline is the permutation-null LIFT, not raw coverage: "do the files we
// surface for a query get opened MORE than random plausible repo files would?"
// Raw coverage alone is uninterpretable (the agent opens central files anyway);
// lift is the closest thing to a benefit number available offline. The live
// injection-OFF holdback arm is the rigorous causal upgrade — this is its
// before-merge complement (009 #12).
//
// Honest by construction: it leads with lift, flags the correlational caveat on
// every surface, and reports the static-summary contrast (whose high raw rate is
// mostly the recent-changes correlation trap) so the number can't be oversold.

const os = require("os");
const path = require("path");
const { flag, hasFlag } = require("../lib/cli");
const traj = require("../lib/trajectory");

function defaultProjectsRoot() {
  return path.join(os.homedir(), ".claude", "projects");
}

function pct(v) {
  return v == null ? "n/a" : `${v.toFixed(2)}%`;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function printReport(report) {
  const a = report.aggregate;
  const L = report.lift;
  const out = [];
  out.push("sextant eval-trajectory — offline benefit replay (real session history)");
  out.push(`  projects:    ${report.projectsRoot}`);
  out.push(`  population:  ${report.sessionsWithInjection} sessions with injection across ${report.repos.length} repos` +
    `  (of ${report.sessionsScanned} scanned; subagent transcripts ${report._includeSubagents ? "INCLUDED" : "excluded"})`);
  out.push(`  file-opens:  ${a.opensTotal} observed`);
  out.push("");

  out.push("OPEN-RATE LIFT — actual coverage vs permutation null (random plausible same-repo surfaced sets)");
  out.push(`  ${pad("signal", 18)}${pad("actual", 10)}${pad("null", 10)}${pad("lift", 8)}opened/surfaced`);
  const row = (name, lift) =>
    `  ${pad(name, 18)}${pad(pct(lift.actualPct), 10)}${pad(pct(lift.nullPct), 10)}${pad((lift.lift == null ? "n/a" : lift.lift + "x"), 8)}${lift.opened}/${lift.surfaced}`;
  out.push(row("query-retrieval", L.retrieval));
  out.push(row("static-summary", L.static));
  out.push("");
  if (L.retrieval.lift != null) {
    out.push(`  → query-relevance opens at ~${L.retrieval.lift}x chance — the retrieval signal genuinely steers.`);
  }
  if (L.static.lift != null && L.retrieval.lift != null && L.static.lift < L.retrieval.lift) {
    out.push(`  → the static summary's higher RAW rate (${pct(L.static.actualPct)}) is mostly correlation`);
    out.push(`    (lift only ${L.static.lift}x): recent-changes lists the files already being worked on.`);
  }
  out.push("");

  const r = a.retrieval;
  out.push("ORIENTATION LATENCY — query-retrieval, when a surfaced file is opened within the window");
  out.push(`  first-touch hit-rate: ${pct(r.firstTouchHitPct)} of injections` +
    `   median rank when hit: ${r.medianFirstTouchRank == null ? "n/a" : r.medianFirstTouchRank}` +
    `   opened-first: ${pct(r.firstTouchRank1Pct)}`);
  out.push("");

  out.push("PER-SOURCE coverage — which surfacing signal earns opens (query-retrieval)");
  const sources = Object.entries(report.aggregate.bySource)
    .sort((x, y) => (y[1].surfaced) - (x[1].surfaced));
  if (sources.length === 0) out.push("  (none)");
  for (const [src, v] of sources) {
    out.push(`  ${pad(src, 18)}${pad(pct(v.coveragePct), 10)}(${v.opened}/${v.surfaced})`);
  }
  out.push("");

  out.push("CAVEATS — read before citing");
  out.push("  • Correlational: no per-turn injection-OFF counterfactual yet (the holdback arm is the");
  out.push("    upgrade). The permutation null controls for \"plausible repo files\" but not for \"the");
  out.push("    agent would have opened the canonical file regardless of injection.\"");
  out.push("  • Precision-flavored: coverage = did the agent open what we surfaced. Misses include");
  out.push("    surfaced files the agent simply didn't need this turn — low coverage = precision");
  out.push("    headroom, not \"broken.\"");
  out.push("  • Lead with LIFT, not raw coverage: the static summary's raw rate is the correlation trap.");
  return out.join("\n");
}

async function run() {
  const argv = process.argv;
  const projectsRoot = flag(argv, "--projects") || defaultProjectsRoot();
  const wantJson = hasFlag(argv, "--json");
  const includeSubagents = hasFlag(argv, "--include-subagents");
  const sizeMatched = hasFlag(argv, "--size-matched");
  const repo = flag(argv, "--repo") || null;
  const K = parseInt(flag(argv, "--perms"), 10) || 200;
  const seed = parseInt(flag(argv, "--seed"), 10) || 12345;

  const report = traj.buildReport(projectsRoot, { repo, includeSubagents, sizeMatched, K, seed });
  report._includeSubagents = includeSubagents;

  if (wantJson) {
    // Drop the heavy raw-events payload from JSON output.
    const { _sessions, ...clean } = report;
    process.stdout.write(JSON.stringify(clean, null, 2) + "\n");
    return;
  }
  process.stdout.write(printReport(report) + "\n");
}

module.exports = { run, printReport };
