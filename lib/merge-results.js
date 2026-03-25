"use strict";

// ARCHITECTURE: Merges graph-based structural results with Zoekt text search hits.
// WHY: Graph results carry structural authority (exports, fan-in, re-export chains)
// while Zoekt hits carry textual precision (exact line matches). Files appearing
// in both are the strongest signal — they're structurally important AND textually
// relevant. The fusion bonus rewards this overlap.

// WHY: 1.4x boost for graph hits — structural authority is a stronger relevance
// signal than raw text match frequency. A file that *exports* the queried symbol
// is almost certainly more relevant than one that merely mentions it.
const GRAPH_BOOST = 1.4;

// WHY: 1.2x bonus for files appearing in both graph and Zoekt results. This is
// multiplicative with GRAPH_BOOST, so a graph+zoekt file gets 1.4 * 1.2 = 1.68x.
// The intuition: if both structural and textual analysis agree, confidence is high.
const FUSION_BONUS = 1.2;

const DEFAULT_MAX_FILES = 8;

/**
 * Merge graph retrieval results with Zoekt search hits.
 *
 * @param {{ files: Array<{path: string, hitType: string, matchedTerms: string[], fanIn: number, score: number}> }} graphResults
 * @param {Array<{path: string, lineNumber?: number, line?: string, score?: number}>} zoektHits
 * @param {{ maxFiles?: number }} [opts]
 * @returns {{ files: Array<{path: string, graphSignal: string|null, zoektHit: object|null, fanIn: number, fusedScore: number}> }}
 */
function mergeResults(graphResults, zoektHits, opts = {}) {
  const maxFiles = opts.maxFiles || DEFAULT_MAX_FILES;

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
  // highest-scoring line per file as the representative zoekt hit.
  const zoektArr = Array.isArray(zoektHits) ? zoektHits : [];
  for (const zh of zoektArr) {
    if (!zh.path) continue;
    const lineScore = zh.score || 1;
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

module.exports = { mergeResults };
