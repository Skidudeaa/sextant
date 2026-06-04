"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { mergeResults } = require("../lib/merge-results");

// ─── Graph-only results ─────────────────────────────────────────────

describe("mergeResults — graph only (no zoekt)", () => {
  it("returns graph files with boosted scores", () => {
    const graphResults = {
      files: [
        { path: "lib/graph.js", hitType: "exported_symbol", matchedTerms: ["loadDb"], fanIn: 5, score: 100 },
        { path: "lib/intel.js", hitType: "path_match", matchedTerms: ["intel"], fanIn: 13, score: 60 },
      ],
    };

    const result = mergeResults(graphResults, []);
    assert.equal(result.files.length, 2);
    // graph.js is exported_symbol (a canonical-def signal), so it gets the
    // DEF_SCORE_FLOOR: max(graphScore, 600 + graphScore) = 600 + 100*1.4 = 740.
    // WHY floored: a graph-only canonical def must compete on the zoekt ~500
    // scale or it gets evicted below text-only hits (bug B3-def-eviction).
    assert.equal(result.files[0].path, "lib/graph.js");
    assert.equal(result.files[0].fusedScore, 740);
    assert.equal(result.files[0].graphSignal, "exported_symbol");
    assert.equal(result.files[0].zoektHit, null);
    // intel.js is path_match (NOT a def signal) — no floor, plain graph boost:
    // 60 * 1.4 = 84.
    assert.equal(result.files[1].path, "lib/intel.js");
    assert.equal(result.files[1].fusedScore, 84);
  });

  it("preserves fanIn and matchedTerms", () => {
    const graphResults = {
      files: [
        { path: "lib/resolver.js", hitType: "exported_symbol", matchedTerms: ["resolveImport"], fanIn: 3, score: 100 },
      ],
    };

    const result = mergeResults(graphResults, []);
    assert.equal(result.files[0].fanIn, 3);
    assert.deepEqual(result.files[0].matchedTerms, ["resolveImport"]);
  });
});

// ─── Zoekt-only results ─────────────────────────────────────────────

describe("mergeResults — zoekt only (no graph)", () => {
  it("returns zoekt files with raw scores", () => {
    const zoektHits = [
      { path: "lib/scoring.js", lineNumber: 42, line: "function adjustScore(hit) {", score: 85 },
      { path: "lib/retrieve.js", lineNumber: 10, line: "const scoring = require('./scoring');", score: 30 },
    ];

    const result = mergeResults({ files: [] }, zoektHits);
    assert.equal(result.files.length, 2);
    assert.equal(result.files[0].path, "lib/scoring.js");
    assert.equal(result.files[0].fusedScore, 85);
    assert.equal(result.files[0].graphSignal, null);
    assert.equal(result.files[0].zoektHit.lineNumber, 42);
  });

  it("deduplicates multiple zoekt hits for the same file (keeps best)", () => {
    const zoektHits = [
      { path: "lib/scoring.js", lineNumber: 10, line: "line one", score: 30 },
      { path: "lib/scoring.js", lineNumber: 42, line: "line two (best)", score: 85 },
      { path: "lib/scoring.js", lineNumber: 50, line: "line three", score: 40 },
    ];

    const result = mergeResults({ files: [] }, zoektHits);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].fusedScore, 85);
    assert.equal(result.files[0].zoektHit.lineNumber, 42);
    assert.equal(result.files[0].zoektHit.line, "line two (best)");
  });
});

// ─── Both graph and zoekt ───────────────────────────────────────────

