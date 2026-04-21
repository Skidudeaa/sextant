const intel = require("../lib/intel");
const { stripUnsafeXmlTags, refreshSummaryAge } = require("../lib/cli");

async function run() {
  const root = process.cwd();
  await intel.init(root);
  const raw = intel.readSummary(root);
  if (!raw || !raw.trim()) process.exit(0);
  // WHY: route through refreshSummaryAge so the injected block reports the
  // actual age/watcher state at read time, not whatever summary.js baked in
  // when the file was written.  Same contract as `sextant summary` and the
  // UserPromptSubmit hook's static-summary fallback path — all three surfaces
  // must agree on the current state.
  const summary = refreshSummaryAge(raw, root);
  const safeInject = stripUnsafeXmlTags(summary.trim());
  process.stdout.write(
    `<codebase-intelligence>\n${safeInject}\n</codebase-intelligence>`
  );
  process.exit(0);
}

module.exports = { run };
