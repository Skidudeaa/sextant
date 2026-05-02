const path = require("path");

function posixify(p) {
  return String(p).replace(/\\/g, "/");
}

function normalizeRelPath(relPath) {
  return posixify(String(relPath)).replace(/^\/+/, "");
}

function fileTypeHeuristic(relPath) {
  const p = normalizeRelPath(relPath);
  const ext = path.extname(p).toLowerCase();

  switch (ext) {
    case ".ts":
      return "ts";
    case ".tsx":
      return "tsx";
    case ".js":
      return "js";
    case ".jsx":
      return "jsx";
    case ".mjs":
      return "mjs";
    case ".cjs":
      return "cjs";
    case ".json":
      return "json";
    case ".py":
      return "py";
    case ".swift":
      return "swift";
    case ".md":
      return "md";
    default:
      return "other";
  }
}

function isIndexable(relPath) {
  const p = normalizeRelPath(relPath);
  if (!p || p.startsWith(".")) return false;

  // Hard guardrails (even if caller forgets ignore globs).
  if (
    p.includes("/node_modules/") ||
    p.includes("/.git/") ||
    p.includes("/.planning/") ||
    p.includes("/.claude/") ||
    p.includes("/dist/") ||
    p.includes("/build/") ||
    p.includes("/.next/")
  ) {
    return false;
  }

  const t = fileTypeHeuristic(p);
  return (
    t === "ts" ||
    t === "tsx" ||
    t === "js" ||
    t === "jsx" ||
    t === "mjs" ||
    t === "cjs" ||
    t === "py" ||
    t === "swift"
  );
}

// WHY: Unified entry point detection with path exclusion.  Cross-project
// testing showed the regex-only approach matched fixtures/examples
// (e.g., examples/error-pages/index.js, fixtures/art/app.js).
// Path exclusion filters these out without losing real entry points.
const ENTRY_POINT_EXCLUDE = /(^|\/)(fixtures?|tests?|__tests__|specs?|examples?|demos?|samples?|e2e|mocks?)\//i;

function isEntryPoint(relPath) {
  if (!relPath) return false;
  if (ENTRY_POINT_EXCLUDE.test(relPath)) return false;
  if (/(src\/)?(main|index|app|root|router|routes)\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(relPath))
    return true;
  if (/(^|\/)(__init__|__main__|app|manage|wsgi|asgi)\.py$/i.test(relPath))
    return true;
  return false;
}

function stateDir(root) {
  return path.join(path.resolve(root), ".planning", "intel");
}

module.exports = {
  posixify,
  normalizeRelPath,
  isIndexable,
  fileTypeHeuristic,
  isEntryPoint,
  stateDir,
};

