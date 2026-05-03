"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { quoteIfPhrase } = require("../lib/zoekt");

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
