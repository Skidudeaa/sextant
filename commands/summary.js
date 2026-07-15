const intel = require("../lib/intel");
const { applyBoundFreshnessGate } = require("../lib/cli");

async function run(ctx) {
  const r = ctx.roots[0];
  const raw = intel.readSummary(r);
  // WHY: route through applyFreshnessGate so the CLI output matches what
  // the hook injects -- on stale repo state, both produce a minimal body
  // (no hotspots, no fan-in numbers) and trigger the same async rescan.
  // All three surfaces (this command, sextant inject, the hooks) must
  // agree on what's currently true; using the same gate guarantees that.
  const summary = await applyBoundFreshnessGate(raw || "", r);
  process.stdout.write(summary && summary.trim() ? summary : "No summary\n");
}

module.exports = { run };
