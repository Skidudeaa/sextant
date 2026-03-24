// ARCHITECTURE: Lightweight search scoring improvements without vector embeddings.
// WHY: Structural reranking (fan-in/fan-out) already handles importance; these
//      additions improve lexical matching quality for symbol/pattern queries.
// TRADEOFF: Slightly more processing per query vs significantly better relevance.

// Very common keywords that add noise to matches (multi-language)
const COMMON_NOISE_WORDS = new Set([
  // JavaScript/TypeScript
  "const",
  "let",
  "var",
  "function",
  "class",
  "return",
  "import",
  "export",
  "from",
  "require",
  "module",
  "exports",
  "default",
  "if",
  "else",
  "for",
  "while",
  "switch",
  "case",
  "break",
  "continue",
  "try",
  "catch",
  "finally",
  "throw",
  "new",
  "this",
  "true",
  "false",
  "null",
  "undefined",
  "void",
  "typeof",
  "instanceof",
  "async",
  "await",
  "yield",
  "static",
  "public",
  "private",
  "protected",
  "readonly",
  "extends",
  "implements",
  "interface",
  "type",
  "enum",
  "abstract",
  // Python-specific
  "def",
  "self",
  "cls",
  "None",
  "and",
  "or",
  "not",
  "in",
  "is",
  "as",
  "with",
  "pass",
  "lambda",
  "global",
  "nonlocal",
  "assert",
  "raise",
  "except",
  "elif",
  "yield",
  "from",
  "print",
  "len",
  "str",
  "int",
  "float",
  "bool",
  "list",
  "dict",
  "set",
  "tuple",
  "range",
  "super",
  "property",
  "staticmethod",
  "classmethod",
  "isinstance",
  "hasattr",
  "getattr",
  "setattr",
]);