describe("mergeResults — fusion (graph + zoekt)", () => {
  it("applies fusion bonus when file appears in both", () => {
    const graphResults = {
      files: [
        { path: "lib/graph.js", hitType: "exported_symbol", matchedTerms: ["loadDb"], fanIn: 5, score: 100 },
      ],
    };
    const zoektHits = [
      { path: "lib/graph.js", lineNumber: 78, line: "async function loadDb(root) {", score: 50 },
    ];

    const result = mergeResults(graphResults, zoektHits);
    assert.equal(result.files.length, 1);
    // Fusion: (100*1.4 + 50) * 1.2 = 228.  But graph.js is exported_symbol
    // (canonical-def signal), so the DEF_SCORE_FLOOR floor of 600 + 100*1.4 =
    // 740 applies via Math.max — and 740 > 228, so the floor wins.  (When the
    // zoekt corroboration is strong enough that fusion exceeds 740, the fused
    // score wins instead — the floor is purely a Math.max, never lowers.)
    assert.equal(result.files[0].fusedScore, 740);
    assert.equal(result.files[0].graphSignal, "exported_symbol");
    assert.ok(result.files[0].zoektHit);
    assert.equal(result.files[0].zoektHit.lineNumber, 78);
  });

  it("does NOT apply fusion bonus to files only in one source", () => {
    const graphResults = {
      files: [
        { path: "lib/graph.js", hitType: "exported_symbol", matchedTerms: ["loadDb"], fanIn: 5, score: 100 },
      ],
    };
    const zoektHits = [
      { path: "lib/other.js", lineNumber: 1, line: "something", score: 50 },
    ];

    const result = mergeResults(graphResults, zoektHits);
    assert.equal(result.files.length, 2);
    // graph.js: graph-only exported_symbol — no fusion bonus, but the
    // canonical-def floor lifts it to 600 + 100*1.4 = 740 (was 140).  This is
    // the bug-B3 fix: a graph-only def must outrank text-only hits, not be
    // buried beneath them.
    const graphFile = result.files.find((f) => f.path === "lib/graph.js");
    assert.equal(graphFile.fusedScore, 740);
    // other.js: zoekt-only, no fusion, no def signal — 50
    const zoektFile = result.files.find((f) => f.path === "lib/other.js");
    assert.equal(zoektFile.fusedScore, 50);
  });

  it("ranks fusion files above single-source files", () => {
    const graphResults = {
      files: [
        { path: "lib/a.js", hitType: "exported_symbol", matchedTerms: ["foo"], fanIn: 2, score: 80 },
        { path: "lib/b.js", hitType: "path_match", matchedTerms: ["bar"], fanIn: 0, score: 60 },
      ],
    };
    const zoektHits = [
      { path: "lib/a.js", lineNumber: 5, line: "export function foo() {", score: 40 },
    ];

    const result = mergeResults(graphResults, zoektHits);
    // lib/a.js: (80*1.4 + 40) * 1.2 = (112 + 40) * 1.2 = 182.4
    // lib/b.js: 60*1.4 = 84
    assert.equal(result.files[0].path, "lib/a.js");
    assert.ok(result.files[0].fusedScore > result.files[1].fusedScore);
  });
});

// ─── Deduplication ──────────────────────────────────────────────────

describe("mergeResults — deduplication", () => {
  it("same file in graph and zoekt produces one entry", () => {
    const graphResults = {
      files: [
        { path: "lib/graph.js", hitType: "exported_symbol", matchedTerms: ["loadDb"], fanIn: 5, score: 100 },
      ],
    };
    const zoektHits = [
      { path: "lib/graph.js", lineNumber: 78, line: "async function loadDb(root) {", score: 50 },
    ];

    const result = mergeResults(graphResults, zoektHits);
    assert.equal(result.files.length, 1);
    // Should have both graph signal and zoekt hit
    assert.equal(result.files[0].graphSignal, "exported_symbol");
    assert.ok(result.files[0].zoektHit);
  });
});

// ─── maxFiles cap ───────────────────────────────────────────────────

describe("mergeResults — maxFiles cap", () => {
  it("caps output at maxFiles", () => {
    const graphResults = {
      files: Array.from({ length: 20 }, (_, i) => ({
        path: `lib/file${i}.js`,
        hitType: "path_match",
        matchedTerms: ["file"],
        fanIn: 0,
        score: 60 - i,
      })),
    };

    const result = mergeResults(graphResults, [], { maxFiles: 5 });
    assert.equal(result.files.length, 5);
    assert.equal(result.files[0].path, "lib/file0.js");
    assert.equal(result.files[4].path, "lib/file4.js");
  });

  it("defaults to 8 files when maxFiles not specified", () => {
    const graphResults = {
      files: Array.from({ length: 15 }, (_, i) => ({
        path: `lib/file${i}.js`,
        hitType: "path_match",
        matchedTerms: ["file"],
        fanIn: 0,
        score: 60,
      })),
    };

    const result = mergeResults(graphResults, []);
    assert.equal(result.files.length, 8);
  });
});

// ─── Empty results ──────────────────────────────────────────────────

describe("mergeResults — empty results", () => {
  it("empty graph + empty zoekt → empty files", () => {
    const result = mergeResults({ files: [] }, []);
    assert.deepEqual(result.files, []);
  });

  it("null/undefined inputs handled gracefully", () => {
    const result = mergeResults(null, null);
    assert.deepEqual(result.files, []);
  });

  it("missing files array handled gracefully", () => {
    const result = mergeResults({}, []);
    assert.deepEqual(result.files, []);
  });
});

// ─── Term-coverage bonus on multi-term queries ─────────────────────

