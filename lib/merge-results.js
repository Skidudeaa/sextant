"use strict";

// ARCHITECTURE: Merges graph-based structural results with Zoekt text search hits.
// WHY: Graph results carry structural authority (exports, fan-in, re-export chains)
// while Zoekt hits carry textual precision (exact line matches). Files appearing
// in both are the strongest signal — they're structurally important AND textually
// relevant. The fusion bonus rewards this overlap.

const scoring = require("./scoring");
const C       = require("./scoring-constants");

// WHY: 1.4x boost for graph hits — structural authority is a stronger relevance
// signal than raw text match frequency. A file that *exports* the queried symbol
// is almost certainly more relevant than one that merely mentions it.
const GRAPH_BOOST = 1.4;

// WHY: 1.2x bonus for files appearing in both graph and Zoekt results. This is
// multiplicative with GRAPH_BOOST, so a graph+zoekt file gets 1.4 * 1.2 = 1.68x.
// The intuition: if both structural and textual analysis agree, confidence is high.
const FUSION_BONUS = 1.2;

// WHY: Zoekt's default query syntax treats space-separated tokens as a
// document-level conjunction, then scores lines individually.  For a two-term
// query like "extractImports function", it happily returns lines that contain
// only "function" from files that contain "extractImports" somewhere else —
// which lets hub files (intel.js has "function" dozens of times) monopolize
// the top hits over the actual definition line.  Award a per-term bonus to
// lines that contain MORE of the query terms.  The def line "function
// extractImports(...)" matches both, beating intel.js lines that only match
// one.  Absolute bonus (not fraction) because zoekt per-line scores sit in a
// tight band (~500-502) that a 1% multiplicative bonus wouldn't move.
const MULTI_TERM_LINE_BONUS = 15;

const DEFAULT_MAX_FILES = 8;

function fileTypePenalty(filePath) {
  const p = String(filePath).toLowerCase();
  const original = String(filePath);
  if (p.includes("/vendor/") || p.includes("/node_modules/")) return C.VENDOR_PENALTY;
  if (
    p.endsWith(".md") || p.endsWith(".rst") || p.endsWith(".txt") ||
    p.includes("/docs/") || p.includes("/doc/")
  ) return C.DOC_PENALTY;
  if (
    // WHY tests? not test: Swift convention is `Tests/` (plural).  The
    // earlier `p.includes("/test/")` check only caught `/test/` and
    // silently missed `/Tests/` directories on every Swift codebase —
    // Vapor's `Tests/VaporTests/URITests.swift` got no test penalty
    // and outranked canonical lib files for common-name queries.
    /(^|\/)(__tests__|__test__|tests?|specs?)\//i.test(p) ||
    /\.(test|spec)\.[jt]s$/.test(p) ||
    // WHY: Swift uses XCT* and *Testing dir-name conventions for test
    // infrastructure that the JS-shaped patterns above miss.  Apply the
    // case-sensitive original here — XCTVapor / VaporTesting are
    // PascalCase by convention and the lowercased form is ambiguous
    // ("/testing/" alone could be a non-test directory like an i18n
    // testing-locale folder).  Trailing `\w+` requirement avoids matching
    // a literal "/Testing/" prose directory.
    /(^|\/)XCT[A-Za-z0-9_]+\//.test(original) ||
    /(^|\/)[A-Za-z0-9_]+Testing\//.test(original)
  ) return C.TEST_PENALTY;
  return 0;
}

// WHY: Lifts the per-line scoring that retrieve.js applies to rg hits into the
// hook path, so def-site lines outrank usage-site lines without an rg pass.
// Mirrors retrieve.js computeAdjustedHitScore: DEF_SITE_PRIORITY (+25%) stacks
// with EXACT_SYMBOL_BOOST (+40%) from computeEnhancedSignals on the defining
// line of the queried symbol, plus export_match / symbol_contains_query / noise
// penalty signals from scoring.js.  Returns the absolute bonus to ADD to the
// raw zoekt score.
function lineLevelAdjustment(line, filePath, queryTerms, baseScore) {
  if (!line || !Array.isArray(queryTerms) || queryTerms.length === 0) return 0;

  const enhanced = scoring.computeEnhancedSignals(
    { line, path: filePath || "", score: baseScore },
    queryTerms
  );
  let adjustment = enhanced.adjustment || 0;

  // WHY: DEF_SITE_PRIORITY (+25%) is the retrieve.js layer that stacks on top
  // of computeEnhancedSignals's exact-symbol +40% — combined +65% on the
  // defining line.  Without both, hub files with high zoekt term frequency
  // outrank the file that actually defines the symbol.
  //
  // WHY case-sensitive match (changed from case-insensitive): consumer
  // lines like Swift's `let uri = URI(scheme:...)` get extractSymbolDef
  // returning "uri" (the variable being declared).  Case-insensitive
  // matching against the queried term "URI" (the type) treated those
  // lines as definition sites and stacked +65% on URITests.swift hits,
  // letting the test file outrank the canonical URI.swift.  Case-
  // sensitive match (`uri !== URI`) correctly distinguishes a variable
  // declaration from a type definition.  The cost is users who type a
  // query in mismatched case ("rerankfiles" instead of "rerankFiles")
  // miss the def-site bonus — small in practice, since identifier shape
  // detection already nudges users toward correct casing.
  const defSym = scoring.extractSymbolDef(line);
  if (defSym) {
    if (queryTerms.some((t) => String(t) === defSym)) {
      adjustment += baseScore * C.DEF_SITE_PRIORITY;
    }
  }

  return adjustment;
}

