/**
 * On-demand scope detection for function-level context.
 * 
 * Finds the enclosing function/method/class for a given line number.
 * Parses files on-demand (not pre-indexed) for accuracy.
 * Batches by file to avoid redundant parsing.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const MAX_SCOPE_LINES = 200;

// File extension to language mapping
const LANG_MAP = {
  py: "python",
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mjs: "javascript",
  cjs: "javascript",
};

/**
 * Find enclosing scopes for multiple line numbers in a single file.
 * Parses once, returns scope info for each line.
 * 
 * @param {string} filePath - Absolute path to file
 * @param {number[]} lineNumbers - 1-indexed line numbers to find scopes for
 * @param {object} opts - Options
 * @param {string} opts.mode - "function" (innermost) or "class" (include containing class)
 * @param {number} opts.maxLines - Max lines to include (default 200)
 * @returns {Map<number, ScopeInfo|null>} Map from lineNumber to scope info
 * 
 * ScopeInfo: { name, kind, startLine, endLine, totalLines }
 */
function findEnclosingScopeBatch(filePath, lineNumbers, opts = {}) {
  const mode = opts.mode || "function";
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const lang = LANG_MAP[ext];

  const results = new Map();
  for (const ln of lineNumbers) {
    results.set(ln, null);
  }

  if (!lang) return results;

  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return results;
  }

  if (lang === "python") {
    return findPythonScopesBatch(content, lineNumbers, mode);
  } else if (lang === "javascript" || lang === "typescript") {
    return findJsScopesBatch(content, lineNumbers, mode);
  }

  return results;
}

/**
 * Python scope detection via AST.
 * Calls python_ast.py with find_scopes mode.
 */
function findPythonScopesBatch(content, lineNumbers, mode) {
  const results = new Map();
  for (const ln of lineNumbers) {
    results.set(ln, null);
  }

  const scriptPath = path.join(__dirname, "extractors", "python_ast.py");
  const input = JSON.stringify({
    mode: "find_scopes",
    content,
    lines: lineNumbers,
    scope_mode: mode,
  });

  const result = spawnSync("python3", [scriptPath], {
    input,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 15000,
  });

  if (result.status !== 0) return results;

  try {
    const parsed = JSON.parse(result.stdout);
    // parsed.scopes: { "lineNumber": {...} | null }
    for (const [ln, scope] of Object.entries(parsed.scopes || {})) {
      const lineNum = parseInt(ln, 10);
      if (scope) {
        results.set(lineNum, {
          name: scope.name,
          kind: scope.kind,
          startLine: scope.start_line,
          endLine: scope.end_line,
          totalLines: scope.end_line - scope.start_line + 1,
        });
      }
    }
  } catch {
    // Parse failed, return nulls
  }

  return results;
}

/**
 * JavaScript/TypeScript scope detection via heuristics.
 * 
 * Strategy:
 * 1. Build a simple token stream, skipping strings/comments/regex
 * 2. Track brace depth and scope boundaries
 * 3. For each target line, find the innermost enclosing scope
 */
function findJsScopesBatch(content, lineNumbers, mode) {
  const results = new Map();
  for (const ln of lineNumbers) {
    results.set(ln, null);
  }

  const lines = content.split(/\r?\n/);
  const scopes = parseJsScopes(lines);

  for (const ln of lineNumbers) {
    const scope = findEnclosingScopeForLine(scopes, ln, mode);
    if (scope) {
      results.set(ln, scope);
    }
  }

  return results;
}

/**
 * Parse JS/TS to extract scope boundaries.
 * Returns array of { name, kind, startLine, endLine }
 *
 * Heuristic-only:
 * - Masks comments/strings/regex for stable brace pairing
 * - Treats template literal `${...}` sections as real code
 * - Uses brace pairing to find endLine for each detected scope start
 */
