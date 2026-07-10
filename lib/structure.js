"use strict";

// Summary "Structure" section (docs/021, evidence in docs/020): the directory
// skeleton of the repo — per-dir file counts, dominant module type, and the
// dominant source→source import flows — computed at summary time from the
// files/imports tables plus a depth≤2 manifest walk.  Factual aggregation
// only; no schema change (the 020 probes did this in-memory in <100ms on a
// 1,400-file repo).
//
// Design decisions (021 D1–D5) enforced here:
//   D1  monorepo expansion is junk-filtered — a fixtures/ parent with three
//       manifest-bearing subdirs must NOT expand (probed failure, not
//       hypothetical).
//   D2  the `.` pseudo-dir (root-level files) never appears in rows or flows.
//   D3  flows SOURCED from test-ish dirs are excluded — highest-mass pairs
//       on every probed Python repo, zero architecture.
//   D4  a subdir counts toward expansion only when it passes the mapping
//       guard triplet: not junk-hint, no nested .git, ≥1 indexed file.
//   D5  displacement/omission is the CALLER's job (lib/summary.js renders
//       Module types when computeStructure returns null).
//
// The recon scripts (docs/recon/019-dirmap/) are the frozen reference
// implementation; this is the production re-implementation.

const fs = require("fs");
const path = require("path");

const MAX_ROWS = 7;
const MIN_ROWS_BEFORE_FLOW_DROP = 3;
const FLOW_ASYM_MIN = 0.6;
const FLOW_MAX = 3;
const EXPAND_MIN_PKGS = 3;
const PKGS_SHOWN = 4;
const MAX_BYTES_DEFAULT = 320;
const MAX_BYTES_EXPANDED = 420;
// Omission rule (021): <2 non-root dirs with indexed files → no Structure
// section (a 1-dir repo gets Module types instead — the subsumption argument
// fails exactly there).
const MIN_DIRS = 2;

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

// The probe-3 junk-hint class: dirs whose manifests mark fixtures/vendored
// trees, not nameable packages.  Applied to expansion parents AND subdirs.
const JUNK_DIR_RE =
  /(^|\/)(fixtures?|examples?|demos?|samples?|tests?|__tests__|testdata|vendor|third_party|e2e|playground|templates?|scaffold)(\/|$)/i;

// D3: flow SOURCES that carry no architecture (tests import everything).
const TEST_SRC_RE = /^(tests?|__tests__|spec)\//i;

