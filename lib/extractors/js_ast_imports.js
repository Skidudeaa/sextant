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

// PARSE FRONT-END (docs/033 Tier 2 #6): shared with js_ast_exports so a file
// indexed by both lanes is parsed ONCE, not twice. The plugin set used to be
// duplicated here verbatim; it now lives in one place and cannot drift.
const { parseJs } = require("./js_ast_cache");

/**
 * Extract imports from JS/TS/JSX code using AST parsing.
 *
 * @param {string} code - Source code
 * @param {string} filePath - File path (for diagnostics only)
 * @returns {Array<{specifier: string, kind: string}>|null}
 *   Array of import specs, or null on parse failure (signals regex fallback).
 */
function extractImportsAST(code, filePath) {
  if (!code) return [];

  // null = parse failed or no parser. The caller reads that as "fall back to
  // regex"; an empty array would instead mean "parsed fine, no imports".
  const ast = parseJs(code);
  if (!ast) return null;

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
