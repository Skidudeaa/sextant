"use strict";

// `sextant closure [--session <key>] [--json]` (docs/029 Phase D).
//
// The supervisor interface: a FACTUAL task-closure report assembled from the
// capsule + claim ledger + structural deltas + observed-file set. States evidence
// and gaps only — never "safe to merge." See lib/closure.js.

const { flag, hasFlag } = require("../lib/cli");
const { buildClosure, renderClosure } = require("../lib/closure");

async function run(ctx) {
  const root = ctx.root || (ctx.roots && ctx.roots[0]);
  const sessionKey = flag(process.argv, "--session") || null;
  const report = buildClosure(root, { sessionKey });
  if (hasFlag(process.argv, "--json")) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }
  process.stdout.write(renderClosure(report) + "\n");
}

module.exports = { run };
