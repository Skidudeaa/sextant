/**
 * AST-based JS/TS import extractor using @babel/parser.
 *
 * WHY: Regex-based import extraction picks up `require("./x")` and
 * `import("./x")` calls inside string literals — common in test fixtures
 * that pass source-code strings to extractors as test inputs.  Those false
 * positives show up as unresolved imports in health output every session.
 * AST parsing only walks real call expressions, so string-literal contents
 * are never visited.  On parse failure, returns null so the caller falls
 * back to the proven regex extractor — never crash, never lose data.
 */

"use strict";

let parser;
try {
  parser = require("@babel/parser");
} catch {
  // WHY: If @babel/parser is not installed, we degrade gracefully.
  // The caller checks for null return and falls back to regex.
  parser = null;
}

// WHY: Mirror the export extractor's plugin set so we cover the same files.
// errorRecovery: true ensures partial results from files with syntax errors.
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

/**
 * Extract imports from JS/TS/JSX code using AST parsing.
 *
 * @param {string} code - Source code
 * @param {string} filePath - File path (for diagnostics only)
 * @returns {Array<{specifier: string, kind: string}>|null}
 *   Array of import specs, or null on parse failure (signals regex fallback).
 */
function extractImportsAST(code, filePath) {
  if (!parser) return null;
  if (!code) return [];

  let ast;
  try {
    ast = parser.parse(code, PARSE_OPTS);
  } catch {
    // WHY: Return null so the caller knows parsing failed and should fall
    // back to regex.  An empty array would mean "no imports found" — a valid
    // result.  null means "I couldn't parse this file".
    return null;
  }

  const out = [];
  const body = ast.program && ast.program.body;
  if (!Array.isArray(body)) return null;

  // Top-level import/export statements
  for (const node of body) {
    if (node.type === "ImportDeclaration") {
      const src = node.source && node.source.value;
      if (src) out.push({ specifier: src, kind: "import" });
    } else if (
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration"
    ) {
      const src = node.source && node.source.value;
      if (src) out.push({ specifier: src, kind: "export-from" });
    }
  }

  // Walk the full AST for dynamic import() and require() calls.
  // WHY: Both can appear anywhere — inside functions, conditionals, etc.
  walk(ast.program, (node) => {
    if (!node || typeof node.type !== "string") return;

    if (node.type === "CallExpression") {
      // Dynamic import("x")
      if (node.callee && node.callee.type === "Import") {
        const arg = node.arguments && node.arguments[0];
        if (arg && arg.type === "StringLiteral") {
          out.push({ specifier: arg.value, kind: "dynamic" });
        }
        return;
      }

      // require("x")
      if (
        node.callee &&
        node.callee.type === "Identifier" &&
        node.callee.name === "require"
      ) {
        const arg = node.arguments && node.arguments[0];
        if (arg && arg.type === "StringLiteral") {
          out.push({ specifier: arg.value, kind: "require" });
        }
      }
    }
  });

  return dedupe(out);
}

// ── AST walker ──

// WHY: Hand-rolled to avoid a dep on @babel/traverse (multi-MB).  We only
// need to visit each node once; order doesn't matter for our use case.
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node.type !== "string") return;

  visit(node);

  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "range" || key === "start" || key === "end") {
      continue;
    }
    const child = node[key];
    if (child && typeof child === "object") walk(child, visit);
  }
}

// ── Deduplication ──

function dedupe(items) {
  const seen = new Set();
  const result = [];
  for (const it of items) {
    const key = `${it.kind}\0${it.specifier}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(it);
  }
  return result;
}

module.exports = { extractImportsAST };
