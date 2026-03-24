#!/usr/bin/env node

const { rootsFromArgs } = require("../lib/cli");

function usage(exitCode = 1) {
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
  process.exit(exitCode);
}

// Command map for commands that need roots parsing
const commandMap = {
  init: "../commands/init",
  scan: "../commands/scan",
  rescan: "../commands/scan",
  update: "../commands/update",
  watch: "../commands/watch",
  summary: "../commands/summary",
  health: "../commands/health",
  doctor: "../commands/doctor",
  query: "../commands/query",
  retrieve: "../commands/retrieve",
  zoekt: "../commands/zoekt",
};

(async () => {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  // ---- version ----
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    const pkg = require("../package.json");
    console.log(`sextant v${pkg.version}`);
    process.exit(0);
  }

  // ---- hook commands: dispatch by subcommand, no roots parsing ----
  if (cmd === "hook") {
    const sub = argv[1];
    if (sub === "sessionstart") {
      const { run } = require("../commands/hook-sessionstart");
      await run();
      return;
    }
    if (sub === "refresh") {
      const { run } = require("../commands/hook-refresh");
      await run();
      return;
    }
    usage(1);
  }

  // ---- early-exit commands: no roots parsing needed ----
  if (cmd === "inject") {
    const { run } = require("../commands/inject");
    await run();
    return;
  }

  if (cmd === "watch-start") {
    const { run } = require("../commands/watch-start");
    await run();
    return;
  }

  if (cmd === "watch-stop") {
    const { run } = require("../commands/watch-stop");
    await run();
    return;
  }

  // ---- all other commands: parse roots, build ctx, dispatch ----
  const modPath = commandMap[cmd];
  if (!modPath) usage(1);

  const roots = rootsFromArgs(process.argv);
  const ctx = { argv, roots, root: roots[0] };

  const { run } = require(modPath);
  await run(ctx);
})().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});
