// Probe 2 (docs/019): flow-signal.
// Is there a dominant, meaningful cross-directory import direction on real
// repos, or is it mush? Computes the dir->dir matrix from the imports table
// and reports per-pair asymmetry + how much cross-dir mass is strongly directed.
//
// Usage: node probe2-flows.js <repoRoot> [--depth N] [--prefix packages/]
"use strict";

const { openDb, dirKey, flowMatrix, pairAsymmetry } = require("./common");

async function main() {
  const root = process.argv[2];
  if (!root) { console.error("usage: probe2-flows.js <repoRoot> [--depth N] [--prefix p/]"); process.exit(1); }
  const depthArg = process.argv.indexOf("--depth");
  const depth = depthArg > -1 ? Number(process.argv[depthArg + 1]) : 1;
  const prefixArg = process.argv.indexOf("--prefix");
  const prefix = prefixArg > -1 ? process.argv[prefixArg + 1] : null;

  const db = await openDb(root);
  // With --prefix, analyze only files under that prefix at depth+1 keys
  // (e.g. flows BETWEEN packages inside packages/).
  const keyOf = (p) => dirKey(p, depth + (prefix ? 1 : 0));
  const filterKey = (k) => !prefix || k.startsWith(prefix);

  const { edges, matrix } = flowMatrix(db, keyOf);
  const filtered = new Map([...matrix].filter(([k]) => {
    const [a, b] = k.split(" -> ");
    return filterKey(a) && filterKey(b);
  }));
  const crossMass = [...filtered.values()].reduce((s, n) => s + n, 0);
  const pairs = pairAsymmetry(filtered);

  const directedMass = pairs.filter((p) => p.asym >= 0.6).reduce((s, p) => s + p.mass, 0);
  const wAsym = crossMass ? pairs.reduce((s, p) => s + p.asym * p.mass, 0) / crossMass : 0;

  console.log(`repo=${root} depth=${depth}${prefix ? ` prefix=${prefix}` : ""}`);
  console.log(`internalEdges=${edges} crossDirEdges=${crossMass} pairs=${pairs.length}`);
  console.log(`massWeightedAsymmetry=${wAsym.toFixed(3)} directedMassShare(asym>=0.6)=${crossMass ? (directedMass / crossMass).toFixed(3) : "n/a"}`);
  console.log("top pairs (mass desc):");
  for (const p of pairs.slice(0, 12)) {
    console.log(
      `  ${p.dominant.padEnd(40)} fwd=${String(Math.max(p.fwd, p.rev)).padStart(4)} rev=${String(Math.min(p.fwd, p.rev)).padStart(4)} asym=${p.asym.toFixed(2)}`
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