describe("mergeResults — term coverage bonus", () => {
  const { termCoverageBonus, MULTI_TERM_LINE_BONUS } = require("../lib/merge-results");

  it("termCoverageBonus returns 0 for single-term queries", () => {
    assert.equal(termCoverageBonus("function foo()", ["foo"]), 0);
  });

  it("termCoverageBonus returns 0 when zero or one term matches on the line", () => {
    assert.equal(termCoverageBonus("const x = 1;", ["foo", "bar"]), 0);
    assert.equal(termCoverageBonus("const foo = 1;", ["foo", "bar"]), 0);
  });

  it("termCoverageBonus awards (matched-1) * BONUS for multi-term line", () => {
    // Line matches both query terms → bonus = (2-1) * 15 = 15
    assert.equal(
      termCoverageBonus("function extractImports()", ["extractImports", "function"]),
      MULTI_TERM_LINE_BONUS
    );
    // Line matches 3 of 3 terms → bonus = (3-1) * 15 = 30
    assert.equal(
      termCoverageBonus("async function extractImports()", ["async", "function", "extractImports"]),
      2 * MULTI_TERM_LINE_BONUS
    );
  });

  it("multi-term line beats single-term line for same file", () => {
    // Simulates two zoekt hits for the same file: one line has both terms,
    // the other only one.  mergeResults keeps the best representative per
    // file — the def line must win.
    const zoektHits = [
      { path: "a.js", lineNumber: 10, line: "foo();", score: 500 },
      { path: "a.js", lineNumber: 20, line: "function foo() {}", score: 500 },
    ];
    const result = mergeResults({ files: [] }, zoektHits, { queryTerms: ["foo", "function"] });
    // Representative line should be the def (line 20) because it matches both
    // terms and got +15 bonus — not line 10 which matches only "foo".
    assert.equal(result.files[0].zoektHit.lineNumber, 20);
  });

  it("applies no bonus when queryTerms is missing or empty", () => {
    const zoektHits = [
      { path: "a.js", lineNumber: 10, line: "function foo bar", score: 500 },
      { path: "a.js", lineNumber: 20, line: "plain foo", score: 501 },
    ];
    // Without queryTerms, plain sort by raw score → line 20 wins (higher
    // raw score).  The def-style line 10 does NOT get bumped.
    const result = mergeResults({ files: [] }, zoektHits);
    assert.equal(result.files[0].zoektHit.lineNumber, 20);
  });
});

// ─── Def-site line-level scoring (parity with retrieve.js CLI path) ─────

describe("mergeResults — def-site line-level scoring", () => {
  it("def-site line outranks usage line in the same file", () => {
    const zoektHits = [
      { path: "lib/a.js", lineNumber: 5,  line: "function resolveImport(spec) {", score: 500 },
      { path: "lib/a.js", lineNumber: 60, line: "    resolveImport(other);",       score: 501 },
    ];
    const result = mergeResults({ files: [] }, zoektHits, { queryTerms: ["resolveImport"] });
    // Def line (rank by adjusted score) wins as representative — without the
    // boost, the usage line at score 501 would win over score 500.
    assert.equal(result.files[0].zoektHit.lineNumber, 5);
  });

  it("file with def-site line outranks file with only usage lines (zoekt-only)", () => {
    const zoektHits = [
      { path: "lib/usage.js",  lineNumber: 10, line: "    resolveImport(spec);",        score: 510 },
      { path: "lib/define.js", lineNumber: 20, line: "function resolveImport(spec) {",  score: 500 },
    ];
    // Without the def-site boost, usage.js (raw 510) outranks define.js (raw 500).
    // With the boost, define.js gets +65% and dominates: 500 * 1.65 = 825 > 510.
    const result = mergeResults({ files: [] }, zoektHits, { queryTerms: ["resolveImport"] });
    assert.equal(result.files[0].path, "lib/define.js");
  });

  it("def-site boost ignores files where symbol is only a substring of the def name", () => {
    // "extractImports" query against "function extractImportsAST(...)" should
    // NOT trigger the +25% def_site_priority (which requires exact match), but
    // SHOULD trigger the smaller +12% symbol_contains_query boost.
    const zoektHits = [
      { path: "lib/exact.js",     lineNumber: 1, line: "function extractImports(code) {",    score: 500 },
      { path: "lib/substring.js", lineNumber: 1, line: "function extractImportsAST(code) {", score: 500 },
    ];
    const result = mergeResults({ files: [] }, zoektHits, { queryTerms: ["extractImports"] });
    // Exact match must rank first.
    assert.equal(result.files[0].path, "lib/exact.js");
    assert.ok(
      result.files[0].fusedScore > result.files[1].fusedScore,
      `exact (${result.files[0].fusedScore}) must outscore substring (${result.files[1].fusedScore})`
    );
  });

  it("no def-site boost when queryTerms is empty (back-compat)", () => {
    const zoektHits = [
      { path: "lib/a.js", lineNumber: 5, line: "function resolveImport(spec) {", score: 500 },
    ];
    const result = mergeResults({ files: [] }, zoektHits);
    // Without queryTerms, no line-level adjustment — score stays at the raw 500.
    assert.equal(result.files[0].fusedScore, 500);
  });
});

