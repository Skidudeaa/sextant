"use strict";

// `sextant sprawl [--json] [--within <N>]` (docs/030 Phase E).
//
// The anti-sprawl KILL-criterion instrument: the create-then-abandon baseline
// mined from git history — source files added and deleted within N commits. This
// is the rate the anti-sprawl nudge aims to reduce; a near-zero rate means the
// repo has little sprawl to reclaim (the nudge's headroom is elsewhere).

const { hasFlag, flag } = require("../lib/cli");
const { analyzeSprawlHistory } = require("../lib/anti-sprawl");

async function run(ctx) {
  const root = ctx.root || (ctx.roots && ctx.roots[0]);
  const within = parseInt(flag(process.argv, "--within"), 10) || 10;
  const r = analyzeSprawlHistory(root, { withinCommits: within });
  if (hasFlag(process.argv, "--json")) {
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    return;
  }
  const L = [];
  L.push("sextant sprawl — create-then-abandon baseline (git history)");
  L.push(`  source files added: ${r.addedSourceFiles}`);
  L.push(
    `  abandoned within ${r.withinCommits} commits: ${r.abandonedWithin}` +
    (r.abandonRate != null ? `  (${(r.abandonRate * 100).toFixed(1)}%)` : "")
  );
  if (r.examples.length) {
    L.push("  examples:");
    for (const e of r.examples) L.push(`    - ${e.path} (lived ${e.lifespanCommits} commits)`);
  }
  L.push("");
  L.push(
    "This is the baseline the anti-sprawl nudge aims to reduce. A near-zero rate means this " +
    "repo has little sprawl to reclaim — the nudge's headroom is on higher-churn repos."
  );
  process.stdout.write(L.join("\n") + "\n");
}

module.exports = { run };
