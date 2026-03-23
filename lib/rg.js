const { spawn, spawnSync } = require("child_process");
const path = require("path");

function which(bin) {
  const r = spawnSync("sh", ["-lc", `command -v ${bin} 2>/dev/null`], { encoding: "utf8" });
  if (r.status === 0) {
    const out = (r.stdout || "").trim();
    return out ? out : null;
  }
  return null;
}

function isInstalled() {
  return !!which("rg");
}

// Lazy load scope-finder to avoid circular dependencies
let scopeFinder = null;
function getScopeFinder() {
  if (!scopeFinder) {
    scopeFinder = require("./scope-finder");
  }
  return scopeFinder;
}

function readFileLines(p) {
  const fs = require("fs");
  try {
    const txt = fs.readFileSync(p, "utf8");
    return txt.split(/\r?\n/);
  } catch {
    return null;
  }
}

function addContextToHits(root, hits, contextLines) {
  if (!contextLines || contextLines <= 0) {
    for (const h of hits) {
      h.before = [];
      h.after = [];
    }
    return hits;
  }

  const byFile = new Map();
  for (const h of hits) {
    if (!h.path) continue;
    if (!byFile.has(h.path)) byFile.set(h.path, []);
    byFile.get(h.path).push(h);
  }

  for (const [rel, fileHits] of byFile.entries()) {
    const abs = path.join(root, rel);
    const lines = readFileLines(abs);
    if (!lines) {
      for (const h of fileHits) {
        h.before = [];
        h.after = [];
      }
      continue;
    }

    for (const h of fileHits) {
      const idx = (h.lineNumber || 1) - 1;
      const start = Math.max(0, idx - contextLines);
      const end = Math.min(lines.length - 1, idx + contextLines);

      h.before = lines.slice(start, idx);
      h.after = lines.slice(idx + 1, end + 1);
    }
  }

  return hits;
}

/**
 * Add function/class scope context to hits.
 * Batches by file to parse once per file.
 * 
 * @param {string} root - Repo root path
 * @param {object[]} hits - Array of hit objects
 * @param {object} opts - Options
 * @param {string} opts.contextMode - "function" or "class"
 * @param {number} opts.maxScopeLines - Max lines per scope (default 200)
 */
function addFunctionContextToHits(root, hits, opts = {}) {
  const { findEnclosingScopeBatch, readScopeLines, MAX_SCOPE_LINES } = getScopeFinder();
  const mode = opts.contextMode || "function";
  const maxLines = opts.maxScopeLines ?? MAX_SCOPE_LINES;

  // Group hits by file for batch processing
  const byFile = new Map();
  for (const h of hits) {
    if (!h.path) continue;
    if (!byFile.has(h.path)) byFile.set(h.path, []);
    byFile.get(h.path).push(h);
  }

  for (const [rel, fileHits] of byFile.entries()) {
    const abs = path.join(root, rel);
    const lineNumbers = fileHits.map((h) => h.lineNumber).filter((n) => Number.isFinite(n));

    // Find all scopes in one batch call
    const scopeMap = findEnclosingScopeBatch(abs, lineNumbers, { mode });

    for (const h of fileHits) {
      const scopeInfo = scopeMap.get(h.lineNumber);

      if (!scopeInfo) {
        // No scope found: keep line context (fallback) if present.
        h.scope = null;
        continue;
      }

      // Read scope lines with truncation
      const { lines, truncated, matchLineWithinScope } = readScopeLines(
        abs,
        scopeInfo,
        h.lineNumber,
        maxLines
      );

      h.scope = {
        name: scopeInfo.name,
        kind: scopeInfo.kind,
        startLine: scopeInfo.startLine,
        endLine: scopeInfo.endLine,
        totalLines: scopeInfo.totalLines,
        maxLines,
        lines,
        truncated,
        matchLineWithinScope,
      };

      // Clear line-based context when using scope context
      h.before = [];
      h.after = [];
    }
  }

  return hits;
}

