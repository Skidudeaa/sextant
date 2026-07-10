// Shared helpers for the 019 directory-mapping recon probes.
// Read-only against target repos: loadDb() reads graph.db into memory.
"use strict";

const path = require("path");
const fs = require("fs");
const graph = require("../../../lib/graph");

async function openDb(root) {
  return graph.loadDb(path.resolve(root));
}

function rows(db, sql, params) {
  const out = [];
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

// Top-level dir of a repo-relative posix path. Files at the root map to ".".
// depth=2 gives "packages/runtime-core/" style keys for monorepo expansion.
function dirKey(relPath, depth = 1) {
  const parts = String(relPath).split("/");
  if (parts.length <= depth) return ".";
  return parts.slice(0, depth).join("/") + "/";
}

const MANIFESTS = [
  "package.json",
  "pyproject.toml",
  "setup.py",
  "Cargo.toml",
  "go.mod",
  "Package.swift",
  "pom.xml",
  "build.gradle",
  "Gemfile",
  "composer.json",
];

function manifestsIn(absDir) {
  const found = [];
  for (const m of MANIFESTS) {
    try {
      if (fs.existsSync(path.join(absDir, m))) found.push(m);
    } catch { /* unreadable */ }
  }
  return found;
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".planning", ".venv", "venv", "__pycache__",
  "dist", "build", ".next", ".cache",
]);

// Enumerate depth<=2 subdirs that carry a manifest file.
function manifestDirs(root, maxDepth = 2) {
  const out = [];
  const walk = (abs, rel, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      const childAbs = path.join(abs, e.name);
      const childRel = rel ? rel + "/" + e.name : e.name;
      const found = manifestsIn(childAbs);
      if (found.length) out.push({ dir: childRel + "/", manifests: found });
      walk(childAbs, childRel, depth + 1);
    }
  };
  walk(path.resolve(root), "", 1);
  return out;
}

// dir -> {files, types: {ext: n}} at a given depth, from the files table.
function dirStats(db, depth = 1) {
  const byDir = new Map();
  for (const r of rows(db, "SELECT path, type FROM files")) {
    const k = dirKey(r.path, depth);
    let s = byDir.get(k);
    if (!s) { s = { files: 0, types: {} }; byDir.set(k, s); }
    s.files += 1;
    if (r.type) s.types[r.type] = (s.types[r.type] || 0) + 1;
  }
  return byDir;
}

// Directed cross-dir import matrix from resolved internal imports.
// Returns { edges, crossEdges, matrix: Map("A -> B" -> n) } at the given depth,
// with an optional per-file dir override (for mixed-depth monorepo keys).
function flowMatrix(db, keyOf) {
  const matrix = new Map();
  let edges = 0;
  let crossEdges = 0;
  const sql =
    "SELECT from_path, to_path FROM imports WHERE to_path IS NOT NULL AND is_external = 0";
  for (const r of rows(db, sql)) {
    edges += 1;
    const a = keyOf(r.from_path);
    const b = keyOf(r.to_path);
    if (a === b) continue;
    crossEdges += 1;
    const k = a + " -> " + b;
    matrix.set(k, (matrix.get(k) || 0) + 1);
  }
  return { edges, crossEdges, matrix };
}

// Pair-level asymmetry over an directed matrix: for each unordered {A,B},
// asym = |fwd-rev| / (fwd+rev). Returns pairs sorted by mass desc.
function pairAsymmetry(matrix) {
  const seen = new Set();
  const pairs = [];
  for (const [k, fwd] of matrix) {
    const [a, b] = k.split(" -> ");
    const und = a < b ? a + "|" + b : b + "|" + a;
    if (seen.has(und)) continue;
    seen.add(und);
    const rev = matrix.get(b + " -> " + a) || 0;
    const mass = fwd + rev;
    const hi = Math.max(fwd, rev);
    const dir = fwd >= rev ? a + " -> " + b : b + " -> " + a;
    pairs.push({ a, b, fwd, rev, mass, asym: (2 * hi - mass) / mass, dominant: dir });
  }
  pairs.sort((x, y) => y.mass - x.mass);
  return pairs;
}

module.exports = {
  openDb, rows, dirKey, manifestDirs, manifestsIn, dirStats,
  flowMatrix, pairAsymmetry, MANIFESTS,
};