// ─── Case-sensitive symbol matching (Swift bug-2 closure) ──────────────
//
// WHY: In the hook fast-path the caller passes case-preserved queryTerms;
// merge-results forwards them to scoring with { caseSensitive: true }.
// On Swift consumer lines like `let uri = URI(...)` extractSymbolDef
// returns the LOCAL VARIABLE name "uri", not the type "URI".  Case-sensitive
// matching distinguishes a variable declaration from a type definition,
// preventing test-file consumer lines from inheriting the +25%/+40%/+12%
// def-site stack and outranking the canonical type def file.

describe("mergeResults — case-sensitive symbol matching (Swift bug-2)", () => {
  it("URI.swift outranks URITests.swift consumer-only file (the headline case)", () => {
    const zoektHits = [
      { path: "Sources/URI.swift",     lineNumber: 12, line: "public struct URI: Codable, Sendable {",                  score: 500 },
      { path: "Tests/URITests.swift",  lineNumber: 8,  line: "    let uri = URI(scheme: .https, host: \"example.com\")", score: 500 },
    ];
    const result = mergeResults({ files: [] }, zoektHits, { queryTerms: ["URI"] });
    assert.equal(result.files[0].path, "Sources/URI.swift",
      `expected URI.swift first, got ${result.files[0].path} fused=${result.files[0].fusedScore} vs ${result.files[1].path} fused=${result.files[1].fusedScore}`);
    assert.ok(result.files[0].fusedScore > result.files[1].fusedScore);
  });

  it("consumer line `let uri = URI(...)` gets NO def-site boost for query 'URI'", () => {
    // Negative-evidence: extractSymbolDef returns "uri" (the variable),
    // queryTerms ["URI"] is case-preserved into scoring; case-sensitive
    // gate rejects "URI" === "uri".  Result: no +25% def-site, no +40%
    // exact-symbol, no +12% symbol_contains_query.  Raw score survives.
    const zoektHits = [
      { path: "X.swift", lineNumber: 1, line: "    let uri = URI(scheme: .https, host: \"a\")", score: 500 },
    ];
    const result = mergeResults({ files: [] }, zoektHits, { queryTerms: ["URI"] });
    // No bonuses; fused = raw 500.  (No file-type penalty: X.swift isn't a test path.)
    assert.equal(result.files[0].fusedScore, 500);
  });

  it("def line `public struct URI` DOES get the def-site boost for query 'URI'", () => {
    // Positive-evidence: this assertion proves the previously-dead
    // case-sensitive guard at merge-results.js:99 now actually fires.
    // Before the fix, queryTerms was lowercased to ["uri"] upstream so
    // String("uri") === "URI" was always false and the +25% never fired.
    const zoektHits = [
      { path: "X.swift", lineNumber: 1, line: "public struct URI: Codable {", score: 500 },
    ];
    const result = mergeResults({ files: [] }, zoektHits, { queryTerms: ["URI"] });
    // DEF_SITE_PRIORITY 0.25 + EXACT_SYMBOL_BOOST 0.40 + SYMBOL_CONTAINS_QUERY 0.12 = +77%
    // Allow some slack for rounding; assert at least the def-site +25% landed.
    assert.ok(result.files[0].fusedScore >= 500 * 1.25,
      `expected at least +25% def-site boost on canonical def line, got fused=${result.files[0].fusedScore}`);
  });

  it("JS regression: canonical-case def line `function loadDb()` still gets the def-site stack", () => {
    // Confirms the case-sensitive guard doesn't break JS — when the user
    // types the canonical camelCase, the def-site boost still fires.
    const zoektHits = [
      { path: "lib/graph.js", lineNumber: 1, line: "function loadDb(root) {", score: 500 },
    ];
    const result = mergeResults({ files: [] }, zoektHits, { queryTerms: ["loadDb"] });
    assert.ok(result.files[0].fusedScore >= 500 * 1.25,
      `expected def-site boost on canonical-case JS def line, got fused=${result.files[0].fusedScore}`);
  });

  it("termCoverageBonus regression: multi-term coverage still fires after upstream lowercase removal", () => {
    // termCoverageBonus lowercases internally (merge-results.js:237/241),
    // so removing the upstream .toLowerCase() at line 120 must not
    // disturb its case-insensitive substring counting.
    const zoektHits = [
      { path: "a.js", lineNumber: 10, line: "foo();",                score: 500 },
      { path: "a.js", lineNumber: 20, line: "function FOO() {}",     score: 500 },
    ];
    // Mixed-case query; termCoverageBonus should still match BOTH terms
    // on the def line (case-insensitive substring) and pick line 20.
    const result = mergeResults({ files: [] }, zoektHits, { queryTerms: ["foo", "function"] });
    assert.equal(result.files[0].zoektHit.lineNumber, 20);
  });
});

