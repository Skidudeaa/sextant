/**
 * AST-based JS/TS export extractor using @babel/parser.
 *
 * WHY: Regex-based export extraction misses re-exports with symbol-level
 * tracking (e.g., `export { useState } from './ReactHooks'`).  AST parsing
 * captures the full re-export chain, enabling barrel-file tracing in the
 * dependency graph.  On parse failure, returns null so the caller can fall
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

// WHY: Broad plugin set covers real-world code without per-file detection.
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
 * Extract exports from JS/TS/JSX code using AST parsing.
 *
 * @param {string} code - Source code
 * @param {string} filePath - File path (for diagnostics only)
 * @returns {Array<{name: string, kind: string, from?: string}>|null}
 *   Array of export specs, or null on parse failure (signals regex fallback).
 */
function extractExportsAST(code, filePath) {
  if (!parser) return null;
  if (!code) return [];

  let ast;
  try {
    ast = parser.parse(code, PARSE_OPTS);
  } catch {
    // WHY: Return null (not []) so the caller knows parsing failed and
    // should fall back to regex.  An empty array would mean "no exports found"
    // which is a valid result — null means "I couldn't parse this file".
    return null;
  }

  const out = [];
  const body = ast.program && ast.program.body;
  if (!Array.isArray(body)) return null;

  for (const node of body) {
    if (node.type === "ExportNamedDeclaration") {
      handleNamedExport(node, out);
    } else if (node.type === "ExportDefaultDeclaration") {
      handleDefaultExport(node, out);
    } else if (node.type === "ExportAllDeclaration") {
      handleExportAll(node, out);
    }
  }

  // WHY: CJS patterns are assignment expressions buried in the AST body,
  // not top-level export nodes.  We scan the full body for them so mixed
  // ESM/CJS files (common during migrations) get complete coverage.
  scanCJS(body, out);

  return dedupe(out);
}

// ── Export handlers ──

function handleNamedExport(node, out) {
  const source = node.source ? node.source.value : null;

  // WHY: exportKind "type" covers `export type { Foo } from './types'`
  // which is a TS-only pattern.  We track it separately so the graph can
  // distinguish value re-exports from type-only re-exports.
  const isTypeExport = node.exportKind === "type";

  // Case: export { a, b as c } or export { a, b } from './mod'
  // WHY: With the exportNamespaceFrom plugin, `export * as ns from './mod'`
  // is parsed as ExportNamedDeclaration with an ExportNamespaceSpecifier,
  // not as ExportAllDeclaration.  We detect that specifier type here.
  if (node.specifiers && node.specifiers.length > 0) {
    for (const spec of node.specifiers) {
      const exportedName = spec.exported
        ? (spec.exported.name || spec.exported.value)
        : (spec.local ? spec.local.name : null);
      if (!exportedName) continue;

      if (spec.type === "ExportNamespaceSpecifier" && source) {
        out.push({ name: exportedName, kind: "reexport-namespace", from: source });
      } else if (source) {
        // Re-export: export { a } from './mod'
        const kind = isTypeExport ? "type-reexport" : "reexport";
        out.push({ name: exportedName, kind, from: source });
      } else {
        // Local export: export { a, b as c }
        const kind = isTypeExport ? "type" : "named";
        out.push({ name: exportedName, kind });
      }
    }
    return;
  }

  // Case: export with declaration (function, class, variable, type, interface)
  const decl = node.declaration;
  if (!decl) return;

  if (decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") {
    const name = decl.id ? decl.id.name : "default";
    out.push({ name, kind: "named" });
  } else if (decl.type === "VariableDeclaration") {
    for (const declarator of decl.declarations || []) {
      if (declarator.id && declarator.id.name) {
        out.push({ name: declarator.id.name, kind: "named" });
      }
    }
  } else if (decl.type === "TSTypeAliasDeclaration" || decl.type === "TypeAlias") {
    const name = decl.id ? decl.id.name : null;
    if (name) out.push({ name, kind: "type" });
  } else if (
    decl.type === "TSInterfaceDeclaration" ||
    decl.type === "InterfaceDeclaration"
  ) {
    const name = decl.id ? decl.id.name : null;
    if (name) out.push({ name, kind: "type" });
  } else if (decl.type === "TSEnumDeclaration") {
    const name = decl.id ? decl.id.name : null;
    if (name) out.push({ name, kind: "named" });
  }
}

