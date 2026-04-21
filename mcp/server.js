"use strict";

// Sextant MCP server — JSON-RPC 2.0 over stdio.
//
// Exposes sextant's dependency graph, ranked search, and health as MCP tools.
// Launched via `sextant mcp`.  Registered per-project via `.mcp.json`.

const path = require("path");
const readline = require("readline");

const intel = require("../lib/intel");
const graph = require("../lib/graph");
const { retrieve } = require("../lib/retrieve");
const { normalizeRelPath } = require("../lib/utils");

// --- Tool definitions ---------------------------------------------------

const TOOLS = [
  {
    name: "sextant_search",
    description:
      "PREFERRED code search. Combines dependency-graph ranking with full-text search " +
      "(ripgrep + export-graph + re-export chain tracing). Use INSTEAD of grep/ripgrep " +
      "for finding code, definitions, symbols, or understanding codebase structure. " +
      "Returns ranked files with fan-in, scores, and matching lines with context. " +
      "Fast: ~100ms. Just pass a query string.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query — symbol name, phrase, or file path fragment" },
        limit: { type: "number", description: "Max results (default 10)" },
        context_lines: { type: "number", description: "Lines of context around each hit (default 1)" },
      },
      required: ["query"],
    },
  },
  {
    name: "sextant_related",
    description:
      "Find files related to a given file via the dependency graph. " +
      "Returns imports (files it depends on) and dependents (files that depend on it). " +
      "Use to understand blast radius of changes or discover connected modules.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Relative file path (e.g. lib/graph.js)" },
        max: { type: "number", description: "Max imports and dependents to return (default 15)" },
      },
      required: ["file"],
    },
  },
  {
    name: "sextant_explain",
    description:
      "Explain a file's role in the codebase. Returns fan-in (how many files depend on it), " +
      "fan-out (how many files it imports), its exports, imports, detected type, and size. " +
      "Use to quickly understand what a file does and how important it is.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Relative file path (e.g. lib/intel.js)" },
      },
      required: ["file"],
    },
  },
  {
    name: "sextant_health",
    description:
      "Check dependency graph health. Returns import resolution %, file count, index age, " +
      "and any warnings. Use to verify the graph is fresh before trusting ranked results.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// --- Tool handlers ------------------------------------------------------

let _root = null;
let _initialized = false;

async function ensureInit() {
  const cwd = process.cwd();
  // Re-initialize if the working directory changed (new project context)
  if (_initialized && _root === cwd) return;
  _root = cwd;
  await intel.init(_root);
  _initialized = true;
}

async function handleSearch(params) {
  await ensureInit();
  const query = params.query;
  if (!query || typeof query !== "string" || !query.trim()) {
    throw new Error("query parameter is required");
  }
  const limit = Number.isFinite(params.limit) ? params.limit : 10;
  const contextLines = Number.isFinite(params.context_lines) ? params.context_lines : 1;

  const result = await retrieve(_root, query.trim(), {
    maxHits: limit * 5,
    maxSeedFiles: limit,
    hitsPerFileCap: 3,
    contextLines,
    backend: "auto",
  });

  // Compact output: top files + top hits
  const files = (result.results.files || []).slice(0, limit).map((f) => ({
    path: f.path,
    score: f.bestAdjustedHitScore,
    fanIn: f.fanIn,
    fanOut: f.fanOut,
    type: f.type,
    hitCount: f.hitCount,
    isEntryPoint: f.isEntryPoint || false,
  }));

  const hits = (result.results.hits || []).slice(0, limit * 3).map((h) => ({
    path: h.path,
    line: h.lineNumber || h.line_number || null,
    text: typeof h.line === "string" ? h.line : (h.text || null),
    score: h.adjustedScore,
  }));

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            query,
            files,
            hits,
            warnings: result.warnings || [],
            provider: result.providers?.search?.name || "unknown",
          },
          null,
          2
        ),
      },
    ],
  };
}

async function handleRelated(params) {
  await ensureInit();
  const file = params.file;
  if (!file || typeof file !== "string") {
    throw new Error("file parameter is required");
  }
  const rel = normalizeRelPath(file);
  if (rel.startsWith("..") || require("path").isAbsolute(rel)) {
    throw new Error("file path must be relative and within the project root");
  }
  const max = Number.isFinite(params.max) ? params.max : 15;

  const db = await graph.loadDb(_root);
  const result = graph.neighbors(db, rel, { maxImports: max, maxDependents: max });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { file: rel, imports: result.imports, dependents: result.dependents },
          null,
          2
        ),
      },
    ],
  };
}

