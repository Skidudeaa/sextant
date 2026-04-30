const intel = require("../lib/intel");
const { stripUnsafeXmlTags, applyFreshnessGate } = require("../lib/cli");

async function run() {
  const root = process.cwd();
  await intel.init(root);
  const raw = intel.readSummary(root);
  if (!raw || !raw.trim()) process.exit(0);
  // WHY: applyFreshnessGate enforces "structural claims unavailable when
  // stale" by construction.  If graph.db is out of sync with HEAD / status
  // / code versions, the returned body has no hotspots, no fan-in counts,
  // no entry points -- only root, git head, signals, recent commits, and
  // a "rescan requested|pending" marker.  Same contract as the hooks and
  // `sextant summary`; all three surfaces must agree on current state.
  const summary = await applyFreshnessGate(raw, root);
  const safeInject = stripUnsafeXmlTags(summary.trim());
  process.stdout.write(
    `<codebase-intelligence>\n${safeInject}\n</codebase-intelligence>`
  );
  process.exit(0);
}

module.exports = { run };