// Symbol definition patterns by language - Python prioritized
const SYMBOL_DEF_PATTERNS = [
  // Python function definitions (sync and async)
  /^\s*(?:async\s+)?def\s+(\w+)\s*\(/,
  // Python class definitions
  /^\s*class\s+(\w+)(?:\s*\(|\s*:)/,
  // Python decorated definitions (capture the def/class after decorator)
  /^\s*@\w+.*\n\s*(?:async\s+)?def\s+(\w+)/,
  // Python variable assignment at module level (CONSTANT or regular)
  /^([A-Z][A-Z0-9_]+)\s*=/,
  /^(\w+)\s*:\s*\w+\s*=/,
  // JS/TS function definitions
  /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
  // JS/TS arrow function assignments
  /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>/,
  // JS/TS class definitions
  /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
  // JS/TS method definitions (inside class)
  /^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/,
  // WHY: CommonJS prototype/object method assignment (e.g. app.use = function use(fn) {},
  // res.json = function json(obj) {}).  Express uses this pattern extensively and it was
  // invisible to definition-site scoring in cross-project testing.
  /^\s*\w+\.(\w+)\s*=\s*function\s+\w+/,
  // CommonJS named exports: exports.X = ... or module.exports.X = ...
  /^\s*(?:module\.)?exports\.(\w+)\s*=/,
  // TS interface/type definitions
  /^\s*(?:export\s+)?(?:interface|type)\s+(\w+)/,
  // Go function/type
  /^func\s+(?:\([^)]+\)\s+)?(\w+)/,
  /^type\s+(\w+)/,
  // Rust function/struct/enum
  /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,
  /^\s*(?:pub\s+)?struct\s+(\w+)/,
  /^\s*(?:pub\s+)?enum\s+(\w+)/,
];

// Extract symbol name from a line if it's a definition
function extractSymbolDef(line) {
  if (typeof line !== "string") return null;
  for (const pattern of SYMBOL_DEF_PATTERNS) {
    const m = line.match(pattern);
    if (m && m[1]) return m[1];
  }
  return null;
}

// Check if query term matches symbol name exactly
function isExactSymbolMatch(line, queryTerms) {
  const sym = extractSymbolDef(line);
  if (!sym) return false;
  const symLower = sym.toLowerCase();
  return queryTerms.some((t) => t.toLowerCase() === symLower);
}

// Count how many noise words dominate the line
function noiseWordRatio(line) {
  if (typeof line !== "string") return 0;
  const words = line
    .replace(/[^a-zA-Z0-9_]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) return 0;
  const noiseCount = words.filter((w) => COMMON_NOISE_WORDS.has(w.toLowerCase())).length;
  return noiseCount / words.length;
}

// Check if line is primarily an export statement with the query term
function isExportStatement(line, queryTerms) {
  if (typeof line !== "string") return false;

  // JS/TS export
  if (/^\s*export\s+/.test(line)) {
    const lineLower = line.toLowerCase();
    return queryTerms.some((t) => lineLower.includes(t.toLowerCase()));
  }

  // CommonJS exports: exports.X = ... or module.exports = ...
  if (/^\s*(?:module\.)?exports[\s.=]/.test(line)) {
    const lineLower = line.toLowerCase();
    return queryTerms.some((t) => lineLower.includes(t.toLowerCase()));
  }

  // Python __all__ definition (public API declaration)
  if (/^\s*__all__\s*=/.test(line)) {
    const lineLower = line.toLowerCase();
    return queryTerms.some((t) => lineLower.includes(t.toLowerCase()));
  }

  return false;
}

// Check if this is a Python public function/class (not prefixed with _)
function isPythonPublicSymbol(line) {
  if (typeof line !== "string") return false;
  // Python def/class that doesn't start with underscore = public
  const match = line.match(/^\s*(?:async\s+)?(?:def|class)\s+(\w+)/);
  if (match && match[1] && !match[1].startsWith("_")) {
    return true;
  }
  return false;
}

// Compute additional scoring signals for a hit
function computeEnhancedSignals(hit, queryTerms, opts = {}) {
  const explain = !!opts.explainHits;
  const signals = [];
  let adjustment = 0;
  const base = Number.isFinite(hit.score) ? hit.score : 1;

  const line = hit.line || "";
  const filePath = hit.path || "";
  const isPython = filePath.endsWith(".py");

  // Signal 1: Exact symbol match (strong boost)
  // WHY: +40% (raised from +25%) so definition-site matches can outweigh fan-in
  // boosts on hub files like intel.js.  The eval showed +25% was too weak to
  // overcome fan-in promotion, causing MRR drops on sym-002, path-001, path-002.
  if (isExactSymbolMatch(line, queryTerms)) {
    adjustment += base * 0.4;
    if (explain) signals.push("exact_symbol:+40%");
  }

  // Signal 2: Export statement with query term (moderate boost)
  if (isExportStatement(line, queryTerms)) {
    adjustment += base * 0.1;
    if (explain) signals.push("export_match:+10%");
  }

  // Signal 3: High noise ratio penalty
  const noise = noiseWordRatio(line);
  if (noise > 0.7) {
    adjustment -= base * 0.15;
    if (explain) signals.push(`noise_ratio:${Math.round(noise * 100)}%:-15%`);
  } else if (noise > 0.5) {
    adjustment -= base * 0.08;
    if (explain) signals.push(`noise_ratio:${Math.round(noise * 100)}%:-8%`);
  }

  // Signal 4: Symbol definition line bonus
  const symName = extractSymbolDef(line);
  if (symName) {
    // Check if query appears in symbol name (partial match)
    const symLower = symName.toLowerCase();
    if (queryTerms.some((t) => symLower.includes(t.toLowerCase()))) {
      adjustment += base * 0.12;
      if (explain) signals.push("symbol_contains_query:+12%");
    }
  }

  // Signal 5: Python public symbol boost (not prefixed with _)
  if (isPython && isPythonPublicSymbol(line)) {
    const lineLower = line.toLowerCase();
    if (queryTerms.some((t) => lineLower.includes(t.toLowerCase()))) {
      adjustment += base * 0.08;
      if (explain) signals.push("python_public:+8%");
    }
  }

  // Signal 6: Docstring/comment containing query (documentation match)
  if (isPython && /^\s*("""|'''|#)/.test(line)) {
    const lineLower = line.toLowerCase();
    if (queryTerms.some((t) => lineLower.includes(t.toLowerCase()))) {
      adjustment += base * 0.05;
      if (explain) signals.push("docstring_match:+5%");
    }
  }

  return explain ? { adjustment, signals } : { adjustment };
}

module.exports = {
  extractSymbolDef,
  computeEnhancedSignals,
  // WHY: Exported for test-scoring.sh (tests 3 & 4). Not imported by production code.
  noiseWordRatio,
  isPythonPublicSymbol,
};
