"use strict";

// STRUCTURAL DELTA ENGINE (docs/029 Phase D).
//
// After an edit, answer "what did this change in the repository's OBSERVABLE
// STRUCTURE?" — not a textual diff (git has that), but the graph-level delta:
// which exports/imports appeared or vanished. Computed WITHOUT an LLM by diffing
// the file's CURRENT extraction against the graph's STORED extraction. The graph
// is the pre-image: at PostToolUse time the watcher hasn't re-indexed the just-
// edited file yet, so graph.queryExports/queryImports still return its pre-edit
// structure. (If the watcher was fast and re-indexed, old==new → empty delta →
// safe: we never assert a change that didn't happen.) Never throws.

const { extractExports, extractImports } = require("./extractor");

function typeOf(relPath) {
  const i = String(relPath || "").lastIndexOf(".");
  return i >= 0 ? relPath.slice(i + 1).toLowerCase() : "";
}

function uniq(a) {
  return [...new Set(a)];
}
function minus(a, b) {
  const set = new Set(b);
  return a.filter((x) => !set.has(x));
}

// Diff a file's current structure (from newContent) against the graph pre-image.
//   db: loaded graph.db handle; graph: the lib/graph module; relPath: repo-rel.
// Returns { exportsAdded, exportsRemoved, importsAdded, importsRemoved, changed }.
// `changed` is true iff any set is non-empty (a quick "did structure move?").
function computeStructuralDelta(db, graph, relPath, newContent) {
  const empty = { exportsAdded: [], exportsRemoved: [], importsAdded: [], importsRemoved: [], changed: false };
  try {
    if (!db || !graph || typeof relPath !== "string" || typeof newContent !== "string") return empty;
    const type = typeOf(relPath);

    // NEW structure (re-extract). Regular exports only (re-exports carry `from`).
    let newExports = [];
    let newImports = [];
    try {
      newExports = uniq(extractExports(newContent, type).filter((e) => e && !e.from && e.name).map((e) => e.name));
    } catch {}
    try {
      newImports = uniq(extractImports(newContent, type).filter((i) => i && i.specifier).map((i) => i.specifier));
    } catch {}

    // OLD structure (pre-image from the graph).
    const oldExports = uniq((graph.queryExports(db, relPath) || []).map((e) => e.name).filter(Boolean));
    const oldImports = uniq((graph.queryImports(db, relPath) || []).map((i) => i.specifier).filter(Boolean));

    const exportsAdded = minus(newExports, oldExports);
    const exportsRemoved = minus(oldExports, newExports);
    const importsAdded = minus(newImports, oldImports);
    const importsRemoved = minus(oldImports, newImports);
    const changed = !!(exportsAdded.length || exportsRemoved.length || importsAdded.length || importsRemoved.length);
    return { exportsAdded, exportsRemoved, importsAdded, importsRemoved, changed };
  } catch {
    return empty;
  }
}

// Compact one-line-per-field summary for a closure report / telemetry.
function summarizeDelta(d) {
  const parts = [];
  if (d.exportsAdded.length) parts.push(`+${d.exportsAdded.length} export`);
  if (d.exportsRemoved.length) parts.push(`-${d.exportsRemoved.length} export`);
  if (d.importsAdded.length) parts.push(`+${d.importsAdded.length} import`);
  if (d.importsRemoved.length) parts.push(`-${d.importsRemoved.length} import`);
  return parts.join(", ");
}

module.exports = { computeStructuralDelta, summarizeDelta, typeOf };
