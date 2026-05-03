const intel = require("./intel");
const rg = require("./rg");
const zoekt = require("./zoekt");
const graph = require("./graph");
const scoring = require("./scoring");
const C = require("./scoring-constants");
const { isEntryPoint } = require("./utils");

// NOTE: This is the most capable module in sextant — three-layer ranked search
// (rg text, export-graph lookup, re-export chain tracing) with health-gated
// scoring. MRR 0.954, nDCG 0.925 across 19 eval queries. Called from:
//   1. CLI command (commands/retrieve.js)
//   2. Eval harness (scripts/eval-retrieve.js)
//   3. MCP server (mcp/server.js) — sextant_search tool wraps retrieve()
// The UserPromptSubmit hook uses the lighter graph-retrieve.js + zoekt.searchFast()
// fast path instead — retrieve() is too heavy for the 200ms hook budget.

// WHY: rg returns paths with "./" prefix ("./lib/retrieve.js") but the graph DB
// stores bare relative paths ("lib/retrieve.js"). Normalizing before graph queries
// prevents silent fan-in=0 from path mismatch — without this, graph boosts never fire.
function normalizeHitPath(p) {
  return String(p).replace(/^\.\//, "");
}


// WHY XCT* / *Testing: Swift codebases follow two strong test-infrastructure
// naming conventions that the JS-shaped regex below misses entirely.
//   - `XCT<Word>` — Apple's XCTest framework family (XCTVapor,
//     XCTAssertions, etc.).  The trailing `\w` requirement ensures
//     "xctest-helpers/" doesn't false-fire on prose.
//   - `<Word>Testing` — the Swift Testing framework convention
//     (VaporTesting, ApplicationTesting).  Requires a leading word so a
//     directory literally called "Testing/" doesn't pull in legitimate
//     library code that happens to be named that.
// Without these patterns Vapor's `Sources/XCTVapor/` and
// `Sources/VaporTesting/` rank above the canonical Vapor library files
// for queries like `extension Application` (vapor-ext-001).
function isTestPath(p) {
  if (!p) return false;
  return /(^|\/)(__tests__|__test__|tests?|specs?)\//i.test(p) ||
    /(^|\/)XCT[A-Za-z0-9_]+\//.test(p) ||
    /(^|\/)[A-Za-z0-9_]+Testing\//.test(p) ||
    /\.(test|spec)\./i.test(p);
}

// Source-vs-test path authority for the export-graph / swift-decl
// injection paths.  Centralized so both blocks share identical semantics
// — earlier code had two near-identical inline regexes that drifted.
function exportPathAuthority(p) {
  if (isTestPath(p)) return 0;
  if (/(^|\/)(fixtures?|examples?|demos?|e2e|mocks?)\//i.test(p)) return 0;
  if (isDocPath(p) || /(^|\/)docs?\//i.test(p)) return 1;
  return 2; // source
}

// Authoritative Swift kinds get the highest path-injection priority,
// extensions are secondary, members are tertiary.  Mirror of the kind
// taxonomy in lib/scoring-constants.js (HIT_SWIFT_DECL_TYPE vs
// HIT_SWIFT_DECL_OTHER) but used here to bias path selection rather
// than scoring.
const SWIFT_AUTHORITATIVE_KINDS = new Set([
  "struct", "class", "protocol", "enum", "actor", "typealias",
]);
function swiftKindAuthority(kind) {
  if (SWIFT_AUTHORITATIVE_KINDS.has(kind)) return 2;
  if (kind === "extension") return 1;
  return 0;
}

function isVendorPath(p) {
  if (!p) return false;
  return /(^|\/)(node_modules|dist|build|coverage|\.next|out|vendor)\//i.test(p);
}

// WHY: Documentation files (changelogs, READMEs, .md) match many query terms
// but rarely contain the code a developer is looking for.  Without a penalty,
// CHANGELOG.md and History.md consistently outrank source files for common
// terms — this was the #1 cross-project finding in Express/Flask/React testing.
function isDocPath(p) {
  if (!p) return false;
  return /\.(md|rst|txt|adoc)$/i.test(p) ||
    /^(CHANGELOG|CHANGES|History|NEWS|RELEASE|UPGRADING|MIGRATION)/i.test(
      p.split("/").pop() || ""
    );
}

function looksLikeExportLine(line) {
  return typeof line === "string" && /^\s*export\b/.test(line);
}

function looksLikeDefinitionLine(line) {
  if (typeof line !== "string") return false;
  return (
    /^\s*(export\s+)?(default\s+)?(async\s+)?function\b/.test(line) ||
    /^\s*(export\s+)?(default\s+)?class\b/.test(line) ||
    /^\s*export\s+(const|let|var|type|interface)\b/.test(line) ||
    // Python: def, async def, class
    /^\s*(async\s+)?def\s+\w+/.test(line) ||
    /^\s*class\s+\w+/.test(line)
  );
}

function safeNum(n, fallback = 0) {
  return Number.isFinite(n) ? n : fallback;
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function groupHitsByFile(hits) {
  const m = new Map();
  for (const h of hits) {
    if (!h.path) continue;
    if (!m.has(h.path)) m.set(h.path, []);
    m.get(h.path).push(h);
  }
  return m;
}

function addScopeContextToHits(root, hits, { contextMode, maxScopeLines }) {
  const { addScopeContext } = require("./scope-finder");
  addScopeContext(root, hits, { contextMode, maxScopeLines });
}

function pickBackend(backendOpt, root, { zoektBuild = false } = {}) {
  if (backendOpt === "zoekt") return "zoekt";
  if (backendOpt === "rg") return "rg";

  if (zoekt.isInstalled()) {
    if (zoekt.hasIndex(root) || zoektBuild) return "zoekt";
  }
  return "rg";
}

// WHY: bestAdjustedHitScore is the primary sort key because it already
// incorporates fan-in, definition-site priority, exact-symbol match, and
// all other scoring signals.  Using raw fan-in as the primary key (the old
// behavior) caused hub files like intel.js to outrank definition files even
// when the hit-level scoring correctly identified the definition site.
// Fan-in is kept as a tiebreaker for files with equal adjusted scores.
// WHY: HIT_COUNT_WEIGHT adds a log-scaled per-file occurrence contribution on
// top of bestAdjustedHitScore.  Without it, "variable-name" queries where every
// raw hit score is identical (e.g. "resolutionPct") rank purely by graph boost,
// which inflates hub files with a single mention over files that contain the
// identifier many times.  Same magnitude as FAN_IN_CAP_FRACTION so it can
// balance (but not dominate) graph boost when no hit carries a def-site signal.
const HIT_COUNT_WEIGHT = 0.075;

function hitCountContribution(file) {
  const base = safeNum(file.bestHitScore, 1);
  const count = safeNum(file.hitCount, 0);
  return base * Math.log1p(count) * HIT_COUNT_WEIGHT;
}

function rerankFiles(files, { useGraphBoost = true } = {}) {
  return files.sort((a, b) => {
    // Primary: bestAdjustedHitScore + hitCount contribution.  The hit-count
    // contribution balances graph boost for queries where the raw hit score is
    // uniform across files (no def-site priority fires).  See HIT_COUNT_WEIGHT.
    const sa = safeNum(a.bestAdjustedHitScore, safeNum(a.bestHitScore, -Infinity)) + hitCountContribution(a);
    const sb = safeNum(b.bestAdjustedHitScore, safeNum(b.bestHitScore, -Infinity)) + hitCountContribution(b);
    if (sa !== sb) return sb - sa;

    // Tiebreaker: fan-in (structural importance)
    if (useGraphBoost) {
      const fa = safeNum(a.fanIn, 0);
      const fb = safeNum(b.fanIn, 0);
      if (fa !== fb) return fb - fa;
    }

    // Final tiebreaker: raw hit count
    const ha = safeNum(a.hitCount, 0);
    const hb = safeNum(b.hitCount, 0);
    return hb - ha;
  });
}

function computeAdjustedHitScore(hit, fileMeta, opts) {
  const explain = !!opts.explainHits;
  const useGraphBoost = opts.useGraphBoost !== false;
  const queryTerms = opts.queryTerms || [];

  const base = Number.isFinite(hit.score) ? hit.score : 1;
  let adjusted = base;
  const signals = [];

  if (fileMeta) {
    if (fileMeta.isEntryPoint) {
      adjusted += base * C.ENTRY_POINT_BOOST;
      if (explain) signals.push(`entrypoint:+${Math.round(C.ENTRY_POINT_BOOST * 100)}%`);
    }

    if (useGraphBoost) {
      if (fileMeta.isHotspot) {
        adjusted += base * C.HOTSPOT_BOOST;
        if (explain) signals.push(`hotspot:+${Math.round(C.HOTSPOT_BOOST * 100)}%`);
      }

      const fanIn = safeNum(fileMeta.fanIn, 0);
      if (fanIn > 0) {
        const frac = Math.min(C.FAN_IN_CAP_FRACTION, Math.log1p(fanIn) * C.FAN_IN_MULTIPLIER);
        adjusted += base * frac;
        if (explain) signals.push(`fanin:${fanIn}:+${Math.round(frac * 100)}%`);
      }
    }

    if (isTestPath(fileMeta.path)) {
      adjusted -= base * C.TEST_PENALTY;
      if (explain) signals.push(`test:-${Math.round(C.TEST_PENALTY * 100)}%`);
    }

    if (isVendorPath(fileMeta.path)) {
      adjusted -= base * C.VENDOR_PENALTY;
      if (explain) signals.push(`vendor:-${Math.round(C.VENDOR_PENALTY * 100)}%`);
    }

    if (isDocPath(fileMeta.path)) {
      adjusted -= base * C.DOC_PENALTY;
      if (explain) signals.push(`doc:-${Math.round(C.DOC_PENALTY * 100)}%`);
    }
  }

  if (looksLikeExportLine(hit.line)) {
    adjusted += base * C.EXPORT_LINE_BOOST;
    if (explain) signals.push(`exportline:+${Math.round(C.EXPORT_LINE_BOOST * 100)}%`);
  }
  if (looksLikeDefinitionLine(hit.line)) {
    adjusted += base * C.DEF_LINE_BOOST;
    if (explain) signals.push(`defline:+${Math.round(C.DEF_LINE_BOOST * 100)}%`);
  }

  // WHY: Strong definition-site priority (+25%) when a hit is a function/class
  // definition AND the query matches the symbol name.  This is separate from the
  // generic defline:+3% above and from the exact_symbol signal in scoring.js.
  // Together they ensure the file where a symbol is *defined* outranks hub files
  // that merely *import* it (the #1 eval finding: intel.js beating resolver.js).
  if (queryTerms.length > 0) {
    const defSym = scoring.extractSymbolDef(hit.line);
    if (defSym) {
      const defLower = defSym.toLowerCase();
      const matchesQuery = queryTerms.some((t) => t.toLowerCase() === defLower);
      if (matchesQuery) {
        adjusted += base * C.DEF_SITE_PRIORITY;
        if (explain) signals.push(`def_site_priority:+${Math.round(C.DEF_SITE_PRIORITY * 100)}%`);
        // Tag the hit so the fan-in suppression pass (below) can identify
        // files that contain a true definition match.
        hit._hasDefSiteMatch = true;
      }
    }
  }

  // Apply enhanced scoring signals (symbol-aware, noise penalty, etc.)
  if (queryTerms.length > 0) {
    const enhanced = scoring.computeEnhancedSignals(hit, queryTerms, { explainHits: explain });
    adjusted += enhanced.adjustment || 0;
    if (explain && enhanced.signals) {
      signals.push(...enhanced.signals);
    }
  }

  if (!Number.isFinite(hit.score)) {
    if (fileMeta?.isEntryPoint) adjusted += C.ENTRY_POINT_BOOST * 2;
    if (useGraphBoost && fileMeta?.isHotspot) adjusted += C.HOTSPOT_BOOST + 0.1;
    if (useGraphBoost)
      adjusted += Math.min(0.25, Math.log1p(safeNum(fileMeta?.fanIn, 0)) * 0.05);
  }

  adjusted = Math.max(0, adjusted);
  return explain ? { adjustedScore: adjusted, signals } : { adjustedScore: adjusted };
}

function rerankAndCapHits(hits, fileByPath, opts) {
  const maxHits = safeNum(opts.maxHits, hits.length);
  const cap = Number.isFinite(opts.hitsPerFileCap) ? opts.hitsPerFileCap : 5;

  const scored = hits.map((h) => {
    const fm = fileByPath.get(h.path);
    const extra = computeAdjustedHitScore(h, fm, opts);
    return {
      ...h,
      baseScore: Number.isFinite(h.score) ? h.score : null,
      ...extra,
    };
  });

  // WHY — Fan-in suppression when a definition match exists:
  // If ANY hit in the result set landed on the actual definition site of the
  // queried symbol (tagged _hasDefSiteMatch by computeAdjustedHitScore), then
  // hub files that merely *import* the symbol should not outrank the definition
  // file just because they have high fan-in.  We collect the set of files that
  // contain a definition match.  For hits in files WITHOUT such a match, we
  // re-compute the adjusted score with the fan-in/hotspot component halved.
  // This is the most impactful of the three fixes: it directly prevents
  // intel.js (fan-in=5) from outranking resolver.js / summary.js / scoring.js.
  if (opts.useGraphBoost !== false) {
    const filesWithDefMatch = new Set();
    for (const h of scored) {
      if (h._hasDefSiteMatch) filesWithDefMatch.add(h.path);
    }

    if (filesWithDefMatch.size > 0) {
      for (const h of scored) {
        if (filesWithDefMatch.has(h.path)) continue; // definition file — keep score
        const fm = fileByPath.get(h.path);
        if (!fm) continue;
        const fanIn = safeNum(fm.fanIn, 0);
        const isHotspot = !!fm.isHotspot;
        if (fanIn <= 0 && !isHotspot) continue; // no graph boost to suppress

        // Calculate the graph-boost portion that was added, then halve it.
        const base = Number.isFinite(h.baseScore) ? h.baseScore : 1;
        let graphPortion = 0;
        if (isHotspot) graphPortion += base * C.HOTSPOT_BOOST;
        if (fanIn > 0) graphPortion += base * Math.min(C.FAN_IN_CAP_FRACTION, Math.log1p(fanIn) * C.FAN_IN_MULTIPLIER);
        // Also account for the non-finite-score graph fallback path
        if (!Number.isFinite(h.baseScore)) {
          if (isHotspot) graphPortion += 0.25;
          graphPortion += Math.min(0.25, Math.log1p(fanIn) * 0.05);
        }

        // Halve the graph contribution — enough to let definition-site
        // signals win, but not so aggressive that hub files disappear entirely.
        const reduction = graphPortion * C.FAN_IN_SUPPRESSION;
        h.adjustedScore = Math.max(0, safeNum(h.adjustedScore) - reduction);
        if (opts.explainHits && Array.isArray(h.signals)) {
          h.signals.push(`fanin_suppressed:-${Math.round((reduction / Math.max(base, 0.001)) * 100)}%`);
        }
      }
    } else {
      // WHY — Hotspot gate when NO definition match exists:
      // When the query has no clear definition site anywhere in the result set
      // (e.g. a variable name like "resolutionPct", a common word, a config
      // key), the +15% hotspot boost inflates hub files purely for being
      // architecturally central. This is the opposite of what the user wants:
      // they want files that actually mention the identifier, not the
      // dependency hub. Strip the hotspot portion in this case — fan-in (a
      // gradual log-scaled signal) and the hit-count contribution added in
      // rerankFiles() still differentiate hubs, but without the flat +15%
      // step function that pushes hubs past more-relevant files.
      for (const h of scored) {
        const fm = fileByPath.get(h.path);
        if (!fm?.isHotspot) continue;
        const base = Number.isFinite(h.baseScore) ? h.baseScore : 1;
        const hotspotPortion = base * C.HOTSPOT_BOOST;
        h.adjustedScore = Math.max(0, safeNum(h.adjustedScore) - hotspotPortion);
        if (opts.explainHits && Array.isArray(h.signals)) {
          h.signals.push(`hotspot_gated:-${Math.round(C.HOTSPOT_BOOST * 100)}%`);
        }
      }
    }
  }

  scored.sort((a, b) => safeNum(b.adjustedScore) - safeNum(a.adjustedScore));

  if (cap <= 0) return scored.slice(0, maxHits);

  const perFile = new Map();
  const out = [];

  for (const h of scored) {
    const k = h.path || "";
    const c = perFile.get(k) || 0;
    if (c >= cap) continue;
    perFile.set(k, c + 1);
    out.push(h);
    if (out.length >= maxHits) break;
  }

  return out;
}

// Hit-score floor for graph-injected hits where the graph evidence is
// authoritative ("this file is the canonical definition of the matched
// symbol").  rg.searchInFiles returns hits with score=null, which
// computeAdjustedHitScore treats as base=1 — hopelessly outclassed by
// zoekt-sourced hits whose intrinsic score is in the ~500 band.  Without
// a floor, the injected canonical file enters the result set but ranks
// 30th out of 31.  600 puts the def-line stack (base * 1.65 from
// def_site + exact_symbol) at ~990 — competitive with zoekt-scored
// extension/use-site files at ~960 but not overwhelming.
const SWIFT_DECL_TYPE_INJECT_SCORE = 600;

// WHY: Shared injection helper for the export-graph and swift-decl
// blocks.  Takes a per-term lookup function (returns
// `[{path, term, ...kindMeta}]`), a path-scoring function for sorting,
// and the rg flag to mark hits with.  Re-searches each injected file
// using the SYMBOL THAT MATCHED IT (`m.term`), not the full original
// query — this is the multi-token-injection bugfix.  For "extension
// Application", the term `Application` triggers the swift-decl match on
// `Application.swift`, and rg now searches that file for `Application`
// (which finds `class Application`), instead of `extension Application`
// (which finds nothing in the canonical file).
//
// Path selection: each candidate path keeps the SCORE of its
// best-scoring matching row (max across terms/kinds), so a file matched
// as a `class` via term X beats the same file matched as an `extension`
// via term Y.  Ties broken by alphabetical path for deterministic
// output.
//
// Failure mode: rg.searchInFiles errors are absorbed into `warnings`
// per existing convention — never throws to the caller.
async function injectGraphMatches(root, q, db, queryTerms, fileResults, hits, warnings, opts) {
  const { label, lookup, pathScore, injectedFlag, mode, hitScore } = opts;
  const existingPaths = new Set(fileResults.map((f) => f.path));

  // Per-path best match (highest score, with the term + score remembered
  // so we know which term to re-search with, and the kind so the caller
  // can decide whether to assign a score floor below).
  const bestByPath = new Map();
  for (const term of queryTerms) {
    if (term.length < 3) continue;
    const matches = lookup(term);
    for (const m of matches) {
      if (existingPaths.has(m.path)) continue;
      const s = pathScore(m);
      const prev = bestByPath.get(m.path);
      if (!prev || s > prev.score) {
        bestByPath.set(m.path, { score: s, term: m.term, kind: m.kind });
      }
    }
  }

  if (bestByPath.size === 0) return;

  // Sort by score desc, path alpha asc; cap at 10 paths to inject.
  const ranked = [...bestByPath.entries()]
    .sort((a, b) => {
      if (b[1].score !== a[1].score) return b[1].score - a[1].score;
      return a[0].localeCompare(b[0]);
    })
    .slice(0, 10);

  // Group injected paths by the term we'll re-search them with so a
  // single rg invocation per term covers all paths matched by that term.
  // Reduces the number of rg subprocess calls from N (per-path) to T
  // (per unique term, T <= number of distinct identifiers in the query).
  const pathsByTerm = new Map();
  for (const [p, info] of ranked) {
    const arr = pathsByTerm.get(info.term) || [];
    arr.push({ path: p, kind: info.kind });
    pathsByTerm.set(info.term, arr);
  }

  for (const [term, pathInfos] of pathsByTerm) {
    const pathsToInject = pathInfos.map((pi) => pi.path);
    const kindByPath = new Map(pathInfos.map((pi) => [pi.path, pi.kind]));
    try {
      const injectedHits = await rg.searchInFiles(root, term, pathsToInject, {
        maxHits: pathsToInject.length * 5,
        mode: mode || "literal",
      });

      for (const h of injectedHits) {
        if (h.path) h.path = normalizeHitPath(h.path);
        h[injectedFlag] = true;
        // WHY: hitScore is an opt-in callback the caller provides to
        // override the score=null that rg.searchInFiles produces.  When
        // the matched row carries authoritative graph evidence (Swift
        // type def kind), the caller returns a floor so the def line's
        // boosts stack on a competitive base instead of stacking on
        // base=1 and getting buried by zoekt-sourced hits at base=500.
        if (typeof hitScore === "function") {
          const kind = kindByPath.get(h.path);
          const s = hitScore({ kind });
          if (Number.isFinite(s)) h.score = s;
        }
        hits.push(h);
      }

      const injectedByFile = groupHitsByFile(injectedHits);
      const injectedPaths = [...injectedByFile.keys()];
      const injMeta = graph.fileMetaByPaths(db, injectedPaths);
      const injFanIn = graph.fanInByPaths(db, injectedPaths);
      const injFanOut = graph.fanOutByPaths(db, injectedPaths);

      for (const p of injectedPaths) {
        const hs = injectedByFile.get(p) || [];
        const best = hs.reduce((m, x) => (x.score != null && x.score > m ? x.score : m), -Infinity);
        const m = injMeta.get(p);
        fileResults.push({
          path: p, id: p,
          type: m?.type || "unknown",
          hitCount: hs.length,
          bestHitScore: Number.isFinite(best) ? best : null,
          bestAdjustedHitScore: null,
          fanIn: injFanIn.get(p) || 0,
          fanOut: injFanOut.get(p) || 0,
          isEntryPoint: isEntryPoint(p),
          isHotspot: false,
        });
      }
    } catch (e) {
      warnings.push(`${label} injection failed: ${e?.message || String(e)}`);
    }
  }
}

async function retrieve(root, q, opts = {}) {
  const backendOpt = opts.backend ?? "auto";
  const contextLines = opts.contextLines ?? 1;
  const contextMode = opts.contextMode ?? "lines"; // "lines" | "function" | "class"
  const maxScopeLines = opts.maxScopeLines ?? 200;
  const maxHits = opts.maxHits ?? 50;
  const maxSeedFiles = opts.maxSeedFiles ?? 10;
  const expand =
    Array.isArray(opts.expand) && opts.expand.length
      ? opts.expand
      : ["imports", "dependents"];
  const maxRelated = opts.maxRelated ?? 30;

  const hitsPerFileCap = Number.isFinite(opts.hitsPerFileCap) ? opts.hitsPerFileCap : 5;
  const explainHits = !!opts.explainHits;

  const zoektBuild = !!opts.zoektBuild;
  const zoektPort = opts.zoektPort ?? 6070;

  const warnings = [];

  // Extract query terms for scoring (split on whitespace, clean up)
  const queryTerms = q
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/[^a-zA-Z0-9_-]/g, ""));

  const h = await intel.health(root);
  const rerankMinResolutionPct = opts.rerankMinResolutionPct ?? 90;
  const resolutionPct = h?.resolutionPct ?? h?.metrics?.resolutionPct ?? 100;

  const backend = pickBackend(backendOpt, root, { zoektBuild });
  let searchRes;

  if (backend === "zoekt") {
    try {
      searchRes = await zoekt.search(root, q, {
        maxHits,
        contextLines,
        contextMode,
        maxScopeLines,
        autoIndex: zoektBuild,
        port: zoektPort,
      });
    } catch (e) {
      warnings.push(`zoekt failed; falling back to rg: ${e.message}`);
      const rawLimit = Math.max(maxHits, maxHits * 5);
      searchRes = await rg.search(root, q, {
        maxHits: rawLimit,
        contextLines,
        contextMode,
        maxScopeLines,
        mode: opts.rgMode || "literal",
      });
    }
  } else {
    // WHY: Collect more raw hits than the final maxHits so the scorer sees a
    // diverse candidate set.  Without this, common terms ("useState", "Flask")
    // saturate the raw limit with docs/test files and the actual definition
    // sites never reach the scoring layer.  The 5x multiplier is a balance
    // between coverage and latency — rerankAndCapHits trims to maxHits after.
    const rawLimit = Math.max(maxHits, maxHits * 5);
    searchRes = await rg.search(root, q, {
      maxHits: rawLimit,
      contextLines,
      contextMode,
      maxScopeLines,
      mode: opts.rgMode || "literal",
    });
  }

  const hits = searchRes.hits || [];
  // Normalize hit paths so graph lookups match the stored relative paths
  for (const h of hits) {
    if (h.path) h.path = normalizeHitPath(h.path);
  }
  if ((contextMode === "function" || contextMode === "class") && hits.length) {
    // rg applies scope context inside lib/rg.js. Zoekt needs post-processing.
    if (searchRes.provider !== "rg") {
      try {
        addScopeContextToHits(root, hits, { contextMode, maxScopeLines });
      } catch (e) {
        warnings.push(`scope context failed: ${e?.message || String(e)}`);
      }
    }
  }
  const byFile = groupHitsByFile(hits);
  const filePaths = [...byFile.keys()];

  const fileResults = [];
  for (const p of filePaths) {
    const hs = byFile.get(p) || [];
    const bestHitScore = hs.reduce(
      (m, x) => (x.score != null && x.score > m ? x.score : m),
      -Infinity
    );

    fileResults.push({
      path: p,
      id: p,
      type: null,
      hitCount: hs.length,
      bestHitScore: Number.isFinite(bestHitScore) ? bestHitScore : null,
      bestAdjustedHitScore: null,
      fanIn: null,
      fanOut: null,
      isEntryPoint: isEntryPoint(p),
      isHotspot: false,
    });
  }

  let graphAvailable = false;
  let db = null;
  try {
    db = await graph.loadDb(root);
    graphAvailable = graph.countFiles(db) > 0;
  } catch {
    graphAvailable = false;
  }

  if (graphAvailable && db) {
    const meta = graph.fileMetaByPaths(db, filePaths);
    const fanIn = graph.fanInByPaths(db, filePaths);
    const fanOut = graph.fanOutByPaths(db, filePaths);

    for (const f of fileResults) {
      const m = meta.get(f.path);
      f.type = m?.type || "unknown";
      f.fanIn = fanIn.get(f.path) || 0;
      f.fanOut = fanOut.get(f.path) || 0;
    }

    // WHY: Hotspot cutoff uses the 5th-highest fan-in as the threshold.
    // With <5 results the cutoff would equal the lowest fan-in, making every
    // file a "hotspot" — skip hotspot detection entirely in that case.
    const sortedFanIn = [...fileResults].sort((a, b) => (b.fanIn || 0) - (a.fanIn || 0));
    if (sortedFanIn.length >= 5) {
      const cutoff = Math.max(sortedFanIn[4]?.fanIn || 0, 2);
      for (const f of fileResults) {
        f.isHotspot = (f.fanIn || 0) >= cutoff;
      }
    }
  } else {
    warnings.push("graph not available; related expansion disabled");
  }

  // WHY: Export-graph symbol lookup.  If the exports table knows which file
  // EXPORTS the queried symbol, inject that file into results even if rg didn't
  // reach it.  This solves the "common term in large repo" failure class
  // (e.g., React "useState" with 716 source file matches where the definition
  // in ReactHooks.js never enters the raw rg budget).
  if (graphAvailable && db && queryTerms.length > 0) {
    // WHY: For each query term, look up files that EXPORT a symbol matching
    // that term (JS/TS/Python via `exports` table) or DECLARE a Swift type
    // or member matching it (Swift via `swift_declarations`).  Both lookups
    // share the same downstream injection: dedupe paths, sort by authority,
    // re-search each path with the matched symbol as the rg query, and add
    // the resulting file entries.  Earlier code used the FULL original
    // query (`q`) for the rg re-search, which silently dropped canonical
    // files for multi-token queries — e.g. for `extension Application`
    // the term `Application` matched `Application.swift` in
    // `swift_declarations`, but the rg re-search for the literal phrase
    // `extension Application` found 0 hits in `Application.swift` (which
    // has `class Application`, not `extension Application`).  Searching by
    // the matched term instead surfaces the def line.
    await injectGraphMatches(root, q, db, queryTerms, fileResults, hits, warnings, {
      label: "export-graph",
      lookup: (term) => graph.findExportsBySymbol(db, term).map((m) => ({ path: m.path, term })),
      // Exports have no kind — treat all as equal-authority on the path side.
      pathScore: (m) => exportPathAuthority(m.path),
      injectedFlag: "_exportGraphInjected",
      mode: opts.rgMode || "literal",
    });

    // WHY: Mirror the export-graph injection for Swift declarations. Swift
    // doesn't populate the JS-style `exports` table; type / member defs land
    // in `swift_declarations` instead, which findExportsBySymbol never sees.
    // Without this block, single-token queries like `URI` or `Application`
    // on a real Swift codebase get dominated by test files (URITests.swift
    // mentions URI hundreds of times) and the canonical `public struct URI`
    // def line never enters the rg-budgeted result set — exact pathology
    // we observed on Vapor (vapor-uri-001 / vapor-app-001 ranking 0).
    // Authoritative kinds (struct/class/protocol/enum/actor/typealias) take
    // priority over extensions and members in the path-authority sort below.
    await injectGraphMatches(root, q, db, queryTerms, fileResults, hits, warnings, {
      label: "swift-decl",
      lookup: (term) =>
        graph.findDeclarationsBySymbol(db, term, { limit: 50 }).map((m) => ({
          path: m.path,
          term,
          kind: m.kind,
        })),
      pathScore: (m) => swiftKindAuthority(m.kind) * 10 + exportPathAuthority(m.path),
      injectedFlag: "_swiftDeclInjected",
      mode: opts.rgMode || "literal",
      // WHY: Only authoritative type kinds get the score floor.  Extensions
      // and members of a type are evidence too, but weak — the canonical
      // file is the type def, not the extension.  Letting extensions enter
      // at full floor would over-promote files like `Application+Cache.swift`
      // for a query about Application.
      hitScore: ({ kind }) =>
        SWIFT_AUTHORITATIVE_KINDS.has(kind) ? SWIFT_DECL_TYPE_INJECT_SCORE : null,
    });

    // WHY: Follow re-export chains to find the original definition file.
    // A barrel file (e.g., index.ts) re-exports symbols from deeper modules.
    // If the chain resolves to a file not yet in results, inject it with the
    // strongest boost.  This closes the gap where rg finds the barrel file
    // but not the actual implementation.
    try {
      const reexportPaths = new Set();
      const currentPaths = new Set(fileResults.map((f) => f.path));

      for (const term of queryTerms) {
        if (term.length < 3) continue;
        const chain = graph.findReexportChain(db, term);
        for (const entry of chain) {
          if (!currentPaths.has(entry.path)) {
            reexportPaths.add(entry.path);
          }
        }
      }

      if (reexportPaths.size > 0) {
        const chainPaths = [...reexportPaths].slice(0, 10);
        const chainHits = await rg.searchInFiles(root, q, chainPaths, {
          maxHits: chainPaths.length * 5,
          mode: opts.rgMode || "literal",
        });

        for (const h of chainHits) {
          if (h.path) h.path = normalizeHitPath(h.path);
          h._reexportChainInjected = true;
          hits.push(h);
        }

        const chainByFile = groupHitsByFile(chainHits);
        const chainFilePaths = [...chainByFile.keys()];
        const chainMeta = graph.fileMetaByPaths(db, chainFilePaths);
        const chainFanIn = graph.fanInByPaths(db, chainFilePaths);
        const chainFanOut = graph.fanOutByPaths(db, chainFilePaths);

        for (const p of chainFilePaths) {
          const hs = chainByFile.get(p) || [];
          const best = hs.reduce((m, x) => (x.score != null && x.score > m ? x.score : m), -Infinity);
          const m = chainMeta.get(p);
          fileResults.push({
            path: p, id: p,
            type: m?.type || "unknown",
            hitCount: hs.length,
            bestHitScore: Number.isFinite(best) ? best : null,
            bestAdjustedHitScore: null,
            fanIn: chainFanIn.get(p) || 0,
            fanOut: chainFanOut.get(p) || 0,
            isEntryPoint: isEntryPoint(p),
            isHotspot: false,
          });
        }
      }
    } catch (e) {
      warnings.push(`reexport-chain lookup failed: ${e?.message || String(e)}`);
    }
  }

  const fileByPath = new Map(fileResults.map((f) => [f.path, f]));
  const useGraphBoost = graphAvailable && resolutionPct >= rerankMinResolutionPct;

  const rerankedHits = rerankAndCapHits(hits, fileByPath, {
    maxHits,
    hitsPerFileCap,
    explainHits,
    useGraphBoost,
    queryTerms,
  });

  const bestAdj = new Map();
  for (const h2 of rerankedHits) {
    const prev = bestAdj.get(h2.path) ?? -Infinity;
    if (h2.adjustedScore != null && h2.adjustedScore > prev) bestAdj.set(h2.path, h2.adjustedScore);
  }
  for (const f of fileResults) {
    f.bestAdjustedHitScore = bestAdj.has(f.path) ? bestAdj.get(f.path) : null;
  }

  rerankFiles(fileResults, { useGraphBoost });

  const seed = fileResults.slice(0, maxSeedFiles);
  const related = [];
  if (graphAvailable && db) {
    for (const s of seed) {
      const n = graph.neighbors(db, s.path, { maxImports: 15, maxDependents: 15 });
      if (expand.includes("imports")) {
        for (const p of n.imports) related.push({ from: s.path, relation: "imports", path: p });
      }
      if (expand.includes("dependents")) {
        for (const p of n.dependents)
          related.push({ from: s.path, relation: "depended_on_by", path: p });
      }
    }

    const relatedPaths = uniq(related.map((r) => r.path));
    const relMeta = graph.fileMetaByPaths(db, relatedPaths);
    const relFanIn = graph.fanInByPaths(db, relatedPaths);

    for (const r of related) {
      const m = relMeta.get(r.path);
      r.type = m?.type || "unknown";
      r.fanIn = relFanIn.get(r.path) || 0;
    }
  }

  const seenRel = new Set();
  const relatedClean = [];
  for (const r of related) {
    if (!r.path) continue;
    const k = `${r.relation}:${r.path}`;
    if (seenRel.has(k)) continue;
    seenRel.add(k);
    relatedClean.push(r);
    if (relatedClean.length >= maxRelated) break;
  }

  const { getGitInfo } = require("./git");
  const git = getGitInfo(root);

  return {
    schema: "sextant.retrieve.v1",
    timestamp: new Date().toISOString(),
    repo: { root, git },
    query: {
      q,
      terms: queryTerms,
      opts: {
        backend: backendOpt,
        contextLines,
        contextMode,
        maxScopeLines,
        maxHits,
        maxSeedFiles,
        expand,
        maxRelated,
        hitsPerFileCap,
        explainHits,
        rerankMinResolutionPct,
      },
    },
    providers: {
      search: { name: searchRes.provider, details: searchRes.details || null },
      graph: { available: graphAvailable },
    },
    health: h,
    results: {
      files: fileResults,
      hits: rerankedHits,
      related: relatedClean,
    },
    warnings,
  };
}

module.exports = { retrieve, rerankFiles, rerankAndCapHits, hitCountContribution, HIT_COUNT_WEIGHT };
