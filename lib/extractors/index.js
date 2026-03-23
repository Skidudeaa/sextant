/**
 * Extractor registry - maps file extensions to language extractors.
 * 
 * Each extractor module must export:
 *   - extensions: string[] - list of supported extensions (without dot)
 *   - extractImports(code: string, filePath: string): ImportSpec[]
 *   - extractExports(code: string, filePath: string): ExportSpec[]
 */

const path = require("path");

const javascript = require("./javascript");
const python = require("./python");

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

/**
 * Get extractor for a file path.
 * @param {string} filePath - File path
 * @returns {object|null} Extractor module or null
 */
function forFile(filePath) {
  const ext = path.extname(filePath).slice(1);
  return forExtension(ext);
}

/**
 * List all registered extensions.
 * @returns {string[]} Array of extensions (without dots)
 */
function listExtensions() {
  return Object.keys(byExtension);
}

/**
 * Check if a file extension is supported.
 * @param {string} ext - Extension with or without leading dot
 * @returns {boolean}
 */
function isSupported(ext) {
  return forExtension(ext) !== null;
}

// Register built-in extractors
register(javascript);
register(python);

module.exports = {
  register,
  forExtension,
  forFile,
  listExtensions,
  isSupported,
};
