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
 * Call python_ast.py in batch mode for multiple files in a single subprocess.
 * @param {Array<{relPath: string, content: string}>} items - Files to extract
 * @returns {Array<{imports: Array, exports: object}>} Results in same order as input
 */
function extractPythonASTBatch(items) {
  const empty = {
    imports: [],
    exports: { functions: [], classes: [], assignments: [], all: null },
  };

  if (!checkPython() || items.length === 0) {
    return items.map(() => empty);
  }

  const input = JSON.stringify({
    mode: "batch_extract",
    items: items.map((it) => ({ path: it.relPath, content: it.content })),
  });

  const r = spawnSync("python3", [SCRIPT_PATH], {
    input,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024, // 4MB
    timeout: 15000 + items.length * 1000, // scale timeout with batch size
  });

  if (r.status !== 0) {
    return null; // signal caller to fall back to per-file
  }

  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return null; // signal caller to fall back to per-file
  }

  if (!Array.isArray(parsed.results) || parsed.results.length !== items.length) {
    return null; // unexpected shape, fall back
  }

  return parsed.results;
}

/**
 * Extract imports and exports for multiple Python files in a single subprocess.
 * Checks the AST cache first, sends only uncached items to the batch subprocess,
 * then populates the cache with results.
 *
 * Falls back to per-file extraction if the batch call fails.
 *
 * @param {Array<{relPath: string, content: string}>} items - Files to extract
 * @returns {Array<{imports: Array<{specifier: string, kind: string}>, exports: Array<{name: string, kind: string}>}>}
 */
function extractBatch(items) {
  if (!items || items.length === 0) return [];

  // Build content hashes and check cache for each item
  const hashes = items.map((it) =>
    crypto.createHash("md5").update(it.content || "").digest("hex")
  );

  // results[i] = cached result or null (needs extraction)
  const results = hashes.map((h) => (astCache.has(h) ? astCache.get(h) : null));

  // Collect indices of uncached items
  const uncachedIndices = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i] === null) {
      uncachedIndices.push(i);
    }
  }

  if (uncachedIndices.length > 0) {
    // Try batch extraction for uncached items
    const uncachedItems = uncachedIndices.map((i) => items[i]);
    const batchResults = extractPythonASTBatch(uncachedItems);

    if (batchResults !== null) {
      // Batch succeeded — populate cache and results
      for (let j = 0; j < uncachedIndices.length; j++) {
        const idx = uncachedIndices[j];
        const raw = batchResults[j];

        // Store in cache with LRU eviction
        if (astCache.size >= AST_CACHE_MAX) {
          const oldest = astCache.keys().next().value;
          astCache.delete(oldest);
        }
        astCache.set(hashes[idx], raw);
        results[idx] = raw;
      }
    } else {
      // Batch failed — fall back to per-file extraction
      for (const idx of uncachedIndices) {
        const raw = extractPythonAST(items[idx].relPath, items[idx].content);
        results[idx] = raw;
      }
    }
  }

  // Normalize all results to standard format
  return results.map((raw) => ({
    imports: normalizeImports(raw.imports),
    exports: normalizeExports(raw.exports),
  }));
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

  const fns = new Set(astExports.functions || []);
  const classes = new Set(astExports.classes || []);
  const consts = new Set(astExports.assignments || []);

  // WHY: __all__ is the module's declared public API, but a name listed there is
  // either locally DEFINED (a real def) or merely IMPORTED-then-re-exported (a
  // barrel / __init__ shim). The old code tagged EVERY __all__ name "explicit",
  // erasing that distinction — so graph-retrieve and the merge-layer
  // canonical-def floor could not tell a re-export barrel from a definition, and
  // a barrel re-exporting a signal-less def (e.g. a module constant) got the def
  // floor and outranked the real def (B3 edge, 2026-05-28). Cross-reference each
  // __all__ name against the locally-defined functions/classes/constants:
  // locally-defined names keep their construct kind; only names with NO local
  // definition (true re-exports) get "explicit". This makes "explicit" reliably
  // mean "re-export", which graph-retrieve depends on to withhold the def floor.
  if (Array.isArray(astExports.all)) {
    for (const name of astExports.all) {
      let kind;
      if (classes.has(name)) kind = "class";
      else if (fns.has(name)) kind = "function";
      else if (consts.has(name)) kind = "const";
      else kind = "explicit"; // in __all__ but not defined locally → re-export
      out.push({ name, kind });
    }
    return out;
  }

  // Otherwise, collect functions, classes, and constants
  for (const name of fns) out.push({ name, kind: "function" });
  for (const name of classes) out.push({ name, kind: "class" });
  for (const name of consts) out.push({ name, kind: "const" });

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
  extractBatch,
};
