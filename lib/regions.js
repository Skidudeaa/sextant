"use strict";

// REGION OUTCOME SUBSTRATE (docs/025 Phase A) — the thin region-identity layer.
//
// The whole retrieval → injection → open-attribution loop is path-granular today
// (a "path_hit" = the agent touched a file we surfaced, nothing finer). But real
// Claude Code records carry line coordinates: Read inputs have offset/limit, and
// Edit results have a structuredPatch with newStart/newLines. This module turns a
// line into a stable REGION identity (enclosing function/class/decl) so we can ask
// the sharper question the vision needs: did the agent edit the REGION we pointed
// at, or open the right file and edit a DIFFERENT region (reclaimable navigation)?
//
// Deliberately NOT persisted to graph.db in Phase A (query-time only). This is a
// measurement substrate; a persisted region table is a later, gated phase. Reuse
// only — scope resolution lives in scope-finder.js; this file never re-implements
// it. Never throws: every entry point degrades to null / [] on any failure, so a
// caller on the hook hot path can wrap-and-forget.

const fs = require("fs");
const path = require("path");
const { findEnclosingScopeInContent, LANG_MAP } = require("./scope-finder");

// Extension (no dot, lowercased) → region resolution is supported. Mirrors the
// languages scope-finder actually parses; Swift/others resolve to null here and
// flow through the pre-attached decl breadcrumb instead (see hook-refresh).
function extOf(relPath) {
  return path.extname(String(relPath || "")).slice(1).toLowerCase();
}
function isSupportedExt(ext) {
  return Object.prototype.hasOwnProperty.call(LANG_MAP, String(ext || "").toLowerCase());
}

// Stable internal region id — the query-time form of the vision's
// sextant://…#region address. path#name; kind is kept on the object for
// disambiguation but stays out of the id so it survives a kind reclassification.
// null when there's no name to anchor to (an unnamed/again-null scope is not a
// region we can attribute).
function regionId(relPath, name) {
  if (!relPath || !name) return null;
  return `${relPath}#${name}`;
}

// Resolve the enclosing region of a 1-indexed line within in-memory content.
// Returns { id, name, kind, startLine, endLine } or null (unsupported lang,
// no enclosing scope, spawn-gated python, or any parse failure).
//   opts.allowSpawn=false  → python3 path skipped (hot-path callers pass this)
function resolveRegionInContent(relPath, content, line, opts = {}) {
  try {
    if (typeof content !== "string" || !Number.isFinite(line) || line <= 0) return null;
    const ext = extOf(relPath);
    if (!isSupportedExt(ext)) return null;
    const map = findEnclosingScopeInContent(content, ext, [line], {
      mode: opts.mode || "function",
      allowSpawn: opts.allowSpawn !== false,
    });
    const scope = map && map.get(line);
    if (!scope || !scope.name) return null;
    return {
      id: regionId(relPath, scope.name),
      name: scope.name,
      kind: scope.kind || "scope",
      startLine: scope.startLine,
      endLine: scope.endLine,
    };
  } catch {
    return null;
  }
}

// Disk-reading variant (used when no in-memory content is available).
function resolveRegionOnDisk(absPath, relPath, line, opts = {}) {
  let content;
  try {
    content = fs.readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
  return resolveRegionInContent(relPath, content, line, opts);
}

// Is a 1-indexed line inside a region's [startLine, endLine] span?
function lineInRegion(region, line) {
  return !!(
    region &&
    Number.isFinite(region.startLine) &&
    Number.isFinite(region.endLine) &&
    Number.isFinite(line) &&
    line >= region.startLine &&
    line <= region.endLine
  );
}

// Derive representative 1-indexed line numbers for an edit, from whichever
// signal is present (preferring the exact structuredPatch coordinates):
//   1. tool_response.structuredPatch hunks → each hunk's newStart.
//   2. fallback: locate tool_input.old_string (or MultiEdit edits[].old_string)
//      inside `content` → the 1-indexed line of its first char.
// Returns a de-duplicated number[]; [] when nothing locatable.
function deriveEditedLines(toolInput, toolResponse, content) {
  const lines = new Set();
  try {
    const sp = toolResponse && toolResponse.structuredPatch;
    if (Array.isArray(sp)) {
      for (const hunk of sp) {
        if (hunk && Number.isFinite(hunk.newStart) && hunk.newStart > 0) {
          lines.add(hunk.newStart);
        }
      }
    }
    if (lines.size) return [...lines];

    // Fallback: string-locate the edited region(s) in the post-edit content.
    if (typeof content !== "string" || !content) return [];
    const olds = [];
    if (toolInput && typeof toolInput.old_string === "string") olds.push(toolInput.old_string);
    if (toolInput && Array.isArray(toolInput.edits)) {
      for (const e of toolInput.edits) {
        if (e && typeof e.old_string === "string") olds.push(e.old_string);
      }
    }
    for (const old of olds) {
      if (!old) continue;
      const idx = content.indexOf(old);
      if (idx >= 0) {
        // 1-indexed line = count of newlines before the match + 1.
        let ln = 1;
        for (let i = 0; i < idx; i++) if (content[i] === "\n") ln++;
        lines.add(ln);
      }
    }
  } catch {
    return [...lines];
  }
  return [...lines];
}

// Resolve the distinct enclosing regions touched by a set of edited lines,
// de-duplicated by region id. content = post-edit file text.
function editedRegions(relPath, content, editedLines, opts = {}) {
  const byId = new Map();
  for (const ln of editedLines || []) {
    const region = resolveRegionInContent(relPath, content, ln, opts);
    if (region && region.id && !byId.has(region.id)) byId.set(region.id, region);
  }
  return [...byId.values()];
}

// The scoring verdict for a single edit against ONE surfaced breadcrumb.
//   surfacedLine   = the line we pointed at (Swift decl start / matched zoekt
//                    line); may be null.
//   surfacedSymbol = the symbol we surfaced (matched export/decl term or
//                    enclosing type); may be null. Load-bearing: only ~4% of
//                    surfaced rows carry a line, but export/decl rows carry a
//                    symbol — name-matching lets those score too.
//   regions = editedRegions(...) for this edit.
// A verdict needs AT LEAST ONE breadcrumb (line or symbol) AND a resolved edited
// region; else null (unscoreable). hit=true iff the edit changed the region we
// pointed at — by line containment OR by region-name === surfacedSymbol.
// hit=false is the headroom signal ("right file, different region").
function scoreEditedRegion(surfacedLine, surfacedSymbol, regions) {
  const hasLine = Number.isFinite(surfacedLine) && surfacedLine > 0;
  const sym = typeof surfacedSymbol === "string" && surfacedSymbol ? surfacedSymbol : null;
  if (!hasLine && !sym) return null;
  if (!Array.isArray(regions) || regions.length === 0) return null;
  for (const r of regions) {
    if (hasLine && lineInRegion(r, surfacedLine)) return { hit: true, regionKind: r.kind };
    if (sym && r.name === sym) return { hit: true, regionKind: r.kind };
  }
  // Edited a resolved region, but not the one we surfaced.
  return { hit: false, regionKind: regions[0].kind };
}

module.exports = {
  extOf,
  isSupportedExt,
  regionId,
  resolveRegionInContent,
  resolveRegionOnDisk,
  lineInRegion,
  deriveEditedLines,
  editedRegions,
  scoreEditedRegion,
};
