/**
 * Python import/export extractor.
 * 
 * Shells to python_ast.py for correct AST-based extraction.
 * Falls back gracefully if python3 is not available.
 */

const { spawnSync } = require("child_process");
const path = require("path");
const crypto = require("crypto");

const SUPPORTED_EXTENSIONS = ["py"];

const SCRIPT_PATH = path.join(__dirname, "python_ast.py");

// Cache python3 availability check
let pythonAvailable = null;

// LRU cache for AST results to avoid double-parsing
// Key: content hash, Value: { imports, exports }
const astCache = new Map();
const AST_CACHE_MAX = 100;

function checkPython() {
  if (pythonAvailable !== null) return pythonAvailable;
  const r = spawnSync("python3", ["--version"], {
    encoding: "utf8",
    timeout: 5000,
  });
  pythonAvailable = r.status === 0;
  return pythonAvailable;
}

/**
 * Call python_ast.py and parse result.
 * Uses LRU cache to avoid re-parsing identical content.
 * @param {string} relPath - Relative file path
 * @param {string} content - File content
 * @returns {{ imports: Array, exports: object }}
 */
function extractPythonAST(relPath, content) {
  const empty = {
    imports: [],
    exports: { functions: [], classes: [], assignments: [], all: null },
  };

  if (!checkPython()) {
    return empty;
  }

  // Check cache first (keyed by content hash)
  const contentHash = crypto.createHash("md5").update(content || "").digest("hex");
  if (astCache.has(contentHash)) {
    return astCache.get(contentHash);
  }

  const input = JSON.stringify({ path: relPath, content });

  const r = spawnSync("python3", [SCRIPT_PATH], {
    input,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024, // 4MB
    timeout: 15000, // 15s max per file — matches scope-finder.js
  });

  if (r.status !== 0) {
    // Don't crash pipeline on extraction failure
    return empty;
  }

  let result;
  try {
    result = JSON.parse(r.stdout);
  } catch {
    return empty;
  }

  // Store in cache with LRU eviction
  if (astCache.size >= AST_CACHE_MAX) {
    const oldest = astCache.keys().next().value;
    astCache.delete(oldest);
  }
  astCache.set(contentHash, result);

  return result;
}

/**
 * Convert Python AST imports to the standard { specifier, kind } format.
 * 
 * Specifier format:
 *   - "import os"           → specifier: "os"
 *   - "from pkg.sub import x" → specifier: "pkg.sub"
 *   - "from . import foo"   → specifier: "."
 *   - "from ..pkg import x" → specifier: "..pkg"
 */
function normalizeImports(astImports) {
  const out = [];
  const seen = new Set();

  for (const imp of astImports) {
    let specifier;
    let kind;

    if (imp.kind === "import") {
      // import os, import os.path
      specifier = imp.module;
      kind = "import";
    } else {
      // from X import Y
      const dots = ".".repeat(imp.level || 0);
      specifier = imp.module ? `${dots}${imp.module}` : dots;
      kind = imp.level > 0 ? "relative" : "from";
    }

    const key = `${kind}:${specifier}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ specifier, kind });
  }

  return out;
}

/**
 * Convert Python exports to the standard { name, kind } format.
 */
function normalizeExports(astExports) {
  const out = [];

  // If __all__ is defined, use it as the authoritative export list
  if (Array.isArray(astExports.all)) {
    for (const name of astExports.all) {
      out.push({ name, kind: "explicit" });
    }
    return out;
  }

  // Otherwise, collect functions, classes, and constants
  for (const name of astExports.functions || []) {
    out.push({ name, kind: "function" });
  }
  for (const name of astExports.classes || []) {
    out.push({ name, kind: "class" });
  }
  for (const name of astExports.assignments || []) {
    out.push({ name, kind: "const" });
  }

  return out;
}

/**
 * Extract imports from Python source.
 * @param {string} code - Source code
 * @param {string} filePath - File path
 * @returns {Array<{specifier: string, kind: string}>}
 */
function extractImports(code, filePath) {
  if (!code) return [];
  const result = extractPythonAST(filePath, code);
  return normalizeImports(result.imports);
}

/**
 * Extract exports from Python source.
 * @param {string} code - Source code
 * @param {string} filePath - File path
 * @returns {Array<{name: string, kind: string}>}
 */
function extractExports(code, filePath) {
  if (!code) return [];
  const result = extractPythonAST(filePath, code);
  return normalizeExports(result.exports);
}

module.exports = {
  extensions: SUPPORTED_EXTENSIONS,
  extractImports,
  extractExports,
};
