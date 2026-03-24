/**
 * Extractor dispatcher - delegates to language-specific extractors.
 * 
 * This is the public API. Internal code should use this module,
 * not the individual extractor implementations directly.
 */

const extractors = require("./extractors");

/**
 * Extract import specifiers from source code.
 * @param {string} code - Source code
 * @param {string} fileType - File extension without dot (e.g., "ts", "py")
 * @returns {Array<{specifier: string, kind: string}>}
 */
function extractImports(code, fileType = "js") {
  const extractor = extractors.forExtension(fileType);
  if (!extractor) return [];
  return extractor.extractImports(code, fileType);
}

/**
 * Extract export declarations from source code.
 * @param {string} code - Source code
 * @param {string} fileType - File extension without dot (e.g., "ts", "py")
 * @returns {Array<{name: string, kind: string}>}
 */
function extractExports(code, fileType = "js") {
  const extractor = extractors.forExtension(fileType);
  if (!extractor) return [];
  return extractor.extractExports(code, fileType);
}

module.exports = {
  extractImports,
  extractExports,
};
