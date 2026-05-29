"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { quoteIfPhrase, escapeForZoekt, rankByTokenCoverage } = require("../lib/zoekt");

// WHY: zoekt's default query parser AND's whitespace-separated tokens as
// independent substring clauses, while rg with -F treats the same query as
// a single literal phrase. quoteIfPhrase makes the two backends behave
// equivalently for the sextant pipeline (which sends plain strings, never
// zoekt query DSL). See lib/zoekt.js for the prose rationale.

describe("quoteIfPhrase", () => {
  it("wraps multi-token queries in double quotes", () => {
    assert.equal(quoteIfPhrase("extension EventLoopFuture"), '"extension EventLoopFuture"');
    assert.equal(quoteIfPhrase("protocol Middleware"), '"protocol Middleware"');
    assert.equal(quoteIfPhrase("public final class Application"), '"public final class Application"');
  });

  it("leaves plain single-token queries unchanged", () => {
    assert.equal(quoteIfPhrase("Application"), "Application");
    assert.equal(quoteIfPhrase("rerankFiles"), "rerankFiles");
    assert.equal(quoteIfPhrase("URLSession"), "URLSession");
  });

  it("escapes regex metacharacters in single-token queries", () => {
    // WHY: zoekt's default query syntax is regex. `+` means one-or-more,
    // not the literal `+` character — so `View+Toolbar` would never match
    // the literal text in source files. Escape so it does.
    assert.equal(quoteIfPhrase("View+Toolbar"), "View\\+Toolbar");
    assert.equal(quoteIfPhrase("foo.bar"), "foo\\.bar");
    assert.equal(quoteIfPhrase("a*b"), "a\\*b");
    assert.equal(quoteIfPhrase("x?"), "x\\?");
    assert.equal(quoteIfPhrase("a|b"), "a\\|b");
    assert.equal(quoteIfPhrase("(group)"), "\\(group\\)");
    assert.equal(quoteIfPhrase("[bracket]"), "\\[bracket\\]");
    assert.equal(quoteIfPhrase("path\\sep"), "path\\\\sep");
  });

  it("escapes regex metacharacters inside multi-token quoted queries", () => {
    // WHY: zoekt still interprets regex metacharacters inside double-quoted
    // phrases. Without the escape, "View+Toolbar foo" would treat the `+`
    // as a quantifier even though the phrase wrapping forces adjacency.
    assert.equal(quoteIfPhrase("View+Toolbar foo"), '"View\\+Toolbar foo"');
    assert.equal(quoteIfPhrase("a.b c"), '"a\\.b c"');
  });

  it("trims surrounding whitespace before deciding", () => {
    assert.equal(quoteIfPhrase("  Application  "), "Application");
    assert.equal(quoteIfPhrase("  protocol Middleware  "), '"protocol Middleware"');
  });

  it("passes through queries that the caller already quoted", () => {
    assert.equal(quoteIfPhrase('"already quoted"'), '"already quoted"');
    assert.equal(quoteIfPhrase('"single"'), '"single"');
  });

  it("strips embedded double quotes before processing", () => {
    // WHY: a stray internal quote would terminate the wrapping phrase early
    // and turn the rest into a separate clause — worse than the unwrapped
    // behavior. Drop the quote rather than splitting the query.
    assert.equal(quoteIfPhrase('foo "bar baz'), '"foo bar baz"');
  });

  it("handles empty / whitespace-only / non-string input gracefully", () => {
    assert.equal(quoteIfPhrase(""), "");
    assert.equal(quoteIfPhrase("   "), "");
    assert.equal(quoteIfPhrase(null), null);
    assert.equal(quoteIfPhrase(undefined), undefined);
    assert.equal(quoteIfPhrase(42), 42);
  });

  it("treats tabs and newlines as whitespace for phrase detection", () => {
    assert.equal(quoteIfPhrase("foo\tbar"), '"foo\tbar"');
    assert.equal(quoteIfPhrase("foo\nbar"), '"foo\nbar"');
  });
});

