const intel = require("../lib/intel");

async function run(ctx) {
  const r = ctx.roots[0];
  const s = intel.readSummary(r);
  process.stdout.write(s && s.trim() ? s : "No summary\n");
}

module.exports = { run };