// ─── Canonical-def floor (bug B3-def-eviction) ─────────────────────────
//
// WHY: graph-only canonical-def files and zoekt hits live on incompatible
// score scales (graph def ceiling ~161 vs zoekt line ~500).  fusedScore =
// graphScore + zoektScore let ANY zoekt-corroborated file outscore ANY
// graph-only def.  Reproduced on a real Python repo: the canonical class def
// (graph rank 1, exported_symbol) was evicted to dead-last and cut by the
// top-8 slice whenever its def line fell outside zoekt's capped hit set,
// while text-only docs/HTML/test files that mention the symbol filled the
// top slots.  The floor mirrors retrieve.js:injectGraphMatches (CLI path
// already floors canonical-def injections at 600 vs zoekt's ~500 band).

describe("mergeResults — canonical-def floor (bug B3-def-eviction)", () => {
  it("graph-only canonical def is NOT evicted below text-only zoekt hits", () => {
    // Mirrors the somaNotes 'ProgressNoteGenerator' pathology: the true class
    // def is graph-only (its def line crowded out of zoekt's capped hit set),
    // while a pile of text-only doc/source files DO have zoekt hits at ~500.
    const graphResults = {
      files: [
        // canonical class def — exported_symbol, high fan-in, graph rank 1,
        // but absent from zoekt's hit set (inZoekt=false)
        { path: "generators/progress_generator.py", hitType: "exported_symbol", matchedTerms: ["ProgressNoteGenerator"], fanIn: 51, score: 107.9 },
      ],
    };
    // Text-only files that mention the symbol — none is the definition.
    const zoektHits = [
      { path: "docs/ARCHITECTURE.md",     lineNumber: 10, line: "ProgressNoteGenerator builds the note", score: 500 },
      { path: "hyperdrive/matching.py",   lineNumber: 20, line: "from generators import ProgressNoteGenerator", score: 500 },
      { path: "services/note_compiler.py",lineNumber: 30, line: "gen = ProgressNoteGenerator()", score: 500 },
      { path: "somaNotes.py",             lineNumber: 40, line: "ProgressNoteGenerator", score: 500 },
    ];
    const result = mergeResults(graphResults, zoektHits, {
      queryTerms: ["ProgressNoteGenerator"],
      maxFiles: 8,
    });
    const defRank = result.files.findIndex((f) => f.path === "generators/progress_generator.py");
    assert.notEqual(defRank, -1, "canonical def must NOT be evicted from the result set");
    assert.equal(defRank, 0,
      `canonical def must outrank text-only hits, got rank ${defRank + 1}: ` +
      result.files.map((f) => f.path).join(", "));
  });

  it("a barrel re-exporter (def signal + zoekt hit) and the true def both survive; true def's higher fan-in keeps it competitive", () => {
    // Both files carry the exported_symbol signal; the barrel also has a zoekt
    // hit (it literally contains `from .x import Y`).  Both must be present and
    // both above text-only noise.  The true def has higher fan-in-boosted graph
    // score, so the +graphScore term in the floor keeps it ahead of any
    // equal-text-only file.
    const graphResults = {
      files: [
        { path: "generators/progress_generator.py", hitType: "exported_symbol", matchedTerms: ["ProgressNoteGenerator"], fanIn: 51, score: 107.9 },
        { path: "generators/__init__.py",           hitType: "exported_symbol", matchedTerms: ["ProgressNoteGenerator"], fanIn: 1,  score: 101.39 },
      ],
    };
    const zoektHits = [
      { path: "generators/__init__.py", lineNumber: 3,  line: "from .progress_generator import ProgressNoteGenerator", score: 501 },
      { path: "docs/ARCHITECTURE.md",   lineNumber: 10, line: "ProgressNoteGenerator builds the note", score: 500 },
      { path: "scripts/debug_progress_test.py", lineNumber: 5, line: "ProgressNoteGenerator()", score: 500 },
    ];
    const result = mergeResults(graphResults, zoektHits, {
      queryTerms: ["ProgressNoteGenerator"],
      maxFiles: 8,
    });
    const paths = result.files.map((f) => f.path);
    assert.ok(paths.includes("generators/progress_generator.py"), "true def must survive");
    const defRank = paths.indexOf("generators/progress_generator.py");
    const docRank = paths.indexOf("docs/ARCHITECTURE.md");
    // The text-only doc must rank below the true def.
    assert.ok(defRank !== -1 && (docRank === -1 || defRank < docRank),
      `true def (rank ${defRank + 1}) must outrank text-only doc (rank ${docRank + 1}): ${paths.join(", ")}`);
  });

  it("floor never LOWERS a strongly-corroborated def (Math.max semantics)", () => {
    // A def file that is also strongly zoekt-corroborated already exceeds the
    // floor via fusion — the floor must not pull it down.
    const graphResults = {
      files: [
        { path: "lib/a.js", hitType: "exported_symbol", matchedTerms: ["foo"], fanIn: 10, score: 100 },
      ],
    };
    const zoektHits = [
      { path: "lib/a.js", lineNumber: 1, line: "export function foo() {", score: 800 },
    ];
    const result = mergeResults(graphResults, zoektHits, { queryTerms: ["foo"] });
    // Fusion (graph + zoekt, then *1.2, plus def-site/exact boosts) far exceeds
    // the 600+graphScore floor, so the higher fused score is kept.
    assert.ok(result.files[0].fusedScore > 740,
      `strongly-corroborated def should keep its higher fused score, got ${result.files[0].fusedScore}`);
  });

  it("non-def graph signals (path_match / reexport_chain) get NO floor", () => {
    // Only exported_symbol / swift_decl_type are canonical-def signals.  A
    // path_match must not be floored onto the zoekt scale — that would
    // over-promote filename coincidences above real text matches.
    const graphResults = {
      files: [
        { path: "lib/watcher.js", hitType: "path_match", matchedTerms: ["watch"], fanIn: 0, score: 60 },
      ],
    };
    const result = mergeResults(graphResults, [], { queryTerms: ["watch"] });
    // path_match: 60 * 1.4 = 84, no floor.
    assert.equal(result.files[0].fusedScore, 84);
  });

  it("withholds the fusion bonus from a re-export signal", () => {
    // A re-export shim's graph edge and its zoekt `from .mod import X` line are
    // the SAME fact, not independent corroboration — so it must NOT earn the
    // inBoth fusion bonus.  Two files with identical graph score + identical
    // zoekt line, differing ONLY in graph signal: path_match earns the *1.2
    // bonus, reexport_chain does not.  Neither is a DEF_SIGNAL_TYPE, so the
    // canonical-def floor is not involved — this isolates the fusion bonus.
    const line = "alpha beta gamma"; // no def-site/exact-symbol trigger
    const graphResults = {
      files: [
        { path: "a_pathmatch.js", hitType: "path_match",     matchedTerms: ["alpha"], fanIn: 0, score: 100 },
        { path: "b_reexport.js",  hitType: "reexport_chain", matchedTerms: ["alpha"], fanIn: 0, score: 100 },
      ],
    };
    const zoektHits = [
      { path: "a_pathmatch.js", lineNumber: 1, line, score: 500 },
      { path: "b_reexport.js",  lineNumber: 1, line, score: 500 },
    ];
    const result = mergeResults(graphResults, zoektHits, { queryTerms: ["alpha"] });
    const a = result.files.find((f) => f.path === "a_pathmatch.js").fusedScore;
    const b = result.files.find((f) => f.path === "b_reexport.js").fusedScore;
    assert.ok(a > b, `path_match (fusion bonus) must exceed reexport_chain (no bonus): a=${a} b=${b}`);
    assert.ok(Math.abs(a - b * 1.2) < 1, `path_match should be exactly the reexport score * 1.2: a=${a} b=${b}`);
  });

  it("canonical def outranks a re-export barrel of the same symbol (B3 constant edge)", () => {
    // The somaNotes FLAG_REGISTRY pathology after the full fix: the def carries
    // an exported_symbol signal (AnnAssign now surfaces annotated constants) and
    // is floored; the __init__ barrel is a reexport_chain with a zoekt re-export
    // line but earns neither the floor nor the fusion bonus.  The floored def
    // must win even though the barrel is zoekt-corroborated.
    const graphResults = {
      files: [
        { path: "app/feature_gate.py", hitType: "exported_symbol", matchedTerms: ["FLAG_REGISTRY"], fanIn: 3, score: 100 },
        { path: "app/__init__.py",     hitType: "reexport_chain",  matchedTerms: ["FLAG_REGISTRY"], fanIn: 1, score: 80 },
      ],
    };
    const zoektHits = [
      { path: "app/__init__.py",     lineNumber: 3, line: "from .feature_gate import FLAG_REGISTRY", score: 500 },
      { path: "app/feature_gate.py", lineNumber: 9, line: "FLAG_REGISTRY = {", score: 500 },
    ];
    const result = mergeResults(graphResults, zoektHits, { queryTerms: ["FLAG_REGISTRY"], maxFiles: 8 });
    assert.equal(result.files[0].path, "app/feature_gate.py",
      `def must outrank re-export barrel, got: ${result.files.map((f) => f.path).join(", ")}`);
  });
});

