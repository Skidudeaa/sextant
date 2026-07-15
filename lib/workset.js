"use strict";

// TASK CAPSULE — role-based workset compiler (docs/027 Phase B).
//
// Turns the flat, ranked retrieval hit list into a ROLE-BASED workset: instead
// of "here are N relevant files", it answers "which of these is the thing to
// change (primary), what you need to understand it (support), what proves it
// (witnesses), what's dangerous about it (hazards), and what sextant can't
// verify (unknowns)". Every role is derived from signals ALREADY on the merged
// hit (graphSignal / fanIn / rank / path) plus the Phase-A region resolver —
// no new extraction, no LLM. Facts only; degrades to empty roles, never throws.

const { isTestPath } = require("./retrieve");
const regionsLib = require("./regions");

// A file is PRIMARY when it carries a definitional signal — the graph says it
// DEFINES the queried symbol, not merely mentions it.
const PRIMARY_SIGNALS = new Set([
  "exported_symbol",
  "swift_decl_type",
  "swift_decl_other",
  "reexport_chain",
]);

// Non-test files ranked in the top-N are primary even without a def signal
// (they're the strongest matches this turn).
const PRIMARY_TOP = 3;
// Fan-in at/above which a surfaced file is flagged a hazard (high blast radius /
// public surface). Mirrors the orientation hotspot floor.
const HAZARD_FANIN = 15;
// Resolution below which the whole index is a hazard (stale/partial structure).
const HEALTH_MIN_RESOLUTION_PCT = 90;

// The Phase-A positional breadcrumb for a hit: the line we'd point at.
function surfacedLine(f) {
  if (typeof f.startLine === "number" && f.startLine > 0) return f.startLine;
  if (f.zoektHit && typeof f.zoektHit.lineNumber === "number" && f.zoektHit.lineNumber > 0) {
    return f.zoektHit.lineNumber;
  }
  return null;
}
// The surfacing signal — merged hits carry `graphSignal`; graph-only hits (the
// MCP focus path) carry `hitType`. Treat them as the same fact.
function signalOf(f) {
  return f.graphSignal || f.hitType || null;
}
function surfacedSymbol(f) {
  if (!PRIMARY_SIGNALS.has(signalOf(f))) return null;
  return (Array.isArray(f.matchedTerms) && f.matchedTerms[0]) || f.parentName || null;
}

// Resolve a primary file's enclosing region for surfacing (raises the 3.9%
// line-coverage Phase A found). Disk-read, in-process langs only; null on any
// failure (Swift/unsupported/parse error) — the row still surfaces, just without
// a region label.
function resolvePrimaryRegion(rootAbs, relPath, line) {
  if (!Number.isFinite(line)) return null;
  try {
    const path = require("path");
    return regionsLib.resolveRegionOnDisk(path.resolve(rootAbs, relPath), relPath, line, {
      allowSpawn: false,
    });
  } catch {
    return null;
  }
}

// Compile a role-based workset from ranked merged hits.
//   files: merged.files (ranked; each {path, graphSignal, matchedTerms, fanIn,
//          startLine, parentName, zoektHit, fusedScore})
//   opts:  { root, resolutionPct }
// Returns { primary[], support[], witnesses[], hazards[], unknowns[] } where a
// file entry = { path, source, line?, symbol?, region?, fanIn }.
function compileWorkset(files, opts = {}) {
  const root = opts.root;
  const out = { primary: [], support: [], witnesses: [], hazards: [], unknowns: [] };
  const list = Array.isArray(files) ? files : [];

  let nonTestRank = 0;
  let unsupportedCount = 0;
  const hazardFiles = [];

  for (const f of list) {
    if (!f || typeof f.path !== "string") continue;
    const signal = signalOf(f);
    const line = surfacedLine(f);
    const entry = {
      path: f.path,
      source: signal || "text_only",
      fanIn: typeof f.fanIn === "number" ? f.fanIn : 0,
    };
    if (line != null) entry.line = line;
    const sym = surfacedSymbol(f);
    if (sym) entry.symbol = sym;

    // Hazard annotation (independent of role): high fan-in = public/blast surface.
    if (entry.fanIn >= HAZARD_FANIN) hazardFiles.push({ path: f.path, fanIn: entry.fanIn });

    if (isTestPath(f.path)) {
      out.witnesses.push(entry);
      continue;
    }

    nonTestRank += 1;
    const isPrimary = PRIMARY_SIGNALS.has(signal) || nonTestRank <= PRIMARY_TOP;
    if (isPrimary) {
      const region = resolvePrimaryRegion(root, f.path, line);
      // Attach a region for DISPLAY only when it isn't misleading: for a def
      // (symbol) hit the surfaced line is often a USE site, so only show the
      // region when it IS that symbol's region; a non-symbol primary's match-
      // site region is legitimate. (Scoring still uses line+symbol regardless.)
      if (region && (!sym || region.name === sym)) {
        entry.region = { name: region.name, kind: region.kind, startLine: region.startLine, endLine: region.endLine };
      }
      // Honest "can't resolve to a region" count = primary files in a language
      // the resolver doesn't support (Swift, etc.).
      if (!regionsLib.isSupportedExt(regionsLib.extOf(f.path))) unsupportedCount += 1;
      out.primary.push(entry);
    } else {
      out.support.push(entry);
    }
  }

  // Hazard notes (annotations, facts-only). Dedup high-fan-in files, biggest first.
  const seenH = new Set();
  for (const h of hazardFiles.sort((a, b) => b.fanIn - a.fanIn)) {
    if (seenH.has(h.path)) continue;
    seenH.add(h.path);
    out.hazards.push(`${h.path} high fan-in (${h.fanIn})`);
  }
  if (typeof opts.resolutionPct === "number" && opts.resolutionPct < HEALTH_MIN_RESOLUTION_PCT) {
    out.hazards.push(`index import resolution ${opts.resolutionPct}% — structural claims degraded`);
  }

  // Unknowns (annotations): primary files sextant can't resolve to a region.
  if (unsupportedCount > 0) {
    out.unknowns.push(`${unsupportedCount} primary file(s) in a language sextant can't resolve to regions`);
  }

  return out;
}

module.exports = {
  compileWorkset,
  surfacedLine,
  surfacedSymbol,
  PRIMARY_SIGNALS,
  PRIMARY_TOP,
  HAZARD_FANIN,
};
