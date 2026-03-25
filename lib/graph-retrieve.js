"use strict";

const graph = require("./graph");

// WHY: Minimum term length of 3 filters out noise words and single-char
// identifiers that would match too broadly in symbol and path searches.
const MIN_TERM_LENGTH = 3;

// WHY: If a path-match term hits more than 10 files, it's too generic to
// be useful (e.g., "js" would match every .js file).  Skip it to avoid
// polluting results with low-signal matches.
const MAX_PATH_MATCHES = 10;

/**
 * Graph-only fast retrieval.  Queries the dependency graph for files
 * relevant to the given terms.  No subprocesses, no rg, no Zoekt --
 * purely in-memory SQLite queries against graph.db.
 *
 * Three query layers executed sequentially:
 *   1. Export-graph symbol lookup (highest signal)
 *   2. Re-export chain tracing (barrel-file resolution)
 *   3. Filename path matching (catches non-symbol concepts)
 *
 * @param {object} db - sql.js Database instance (from graph.loadDb)
 * @param {string[]} queryTerms - extracted search terms
 * @param {object} [opts]
 * @param {number} [opts.maxResults=10] - cap on returned files
 * @returns {{ files: Array, warnings: string[], durationMs: number }}
 */
function graphRetrieve(db, queryTerms, opts = {}) {
  const start = Date.now();
  const maxResults = opts.maxResults || 10;
  const warnings = [];

  // NOTE: fileMap tracks the best entry per path for deduplication.
  // Key = file path, value = { path, hitType, matchedTerms, score }
  const fileMap = new Map();

  const terms = (queryTerms || []).filter((t) => t.length >= MIN_TERM_LENGTH);

  if (!terms.length) {
    warnings.push("all query terms too short (< 3 chars)");
    return { files: [], warnings, durationMs: Date.now() - start };
  }

  // --- Layer 1: Export-graph symbol lookup ---
  // WHY: Files that export a matching symbol are the strongest signal.
  // If you search for "resolveImport", the file that exports that function
  // is almost certainly what you want.
  for (const term of terms) {
    const exports = graph.findExportsBySymbol(db, term);
    for (const exp of exports) {
      addOrUpgrade(fileMap, exp.path, "exported_symbol", term, 100);
    }
  }

  // --- Layer 2: Re-export chain tracing ---
  // WHY: Barrel files re-export symbols from deeper modules.  If "useState"
  // is re-exported through index.js from hooks.js, we want to surface both
  // the barrel file and the files along the chain.
  for (const term of terms) {
    const chain = graph.findReexportChain(db, term);
    for (const entry of chain) {
      addOrUpgrade(fileMap, entry.path, "reexport_chain", term, 80);
    }
  }

  // --- Layer 3: Filename path matching ---
  // WHY: Some concepts live in filenames, not export names.  "watcher"
  // won't match any export but should find watch.js.
  for (const term of terms) {
    const paths = graph.filePathsMatching(db, term);
    // NOTE: Skip terms that are too generic -- they would flood results
    // with low-signal matches.
    if (paths.length > MAX_PATH_MATCHES) continue;
    for (const p of paths) {
      addOrUpgrade(fileMap, p, "path_match", term, 60);
    }
  }

  if (fileMap.size === 0) {
    warnings.push("no matches found in exports, re-export chains, or file paths");
    return { files: [], warnings, durationMs: Date.now() - start };
  }

  // --- Ranking pass ---
  const allPaths = Array.from(fileMap.keys());
  const fanInMap = graph.fanInByPaths(db, allPaths);
  const fanOutMap = graph.fanOutByPaths(db, allPaths);
  const metaMap = graph.fileMetaByPaths(db, allPaths);

  const ranked = [];
  for (const [filePath, entry] of fileMap) {
    const fanIn = fanInMap.get(filePath) || 0;
    const fanOut = fanOutMap.get(filePath) || 0;
    const meta = metaMap.get(filePath);
    const type = meta ? meta.type : "unknown";

    // WHY: log1p(fanIn) * 10 gives a gentle boost for well-connected files
    // without letting hub files dominate.  Capped at 50 to keep hit-type
    // as the primary ranking signal.
    const fanInBonus = Math.min(50, Math.log1p(fanIn) * 10);
    const score = entry.score + fanInBonus;

    ranked.push({
      path: filePath,
      hitType: entry.hitType,
      matchedTerms: Array.from(entry.matchedTerms),
      fanIn,
      fanOut,
      type,
      score: Math.round(score * 100) / 100,
    });
  }

  // Sort: score desc, then fan-in desc, then path alphabetical
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.fanIn !== a.fanIn) return b.fanIn - a.fanIn;
    return a.path.localeCompare(b.path);
  });

  return {
    files: ranked.slice(0, maxResults),
    warnings,
    durationMs: Date.now() - start,
  };
}

/**
 * Add a file to the result map, or upgrade it if the new hit type scores higher.
 * Accumulates matched terms across layers so deduplication preserves all signals.
 */
function addOrUpgrade(fileMap, filePath, hitType, term, score) {
  const existing = fileMap.get(filePath);
  if (!existing) {
    fileMap.set(filePath, {
      hitType,
      score,
      matchedTerms: new Set([term]),
    });
  } else {
    existing.matchedTerms.add(term);
    // WHY: Keep the highest-scoring hit type.  If a file appears as both
    // an exported_symbol (100) and a path_match (60), the export signal
    // is more authoritative.
    if (score > existing.score) {
      existing.hitType = hitType;
      existing.score = score;
    }
  }
}

module.exports = { graphRetrieve };