function parseJsScopes(lines) {
  const codeLines = [];
  const braceTokens = []; // { type: "{"|"}", line: 1-indexed, col: 0-indexed }
  const openBraceIndexByPos = new Map(); // "line:col" -> tokenIndex

  // Scanner state (spans lines)
  let inBlockComment = false;
  let stringQuote = null; // "'" | '"'
  let stringEscape = false;

  let inRegex = false;
  let regexEscape = false;
  let regexInCharClass = false;

  // Template literal support (including nested templates)
  // Each ctx: { inExpr: boolean, exprDepth: number }
  const templateStack = [];
  let templateEscape = false;

  function shouldStartRegex(prevSigChar) {
    if (!prevSigChar) return true;
    return /[=(:,[!&|?;{}]/.test(prevSigChar);
  }

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i] ?? "";
    const out = Array.from({ length: line.length }, () => " ");

    let inLineComment = false;
    let prevSigChar = null; // previous non-whitespace code char on this line

    for (let col = 0; col < line.length; col++) {
      const c = line[col];
      const next = col + 1 < line.length ? line[col + 1] : "";

      if (inLineComment) {
        out[col] = " ";
        continue;
      }

      if (inBlockComment) {
        out[col] = " ";
        if (c === "*" && next === "/") {
          out[col + 1] = " ";
          inBlockComment = false;
          col += 1;
        }
        continue;
      }

      const tmpl = templateStack.length > 0 ? templateStack[templateStack.length - 1] : null;
      const inTemplateText = tmpl && !tmpl.inExpr;
      const inTemplateExpr = tmpl && tmpl.inExpr;

      // Template literal text mode: mask everything except `${`
      if (inTemplateText) {
        out[col] = " ";

        if (templateEscape) {
          templateEscape = false;
          continue;
        }
        if (c === "\\") {
          templateEscape = true;
          continue;
        }
        if (c === "`") {
          templateStack.pop();
          templateEscape = false;
          continue;
        }
        if (c === "$" && next === "{") {
          // Enter template expression mode; the following '{' is real code.
          out[col] = "$";
          tmpl.inExpr = true;
          tmpl.exprDepth = 0;
          prevSigChar = "$";
          continue;
        }
        continue;
      }

      // Line / block comments (only in code / template expr)
      if (!stringQuote && !inRegex) {
        if (c === "/" && next === "/") {
          out[col] = " ";
          inLineComment = true;
          continue;
        }
        if (c === "/" && next === "*") {
          out[col] = " ";
          out[col + 1] = " ";
          inBlockComment = true;
          col += 1;
          continue;
        }
      }

      // String mode (single/double only). Template literals are handled via templateStack.
      if (stringQuote) {
        out[col] = " ";
        if (stringEscape) {
          stringEscape = false;
          continue;
        }
        if (c === "\\") {
          stringEscape = true;
          continue;
        }
        if (c === stringQuote) {
          stringQuote = null;
        }
        continue;
      }

      // Regex mode
      if (inRegex) {
        out[col] = " ";
        if (regexEscape) {
          regexEscape = false;
          continue;
        }
        if (c === "\\") {
          regexEscape = true;
          continue;
        }
        if (regexInCharClass) {
          if (c === "]") regexInCharClass = false;
          continue;
        }
        if (c === "[") {
          regexInCharClass = true;
          continue;
        }
        if (c === "/") {
          inRegex = false;
        }
        continue;
      }

      // Start of template literal (can occur in normal code or inside template expr)
      if (c === "`") {
        out[col] = " ";
        templateStack.push({ inExpr: false, exprDepth: 0 });
        templateEscape = false;
        continue;
      }

      // Start of single/double quoted strings
      if (c === "'" || c === '"') {
        out[col] = " ";
        stringQuote = c;
        stringEscape = false;
        continue;
      }

      // Regex literal start (heuristic)
      if (c === "/" && next !== "/" && next !== "*") {
        if (shouldStartRegex(prevSigChar)) {
          out[col] = " ";
          inRegex = true;
          regexEscape = false;
          regexInCharClass = false;
          continue;
        }
      }

      // Code character
      out[col] = c;

      // Track braces for pairing
      if (c === "{" || c === "}") {
        const idx = braceTokens.length;
        braceTokens.push({ type: c, line: lineNum, col });
        if (c === "{") openBraceIndexByPos.set(`${lineNum}:${col}`, idx);

        // Template expression depth tracking (count braces like a real parser would)
        if (inTemplateExpr && tmpl) {
          if (c === "{") {
            tmpl.exprDepth += 1;
          } else {
            tmpl.exprDepth -= 1;
            if (tmpl.exprDepth <= 0) {
              tmpl.inExpr = false;
              tmpl.exprDepth = 0;
              templateEscape = false;
            }
          }
        }
      }

      if (!/\s/.test(c)) prevSigChar = c;
    }

    codeLines.push(out.join(""));

    // If a line ends with an escape, treat it as consumed by the newline.
    if (templateEscape) templateEscape = false;
    if (stringEscape) stringEscape = false;
    if (regexEscape) regexEscape = false;
  }

  // Pair braces
  const openToClose = new Map(); // openTokenIndex -> closeTokenIndex
  const stack = [];
  for (let i = 0; i < braceTokens.length; i++) {
    const t = braceTokens[i];
    if (t.type === "{") stack.push(i);
    else {
      const openIdx = stack.pop();
      if (openIdx != null) openToClose.set(openIdx, i);
    }
  }

  const scopes = [];

  // Match scope *starts* (brace may be on a later line).
  const CLASS_START_RE = /\bclass\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g;
  const FUNC_START_RE = /\b(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  // Arrow functions: keep a simple same-line matcher for now to avoid false positives
  // from nested callback arrows in assignments like: const x = arr.map(v => { ... })
  const ARROW_SAMELINE_RE =
    /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>\s*\{/g;
  const METHOD_START_RE =
    /^\s*(?:(?:public|private|protected|static|async|get|set|override|readonly)\s+)*\*?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/;

  const DISALLOWED_METHOD = new Set([
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "function",
    "class",
    "return",
    "throw",
    "try",
    "else",
    "do",
  ]);

  function addScopeFromOpenBrace(kind, name, startLine, openLine, openCol) {
    const openIdx = openBraceIndexByPos.get(`${openLine}:${openCol}`);
    if (openIdx == null) return;
    const closeIdx = openToClose.get(openIdx);
    if (closeIdx == null) return;
    const endLine = braceTokens[closeIdx]?.line ?? openLine;
    scopes.push({
      name,
      kind,
      startLine,
      endLine,
      totalLines: endLine - startLine + 1,
    });
  }

  function findClassBodyBrace(startLineIdx, startCol, maxLines = 120) {
    let angleDepth = 0;
    const endLineIdx = Math.min(codeLines.length - 1, startLineIdx + maxLines);

    for (let i = startLineIdx; i <= endLineIdx; i++) {
      const line = codeLines[i];
      for (let col = i === startLineIdx ? startCol : 0; col < line.length; col++) {
        const c = line[col];
        if (c === "<") angleDepth++;
        else if (c === ">") angleDepth = Math.max(0, angleDepth - 1);
        else if (c === "{" && angleDepth === 0) return { line: i + 1, col };
        else if (c === ";" && angleDepth === 0) return null; // declare class Foo;
      }
    }
    return null;
  }

  function findCallableBodyBrace(startLineIdx, startParenCol, maxLines = 200) {
    const limitLineIdx = Math.min(codeLines.length - 1, startLineIdx + maxLines);

    // Phase 1: find the end of the parameter list.
    let parenDepth = 0;
    let sawParen = false;
    let paramsEndLineIdx = null;
    let paramsEndCol = null;

    for (let i = startLineIdx; i <= limitLineIdx; i++) {
      const line = codeLines[i];
      for (let col = i === startLineIdx ? startParenCol : 0; col < line.length; col++) {
        const c = line[col];
        if (c === "(") {
          sawParen = true;
          parenDepth++;
        } else if (c === ")") {
          if (sawParen) parenDepth = Math.max(0, parenDepth - 1);
          if (sawParen && parenDepth === 0) {
            paramsEndLineIdx = i;
            paramsEndCol = col + 1;
            break;
          }
        }
      }
      if (paramsEndLineIdx != null) break;
    }

    if (paramsEndLineIdx == null || paramsEndCol == null) return null;

    // Phase 2: find the body opening brace.
    let inReturnType = false;
    let angleDepth = 0;
    let typeBraceDepth = 0;
    let typeParenDepth = 0;
    let typeBracketDepth = 0;
    let prevSig = ")"; // Previous non-whitespace significant char across lines.

    for (let i = paramsEndLineIdx; i <= limitLineIdx; i++) {
      const line = codeLines[i];
      for (let col = i === paramsEndLineIdx ? paramsEndCol : 0; col < line.length; col++) {
        const c = line[col];

        if (!inReturnType) {
          if (c === ":") {
            inReturnType = true;
            prevSig = ":";
            continue;
          }
          if (c === "{") return { line: i + 1, col };
          if (c === ";") return null;
          if (!/\s/.test(c)) prevSig = c;
          continue;
        }

        // Return type parsing (heuristic): track delimiters so we don't confuse
        // type-literal braces `{ ... }` with the function body `{ ... }`.
        if (c === "<") angleDepth++;
        else if (c === ">") angleDepth = Math.max(0, angleDepth - 1);
        else if (c === "(") typeParenDepth++;
        else if (c === ")") typeParenDepth = Math.max(0, typeParenDepth - 1);
        else if (c === "[") typeBracketDepth++;
        else if (c === "]") typeBracketDepth = Math.max(0, typeBracketDepth - 1);
        else if (c === "{") {
          const isBodyCandidate =
            angleDepth === 0 &&
            typeBraceDepth === 0 &&
            typeParenDepth === 0 &&
            typeBracketDepth === 0 &&
            prevSig &&
            /[)\]}>A-Za-z0-9_$]/.test(prevSig);

          if (isBodyCandidate) return { line: i + 1, col };
          typeBraceDepth++;
        } else if (c === "}") {
          if (typeBraceDepth > 0) typeBraceDepth--;
        } else if (c === ";") {
          if (
            angleDepth === 0 &&
            typeBraceDepth === 0 &&
            typeParenDepth === 0 &&
            typeBracketDepth === 0
          ) {
            return null;
          }
        }

        if (!/\s/.test(c)) prevSig = c;
      }
    }

    return null;
  }

  for (let i = 0; i < codeLines.length; i++) {
    const startLine = i + 1;
    const code = codeLines[i];

    for (const m of code.matchAll(CLASS_START_RE)) {
      const scanFromCol = (m.index ?? 0) + m[0].length;
      const open = findClassBodyBrace(i, scanFromCol);
      if (open) addScopeFromOpenBrace("class", m[1], startLine, open.line, open.col);
    }

    for (const m of code.matchAll(FUNC_START_RE)) {
      const parenCol = (m.index ?? 0) + m[0].lastIndexOf("(");
      const open = findCallableBodyBrace(i, parenCol);
      if (open) addScopeFromOpenBrace("function", m[1], startLine, open.line, open.col);
    }

    for (const m of code.matchAll(ARROW_SAMELINE_RE)) {
      const openBraceCol = (m.index ?? 0) + m[0].lastIndexOf("{");
      addScopeFromOpenBrace("function", m[1], startLine, startLine, openBraceCol);
    }

    const mm = code.match(METHOD_START_RE);
    if (mm && mm[1] && !DISALLOWED_METHOD.has(mm[1])) {
      const parenCol = mm[0].lastIndexOf("(");
      const open = findCallableBodyBrace(i, parenCol);
      if (open) addScopeFromOpenBrace("method", mm[1], startLine, open.line, open.col);
    }
  }

  return scopes;
}