/**
 * Merge graph retrieval results with Zoekt search hits.
 *
 * @param {{ files: Array<{path: string, hitType: string, matchedTerms: string[], fanIn: number, score: number}> }} graphResults
 * @param {Array<{path: string, lineNumber?: number, line?: string, score?: number}>} zoektHits
 * @param {{ maxFiles?: number, queryTerms?: string[] }} [opts]
 * @returns {{ files: Array<{path: string, graphSignal: string|null, zoektHit: object|null, fanIn: number, fusedScore: number}> }}
 */
function mergeResults(graphResults, zoektHits, opts = {}) {
  const maxFiles = opts.maxFiles || DEFAULT_MAX_FILES;
  // Lowercased query terms (caller's responsibility to pre-filter noise).
  // Used to award MULTI_TERM_LINE_BONUS per extra term matched on a line.
  const queryTerms = Array.isArray(opts.queryTerms)
    ? opts.queryTerms.filter((t) => typeof t === "string" && t.length > 0).map((t) => t.toLowerCase())
    : [];

  // NOTE: fileMap tracks the best entry per normalized file path.
  // Key = path, value = accumulated merge state
  const fileMap = new Map();

  // --- Ingest graph results ---
  const graphFiles = (graphResults && graphResults.files) || [];
  for (const gf of graphFiles) {
    if (!gf.path) continue;
    const existing = fileMap.get(gf.path);
    if (existing) {
      // Upgrade if this graph entry scores higher
      if (gf.score * GRAPH_BOOST > existing.graphScore) {
        existing.graphSignal = gf.hitType;
        existing.graphScore = gf.score * GRAPH_BOOST;
        existing.matchedTerms = gf.matchedTerms || [];
      }
      existing.fanIn = Math.max(existing.fanIn, gf.fanIn || 0);
    } else {
      fileMap.set(gf.path, {
        path: gf.path,
        graphSignal: gf.hitType,
        graphScore: gf.score * GRAPH_BOOST,
        matchedTerms: gf.matchedTerms || [],
        fanIn: gf.fanIn || 0,
        zoektHit: null,
        zoektScore: 0,
        inBoth: false,
      });
    }
  }

  // --- Ingest Zoekt hits ---
  // WHY: Zoekt returns per-line hits; we want per-file entries. Keep the
  // highest-scoring line per file as the representative zoekt hit.  When
  // multiple query terms are present, award a per-term bonus for lines that
  // cover more of them — the def line "function extractImports(...)" beats
  // a plain "function\b" occurrence elsewhere in the file.  Per-line
  // lineLevelAdjustment also fires here so the def-site line for the queried
  // symbol gets the +65% boost it earns in the CLI path — without this, the
  // hook path can't distinguish "function foo() {" from "foo()" call sites.
  const zoektArr = Array.isArray(zoektHits) ? zoektHits : [];
  for (const zh of zoektArr) {
    if (!zh.path) continue;
    const rawScore = zh.score || 1;
    const lineAdj = lineLevelAdjustment(zh.line, zh.path, queryTerms, rawScore);
    const lineScore = rawScore + lineAdj + termCoverageBonus(zh.line, queryTerms);
    const existing = fileMap.get(zh.path);
    if (existing) {
      existing.inBoth = existing.graphSignal !== null;
      if (lineScore > existing.zoektScore) {
        existing.zoektHit = {
          lineNumber: zh.lineNumber || null,
          line: zh.line || null,
        };
        existing.zoektScore = lineScore;
      }
    } else {
      fileMap.set(zh.path, {
        path: zh.path,
        graphSignal: null,
        graphScore: 0,
        matchedTerms: [],
        fanIn: 0,
        zoektHit: {
          lineNumber: zh.lineNumber || null,
          line: zh.line || null,
        },
        zoektScore: lineScore,
        inBoth: false,
      });
    }
  }

  if (fileMap.size === 0) {
    return { files: [] };
  }

  // --- Fuse scores ---
  const ranked = [];
  for (const entry of fileMap.values()) {
    let fusedScore = entry.graphScore + entry.zoektScore;
    if (entry.inBoth) {
      fusedScore *= FUSION_BONUS;
    }
    const penalty = fileTypePenalty(entry.path);
    if (penalty > 0) fusedScore *= (1 - penalty);
    ranked.push({
      path: entry.path,
      graphSignal: entry.graphSignal,
      matchedTerms: entry.matchedTerms,
      zoektHit: entry.zoektHit,
      fanIn: entry.fanIn,
      fusedScore: Math.round(fusedScore * 100) / 100,
    });
  }

  // Sort: fused score desc, then fan-in desc, then path alphabetical
  ranked.sort((a, b) => {
    if (b.fusedScore !== a.fusedScore) return b.fusedScore - a.fusedScore;
    if (b.fanIn !== a.fanIn) return b.fanIn - a.fanIn;
    return a.path.localeCompare(b.path);
  });

  return { files: ranked.slice(0, maxFiles) };
}

// Count how many distinct query terms appear as substrings of the given
// line, then award MULTI_TERM_LINE_BONUS per extra term beyond the first.
// A line with 1 term or no terms gets zero bonus; a line with 3 terms gets 2x.
// Terms and line are lower-cased here so callers can pass either — the
// mergeResults ingest path already lower-cases, but direct callers and
// test harnesses shouldn't have to remember.
function termCoverageBonus(line, queryTerms) {
  if (!line || !Array.isArray(queryTerms) || queryTerms.length < 2) return 0;
  const lower = String(line).toLowerCase();
  let matched = 0;
  for (const t of queryTerms) {
    if (!t) continue;
    if (lower.includes(String(t).toLowerCase())) matched++;
  }
  if (matched <= 1) return 0;
  return (matched - 1) * MULTI_TERM_LINE_BONUS;
}

module.exports = { mergeResults, termCoverageBonus, MULTI_TERM_LINE_BONUS };
