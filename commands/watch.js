const { flag, hasFlag } = require("../lib/cli");
const { loadRepoConfig } = require("../lib/config");

async function run(ctx) {
  const secStr = flag(process.argv, "--summary-every");
  const sec = secStr ? Number.parseFloat(secStr) : null;
  if (secStr && (!Number.isFinite(sec) || sec < 0)) {
    console.error("Invalid --summary-every value");
    process.exit(1);
  }

  const noDashboard = hasFlag(process.argv, "--no-dashboard");

  const { watchRoots } = require("../watch");
  await watchRoots(ctx.roots, {
    loadRepoConfig,
    summaryEverySecOverride: sec,
    dashboard: !noDashboard,
  });
}

module.exports = { run };