/**
 * Find the enclosing scope for a specific line number.
 */
function findEnclosingScopeForLine(scopes, lineNumber, mode) {
  // Find all scopes that contain this line
  const containing = scopes.filter(
    (s) => s.startLine <= lineNumber && s.endLine >= lineNumber
  );

  if (containing.length === 0) return null;

  // Sort by size (smallest first = innermost)
  containing.sort((a, b) => a.totalLines - b.totalLines);

  if (mode === "function") {
    // Return innermost function/method
    const funcScope = containing.find((s) => s.kind === "function" || s.kind === "method");
    return funcScope || containing[0];
  } else if (mode === "class") {
    // Return containing class if exists, otherwise innermost
    const classScope = containing.find((s) => s.kind === "class");
    return classScope || containing[0];
  }

  return containing[0];
}

/**
 * Read scope lines from file with truncation support.
 * 
 * @param {string} filePath - Absolute path to file
 * @param {object} scope - Scope info with startLine/endLine
 * @param {number} matchLine - The line number that matched (1-indexed)
 * @param {number} maxLines - Max lines to return
 * @returns {object} { lines[], truncated, matchLineWithinScope }
 */
function readScopeLines(filePath, scope, matchLine, maxLines = MAX_SCOPE_LINES) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return { lines: [], truncated: false, matchLineWithinScope: 0 };
  }

  const allLines = content.split(/\r?\n/);
  const startIdx = scope.startLine - 1;
  const endIdx = scope.endLine;
  const scopeLines = allLines.slice(startIdx, endIdx);
  const matchLineWithinScope = matchLine - scope.startLine;

  if (scopeLines.length <= maxLines) {
    return {
      lines: scopeLines,
      truncated: false,
      matchLineWithinScope,
    };
  }

  return {
    // Always include the scope header/signature at the top.
    // The matched line is still present in the hit itself, and its position
    // within the full scope is provided via matchLineWithinScope.
    lines: scopeLines.slice(0, maxLines),
    truncated: true,
    matchLineWithinScope,
  };
}