async function handleExplain(params) {
  await ensureInit();
  const file = params.file;
  if (!file || typeof file !== "string") {
    throw new Error("file parameter is required");
  }
  const rel = normalizeRelPath(file);
  if (rel.startsWith("..") || require("path").isAbsolute(rel)) {
    throw new Error("file path must be relative and within the project root");
  }

  const db = await graph.loadDb(_root);
  const meta = graph.getFileMeta(db, rel);

  // WHY: without this branch, querying a file that isn't in the graph
  // silently returned { fanIn: 0, fanOut: 0, exports: [], imports: [] },
  // indistinguishable from a real-but-isolated file.  Claude would treat
  // the empty result as authoritative.  Make the "not indexed" case
  // explicit so the caller can decide whether to re-scan or correct the
  // path.
  if (!meta) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              file: rel,
              notIndexed: true,
              hint: "File not found in dependency graph. Check the path (must be relative to project root) or run: sextant scan --force",
            },
            null,
            2
          ),
        },
      ],
    };
  }

  const fanInMap = graph.fanInByPaths(db, [rel]);
  const fanOutMap = graph.fanOutByPaths(db, [rel]);
  const exports = graph.queryExports(db, rel);
  const imports = graph.queryImports(db, rel);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            file: rel,
            fanIn: fanInMap.get(rel) || 0,
            fanOut: fanOutMap.get(rel) || 0,
            exports: exports.map((e) => ({ name: e.name, kind: e.kind })),
            imports: imports.map((i) => ({
              specifier: i.specifier,
              resolved: i.toPath || null,
              kind: i.kind || null,
            })),
            type: meta?.type || "unknown",
            sizeBytes: meta?.sizeBytes || null,
          },
          null,
          2
        ),
      },
    ],
  };
}

async function handleHealth() {
  await ensureInit();
  const h = await intel.health(_root);
  const { getWatcherStatus } = require("../lib/cli");
  const watcher = getWatcherStatus(_root);

  // WHY: index freshness depends on watcher liveness, not just index age.
  // A 6-hour-old index with a live watcher is fine (no file changes in 6h);
  // the same age with a dead watcher means real drift.  Report both so the
  // caller can interpret correctly.
  const warnings = [];
  if (h.topMisses?.length > 0) warnings.push(`${h.topMisses.length} unresolved specifiers`);
  if (!watcher.running) warnings.push("watcher not running — run: sextant watch-start");
  if (h.resolutionPct != null && h.resolutionPct < 90) {
    warnings.push(`import resolution ${h.resolutionPct}% (graph boosts are gated below 90%)`);
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            root: h.root,
            resolutionPct: h.resolutionPct,
            files: h.index?.files || 0,
            localResolved: h.localResolved,
            localTotal: h.localTotal,
            indexAgeSec: h.indexAgeSec,
            watcher: {
              running: watcher.running,
              heartbeatAgeSec: watcher.ageSec ?? null,
            },
            warnings,
          },
          null,
          2
        ),
      },
    ],
  };
}

// --- Dispatch table -----------------------------------------------------

const toolHandlers = {
  sextant_search: handleSearch,
  sextant_related: handleRelated,
  sextant_explain: handleExplain,
  sextant_health: handleHealth,
};

// --- JSON-RPC 2.0 protocol layer ---------------------------------------

const SERVER_INFO = {
  name: "sextant",
  version: require("../package.json").version,
};

const CAPABILITIES = {
  tools: {},
};

function jsonRpcResult(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", result, id });
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id });
}

async function dispatch(method, params) {
  // MCP lifecycle
  if (method === "initialize") {
    await ensureInit();
    return {
      protocolVersion: "2024-11-05",
      serverInfo: SERVER_INFO,
      capabilities: CAPABILITIES,
    };
  }

  if (method === "tools/list") {
    return { tools: TOOLS };
  }

  if (method === "tools/call") {
    const toolName = params.name;
    const toolArgs = params.arguments || {};
    const handler = toolHandlers[toolName];
    if (!handler) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
        isError: true,
      };
    }
    // WHY: MCP protocol requires tool-level failures to be returned as isError
    // in the response body, NOT as JSON-RPC error responses. JSON-RPC errors
    // signal protocol failures (malformed request, server crash), not tool failures.
    try {
      return await handler(toolArgs);
    } catch (err) {
      return {
        content: [{ type: "text", text: err.message || String(err) }],
        isError: true,
      };
    }
  }

  // Unknown method
  return null;
}

// --- Main stdio loop ----------------------------------------------------

function startServer() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const pending = new Set();
  let stdinClosed = false;

  function maybeExit() {
    if (stdinClosed && pending.size === 0) process.exit(0);
  }

  rl.on("line", (line) => {
    if (!line.trim()) return;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // WHY: JSON-RPC 2.0 section 5.1 requires a parse error response with id: null.
      // Silently dropping would cause clients to hang waiting for a response.
      process.stdout.write(jsonRpcError(null, -32700, "Parse error") + "\n");
      return;
    }

    // Notifications have no id — silently ignore (e.g. notifications/initialized)
    if (msg.id === undefined || msg.id === null) return;

    const p = (async () => {
      try {
        const result = await dispatch(msg.method, msg.params || {});
        if (result === null) {
          // Unknown method
          process.stdout.write(
            jsonRpcError(msg.id, -32601, `Method not found: ${msg.method}`) + "\n"
          );
        } else {
          process.stdout.write(jsonRpcResult(msg.id, result) + "\n");
        }
      } catch (err) {
        process.stdout.write(
          jsonRpcError(msg.id, -32603, err.message || String(err)) + "\n"
        );
      }
    })();

    pending.add(p);
    p.finally(() => {
      pending.delete(p);
      maybeExit();
    });
  });

  rl.on("close", () => {
    stdinClosed = true;
    maybeExit();
  });
}

// Export internals for testing
module.exports = { dispatch, TOOLS, toolHandlers, startServer };

// Auto-start when run directly or via `sextant mcp`
if (require.main === module) {
  startServer();
}
