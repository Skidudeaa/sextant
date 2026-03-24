const intel = require("../lib/intel");

async function run(ctx) {
  for (const r of ctx.roots) await intel.init(r);
}

module.exports = { run };
