#!/usr/bin/env node

// The retrieval-era CLI (scan, watch, hooks, MCP server, telemetry and the
// rest) was archived on 2026-11-03; restore any file with
// `git show archive/retrieval-era-2026-11-03:<path>`. What remains are the
// commands with live callers: the atoms exposure hook in four repos and the
// ledger/atoms instruments.

const { rootsFromArgs } = require("../lib/cli");

function usage(exitCode = 1) {
  const pkg = require("../package.json");
  console.log(`sextant v${pkg.version}

Usage:
  sextant ledger census [--projects <path>] [--days <N>] [--json]
  sextant atoms compile --dry-run [--roots <a,b>] [--json]
  sextant atoms replay [--roots <a,b>] [--projects <path>] [--days <N>] [--json]
  sextant atoms exposure`);
  process.exit(exitCode);
}

const commandMap = {
  ledger: "../commands/ledger",
  atoms: "../commands/atoms",
};

(async () => {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    const pkg = require("../package.json");
    console.log(`sextant v${pkg.version}`);
    process.exit(0);
  }

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
