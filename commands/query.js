const intel = require("../lib/intel");
const { flag } = require("../lib/cli");

async function run(ctx) {
  const sub = ctx.argv[1];
  const r = ctx.roots[0];
  const rel = flag(process.argv, "--file") || ctx.argv[2];
  if (!sub || !rel) {
    const pkg = require("../package.json");
    console.log(`sextant v${pkg.version}

Usage:
  sextant init [--root <path> | --roots <a,b> | --roots-file <file>]
  sextant scan [--root/--roots/--roots-file] [--force]
  sextant rescan [--root/--roots/--roots-file] [--force]
  sextant update --file <relPath> [--root <path>]
  sextant watch [--root/--roots/--roots-file] [--summary-every <sec>] [--no-dashboard]
  sextant summary [--root <path>]
  sextant health [--root <path>] [--pretty]
  sextant doctor [--root <path>]
  sextant query <imports|dependents|exports> --file <relPath> [--root <path>]
  sextant hook sessionstart
  sextant hook refresh
  sextant inject
  sextant retrieve <query>
  sextant zoekt <index|serve|search>`);
    process.exit(1);
  }

  if (!["imports", "dependents", "exports"].includes(sub)) {
    console.error(`Unknown query subcommand: "${sub}". Valid subcommands: imports, dependents, exports`);
    process.exit(1);
  }

  // WHY: previously returned empty JSON arrays silently for unknown files,
  // indistinguishable from real-but-isolated files.  Check first.
  const graph = require("../lib/graph");
  const path = require("path");
  const db = await graph.loadDb(path.resolve(r));
  const meta = graph.getFileMeta(db, rel);
  if (!meta) {
    console.error(`file not in index: ${rel}`);
    console.error(`hint: run \`sextant scan\` or check that the path is relative to the project root`);
    process.exit(1);
  }

  if (sub === "imports") {
    const out = await intel.queryImports(r, rel);
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  } else if (sub === "dependents") {
    const out = await intel.queryDependents(r, rel);
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  } else if (sub === "exports") {
    const out = await intel.queryExports(r, rel);
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  }
}

module.exports = { run };