// WHY: escapeForZoekt is the AND-fallback form used when a phrase query
// returns zero hits (searchFast/search). It must escape regex metacharacters
// like quoteIfPhrase BUT must NOT quote-wrap multi-token input, so the query
// degrades to zoekt's whitespace-AND conjunction. This is the recall recovery
// for natural-language prompts whose tokens are scattered in source (the
// real-repo A4 failure: phrase "hyperdrive meds source" matched nothing, the
// canonical source was absent; the unquoted AND form matched it). The contrast
// with quoteIfPhrase (which always quotes) is the load-bearing distinction.
describe("escapeForZoekt", () => {
  it("does NOT quote-wrap multi-token queries (the AND-form contract)", () => {
    // The key difference from quoteIfPhrase: no surrounding quotes, so zoekt
    // treats the tokens as an independent-clause conjunction, not a phrase.
    assert.equal(escapeForZoekt("hyperdrive meds source"), "hyperdrive meds source");
    assert.equal(escapeForZoekt("protocol Middleware"), "protocol Middleware");
    assert.notEqual(escapeForZoekt("protocol Middleware"), quoteIfPhrase("protocol Middleware"));
  });

  it("still escapes regex metacharacters (multi- and single-token)", () => {
    // Same escape policy as quoteIfPhrase, just without the quoting.
    assert.equal(escapeForZoekt("View+Toolbar foo"), "View\\+Toolbar foo");
    assert.equal(escapeForZoekt("a.b c"), "a\\.b c");
    assert.equal(escapeForZoekt("View+Toolbar"), "View\\+Toolbar");
  });

  it("leaves single-token queries identical to quoteIfPhrase (both unquoted)", () => {
    assert.equal(escapeForZoekt("Application"), "Application");
    assert.equal(escapeForZoekt("rerankFiles"), "rerankFiles");
  });

  it("strips embedded quotes and passes through caller-quoted DSL", () => {
    assert.equal(escapeForZoekt('foo "bar baz'), "foo bar baz");
    assert.equal(escapeForZoekt('"already quoted"'), '"already quoted"');
  });

  it("handles empty / whitespace-only / non-string input gracefully", () => {
    assert.equal(escapeForZoekt(""), "");
    assert.equal(escapeForZoekt("   "), "");
    assert.equal(escapeForZoekt(null), null);
    assert.equal(escapeForZoekt(42), 42);
  });
});

// WHY: rankByTokenCoverage powers the Tier-3 OR-fallback in search() — when a
// long NL question's tokens are scattered across the repo (no single file
// contains them all, so phrase AND both return nothing), the union (OR) query
// matches anything with ANY token. Ranking those by distinct-token COVERAGE
// floats the file that touches the most concepts above a file that merely
// repeats one common token. Pure function — locked here without a daemon.
describe("rankByTokenCoverage", () => {
  const tokens = ["clinical", "problems", "jaccard", "similarity"];

  it("ranks the highest-coverage file first, not the highest hit-count file", () => {
    const hits = [
      // a file that mentions ONE common token many times (high count, low coverage)
      { path: "noise.py", line: "clinical clinical clinical clinical", score: 900 },
      { path: "noise.py", line: "clinical note", score: 850 },
      // the canonical file: covers all four concepts across its lines (low per-line score)
      { path: "problem_clustering.py", line: "cluster clinical problems by", score: 400 },
      { path: "problem_clustering.py", line: "jaccard similarity threshold", score: 380 },
    ];
    const ranked = rankByTokenCoverage(hits, tokens);
    assert.equal(ranked[0].path, "problem_clustering.py"); // coverage 4 > coverage 1
    assert.equal(ranked.length, 2); // one (best) hit per file
  });

  it("breaks coverage ties by best line score and dedupes to one hit per file", () => {
    const hits = [
      { path: "a.py", line: "clinical problems", score: 100 },
      { path: "b.py", line: "clinical problems", score: 500 },
      { path: "b.py", line: "clinical", score: 200 },
    ];
    const ranked = rankByTokenCoverage(hits, tokens);
    assert.equal(ranked[0].path, "b.py"); // equal coverage (2), higher score wins
    assert.equal(ranked[0].score, 500); // keeps the best line
    assert.equal(ranked.length, 2);
  });
});