describe("mergeResults — test-path penalty (Python/Go filename conventions)", () => {
  const C = require("../lib/scoring-constants");

  // Regression: dogfooding on a Python project (2026-05-25) found test_*.py
  // files outranking real source.  The penalty regexes knew only JS
  // (__tests__/, .test.js) and Swift (Tests/, XCT*/, *Testing/) conventions;
  // pytest's filename-PREFIX convention (test_*.py discovered anywhere) fell
  // through with zero penalty, so a test file sharing one query token ranked
  // beside the source that actually defined the symbol.

  it("ranks a Python source file above an equal-scoring test_*.py file", () => {
    // Identical line + score — the ONLY differentiator is the test penalty.
    // Pre-fix both scored equally and the alphabetical tiebreak
    // ("app/test_widget.py" < "app/widget.py") put the TEST file at rank 1.
    const zoektHits = [
      { path: "app/test_widget.py", lineNumber: 5, line: "def make_widget():", score: 100 },
      { path: "app/widget.py",      lineNumber: 5, line: "def make_widget():", score: 100 },
    ];
    const result = mergeResults({ files: [] }, zoektHits);
    assert.equal(result.files[0].path, "app/widget.py",
      "real source must outrank the equal-scoring test_*.py file");
    assert.equal(result.files[1].path, "app/test_widget.py");
  });

  it("penalizes test_*.py (prefix) and *_test.go (suffix), not lookalikes", () => {
    const fused = (path) => mergeResults(
      { files: [] },
      [{ path, lineNumber: 1, line: "x", score: 100 }]
    ).files[0].fusedScore;
    const penalized = 100 * (1 - C.TEST_PENALTY);
    assert.equal(fused("pkg/test_foo.py"), penalized, "test_ filename prefix penalized");
    assert.equal(fused("pkg/foo_test.go"), penalized, "_test filename suffix penalized");
    // Anchored to the basename, so a test_data/ fixtures DIR (basename
    // foo.py) is not a test file, and lookalikes are not penalized.
    assert.equal(fused("test_data/foo.py"), 100, "fixtures dir not penalized");
    assert.equal(fused("pkg/pytest_plugin.py"), 100, "pytest_ prefix is not test_");
    assert.equal(fused("pkg/latest.py"), 100, "trailing 'test' without _ not penalized");
  });
});

