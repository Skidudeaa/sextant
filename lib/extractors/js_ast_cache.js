/**
 * Shared @babel/parser front-end for the JS/TS extractors.
 *
 * WHY (docs/033 Tier 2 #6): `intel.js:indexOneFile` calls extractImports() and
 * extractExports() back-to-back on the SAME source string, and each used to run
 * its own `parser.parse(code, PARSE_OPTS)` with byte-identical options. Every
 * JS/TS file in the repo was therefore parsed TWICE. A CPU profile of a forced
 * scan put @babel/parser at 33.2% of total samples — about half of that was the
 * redundant second parse.
 *
 * The cache holds exactly ONE entry (the last parse). That is all the access
 * pattern needs — the two consumers are adjacent — and it bounds memory to a
 * single AST instead of growing with repo size. Keyed on the exact source
 * STRING, never on a path: a file whose contents changed produces a different
 * key and re-parses, so a stale AST can never be served.
 *
 * Parse FAILURES are cached too. Both extractors return null on failure to
 * signal "fall back to regex", and re-attempting a parse that already threw
 * would pay the full cost twice for no new information.
 *
 * Both walkers are read-only (they never assign to or delete AST nodes), so
 * handing them the same object is safe. If a future walker needs to annotate
 * nodes, it must copy first or this sharing becomes a cross-extractor bug.
 */

"use strict";

let parser;
try {
  parser = require("@babel/parser");
} catch {
  // Degrade gracefully: callers check for null and fall back to regex.
  parser = null;
}

// Broad plugin set covers real-world code without per-file detection.
// errorRecovery: true ensures partial results from files with syntax errors.
// SHARED so the import and export lanes can never drift apart — they were
// previously two copies that happened to be identical.
const PARSE_OPTS = {
  sourceType: "module",
  allowImportExportEverywhere: true,
  errorRecovery: true,
  plugins: [
    "jsx",
    "typescript",
    "decorators-legacy",
    "classProperties",
    "dynamicImport",
    "exportDefaultFrom",
    "exportNamespaceFrom",
  ],
};

let lastCode = null;
let lastAst; // undefined = nothing cached; null = cached parse FAILURE

/**
 * Parse JS/TS source, reusing the immediately-preceding parse of the same
 * source. Returns the AST, or null when parsing failed / the parser is absent
 * (the caller's signal to fall back to its regex extractor).
 *
 * @param {string} code
 * @returns {object|null}
 */
function parseJs(code) {
  if (!parser) return null;
  if (lastAst !== undefined && lastCode === code) return lastAst;

  let ast;
  try {
    ast = parser.parse(code, PARSE_OPTS);
  } catch {
    ast = null;
  }
  lastCode = code;
  lastAst = ast;
  return ast;
}

// Tests use this to prove the second call is served from cache rather than
// re-parsing, and to isolate cases from each other.
function _resetCache() {
  lastCode = null;
  lastAst = undefined;
}

module.exports = { parseJs, PARSE_OPTS, _resetCache, _hasParser: () => !!parser };
