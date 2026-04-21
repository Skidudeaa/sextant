const intel = require("../lib/intel");
const { refreshSummaryAge } = require("../lib/cli");

async function run(ctx) {
  const r = ctx.roots[0];
  const raw = intel.readSummary(r);
  if (!raw || !raw.trim()) {
    process.stdout.write("No summary\n");
    return;
  }
  // WHY: summary.md bakes "index age Xs" at write time and — until the
  // running watcher picks up a newer sextant binary — may still carry a
  // stale "INDEX STALE (watcher dead?)" alert.  Route the CLI output through
  // the same refresh logic the hook uses so both surfaces tell the same
  // truth about current state.
  process.stdout.write(refreshSummaryAge(raw, r));
}

module.exports = { run };
