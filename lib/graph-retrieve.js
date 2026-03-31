"use strict";

const graph = require("./graph");
const C = require("./scoring-constants");

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
      addOrUpgrade(fileMap, exp.path, C.HIT_EXPORTED_SYMBOL, term, C.GR_EXPORTED_SYMBOL);
    }
  }

  // --- Layer 2: Re-export chain tracing ---
  // WHY: Barrel files re-export symbols from deeper modules.  If "useState"
  // is re-exported through index.js from hooks.js, we want to surface both
  // the barrel file and the files along the chain.
  for (const term of terms) {
    const chain = graph.findReexportChain(db, term);
    for (const entry of chain) {
      addOrUpgrade(fileMap, entry.path, C.HIT_REEXPORT_CHAIN, term, C.GR_REEXPORT_CHAIN);
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
      addOrUpgrade(fileMap, p, C.HIT_PATH_MATCH, term, C.GR_PATH_MATCH);
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

    // WHY: Fan-in boost as a fraction of base score, matching retrieve.js formula.
    // Previously used absolute points (log1p * 10, cap 50) which inflated hub files
    // by up to 50 points — a 100x mismatch with retrieve.js's relative % approach.
    const base = entry.score;
    const fanInFrac = Math.min(C.FAN_IN_CAP_FRACTION, Math.log1p(fanIn) * C.FAN_IN_MULTIPLIER);
    const fanInBonus = base * fanInFrac;
    const score = base + fanInBonus;

    ranked.push({
      path: filePath,
      hitType: entry.hitType,
      matchedTerms: Array.from(entry.matchedTerms),
      fanIn,
      fanOut,
      type,
      baseScore: base, // pre-fanIn score, used by suppression pass
      score: Math.round(score * 100) / 100,
    });
  }

  // --- Definition-site suppression ---
  // WHY: If any file is the true exporter of the queried symbol (hitType =
  // exported_symbol), halve the fan-in bonus for all other files so hub files
  // don't outrank the definition. Mirrors retrieve.js rerankAndCapHits
  // suppression but uses hit-type taxonomy instead of line content — no file
  // access needed, stays within the <50ms hook budget.
  const defFiles = new Set(
    ranked.filter((r) => r.hitType === C.HIT_EXPORTED_SYMBOL).map((r) => r.path)
  );
  if (defFiles.size > 0) {
    for (const r of ranked) {
      if (defFiles.has(r.path)) continue; // definition file — keep score
      const fanInFrac = Math.min(
        C.FAN_IN_CAP_FRACTION,
        Math.log1p(r.fanIn) * C.FAN_IN_MULTIPLIER
      );
      const fanInContrib = r.baseScore * fanInFrac;
      if (fanInContrib > 0) {
        r.score = Math.round(Math.max(0, r.score - fanInContrib * C.FAN_IN_SUPPRESSION) * 100) / 100;
      }
    }
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
