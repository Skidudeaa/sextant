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

/**
 * Extract span-tagged declarations (Swift v1).  Returns [] for extractors that
 * don't implement it, so JS/Python paths stay byte-identical without changes
 * to their modules.
 * @param {string} code - Source code
 * @param {string} fileType - File extension without dot (e.g., "ts", "py", "swift")
 * @returns {Array<{name: string, kind: string, parent_name?: string|null,
 *   parent_kind?: string|null, start_byte: number, end_byte: number,
 *   start_line: number, start_col: number, signature_hint?: string|null}>}
 */
function extractDeclarations(code, fileType = "js") {
  const extractor = extractors.forExtension(fileType);
  if (!extractor || typeof extractor.extractDeclarations !== "function") return [];
  return extractor.extractDeclarations(code, fileType);
}

/**
 * Extract structural relations (Swift v1: extends / conforms_to / inherits_from).
 * Each relation links to a specific declaration via source span so multiple
 * `extension Foo {}` blocks in the same file remain distinguishable.
 * @param {string} code - Source code
 * @param {string} fileType - File extension without dot
 * @returns {Array<{source_name: string, source_start_byte: number,
 *   source_end_byte: number, kind: "extends"|"conforms_to"|"inherits_from",
 *   target_name: string, confidence: "direct"|"heuristic"}>}
 */
function extractRelations(code, fileType = "js") {
  const extractor = extractors.forExtension(fileType);
  if (!extractor || typeof extractor.extractRelations !== "function") return [];
  return extractor.extractRelations(code, fileType);
}

module.exports = {
  extractImports,
  extractExports,
  extractDeclarations,
  extractRelations,
};