function handleDefaultExport(node, out) {
  const decl = node.declaration;
  if (!decl) {
    out.push({ name: "default", kind: "default" });
    return;
  }

  // export default function foo() / export default class Bar
  if (decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") {
    const name = decl.id ? decl.id.name : "default";
    out.push({ name, kind: "default" });
  } else {
    // export default <expression>
    out.push({ name: "default", kind: "default" });
  }
}

function handleExportAll(node, out) {
  const source = node.source ? node.source.value : null;
  if (!source) return;

  // export * as ns from './mod'
  if (node.exported) {
    const name = node.exported.name || node.exported.value;
    out.push({ name: name || "*", kind: "reexport-namespace", from: source });
  } else {
    // export * from './mod'
    out.push({ name: "*", kind: "reexport-all", from: source });
  }
}

// ── CJS scanning ──

/**
 * Scan AST body for CommonJS export patterns.
 *
 * WHY: Many Node.js codebases use CJS even when the AST parser treats
 * the file as a module.  We look for the three canonical patterns:
 *   1. module.exports = X
 *   2. module.exports = { a, b }  (also emit per-property cjs-named)
 *   3. exports.foo = ...
 *   4. exports = module.exports = X
 *   5. Object.assign(exports, { a, b })
 */
function scanCJS(body, out) {
  for (const node of body) {
    if (node.type === "ExpressionStatement" && node.expression) {
      scanCJSExpression(node.expression, out);
    }
  }
}

function scanCJSExpression(expr, out) {
  if (expr.type !== "AssignmentExpression") {
    // Check for Object.assign(exports, { ... })
    if (expr.type === "CallExpression") {
      handleObjectAssignExports(expr, out);
    }
    return;
  }

  const left = expr.left;
  const right = expr.right;

  // Pattern: module.exports = X
  if (isModuleExports(left)) {
    out.push({ name: "default", kind: "cjs-default" });
    // If RHS is an object literal, also emit per-property cjs-named
    if (right && right.type === "ObjectExpression") {
      emitObjectProperties(right, out);
    }
    return;
  }

  // Pattern: exports.foo = ...
  if (isExportsDotProp(left)) {
    const name = left.property ? (left.property.name || left.property.value) : null;
    if (name) {
      out.push({ name, kind: "cjs-named" });
    }
    return;
  }

  // Pattern: exports = module.exports = X
  if (isExportsIdent(left) && right && right.type === "AssignmentExpression") {
    if (isModuleExports(right.left)) {
      out.push({ name: "default", kind: "cjs-default" });
      if (right.right && right.right.type === "ObjectExpression") {
        emitObjectProperties(right.right, out);
      }
    }
  }
}

function handleObjectAssignExports(expr, out) {
  if (!expr.callee || expr.callee.type !== "MemberExpression") return;
  const obj = expr.callee.object;
  const prop = expr.callee.property;
  if (!obj || obj.name !== "Object") return;
  if (!prop || prop.name !== "assign") return;

  const args = expr.arguments;
  if (!args || args.length < 2) return;

  // First arg should be `exports` or `module.exports`
  const target = args[0];
  if (!isExportsIdent(target) && !isModuleExports(target)) return;

  // Second arg should be an object literal
  for (let i = 1; i < args.length; i++) {
    if (args[i].type === "ObjectExpression") {
      emitObjectProperties(args[i], out);
    }
  }
}

function emitObjectProperties(objExpr, out) {
  for (const prop of objExpr.properties || []) {
    if (prop.type === "SpreadElement") continue;
    // Shorthand: { foo } or keyed: { foo: bar }
    const name = prop.key
      ? (prop.key.name || prop.key.value)
      : null;
    if (name) {
      out.push({ name, kind: "cjs-named" });
    }
  }
}

// ── AST node helpers ──

function isModuleExports(node) {
  return (
    node &&
    node.type === "MemberExpression" &&
    node.object &&
    node.object.name === "module" &&
    node.property &&
    (node.property.name === "exports" || node.property.value === "exports")
  );
}

function isExportsDotProp(node) {
  return (
    node &&
    node.type === "MemberExpression" &&
    node.object &&
    node.object.name === "exports" &&
    node.property &&
    !isModuleExports(node) // exclude module.exports
  );
}

function isExportsIdent(node) {
  return node && node.type === "Identifier" && node.name === "exports";
}

// ── Deduplication ──

function dedupe(items) {
  const seen = new Set();
  const result = [];
  for (const it of items) {
    // WHY: Include `from` in the key so `export { foo }` and
    // `export { foo } from './mod'` are both kept.
    const key = `${it.kind}\0${it.name}\0${it.from || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(it);
  }
  return result;
}

module.exports = { extractExportsAST };
