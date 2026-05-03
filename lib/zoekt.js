const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const { stateDir } = require("./utils");

function zoektDir(root) {
  return path.join(stateDir(root), "zoekt");
}

function zoektIndexDir(root) {
  return path.join(zoektDir(root), "index");
}

function zoektDaemonPath(root) {
  return path.join(zoektDir(root), "daemon.json");
}

// WHY: zoekt's default query parser splits on whitespace and treats each
// token as an independent substring clause AND'd together — so "extension
// EventLoopFuture" matches any file containing "extension" AND containing
// "EventLoopFuture" anywhere, not necessarily adjacent. The rg backend uses
// `-F` (literal substring) so multi-token queries match the exact phrase.
// To keep the two backends behaviorally equivalent for the sextant pipeline
// (which sends plain identifier/phrase strings, never zoekt query DSL),
// wrap multi-token queries in double quotes to force phrase semantics.
// Single-token queries pass through unchanged. Already-quoted queries
// (caller is intentionally using zoekt syntax) also pass through.
function quoteIfPhrase(q) {
  if (typeof q !== "string") return q;
  const trimmed = q.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('"')) return trimmed;
  if (!/\s/.test(trimmed)) return trimmed;
  // Strip embedded double quotes — they would terminate the phrase early.
  // The query semantics we want is "this phrase as a literal substring";
  // a query containing a `"` was almost certainly a user typing copy-pasted
  // text rather than zoekt DSL, so dropping the quote is safer than
  // splitting the query at it.
  return `"${trimmed.replace(/"/g, "")}"`;
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

// WHY: Uses "command -v" (POSIX) instead of "which" (not POSIX, missing on Alpine).
// Shell argument is quoted via argv to prevent injection while preserving login-shell PATH.
function which(bin) {
  const r = spawnSync("sh", ["-lc", 'command -v "$1" 2>/dev/null', "--", bin], { encoding: "utf8", timeout: 5000 });
  return r.status === 0 ? (r.stdout || "").trim() || null : null;
}

function isInstalled() {
  return !!which("zoekt-webserver");
}

function isGitRepo(root) {
  return exists(path.join(root, ".git"));
}

function hasIndex(root) {
  const dir = zoektIndexDir(root);
  if (!exists(dir)) return false;
  return fs.readdirSync(dir).some((f) => f.endsWith(".zoekt"));
}

