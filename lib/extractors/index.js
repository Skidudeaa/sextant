/**
 * Extractor registry - maps file extensions to language extractors.
 * 
 * Each extractor module must export:
 *   - extensions: string[] - list of supported extensions (without dot)
 *   - extractImports(code: string, filePath: string): ImportSpec[]
 *   - extractExports(code: string, filePath: string): ExportSpec[]
 */

const javascript = require("./javascript");
const python = require("./python");
const swift = require("./swift");

// Registry: extension (without dot) -> extractor module
const byExtension = {};

/**
 * Register an extractor for its declared extensions.
 * @param {object} extractor - Extractor module with extensions array
 */
function register(extractor) {
  if (!extractor || !Array.isArray(extractor.extensions)) return;
  for (const ext of extractor.extensions) {
    byExtension[ext.toLowerCase()] = extractor;
  }
}

/**
 * Get extractor for a file extension.
 * @param {string} ext - Extension with or without leading dot
 * @returns {object|null} Extractor module or null
 */
function forExtension(ext) {
  const normalized = String(ext).replace(/^\./, "").toLowerCase();
  return byExtension[normalized] || null;
}

// Register built-in extractors
register(javascript);
register(python);
register(swift);

module.exports = {
  register,
  forExtension,
};
