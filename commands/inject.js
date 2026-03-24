const intel = require("../lib/intel");
const { stripUnsafeXmlTags } = require("../lib/cli");

async function run() {
  const root = process.cwd();
  await intel.init(root);
  const summary = intel.readSummary(root);
  if (!summary || !summary.trim()) process.exit(0);
  const safeInject = stripUnsafeXmlTags(summary.trim());
  process.stdout.write(
    `<codebase-intelligence>\n${safeInject}\n</codebase-intelligence>`
  );
  process.exit(0);
}

module.exports = { run };