function readDaemon(root) {
  const p = zoektDaemonPath(root);
  if (!exists(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeDaemon(root, data) {
  mkdirp(zoektDir(root));
  fs.writeFileSync(zoektDaemonPath(root), JSON.stringify(data, null, 2));
}

function isPidRunning(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function probeApi(port) {
  const url = `http://127.0.0.1:${port}/api/search`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        Q: "file:.",
        Opts: { TotalMaxMatchCount: 1, NumContextLines: 0 },
      }),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function buildIndex(root, { force = false } = {}) {
  mkdirp(zoektIndexDir(root));
  if (!force && hasIndex(root)) return { ok: true, skipped: true };

  const bin = isGitRepo(root) ? "zoekt-git-index" : "zoekt-index";
  if (!which(bin)) throw new Error(`Missing ${bin} in PATH`);

  const args = ["-index", zoektIndexDir(root), root];
  const r = spawnSync(bin, args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `Zoekt index failed: ${bin} ${args.join(" ")}\n${r.stderr || r.stdout || ""}`
    );
  }
  return { ok: true, indexed: true };
}

async function ensureWebserver(root, { port = 6070, autoIndex = false } = {}) {
  if (!isInstalled()) throw new Error("zoekt-webserver not found in PATH");

  const df = readDaemon(root);
  if (df?.pid && df?.port && isPidRunning(df.pid)) {
    if (await probeApi(df.port)) return { ok: true, reused: true, port: df.port, pid: df.pid };
  }

  if (!hasIndex(root)) {
    if (!autoIndex)
      throw new Error(
        "Zoekt index missing; run `sextant zoekt index` or pass --zoekt-build"
      );
    buildIndex(root, { force: false });
  }

  const ports = [port, ...Array.from({ length: 30 }, (_, i) => port + i + 1)];
  mkdirp(zoektDir(root));
  const lf = path.join(zoektDir(root), "webserver.log");
  const out = fs.openSync(lf, "a");

  for (const p of ports) {
    const args = ["-rpc", "-index", zoektIndexDir(root), "-listen", `127.0.0.1:${p}`];
    const child = spawn("zoekt-webserver", args, {
      cwd: root,
      detached: true,
      stdio: ["ignore", out, out],
    });
    child.unref();

    await sleep(250);

    // WHY: Verify the child we spawned is still alive before trusting the probe.
    // If child died but probe succeeds, another process owns this port — skip it.
    // This prevents recording a stale PID in daemon.json (the root cause of
    // searchFast returning empty results when a global zoekt held the port).
    const childAlive = isPidRunning(child.pid);
    if (childAlive && (await probeApi(p))) {
      writeDaemon(root, { pid: child.pid, port: p, startedAt: new Date().toISOString() });
      return { ok: true, started: true, port: p, pid: child.pid };
    }

    // Child failed to bind (port taken or crashed) — clean up and try next port
    if (childAlive) {
      try { process.kill(child.pid, "SIGTERM"); } catch {}
    }
    await sleep(75);
  }

  throw new Error("Failed to start zoekt-webserver (rpc). Check .planning/intel/zoekt/webserver.log");
}

function b64(s) {
  if (!s) return "";
  try {
    return Buffer.from(s, "base64").toString("utf8");
  } catch {
    return s;
  }
}

function normalize(json) {
  const result = json?.Result || json?.result || json;
  const files = result?.Files || result?.files || [];

  const hits = [];
  for (const f of files) {
    const fileName = f.FileName || f.fileName;
    const fileScore = f.Score || f.score || null;
    const lineMatches = f.LineMatches || f.lineMatches || [];

    for (const lm of lineMatches) {
      const ranges = (lm.LineFragments || lm.lineFragments || [])
        .filter((fr) => fr.Match)
        .map((fr) => ({ start: fr.Start, end: fr.End }));

      hits.push({
        path: fileName,
        lineNumber: lm.LineNumber ?? lm.lineNumber ?? null,
        line: b64(lm.Line).replace(/\n$/, ""),
        before: b64(lm.Before).split(/\r?\n/).filter(Boolean),
        after: b64(lm.After).split(/\r?\n/).filter(Boolean),
        ranges,
        provider: "zoekt",
        score: lm.Score ?? lm.score ?? fileScore,
      });
    }
  }

  return {
    provider: "zoekt",
    stats: {
      matchCount: hits.length,
      fileCount: result?.FileCount ?? result?.fileCount ?? files.length ?? null,
    },
    hits,
  };
}

// WHY: Fast-path search for hook use. Different from search() in three ways:
// 1. Does NOT call ensureWebserver() with autoIndex — if webserver isn't running, skip
// 2. Shared deadline: 180ms total for probe + search (not stacked independent timeouts)
// 3. Never throws — returns empty results on any failure (graceful degradation)
//
// This is the hot path: it runs on every code-relevant prompt. The hook can't
// afford to spawn a webserver (250ms+ startup) or wait 10s for a timeout.
async function searchFast(root, query, opts = {}) {
  const start = Date.now();
  const TOTAL_BUDGET_MS = 180;
  const deadline = start + TOTAL_BUDGET_MS;
  const empty = { hits: [], durationMs: 0, stats: {} };

  try {
    // 1. Read daemon.json to get the port
    const df = readDaemon(root);
    if (!df || !df.port) return empty;

    // WHY: PID check is a fast pre-filter, NOT a hard gate. The webserver may
    // have been restarted externally (e.g. by scan or manual restart) leaving
    // daemon.json with a stale PID. If PID is dead, skip straight to probe —
    // if the port responds, the server is fine. Only bail if probe also fails.
    if (df.pid && isPidRunning(df.pid)) {
      // PID alive — fast path confirmed, proceed to probe
    }

    // 2. Quick probe — fast fail if webserver is unresponsive
    // WHY: Shared deadline prevents probe + search from stacking to 250ms.
    const probeTimeout = Math.max(10, deadline - Date.now());
    const probeOk = await probeFast(df.port, probeTimeout);
    if (!probeOk) return empty;

    // 3. Search with remaining budget
    const searchTimeout = Math.max(10, deadline - Date.now());
    const url = `http://127.0.0.1:${df.port}/api/search`;
    const payload = {
      Q: quoteIfPhrase(query),
      Opts: {
        TotalMaxMatchCount: opts.totalMaxMatchCount || 100,
        NumContextLines: 0,
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), searchTimeout);
    let json;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) return empty;
      json = await res.json();
    } finally {
      clearTimeout(timer);
    }

    // 4. Normalize using existing normalize()
    const norm = normalize(json);
    const maxHits = opts.maxHits || 30;
    if (norm.hits.length > maxHits) norm.hits = norm.hits.slice(0, maxHits);

    return {
      hits: norm.hits,
      durationMs: Date.now() - start,
      stats: norm.stats,
    };
  } catch {
    // Never throw from the fast path — degrade gracefully
    return { ...empty, durationMs: Date.now() - start };
  }
}

// WHY: Separate from probeApi() which has a 5s timeout. The hook needs
// a much tighter budget — 100ms is enough to detect a live local server.
async function probeFast(port, timeoutMs) {
  const url = `http://127.0.0.1:${port}/api/search`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        Q: "file:.",
        Opts: { TotalMaxMatchCount: 1, NumContextLines: 0 },
      }),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function search(root, q, opts = {}) {
  const { port } = await ensureWebserver(root, {
    port: opts.port ?? 6070,
    autoIndex: !!opts.autoIndex,
  });

  const url = `http://127.0.0.1:${port}/api/search`;
  const payload = {
    Q: quoteIfPhrase(q),
    Opts: {
      TotalMaxMatchCount: opts.totalMaxMatchCount ?? 500,
      NumContextLines: opts.contextLines ?? 1,
    },
  };

  // WHY: Timeout covers both fetch() and res.json() — a server that sends headers
  // promptly but stalls the body would hang forever if we cleared the timer early.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let json;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Zoekt search failed: HTTP ${res.status}`);
    json = await res.json();
  } finally {
    clearTimeout(timer);
  }
  const norm = normalize(json);

  const maxHits = opts.maxHits ?? 50;
  if (norm.hits.length > maxHits) norm.hits = norm.hits.slice(0, maxHits);

  return { ...norm, details: { port } };
}

module.exports = {
  isInstalled,
  hasIndex,
  buildIndex,
  ensureWebserver,
  search,
  searchFast,
  zoektIndexDir,
  // Exported for unit testing — see test/zoekt-query.test.js
  quoteIfPhrase,
};
