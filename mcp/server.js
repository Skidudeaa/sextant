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
const { loadRepoConfig } = require("../lib/config");
const { recordEvent } = require("../lib/telemetry");

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
      "Explain a file's role in the codebase, or a directory's aggregate shape. " +
      "File: fan-in (how many files depend on it), fan-out, exports, imports, type, size. " +
      "Directory (path ending in '/', e.g. lib/): file/type counts, top fan-in hotspots inside, " +
      "inbound/outbound import edges grouped by sibling dir, and git co-change coupling to other dirs. " +
      "Use to quickly understand what a file does or how a subsystem sits in the architecture.",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Relative file path (e.g. lib/intel.js) or directory (e.g. lib/ — trailing slash forces dir mode)",
        },
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
  {
    name: "sextant_orient",
    description:
      "Get a compact orientation block for this repo: root, index health, dependency " +
      "hotspots, and (when a task description is provided) the files whose exported " +
      "symbols/paths match it. Designed as a first call when starting work in an " +
      "unfamiliar repo. Returns nothing structural when the index is stale (silent " +
      "absence — stale claims are withheld rather than served).",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Optional: what you're about to work on — used to surface task-relevant files",
        },
      },
    },
  },
  {
    name: "sextant_scope",
    description:
      "Inspect what got cut from the index. Returns the vendored subtrees that were " +
      "auto-detected or user-configured at the project root, with a reason for each " +
      "(nested-git-repo, vendor-dirname, tarball-name, user-config). Use when verifying " +
      "that a sub-tree is intentionally excluded vs missing from the graph by mistake, " +
      "or when reasoning about file counts that look smaller than the working tree suggests.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "sextant_focus",
    description:
      "Compile a role-based Task Capsule for what you're about to work on: the files " +
      "grouped as PRIMARY (the thing to change, with its region), SUPPORT (needed to " +
      "understand it), WITNESSES (its tests/fixtures), HAZARDS (high-fan-in/blast " +
      "surfaces), and UNKNOWNS (what sextant can't verify). A sharper first call than a " +
      "flat file list when starting a task. Returns nothing structural when the index is " +
      "stale (silent absence — stale claims are withheld).",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "What you're about to work on — drives the role-based workset",
        },
      },
    },
  },
  {
    name: "sextant_task_status",
    description:
      "Report the most-recent Task Capsule for this repo: its task id, intent, the repo " +
      "version it was compiled against and whether that fingerprint is still current " +
      "(HEAD/status unchanged), and workset counts by role. When optional Phase-F coherence " +
      "mode is enabled, it also reports recorded parent-delivered / child-spawn-prepared boundaries with workset overlap " +
      "or invalidated claims. Visibility only; it does not assign files or coordinate writers.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "sextant_closure",
    description:
      "A factual task-closure report for the current task: which files changed in observable " +
      "structure (exports/imports added/removed), whether the facts sextant served still hold, " +
      "which directly-connected tests/fixtures were vs were NOT observed, which affected " +
      "surfaces were NOT inspected, and what sextant cannot verify. When optional Phase-F " +
      "coherence mode is enabled, it also includes recorded parent-delivered / child-spawn-prepared boundaries with workset " +
      "overlap or invalidated claims. States evidence and gaps only — it does NOT assert the " +
      "change is correct, complete, or safe to merge. Use before declaring a task done to see " +
      "the connected surfaces you haven't touched.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// --- Tool handlers ------------------------------------------------------

let _root = null;
let _initialized = false;
// Client attribution (todos.md MCP-reach verdict): the MCP `initialize`
// handshake carries the client's spec-mandated self-identification
// (params.clientInfo.name) — captured once here, stamped on every mcp.invoked
// row. Higher-fidelity than env sniffing; SEXTANT_CLIENT env is the fallback
// (recordEvent applies it only when the payload carries no client).
let _client = null;

// MCP INVOCATION TELEMETRY (docs/035 #3).
//
// Root resolution is the trap here. This server resolves the repo from
// process.cwd(), and `_root` is set inside ensureInit() — which runs INSIDE each
// handler, so at dispatch time it can still be null. Recording against the wrong
// root writes another repo's jsonl; recording against a directory that is not a
// sextant install would CREATE state there, which is the self-bootstrap failure
// the 101 GB home-dir incident taught. So: prefer the initialized root, fall
// back to cwd, and write only when `.planning/intel` ALREADY exists. Never
// throws — telemetry must not be able to break a tool call.
function recordMcp(tool, fields) {
  try {
    const root = _root || process.cwd();
    if (!require("fs").existsSync(path.join(root, ".planning", "intel"))) return;
    recordEvent(
      root,
      "mcp.invoked",
      Object.assign({ tool }, _client ? { client: _client } : null, fields || {})
    );
  } catch {}
}

async function ensureInit() {
  const cwd = process.cwd();
  // ROOT GUARD (docs/036). CLAUDE.md justifies the strict marker requirement
  // for hooks and the watcher because they adopt process.cwd() WITHOUT the
  // user naming it. This server does exactly the same thing — and it was not
  // guarded, which is how a zoekt webserver came to be started against a
  // 22 GiB home-directory index on 2026-07-19, nine days after the root guard
  // shipped: an MCP session with cwd=$HOME reached search() -> ensureWebserver().
  // Refusing here costs nothing (the tools return an explicit error instead of
  // silently indexing) and closes the last unguarded adopter of cwd.
  {
    const { checkRoot } = require("../lib/root-guard");
    const verdict = checkRoot(cwd, { requireMarker: true });
    if (!verdict.ok) {
      throw new Error(
        "sextant refuses this directory as a repo root (" + verdict.reason + "): " +
        (verdict.message || "") + " — run sextant from inside a project."
      );
    }
  }
  // Re-initialize if the working directory changed (new project context)
  if (_initialized && _root === cwd) return;
  _root = cwd;
  await intel.init(_root);
  _initialized = true;
}

// WHY: an MCP client (or a prompt-injected agent) can pass an unbounded query.
// retrieve() shells out to rg/zoekt with it; a multi-MB pattern blows latency
// and memory for no benefit. Cap at 2 KB (far above any real symbol/phrase).
// WHY throw, not truncate: silently searching a 2 KB prefix of a longer query
// answers a different question than asked — the "degrade by guessing" failure
// sextant exists to prevent (DESIGN_PHILOSOPHY: drift must be loud). Surface
// it as an explicit error instead. The empty/missing branch keeps the exact
// "query parameter is required" string — test/mcp-server.test.js asserts on it.
const MAX_QUERY_BYTES = 2048;

function normalizeQuery(raw) {
  if (!raw || typeof raw !== "string" || !raw.trim()) {
    throw new Error("query parameter is required");
  }
  const trimmed = raw.trim();
  if (trimmed.length > MAX_QUERY_BYTES) {
    throw new Error(`query too long: ${trimmed.length} chars (max ${MAX_QUERY_BYTES})`);
  }
  return trimmed;
}

async function handleSearch(params) {
  await ensureInit();
  const query = normalizeQuery(params.query);
  const limit = Number.isFinite(params.limit) ? params.limit : 10;
  const contextLines = Number.isFinite(params.context_lines) ? params.context_lines : 1;

  const result = await retrieve(_root, query, {
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

  // Dir mode (docs/021 form c): a trailing "/" forces it; otherwise a file
  // match wins below and the dir aggregate is the fallback (so `lib` works
  // too).  Same aggregation the CLI `sextant explain <dir>/` uses.
  const wantsDir = file.endsWith("/");
  const dirInfo = () => require("../lib/structure").explainDir(db, rel);
  if (wantsDir) {
    const info = dirInfo();
    if (info) {
      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              dir: rel,
              notIndexed: true,
              hint: "No indexed files under this directory. Check the path (relative to project root) or run: sextant scan --force",
            },
            null,
            2
          ),
        },
      ],
    };
  }

  const meta = graph.getFileMeta(db, rel);

  // WHY: without this branch, querying a file that isn't in the graph
  // silently returned { fanIn: 0, fanOut: 0, exports: [], imports: [] },
  // indistinguishable from a real-but-isolated file.  Claude would treat
  // the empty result as authoritative.  Make the "not indexed" case
  // explicit so the caller can decide whether to re-scan or correct the
  // path.  A no-slash directory (e.g. "lib") falls through to the dir
  // aggregate before giving up.
  if (!meta) {
    const info = dirInfo();
    if (info) {
      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    }
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

// WHY: separate tool keeps sextant_health focused on freshness/resolution
// while exposing the richer signal-with-reason shape that callers want
// when reasoning about vendored exclusions. The summary header already
// shows "Vendored excluded: N (...)" but MCP-only consumers (agents
// driving sextant programmatically) never see the summary. Without this
// surface, an agent can't tell whether a sub-tree is intentionally
// excluded vs missing from the graph by mistake.
async function handleScope() {
  await ensureInit();

  let detectionEnabled = true;
  let signals = [];
  try {
    const cfg = loadRepoConfig(_root);
    detectionEnabled = cfg.vendoredDetection !== false;
    if (Array.isArray(cfg.vendoredSignals)) {
      signals = cfg.vendoredSignals;
    }
  } catch {
    /* fail-soft: scope is observability, never throw */
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            root: _root,
            detectionEnabled,
            vendoredCount: signals.length,
            vendored: signals.map((s) => ({ path: s.path, reason: s.reason })),
          },
          null,
          2
        ),
      },
    ],
  };
}

