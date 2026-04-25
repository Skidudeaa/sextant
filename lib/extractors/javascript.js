/**
 * JavaScript/TypeScript import/export extractor.
 * Handles: ESM, CJS, dynamic imports, TS type exports.
 *
 * WHY: Both import and export extraction use AST-first with regex fallback.
 * The AST path (via @babel/parser) captures re-exports with symbol-level
 * tracking needed for barrel-file tracing, and naturally ignores import-
 * looking calls that live inside string literals (a common test-fixture
 * pattern that produced false-positive misses in regex-only mode).  On parse
 * failure the regex path preserves the existing behavior — never crash,
 * never lose data.
 */

const { extractExportsAST } = require("./js_ast_exports");
const { extractImportsAST } = require("./js_ast_imports");

const SUPPORTED_EXTENSIONS = ["ts", "tsx", "js", "jsx", "mjs", "cjs"];

function dedupe(items, keyFn) {
  const m = new Map();
  for (const it of items) m.set(keyFn(it), it);
  return [...m.values()];
}

function stripComments(src) {
  // Heuristic only: good enough to avoid most comment-driven false positives.
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function extractImports(code, filePath) {
  if (!code) return [];

  // WHY: AST-first avoids regex false positives from import/require calls
  // that live inside string literals (test fixtures, doc snippets).  Regex
  // fallback keeps the system working when @babel/parser chokes or isn't
  // installed.
  const astResult = extractImportsAST(code, filePath);
  if (astResult !== null) return astResult;

  return extractImportsRegex(code);
}

function extractImportsRegex(code) {
  const src = stripComments(code);
  const specs = [];

  // ESM: import ... from "x"
  for (const m of src.matchAll(
    /^\s*import\s+(?:type\s+)?[\s\S]{0,500}?\sfrom\s*["']([^"']+)["']/gm
  )) {
    specs.push({ specifier: m[1], kind: "import" });
  }

  // ESM: import "x"
  for (const m of src.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) {
    specs.push({ specifier: m[1], kind: "import" });
  }

  // ESM re-exports: export ... from "x"
  for (const m of src.matchAll(
    /^\s*export\s+[\s\S]{0,500}?\sfrom\s*["']([^"']+)["']/gm
  )) {
    specs.push({ specifier: m[1], kind: "export-from" });
  }

  // Dynamic import("x")
  for (const m of src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    specs.push({ specifier: m[1], kind: "dynamic" });
  }

  // CJS require("x")
  for (const m of src.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    specs.push({ specifier: m[1], kind: "require" });
  }

  return dedupe(specs, (x) => `${x.kind}\0${x.specifier}`);
}

function extractExports(code, filePath) {
  if (!code) return [];

  // WHY: AST-first gives us re-export tracking with `from` field for barrel-file
  // tracing.  Regex fallback keeps the system working when @babel/parser chokes
  // on exotic syntax or isn't installed.
  const astResult = extractExportsAST(code, filePath);
  if (astResult !== null) return astResult;

  // ── Regex fallback (proven path, unchanged) ──
  return extractExportsRegex(code);
}

function extractExportsRegex(code) {
  const src = stripComments(code);
  const out = [];

  if (/\bexport\s+default\b/.test(src)) {
    out.push({ name: "default", kind: "default" });
  }

  // export function Foo / export class Bar / export const Baz
  for (const m of src.matchAll(/\bexport\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g)) {
    out.push({ name: m[1], kind: "named" });
  }
  for (const m of src.matchAll(/\bexport\s+class\s+([A-Za-z0-9_$]+)/g)) {
    out.push({ name: m[1], kind: "named" });
  }
  for (const m of src.matchAll(/\bexport\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g)) {
    out.push({ name: m[1], kind: "named" });
  }

  // TS types
  for (const m of src.matchAll(/\bexport\s+type\s+([A-Za-z0-9_$]+)/g)) {
    out.push({ name: m[1], kind: "type" });
  }
  for (const m of src.matchAll(/\bexport\s+interface\s+([A-Za-z0-9_$]+)/g)) {
    out.push({ name: m[1], kind: "type" });
  }

  // export { a, b as c }
  for (const m of src.matchAll(/\bexport\s*\{\s*([^}]+)\s*\}(?!\s*from)/g)) {
    const body = m[1];
    const parts = body.split(",").map((s) => s.trim()).filter(Boolean);
    for (const part of parts) {
      const [lhs, rhs] = part.split(/\s+as\s+/i).map((s) => s.trim());
      const name = rhs || lhs;
      if (name) out.push({ name, kind: "named" });
    }
  }

  // CommonJS: module.exports = ...
  if (/\bmodule\.exports\s*=/.test(src)) {
    out.push({ name: "default", kind: "cjs-default" });
  }

  // CommonJS: exports.foo =
  for (const m of src.matchAll(/\bexports\.([A-Za-z0-9_$]+)\s*=/g)) {
    out.push({ name: m[1], kind: "cjs-named" });
  }

  return dedupe(out, (x) => `${x.kind}\0${x.name}`);
}

module.exports = {
  extensions: SUPPORTED_EXTENSIONS,
  extractImports,
  extractExports,
};
