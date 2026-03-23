/**
 * Extractor dispatcher - delegates to language-specific extractors.
 * 
 * This is the public API. Internal code should use this module,
 * not the individual extractor implementations directly.
 */

const path = require("path");
const extractors = require("./extractors");

/**
 * Get file type from path (extension without dot).
 * @param {string} filePath
 * @returns {string}
 */
function getFileType(filePath) {
  return path.extname(filePath).slice(1).toLowerCase();
}

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

/**
 * Extract imports from a file path (determines type from extension).
 * @param {string} code - Source code
 * @param {string} filePath - File path (used to determine language)
 * @returns {Array<{specifier: string, kind: string}>}
 */
function extractImportsFromFile(code, filePath) {
  const extractor = extractors.forFile(filePath);
  if (!extractor) return [];
  return extractor.extractImports(code, filePath);
}

/**
 * Extract exports from a file path (determines type from extension).
 * @param {string} code - Source code
 * @param {string} filePath - File path (used to determine language)
 * @returns {Array<{name: string, kind: string}>}
 */
function extractExportsFromFile(code, filePath) {
  const extractor = extractors.forFile(filePath);
  if (!extractor) return [];
  return extractor.extractExports(code, filePath);
}

/**
 * Check if a file type is supported for extraction.
 * @param {string} fileType - File extension without dot
 * @returns {boolean}
 */
function isSupported(fileType) {
  return extractors.isSupported(fileType);
}

/**
 * List all supported file extensions.
 * @returns {string[]}
 */
function listSupportedExtensions() {
  return extractors.listExtensions();
}

module.exports = {
  extractImports,
  extractExports,
  extractImportsFromFile,
  extractExportsFromFile,
  isSupported,
  listSupportedExtensions,
  getFileType,
};