// Lane B of the subagent-orientation track (docs/018 + 022): the pull
// counterpart to the pretask hook's push. Same builder, same freshness gate
// (content-stale → honest absence message, never stale structural claims).
async function handleOrient(args) {
  await ensureInit();
  const { buildOrientationBlock } = require("../lib/orient");
  const built = await buildOrientationBlock(
    _root,
    typeof args?.task === "string" ? args.task : ""
  );
  if (!built) {
    return {
      content: [
        {
          type: "text",
          text:
            "Orientation unavailable: the index is stale or absent for this repo " +
            "(structural claims are withheld rather than served stale). " +
            "`sextant scan` rebuilds it.",
        },
      ],
    };
  }
  return { content: [{ type: "text", text: built.block }] };
}

// TASK CAPSULE (docs/027 Phase B). Facts-only, like sextant_orient.
function textResult(text) {
  return { content: [{ type: "text", text }] };
}

async function handleFocus(args) {
  await ensureInit();
  const task = typeof args?.task === "string" ? args.task : "";
  try {
    const graph = require("../lib/graph");
    const freshness = require("../lib/freshness");
    const { compileWorkset } = require("../lib/workset");
    const { buildCapsule, writeCapsule } = require("../lib/capsule");
    const { formatCapsule } = require("../lib/format-capsule");

    const fresh = await freshness.checkFreshness(_root);
    if (fresh.fresh === false && fresh.contentChanged === true) {
      return textResult(
        "Focus unavailable: the index is stale for this repo (structural claims withheld " +
        "rather than served stale). `sextant scan` rebuilds it."
      );
    }
    const db = await graph.loadDb(_root);
    if (!db || !graph.countFiles(db)) {
      return textResult("Focus unavailable: no index for this repo. Run `sextant scan`.");
    }

    let files = [];
    if (task.trim()) {
      const { shouldRetrieve } = require("../lib/classifier");
      const cls = shouldRetrieve(task.slice(-8192));
      if (cls && Array.isArray(cls.terms) && cls.terms.length) {
        const gr = require("../lib/graph-retrieve").graphRetrieve(db, cls.terms, {
          maxResults: 12,
          borderline: typeof cls.confidence === "number" && cls.confidence <= 0.4,
        });
        files = (gr && gr.files) || [];
      }
    }
    const res = graph.computeResolutionStats(db);
    const workset = compileWorkset(files, { root: _root, resolutionPct: res && res.resolutionPct });
    const capsule = buildCapsule({ root: _root, sessionKey: "mcp", taskText: task, workset });
    writeCapsule(_root, "mcp", capsule);
    const detailed = formatCapsule(capsule, { maxChars: 1400 });
    if (!detailed.text || !detailed.text.trim()) {
      return textResult(
        task.trim()
          ? "No task-relevant files found for that description. Try more specific symbol or file names."
          : "Provide a `task` description to compile a focused workset."
      );
    }
    return textResult(detailed.text);
  } catch {
    return textResult("Focus unavailable (internal error).");
  }
}