// ─── Content-stale gating (T1.2 freshness-gate) ────────────────────────────
//
// WHY: After a checkout/edit the hook must stop asserting graph structure that
// may point at moved/deleted files.  When the caller passes { stale: true }
// (content change detected), mergeResults neutralizes the three structural
// levers — GRAPH_BOOST (1.4→1), FUSION_BONUS (1.2→1), and the DEF_SCORE_FLOOR
// — so a graph-only "definition" contributes its RAW score and live text
// (zoekt) evidence dominates.  The DEFAULT path (no stale opt) MUST be
// byte-identical to today: that is the eval no-op guarantee (eval-hook.js calls
// mergeResults WITHOUT stale, so both eval harnesses are structurally
// unaffected).

describe("mergeResults — content-stale gating (T1.2)", () => {
  it("stale:true drops the DEF_SCORE_FLOOR — graph-only def keeps RAW score", () => {
    // A graph-only exported_symbol def.  Fresh, it would be floored to
    // 600 + 100*1.4 = 740 (see the canonical-def-floor describe above).
    // Stale, the floor is skipped AND the 1.4x graph boost is neutralized,
    // so the def contributes its RAW graph score: 100 * 1 = 100.
    const graphResults = {
      files: [
        { path: "lib/graph.js", hitType: "exported_symbol", matchedTerms: ["loadDb"], fanIn: 5, score: 100 },
      ],
    };
    const result = mergeResults(graphResults, [], { stale: true });
    assert.equal(result.files[0].path, "lib/graph.js");
    // FAIL-PRE: before the merge change, stale:true still floored → 740.
    assert.equal(result.files[0].fusedScore, 100,
      `stale def must keep raw graph score (100), got ${result.files[0].fusedScore}`);
    // The graph signal label is preserved (provenance unchanged) — only the
    // SCORE is de-authoritized.
    assert.equal(result.files[0].graphSignal, "exported_symbol");
  });

  it("stale:true lets a higher text-only hit OUTRANK a graph-only def", () => {
    // The headline behavior: with structure suppressed, a live zoekt hit that
    // text-search just confirmed exists can now outrank a graph-only def whose
    // file may have moved/been deleted.  Fresh, the def's 740 floor would bury
    // the 500 text hit; stale, the def is raw 100 < text 500.
    const graphResults = {
      files: [
        { path: "lib/graph.js", hitType: "exported_symbol", matchedTerms: ["loadDb"], fanIn: 5, score: 100 },
      ],
    };
    const zoektHits = [
      { path: "lib/live_text.js", lineNumber: 7, line: "loadDb mentioned here", score: 500 },
    ];
    // FRESH: def wins (740 > 500) — proves the suppression is what flips it.
    const fresh = mergeResults(graphResults, zoektHits, { queryTerms: ["loadDb"] });
    assert.equal(fresh.files[0].path, "lib/graph.js",
      `fresh: floored def (740) must outrank text hit (500), got ${fresh.files[0].path}`);
    // STALE: text hit wins (500 > raw 100).
    const result = mergeResults(graphResults, zoektHits, { queryTerms: ["loadDb"], stale: true });
    assert.equal(result.files[0].path, "lib/live_text.js",
      `stale: live text hit (500) must outrank de-authoritized def (100), got ${result.files[0].path}`);
  });

  it("stale:true neutralizes the fusion bonus (graph+zoekt corroboration)", () => {
    // A path_match file in BOTH graph and zoekt earns the 1.2x fusion bonus
    // when fresh.  Stale, both graphBoost and fusionBonus are 1, so the file
    // is exactly graphScore(raw) + zoektScore with no multiplier.
    const line = "alpha beta gamma"; // no def-site/exact-symbol trigger
    const graphResults = {
      files: [
        { path: "a.js", hitType: "path_match", matchedTerms: ["alpha"], fanIn: 0, score: 100 },
      ],
    };
    const zoektHits = [{ path: "a.js", lineNumber: 1, line, score: 500 }];
    const stale = mergeResults(graphResults, zoektHits, { queryTerms: ["alpha"], stale: true });
    // raw graph 100 + zoekt 500 = 600, NO fusion bonus, NO graph boost.
    assert.equal(stale.files[0].fusedScore, 600,
      `stale fused = raw graph + zoekt, no multipliers, got ${stale.files[0].fusedScore}`);
    // Contrast fresh: (100*1.4 + 500) * 1.2 = 768.
    const fresh = mergeResults(graphResults, zoektHits, { queryTerms: ["alpha"] });
    assert.equal(fresh.files[0].fusedScore, 768);
  });

  it("graph-only files still APPEAR under stale:true (just de-authoritized)", () => {
    // De-authoritizing the score must NOT drop a graph-only file — the
    // existsSync-drop (in the hook) is the only thing that removes phantoms.
    const graphResults = {
      files: [
        { path: "lib/graph.js", hitType: "exported_symbol", matchedTerms: ["loadDb"], fanIn: 5, score: 100 },
      ],
    };
    const result = mergeResults(graphResults, [], { stale: true });
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].path, "lib/graph.js");
  });

  it("NO-OP GUARANTEE: omitting stale (and stale:false) is byte-identical to today", () => {
    // The eval no-op: eval-hook.js calls mergeResults(g, z, { queryTerms })
    // with NO stale key.  Assert the default still floors the def (740) — the
    // same value the canonical-def-floor describe asserts.  stale:false must
    // also be identical to the absent case.
    const graphResults = {
      files: [
        { path: "lib/graph.js", hitType: "exported_symbol", matchedTerms: ["loadDb"], fanIn: 5, score: 100 },
      ],
    };
    const absent = mergeResults(graphResults, []);
    const falseStale = mergeResults(graphResults, [], { stale: false });
    assert.equal(absent.files[0].fusedScore, 740, "default path must still floor the def to 740");
    assert.equal(falseStale.files[0].fusedScore, 740, "stale:false must match the absent case");
    assert.equal(absent.files[0].graphSignal, "exported_symbol");
  });
});