// WHY: Source-first collection solves the rg saturation problem.  For common
// terms ("Flask", "useState") docs and changelogs dominate the first N raw hits
// from rg's linear traversal, so source file definitions never reach the scorer.
// Two-phase approach: search source files first (guaranteed slot), then fill
// remaining capacity with non-source files (docs, configs, etc.).
const SOURCE_GLOBS = [
  "*.js", "*.jsx", "*.ts", "*.tsx", "*.mjs", "*.cjs",
  "*.py", "*.go", "*.rs", "*.rb", "*.java", "*.kt",
  "*.c", "*.cpp", "*.h", "*.hpp", "*.cs", "*.swift",
  "*.lua", "*.ex", "*.exs", "*.erl", "*.hs",
  "*.scala", "*.clj", "*.php", "*.pl", "*.r",
];

function buildBaseArgs(mode) {
  // WHY: --sort path gives deterministic results (rg default is thread-ordered,
  // which varies between runs for the same query).
  const args = ["--json", "-n", "--smart-case", "--sort", "path"];
  args.push("--glob", "!.planning/**");
  args.push("--glob", "!node_modules/**");
  args.push("--glob", "!.git/**");
  args.push("--glob", "!dist/**");
  args.push("--glob", "!build/**");
  args.push("--glob", "!.next/**");
  if (mode === "literal") args.push("-F");
  return args;
}

function collectHits(root, args, maxHits) {
  return new Promise((resolve, reject) => {
    const hits = [];
    const child = spawn("rg", args, { cwd: root });
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);

        if (!line.trim()) continue;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }

        if (evt.type === "match") {
          const data = evt.data;
          hits.push({
            path: data.path?.text,
            lineNumber: data.line_number,
            line: data.lines?.text?.replace(/\n$/, "") ?? "",
            ranges: (data.submatches || []).map((sm) => ({
              start: sm.start,
              end: sm.end,
            })),
            provider: "rg",
            score: null,
          });

          if (hits.length >= maxHits) {
            child.kill("SIGTERM");
            break;
          }
        }
      }
    });

    child.on("error", reject);
    child.on("exit", () => resolve(hits));
  });
}

async function search(root, q, opts = {}) {
  if (!isInstalled()) throw new Error("rg not found in PATH");

  const mode = opts.mode || "literal";
  const maxHits = opts.maxHits ?? 50;
  const contextLines = opts.contextLines ?? 1;
  const contextMode = opts.contextMode || "lines";
  const maxScopeLines = opts.maxScopeLines ?? 200;

  // Phase 1: Source files only — guarantees definitions reach the scorer.
  // NOTE: We intentionally do NOT use --max-count here.  It would force file
  // diversity (good) but it caps at the FIRST N matches per file, which means
  // definitions deep in a file (e.g., line 4164 in React's beginWork) get cut.
  // The existing rerankAndCapHits handles per-file capping AFTER scoring, which
  // keeps the highest-scored hits per file rather than the first ones.
  const srcArgs = buildBaseArgs(mode);
  for (const g of SOURCE_GLOBS) srcArgs.push("--glob", g);
  srcArgs.push(q, ".");

  const srcHits = await collectHits(root, srcArgs, maxHits);

  // Phase 2: Fill remaining capacity with non-source files (docs, configs).
  let otherHits = [];
  const remaining = maxHits - srcHits.length;
  if (remaining > 0) {
    const otherArgs = buildBaseArgs(mode);
    for (const g of SOURCE_GLOBS) otherArgs.push("--glob", `!${g}`);
    otherArgs.push(q, ".");
    otherHits = await collectHits(root, otherArgs, remaining);
  }

  const hits = [...srcHits, ...otherHits];

  // Add context based on mode
  if (contextMode === "function" || contextMode === "class") {
    addContextToHits(root, hits, contextLines);
    addFunctionContextToHits(root, hits, { contextMode, maxScopeLines });
  } else {
    addContextToHits(root, hits, contextLines);
  }

  return {
    provider: "rg",
    stats: { matchCount: hits.length },
    hits,
  };
}

// WHY: Targeted search within specific files for export-graph injected results.
// When the export graph identifies a file that exports the queried symbol but
// rg's main search didn't include it (budget exhausted), we need line-level
// hits from that file for scoring and display.
async function searchInFiles(root, q, filePaths, opts = {}) {
  if (!isInstalled() || !filePaths.length) return [];
  const mode = opts.mode || "literal";

  const args = ["--json", "-n", "--smart-case"];
  if (mode === "literal") args.push("-F");
  args.push(q);
  for (const f of filePaths) args.push(f);

  const hits = await collectHits(root, args, opts.maxHits ?? 20);
  return hits;
}

module.exports = { isInstalled, search, searchInFiles };