async function handleTaskStatus() {
  await ensureInit();
  try {
    const { readLatestCapsule, capsuleFreshness } = require("../lib/capsule");
    const cap = readLatestCapsule(_root);
    if (!cap) {
      return textResult(
        "No task capsule yet for this repo. Use sextant_focus to compile one (it also " +
        "forms automatically during retrieval when capsule mode is enabled)."
      );
    }
    const fr = capsuleFreshness(_root, cap);
    const ws = cap.workset || {};
    const count = (k) => (Array.isArray(ws[k]) ? ws[k].length : 0);
    const lines = [
      `Task ${cap.taskId} — status: ${cap.status}`,
      `Intent: ${(cap.intent && cap.intent.text) || "(none)"}`,
      `Repo: ${(cap.repo && cap.repo.branch) || "?"} @ ${String((cap.repo && cap.repo.head) || "").slice(0, 7)} ` +
        `(fingerprint ${fr.fresh ? "current" : "STALE — " + fr.reason})`,
      `Workset: primary ${count("primary")}, support ${count("support")}, witnesses ${count("witnesses")}, ` +
        `hazards ${count("hazards")}, unknowns ${count("unknowns")}`,
    ];
    if (count("primary")) lines.push("Primary: " + ws.primary.map((e) => e.path).join(", "));
    if (count("hazards")) lines.push("Hazards: " + ws.hazards.join("; "));
    try {
      const coherence = require("../lib/coherence");
      if (coherence.coherenceEnabled(_root)) {
        const result = coherence.analyzeCoherence(_root, { taskId: cap.taskId });
        lines.push(
          `Recorded agent boundaries: ${result.snapshotCount}; recorded workset-overlap pairs: ` +
          `${result.overlapPairTotal}`
        );
        if (coherence.hasFindings(result)) {
          const detail = coherence.renderCoherence(result, { maxChars: 1000 });
          if (detail) lines.push("Agent coherence:\n" + detail);
        }
      }
    } catch {}
    return textResult(lines.join("\n"));
  } catch {
    return textResult("Task status unavailable (internal error).");
  }
}

