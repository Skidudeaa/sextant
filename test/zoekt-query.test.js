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

  it("leaves single-token queries unchanged", () => {
    assert.equal(quoteIfPhrase("Application"), "Application");
    assert.equal(quoteIfPhrase("rerankFiles"), "rerankFiles");
    assert.equal(quoteIfPhrase("URLSession"), "URLSession");
  });

  it("trims surrounding whitespace before deciding", () => {
    assert.equal(quoteIfPhrase("  Application  "), "Application");
    assert.equal(quoteIfPhrase("  protocol Middleware  "), '"protocol Middleware"');
  });

  it("passes through queries that the caller already quoted", () => {
    assert.equal(quoteIfPhrase('"already quoted"'), '"already quoted"');
    assert.equal(quoteIfPhrase('"single"'), '"single"');
  });

  it("strips embedded double quotes inside an unquoted multi-token query", () => {
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