// WHY: Unified scope context — was duplicated in rg.js and retrieve.js.
// Groups hits by file, batch-finds enclosing scopes, populates h.scope.
function addScopeContext(root, hits, { contextMode = "function", maxScopeLines = MAX_SCOPE_LINES } = {}) {
  const byFile = new Map();
  for (const h of hits) {
    if (!h.path) continue;
    if (!byFile.has(h.path)) byFile.set(h.path, []);
    byFile.get(h.path).push(h);
  }

  for (const [rel, fileHits] of byFile.entries()) {
    const abs = path.join(root, rel);
    const lineNumbers = fileHits.map((h) => h.lineNumber).filter((n) => Number.isFinite(n));
    if (!lineNumbers.length) continue;

    const scopeMap = findEnclosingScopeBatch(abs, lineNumbers, { mode: contextMode });

    for (const h of fileHits) {
      const scopeInfo = scopeMap.get(h.lineNumber);
      if (!scopeInfo) {
        h.scope = null;
        continue;
      }

      const { lines, truncated, matchLineWithinScope } = readScopeLines(
        abs, scopeInfo, h.lineNumber, maxScopeLines
      );

      h.scope = {
        name: scopeInfo.name,
        kind: scopeInfo.kind,
        startLine: scopeInfo.startLine,
        endLine: scopeInfo.endLine,
        totalLines: scopeInfo.totalLines,
        maxLines: maxScopeLines,
        lines,
        truncated,
        matchLineWithinScope,
      };

      h.before = [];
      h.after = [];
    }
  }

  return hits;
}

module.exports = {
  findEnclosingScopeBatch,
  readScopeLines,
  addScopeContext,
  MAX_SCOPE_LINES,
};