async function handleClosure() {
  await ensureInit();
  try {
    const { buildClosure, renderClosure } = require("../lib/closure");
    return textResult(renderClosure(buildClosure(_root, {})));
  } catch {
    return textResult("Closure report unavailable (internal error).");
  }
}

// --- Dispatch table -----------------------------------------------------

const toolHandlers = {
  sextant_search: handleSearch,
  sextant_related: handleRelated,
  sextant_explain: handleExplain,
  sextant_health: handleHealth,
  sextant_orient: handleOrient,
  sextant_scope: handleScope,
  sextant_focus: handleFocus,
  sextant_task_status: handleTaskStatus,
  sextant_closure: handleClosure,
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
    // Bounded string only — the raw clientInfo object is client-controlled.
    try {
      const name = params && params.clientInfo && params.clientInfo.name;
      if (typeof name === "string" && name.trim()) {
        _client = name.trim().toLowerCase().slice(0, 64);
      }
    } catch {}
    await ensureInit();
    return {
      protocolVersion: "2024-11-05",
      serverInfo: SERVER_INFO,
      capabilities: CAPABILITIES,
    };
  }

  if (method === "tools/list") {
    // The DENOMINATOR (docs/035 #3). This surface was completely unmeasured —
    // `grep -c recordEvent mcp/server.js` was 0, which is why nobody noticed
    // that a transcript census finds ~1 sextant tool invocation against
    // hundreds of definition loads. Counting loads separately from calls is the
    // whole point: 9 tool definitions are paid for on EVERY session that wires
    // this server, and the question "is that rent worth it" cannot be answered
    // from call counts alone.
    recordMcp("(tools/list)", { count: TOOLS.length });
    return { tools: TOOLS };
  }

  if (method === "tools/call") {
    const toolName = params.name;
    const toolArgs = params.arguments || {};
    const handler = toolHandlers[toolName];
    if (!handler) {
      recordMcp(String(toolName || "(unknown)"), { ok: false, reason: "unknown_tool" });
      return {
        content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
        isError: true,
      };
    }
    // WHY: MCP protocol requires tool-level failures to be returned as isError
    // in the response body, NOT as JSON-RPC error responses. JSON-RPC errors
    // signal protocol failures (malformed request, server crash), not tool failures.
    const startedAt = Date.now();
    try {
      const result = await handler(toolArgs);
      recordMcp(toolName, { ok: true, durationMs: Date.now() - startedAt });
      return result;
    } catch (err) {
      recordMcp(toolName, { ok: false, durationMs: Date.now() - startedAt, reason: "handler_error" });
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
// TOOL_NAMES is consumed by lib/orient.js so the injected "MCP server exposes"
// line is DERIVED from what this server actually registers rather than being a
// hardcoded string that silently rots when the tool set changes.
const TOOL_NAMES = TOOLS.map((t) => t.name);

module.exports = { dispatch, TOOLS, TOOL_NAMES, toolHandlers, startServer };

// Auto-start when run directly or via `sextant mcp`
if (require.main === module) {
  startServer();
}
