"use strict";

// `sextant tune` — REPORTING-ONLY per-source retrieval diagnostics.
//
// This is the deliberate fallback from the killed self-tuning track
// (docs/016-phase0-recon.md, R3): live prior-based reranking was rejected
// because (a) 88% of injection blocks are single-source, so a per-source
// multiplier has no lever on them; (b) half the source vocabulary
// (exported_symbol 19 samples, reexport_chain 6 — in the ENTIRE corpus) can
// never earn a defensible prior at current volume; (c) the responsibly-gated
// simulation was an exact tie on every actable case; (d) ~/.claude/projects
// is a rolling window, so a learned prior's training set churns out from
// under it.
//
// What survives: the HUMAN-AUDITABLE table.  Per-source surfaced/opened
// volumes with 95% Wilson intervals from real-session trajectory replay, so
// drift is visible over time and the revisit conditions (n>=30 on the thin
// sources, or append-only corpus retention) can be checked at a glance.
// NO scoring weight anywhere reads this output.

const os = require("os");
const path = require("path");
const { flag, hasFlag } = require("../lib/cli");
const traj = require("../lib/trajectory");

// Minimum surfaced-sample count for a rate to be worth acting on at all —
// the same n>=30 bar the R3 simulation used.
const PRIOR_MIN_N = 30;

// 95% Wilson score interval for a binomial proportion.  Chosen over the
// normal approximation because the thin sources sit at 0/19-style extremes
// where the normal interval degenerates to [0, 0].
function wilson95(successes, n) {
  if (!n) return null;
  const z = 1.96;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

function buildTuneReport(projectsRoot, opts = {}) {
  const report = traj.buildReport(projectsRoot, opts);
  const rows = [];
  for (const [source, v] of Object.entries(report.aggregate.bySource || {})) {
    const ci = wilson95(v.opened, v.surfaced);
    rows.push({
      source,
      surfaced: v.surfaced,
      opened: v.opened,
      openRatePct: v.surfaced ? +((100 * v.opened) / v.surfaced).toFixed(2) : null,
      wilson95Pct: ci ? { lo: +(100 * ci.lo).toFixed(2), hi: +(100 * ci.hi).toFixed(2) } : null,
      priorEligible: v.surfaced >= PRIOR_MIN_N,
    });
  }
  rows.sort((a, b) => b.surfaced - a.surfaced);
  return {
    projectsRoot,
    repoFilter: opts.repo || null,
    sessionsWithInjection: report.sessionsWithInjection,
    sessionsScanned: report.sessionsScanned,
    repos: report.repos,
    priorMinN: PRIOR_MIN_N,
    sources: rows,
    mode: "reporting-only",
  };
}

function fmtPct(v) {
  return v == null ? "n/a" : `${v.toFixed(1)}%`;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function printTune(r) {
  const out = [];
  out.push("sextant tune — per-source open-rate diagnostics (REPORTING ONLY)");
  out.push(`  projects: ${r.projectsRoot}${r.repoFilter ? `  repo=${r.repoFilter}` : ""}`);
  out.push(`  corpus:   ${r.sessionsWithInjection} sessions with injection (of ${r.sessionsScanned} scanned, ${r.repos.length} repos)`);
  out.push("");
  if (!r.sources.length) {
    out.push("  No retrieval injections found in the transcript corpus.");
    return out.join("\n");
  }
  out.push(`  ${pad("source", 20)}${pad("surfaced", 10)}${pad("opened", 8)}${pad("rate", 8)}${pad("95% Wilson", 18)}n>=${r.priorMinN}`);
  for (const s of r.sources) {
    const ci = s.wilson95Pct ? `[${fmtPct(s.wilson95Pct.lo)}, ${fmtPct(s.wilson95Pct.hi)}]` : "n/a";
    out.push(
      `  ${pad(s.source, 20)}${pad(s.surfaced, 10)}${pad(s.opened, 8)}${pad(fmtPct(s.openRatePct), 8)}${pad(ci, 18)}${s.priorEligible ? "yes" : "NO"}`
    );
  }
  out.push("");
  out.push("  No scoring weight reads this table — live per-source tuning was evaluated");
  out.push("  and rejected (docs/016-phase0-recon.md R3: single-source blocks give a");
  out.push("  multiplier no lever; thin sources can't earn a defensible prior). Revisit");
  out.push(`  if the NO rows reach n>=${r.priorMinN} in a stable window, or corpus retention`);
  out.push("  becomes append-only.");
  return out.join("\n");
}

async function run(ctx) {
  const argv = ctx.argv || [];
  const projectsRoot =
    flag(process.argv, "projects") || path.join(os.homedir(), ".claude", "projects");
  const repo = flag(process.argv, "repo") || undefined;
  const report = buildTuneReport(projectsRoot, { repo, includeSubagents: hasFlag(process.argv, "include-subagents") });
  if (hasFlag(process.argv, "json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(printTune(report));
  }
}

module.exports = { run, buildTuneReport, wilson95, printTune, PRIOR_MIN_N };
