// Probe 1 (docs/019): skeleton-quality.
// Generates a CANDIDATE Structure section for a repo from its graph.db and
// reports the byte cost. Recognizability is judged by a human/agent reading
// the output next to the real repo — this script only produces the artifact.
//
// Usage: node probe1-skeleton.js <repoRoot> [--rows N]
"use strict";

const { openDb, rows, dirKey, flowMatrix, pairAsymmetry, manifestDirs } = require("./common");

const MAX_ROWS = 8;
const FLOW_ASYM_MIN = 0.6; // only clearly-directed flows earn a mention
const FLOW_TOP = 3;

function dominantType(types) {
  const e = Object.entries(types).sort((a, b) => b[1] - a[1]);
  return e.length ? e[0][0] : "?";
}

async function main() {
  const root = process.argv[2];
  if (!root) { console.error("usage: probe1-skeleton.js <repoRoot>"); process.exit(1); }
  const db = await openDb(root);

  // Monorepo expansion rule (the thing probe 3 tests the accuracy of):
  // a top-level dir expands to depth 2 when it contains >=3 manifest-bearing
  // direct subdirs (the packages/ pattern).
  // Junk-hint filter (probe-3 finding): fixture/example/vendor parents must not
  // trigger monorepo expansion — sextant's fixtures/ falsely expanded without it.
  const JUNK = /(^|\/)(fixtures?|examples?|demos?|samples?|tests?|__tests__|testdata|vendor|third_party|e2e|playground|templates?|scaffold)(\/|$)/i;
  const mDirs = manifestDirs(root, 2).filter((m) => !JUNK.test(m.dir));
  const byParent = new Map();
  for (const m of mDirs) {
    const parts = m.dir.split("/").filter(Boolean);
    if (parts.length === 2) {
      const p = parts[0] + "/";
      byParent.set(p, (byParent.get(p) || 0) + 1);
    }
  }
  const expanded = new Set([...byParent].filter(([, n]) => n >= 3).map(([p]) => p));

  const keyOf = (relPath) => {
    const top = dirKey(relPath, 1);
    return expanded.has(top) ? dirKey(relPath, 2) : top;
  };

  // dir rows at mixed depth
  const stats = new Map();
  for (const r of rows(db, "SELECT path, type FROM files")) {
    const k = keyOf(r.path);
    let s = stats.get(k);
    if (!s) { s = { files: 0, types: {} }; stats.set(k, s); }
    s.files += 1;
    if (r.type) s.types[r.type] = (s.types[r.type] || 0) + 1;
  }

  const sorted = [...stats.entries()].sort((a, b) => b[1].files - a[1].files);
  const shown = sorted.filter(([d]) => d !== ".").slice(0, MAX_ROWS);
  const hidden = sorted.filter(([d]) => d !== ".").length - shown.length;

  // flows at the same granularity
  const { crossEdges, matrix } = flowMatrix(db, keyOf);
  const pairs = pairAsymmetry(matrix).filter((p) => p.asym >= FLOW_ASYM_MIN);
  const flows = pairs
    .filter((p) => {
      // only mention flows between dirs that made the shown list (else noise)
      const names = new Set(shown.map(([d]) => d));
      const [a, , b] = p.dominant.split(" ");
      return names.has(a) && names.has(b);
    })
    .slice(0, FLOW_TOP);

  const lines = ["### Structure"];
  for (const [d, s] of shown) {
    lines.push(`- \`${d}\` — ${s.files} files (${dominantType(s.types)})`);
  }
  if (hidden > 0) lines.push(`- …+${hidden} more dirs`);
  if (flows.length) {
    lines.push(`- Flow: ${flows.map((p) => p.dominant.replace(" -> ", " → ")).join("; ")}`);
  }
  const section = lines.join("\n");

  console.log(section);
  console.log("");
  console.log(`[bytes] ${Buffer.byteLength(section, "utf8")}`);
  console.log(`[dirs] total=${sorted.length} shown=${shown.length} hidden=${hidden} expanded=${[...expanded].join(",") || "none"}`);
  console.log(`[flows] crossDirEdges=${crossEdges} directedPairsShown=${flows.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