// Same escaping discipline as lib/summary.js — the section rides inside
// <codebase-intelligence>, so markup-significant chars in dir names must not
// break the XML tag or markdown emphasis.
function mdEscapeInline(s) {
  return String(s).replace(/([\\`*_])/g, "\\$1");
}
function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sqlRows(db, sql) {
  const out = [];
  const stmt = db.prepare(sql);
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

function hasManifest(absDir) {
  for (const m of MANIFESTS) {
    try {
      if (fs.existsSync(path.join(absDir, m))) return true;
    } catch { /* unreadable → no manifest */ }
  }
  return false;
}

function hasNestedGit(absDir) {
  try {
    return fs.existsSync(path.join(absDir, ".git"));
  } catch {
    return false;
  }
}

// Top-level segment of a repo-relative posix path; "." for root-level files.
function topSegment(relPath) {
  const i = relPath.indexOf("/");
  return i === -1 ? "." : relPath.slice(0, i) + "/";
}

// Compute the structure model, or null when the omission rule applies.
// { rows, expandedParents, flows, hiddenDirCount }
//   rows: [{ kind:"dir", dir, files, domType } | { kind:"expanded", dir, pkgCount, pkgs:[{name, files}] }]
//   flows: [{ from, to, mass }] — display labels (parent prefix stripped)
function computeStructure(db, rootAbs) {
  const files = sqlRows(db, "SELECT path, type FROM files");
  if (!files.length) return null;

  // Per-top-dir stats (D2: "." files counted nowhere).
  const dirStats = new Map(); // dir -> { files, types: Map }
  for (const f of files) {
    const top = topSegment(f.path);
    if (top === ".") continue;
    let s = dirStats.get(top);
    if (!s) { s = { files: 0, types: new Map() }; dirStats.set(top, s); }
    s.files += 1;
    if (f.type) s.types.set(f.type, (s.types.get(f.type) || 0) + 1);
  }
  if (dirStats.size < MIN_DIRS) return null;

  // Indexed-file counts per depth-2 prefix, for the D4 triplet and package rows.
  const depth2Counts = new Map();
  for (const f of files) {
    const parts = f.path.split("/");
    if (parts.length >= 3) {
      const k = parts[0] + "/" + parts[1] + "/";
      depth2Counts.set(k, (depth2Counts.get(k) || 0) + 1);
    }
  }

  // Expansion detection (D1 + D4).  fs walk is best-effort: any error means
  // "no expansion", never a throw.
  const expandedParents = new Map(); // parent -> [{name, files}] sorted desc
  for (const dir of dirStats.keys()) {
    if (JUNK_DIR_RE.test(dir)) continue; // D1: junk parents never expand
    let entries;
    try {
      entries = fs.readdirSync(path.join(rootAbs, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    const pkgs = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const rel = dir + e.name + "/";
      if (JUNK_DIR_RE.test(rel)) continue;
      const indexed = depth2Counts.get(rel) || 0;
      if (indexed < 1) continue;
      const abs = path.join(rootAbs, dir, e.name);
      if (!hasManifest(abs) || hasNestedGit(abs)) continue;
      pkgs.push({ name: e.name, files: indexed });
    }
    if (pkgs.length >= EXPAND_MIN_PKGS) {
      pkgs.sort((a, b) => b.files - a.files || (a.name < b.name ? -1 : 1));
      expandedParents.set(dir, pkgs);
    }
  }

  // Rows, sorted by file count desc, capped.
  const allRows = [...dirStats.entries()]
    .map(([dir, s]) => {
      if (expandedParents.has(dir)) {
        const pkgs = expandedParents.get(dir);
        return { kind: "expanded", dir, files: s.files, pkgCount: pkgs.length, pkgs };
      }
      let domType = null, domN = 0;
      for (const [t, n] of s.types) if (n > domN) { domType = t; domN = n; }
      return { kind: "dir", dir, files: s.files, domType };
    })
    .sort((a, b) => b.files - a.files || (a.dir < b.dir ? -1 : 1));
  const rows = allRows.slice(0, MAX_ROWS);
  const hiddenDirCount = allRows.length - rows.length;

  const flows = computeFlows(db, rows, expandedParents);
  return { rows, expandedParents: [...expandedParents.keys()], flows, hiddenDirCount };
}

// Flow granularity: depth-2 keys inside expanded parents, depth-1 elsewhere.
function flowKey(relPath, expandedParents) {
  const top = topSegment(relPath);
  if (top !== "." && expandedParents.has(top)) {
    const parts = relPath.split("/");
    if (parts.length >= 3) return parts[0] + "/" + parts[1] + "/";
  }
  return top;
}

function computeFlows(db, shownRows, expandedParents) {
  const imports = sqlRows(
    db,
    "SELECT from_path, to_path FROM imports WHERE to_path IS NOT NULL AND is_external = 0"
  );

  // An endpoint qualifies when it's a shown dir row, or any package inside a
  // shown expanded parent (the 020 example flows reference packages beyond the
  // row's top-4 — the PARENT being shown is what prevents dangling references).
  const shownDirs = new Set(shownRows.map((r) => r.dir));
  const endpointShown = (key) => {
    if (shownDirs.has(key)) return true;
    const top = topSegment(key.replace(/\/$/, "") + "/x"); // parent of a depth-2 key
    return expandedParents.has(top) && shownDirs.has(top);
  };

  // NUL separator: cannot appear in a file path, so keys never collide.
  const SEP = "\u0000";
  const matrix = new Map();
  for (const imp of imports) {
    const a = flowKey(imp.from_path, expandedParents);
    const b = flowKey(imp.to_path, expandedParents);
    if (a === b) continue;
    if (a === "." || b === ".") continue; // D2
    const k = a + SEP + b;
    matrix.set(k, (matrix.get(k) || 0) + 1);
  }

  const seen = new Set();
  const pairs = [];
  for (const [k, fwd] of matrix) {
    const [a, b] = k.split(SEP);
    const und = a < b ? a + SEP + b : b + SEP + a;
    if (seen.has(und)) continue;
    seen.add(und);
    const rev = matrix.get(b + SEP + a) || 0;
    const mass = fwd + rev;
    const asym = (2 * Math.max(fwd, rev) - mass) / mass;
    const [src, dst] = fwd >= rev ? [a, b] : [b, a];
    if (asym < FLOW_ASYM_MIN) continue;
    if (TEST_SRC_RE.test(src)) continue; // D3
    if (!endpointShown(src) || !endpointShown(dst)) continue;
    pairs.push({ src, dst, mass });
  }
  pairs.sort((a, b) => b.mass - a.mass || (a.src < b.src ? -1 : 1));

  // Display labels: strip the expanded-parent prefix (packages/runtime-core/
  // → runtime-core); plain dirs keep their trailing slash.
  const label = (key) => {
    const top = topSegment(key.replace(/\/$/, "") + "/x");
    if (key !== top && expandedParents.has(top)) {
      return key.slice(top.length).replace(/\/$/, "");
    }
    return key;
  };
  return pairs.slice(0, FLOW_MAX).map((p) => ({ from: label(p.src), to: label(p.dst), mass: p.mass }));
}

function renderDirRow(row) {
  const noun = row.files === 1 ? "file" : "files";
  const type = row.domType ? ` (${xmlEscape(row.domType)})` : "";
  return `- \`${xmlEscape(mdEscapeInline(row.dir))}\` — ${row.files} ${noun}${type}`;
}

function renderExpandedRow(row) {
  const shown = row.pkgs.slice(0, PKGS_SHOWN);
  const more = row.pkgCount - shown.length;
  const list = shown.map((p) => `${xmlEscape(mdEscapeInline(p.name))} ${p.files}`).join(", ");
  return (
    `- \`${xmlEscape(mdEscapeInline(row.dir))}\` (${row.pkgCount} pkgs): ${list}` +
    (more > 0 ? ` …+${more}` : "")
  );
}

// Render, enforcing the internal byte cap (021 D-budget): dropping rows first
// (down to a floor), then the flow line, then remaining rows.  Returns null
// when structure is null (omission rule — caller falls back to Module types).
function renderStructureSection(structure, opts = {}) {
  if (!structure || !structure.rows || !structure.rows.length) return null;
  const expanded = structure.expandedParents && structure.expandedParents.length > 0;
  const maxBytes = opts.maxBytes || (expanded ? MAX_BYTES_EXPANDED : MAX_BYTES_DEFAULT);

  const build = (rowCount, withFlow) => {
    const rows = structure.rows.slice(0, rowCount);
    const hidden = structure.hiddenDirCount + (structure.rows.length - rows.length);
    const lines = ["### Structure"];
    for (const r of rows) {
      lines.push(r.kind === "expanded" ? renderExpandedRow(r) : renderDirRow(r));
    }
    if (hidden > 0) lines.push(`- …+${hidden} more dirs`);
    if (withFlow && structure.flows.length) {
      lines.push(`- Flow: ${structure.flows.map((f) => `${f.from} → ${f.to}`).join("; ")}`);
    }
    return lines.join("\n");
  };

  let rowCount = structure.rows.length;
  let withFlow = true;
  let out = build(rowCount, withFlow);
  while (Buffer.byteLength(out, "utf8") > maxBytes && rowCount > MIN_ROWS_BEFORE_FLOW_DROP) {
    rowCount -= 1;
    out = build(rowCount, withFlow);
  }
  if (Buffer.byteLength(out, "utf8") > maxBytes && withFlow) {
    withFlow = false;
    out = build(rowCount, withFlow);
  }
  while (Buffer.byteLength(out, "utf8") > maxBytes && rowCount > 1) {
    rowCount -= 1;
    out = build(rowCount, withFlow);
  }
  return out;
}

// Dir-level aggregate view (docs/021 form c — `sextant explain <dir>/`).
// Pure graph.db aggregation: file/type counts, import edges split into
// internal / inbound (outside→inside, grouped by the importer's top dir) /
// outbound (inside→outside, grouped by the target's top dir), the top
// fan-in hotspots INSIDE the dir, and git co-change coupling to other dirs
// (pairs with exactly one side inside, commit counts summed by the other
// side's top dir).  Returns null when no indexed files live under the
// prefix — the caller distinguishes "empty dir" from "isolated dir".
const EXPLAIN_HOTSPOTS = 5;

function explainDir(db, dirPrefix) {
  const prefix = String(dirPrefix).replace(/\/+$/, "") + "/";
  const files = sqlRows(db, "SELECT path, type FROM files").filter((f) =>
    f.path.startsWith(prefix)
  );
  if (!files.length) return null;

  const types = new Map();
  for (const f of files) if (f.type) types.set(f.type, (types.get(f.type) || 0) + 1);

  const imports = sqlRows(
    db,
    "SELECT from_path, to_path FROM imports WHERE to_path IS NOT NULL AND is_external = 0"
  );
  const inboundByDir = new Map();
  const outboundByDir = new Map();
  const fanIn = new Map();
  let inboundTotal = 0, outboundTotal = 0, internalEdges = 0;
  for (const imp of imports) {
    const fromIn = imp.from_path.startsWith(prefix);
    const toIn = imp.to_path.startsWith(prefix);
    if (toIn) fanIn.set(imp.to_path, (fanIn.get(imp.to_path) || 0) + 1);
    if (fromIn && toIn) { internalEdges += 1; continue; }
    if (!fromIn && toIn) {
      inboundTotal += 1;
      const d = topSegment(imp.from_path);
      inboundByDir.set(d, (inboundByDir.get(d) || 0) + 1);
    } else if (fromIn && !toIn) {
      outboundTotal += 1;
      const d = topSegment(imp.to_path);
      outboundByDir.set(d, (outboundByDir.get(d) || 0) + 1);
    }
  }

  const hotspots = [...fanIn.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, EXPLAIN_HOTSPOTS)
    .map(([p, n]) => ({ path: p, fanIn: n }));

  // Co-change coupling: unordered pairs are stored once, so "exactly one side
  // inside" needs no direction handling; commit counts sum by the other dir.
  const cochangeByDir = new Map();
  for (const r of sqlRows(db, "SELECT file_a, file_b, count FROM cochange_pairs")) {
    const aIn = r.file_a.startsWith(prefix);
    const bIn = r.file_b.startsWith(prefix);
    if (aIn === bIn) continue;
    const d = topSegment(aIn ? r.file_b : r.file_a);
    cochangeByDir.set(d, (cochangeByDir.get(d) || 0) + r.count);
  }

  const byCountDesc = (m) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([dir, count]) => ({ dir, count }));

  return {
    dir: prefix,
    files: files.length,
    types: [...types.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([type, count]) => ({ type, count })),
    internalEdges,
    inbound: { total: inboundTotal, byDir: byCountDesc(inboundByDir) },
    outbound: { total: outboundTotal, byDir: byCountDesc(outboundByDir) },
    hotspots,
    cochange: byCountDesc(cochangeByDir),
  };
}

module.exports = {
  computeStructure,
  renderStructureSection,
  explainDir,
  // exported for unit tests:
  topSegment,
  flowKey,
  JUNK_DIR_RE,
  MANIFESTS,
};
