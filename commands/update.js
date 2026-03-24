const intel = require("../lib/intel");
const { flag } = require("../lib/cli");

async function run(ctx) {
  const r = ctx.roots[0];
  const rel = flag(process.argv, "--file") || ctx.argv[1];
  if (!rel) {
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
  await intel.updateFile(r, rel);
}

module.exports = { run };
