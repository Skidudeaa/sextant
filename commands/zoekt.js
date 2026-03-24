const zoekt = require("../lib/zoekt");
const { flag, hasFlag } = require("../lib/cli");

async function run(ctx) {
  const sub = ctx.argv[1];
  const r = ctx.roots[0];
  if (!sub) {
    console.error("Usage: sextant zoekt <index|serve|search> ...");
    process.exit(1);
  }

  if (sub === "index") {
    const force = hasFlag(process.argv, "--force");
    const res = zoekt.buildIndex(r, { force });
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }

  if (sub === "serve") {
    const port = parseInt(flag(process.argv, "--port") || "", 10);
    const autoIndex = hasFlag(process.argv, "--build");
    const res = await zoekt.ensureWebserver(r, {
      port: Number.isFinite(port) ? port : 6070,
      autoIndex,
    });
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }

  if (sub === "search") {
    const parts = [];
    for (let i = 2; i < ctx.argv.length; i += 1) {
      const a = ctx.argv[i];
      if (a.startsWith("--")) {
        i += 1;
        continue;
      }
      parts.push(a);
    }
    const q = parts.join(" ").trim();
    if (!q) {
      console.error("Usage: sextant zoekt search <query>");
      process.exit(1);
    }
    const port = parseInt(flag(process.argv, "--port") || "", 10);
    const contextLines = parseInt(flag(process.argv, "--context") || "", 10);
    const maxHits = parseInt(flag(process.argv, "--max-hits") || "", 10);

    const res = await zoekt.search(r, q, {
      port: Number.isFinite(port) ? port : 6070,
      contextLines: Number.isFinite(contextLines) ? contextLines : 1,
      maxHits: Number.isFinite(maxHits) ? maxHits : 50,
    });
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }

  console.error("Usage: sextant zoekt <index|serve|search> ...");
  process.exit(1);
}

module.exports = { run };
