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

// Regex metacharacters that zoekt's default (regex) query syntax interprets.
// Escaping these gives literal-substring matching, which is what the rg
// backend gives via -F and what the sextant pipeline always wants —
// callers send identifier/phrase strings, never zoekt DSL.
const ZOEKT_REGEX_SPECIALS_RE = /[.*+?^${}()|[\]\\]/g;
function escapeRegex(s) {
  return String(s).replace(ZOEKT_REGEX_SPECIALS_RE, "\\$&");
}

// WHY: zoekt's default query parser does two things that diverge from rg's
// `-F` literal-substring semantics:
//   1. Whitespace splits the query into independent substring clauses AND'd
//      together — so "extension EventLoopFuture" matches any file with
//      "extension" AND "EventLoopFuture" anywhere, not necessarily adjacent.
//   2. Tokens are interpreted as regex — so `View+Toolbar` treats `+` as
//      one-or-more, never matching the literal `+` character in source.
//
// quoteIfPhrase makes the two backends behaviorally equivalent for the
// sextant pipeline:
//   - Regex specials always get escaped (View+Toolbar → View\+Toolbar).
//   - Multi-token queries get wrapped in double quotes to force phrase
//     semantics (extension EventLoopFuture → "extension EventLoopFuture").
//   - Already-quoted queries (caller intentionally using zoekt DSL) pass
//     through unchanged so the escape hatch still exists.
//
// Quoting BEFORE escaping would re-introduce the regex problem inside the
// phrase, since zoekt still interprets `+` inside quotes as a quantifier.
// Quoting AFTER escaping (single-token + multi-token paths share the
// escape) is the correct order.
function quoteIfPhrase(q) {
  if (typeof q !== "string") return q;
  const trimmed = q.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('"')) return trimmed;
  // Strip embedded double quotes first — they would either terminate a
  // wrapping phrase early or split a single-token query.  The query
  // semantics we want is "this string as a literal substring"; a query
  // containing a `"` was almost certainly user copy-paste rather than
  // zoekt DSL, so dropping the quote is safer than splitting.
  const cleaned = trimmed.replace(/"/g, "");
  const escaped = escapeRegex(cleaned);
  if (!/\s/.test(cleaned)) return escaped;
  return `"${escaped}"`;
}

// WHY: The AND-fallback form of a query — escape regex specials (so `+` etc.
// stay literal) but do NOT wrap in quotes, so a multi-token query becomes
// zoekt's default whitespace-AND conjunction instead of a literal adjacency
// phrase. Used ONLY as a recall fallback when the phrase query returns zero
// hits (see searchFast/search): a natural-language prompt whose words are
// scattered — "hyperdrive meds source" — phrase-matches nothing, collapsing
// the hook's candidate set to incidental filename matches while the canonical
// source is absent from every layer (real-repo dogfooding failure, 2026-05-28).
// Distinct from quoteIfPhrase, which always quotes multi-token input.
function escapeForZoekt(q) {
  if (typeof q !== "string") return q;
  const trimmed = q.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('"')) return trimmed; // caller DSL — leave alone
  return escapeRegex(trimmed.replace(/"/g, ""));
}

// WHY: true exactly when quoteIfPhrase would wrap this query as a phrase —
// multi-token and not already caller-quoted zoekt DSL. Gates the zero-hit
// AND-fallback so single-token and DSL queries never trigger a second request.
function isMultiTokenPhrase(q) {
  if (typeof q !== "string") return false;
  const t = q.trim();
  if (!t || t.startsWith('"')) return false;
  return /\s/.test(t.replace(/"/g, ""));
}

// WHY: shared POST helper so the primary query and the zero-hit AND-fallback
// don't duplicate fetch/abort/parse logic. Returns parsed json or null on any
// failure (never throws) so callers fall through to their existing result.
async function postSearch(url, Q, { totalMaxMatchCount, numContextLines, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Q, Opts: { TotalMaxMatchCount: totalMaxMatchCount, NumContextLines: numContextLines } }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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

// Second identity layer, best-effort: does the live process actually serve OUR
// index? On Linux /proc/<pid>/cmdline carries the `-index <dir>` argument the
// daemon was started with, so a PID that was recycled onto an unrelated process
// — or a webserver started for a different repo — is caught even though it is
// "alive". Where /proc is unavailable (macOS) we fall back to trusting the live
// recorded PID, which is still strictly stronger than the previous behaviour of
// trusting a dead one. Never throws; on any doubt returns false (fail closed).
function daemonServesThisRoot(root, pid) {
  let cmdline;
  try {
    cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return true; // no /proc — liveness is the strongest signal available
  }
  const args = cmdline.split("\0").filter(Boolean);
  if (!args.length) return true;
  if (!args.some((a) => a.includes("zoekt"))) return false; // PID recycled
  const wanted = zoektIndexDir(root);
  const idx = args.indexOf("-index");
  const declared = idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
  if (!declared) return args.some((a) => a === wanted);
  return path.resolve(declared) === path.resolve(wanted);
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

// WHY the scope layer (lib/zoekt-scope.js, 2026-07-10 incident): an unscoped
// `zoekt-index <root>` walks everything except .git/.hg/.svn — pointed at a
// mis-adopted root it grew a 101 GB index. Non-git roots get -ignore_dirs +
// a corpus pre-check; both paths get tmp-shard cleanup, a persisted disabled
// marker, and a post-build index-size circuit breaker. `force: true` is the
// deliberate re-enable path (`sextant zoekt index --force`): it clears the
// marker, then the pre-checks still apply — raise the caps in
// .codebase-intel.json (zoektMaxCorpusBytes / zoektMaxIndexBytes) to truly
// override.
function buildIndex(root, { force = false } = {}) {
  const scope = require("./zoekt-scope");
  const disabled = scope.readDisabled(root);
  if (disabled) {
    if (!force) return { ok: false, disabled: true, reason: disabled.reason, detail: disabled.detail };
    scope.clearDisabled(root);
  }

  mkdirp(zoektIndexDir(root));
  if (!force && hasIndex(root)) return { ok: true, skipped: true };

  scope.cleanupTmpShards(zoektIndexDir(root));

  const caps = scope.readZoektCaps(root);
  const isGit = isGitRepo(root);
  const bin = isGit ? "zoekt-git-index" : "zoekt-index";
  if (!which(bin)) throw new Error(`Missing ${bin} in PATH`);

  // Corpus pre-check for the non-git path only: zoekt-git-index indexes
  // committed content (bounded by the repo); zoekt-index walks the live tree.
  if (!isGit) {
    const est = scope.estimateCorpusBytes(root, { capBytes: caps.maxCorpusBytes });
    if (est.exceeded) {
      const detail = `estimated indexable corpus exceeds the ${caps.maxCorpusBytes}-byte cap (${est.reason}); refusing to index`;
      scope.writeDisabled(root, { reason: "corpus-too-large", detail });
      return { ok: false, disabled: true, reason: "corpus-too-large", detail };
    }
  }

  const args = isGit
    ? ["-index", zoektIndexDir(root), root]
    : ["-index", zoektIndexDir(root), "-ignore_dirs", scope.ZOEKT_IGNORE_DIRS.join(","), root];
  const r = spawnSync(bin, args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `Zoekt index failed: ${bin} ${args.join(" ")}\n${r.stderr || r.stdout || ""}`
    );
  }

  const cap = scope.checkIndexSizeCap(root, caps);
  if (cap.disabled) {
    return { ok: false, disabled: true, reason: "index-size-cap", detail: `index reached ${cap.bytes} bytes` };
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
    // A disabled lane must not silently serve an empty index — throwing here
    // lands in the callers' existing catch paths, and search falls back to rg.
    {
      const scope = require("./zoekt-scope");
      const disabled = scope.readDisabled(root);
      if (disabled) {
        throw new Error(
          `Zoekt disabled for this repo (${disabled.reason}) — see \`sextant doctor\`; re-enable with \`sextant zoekt index --force\``
        );
      }
    }
    if (!autoIndex)
      throw new Error(
        "Zoekt index missing; run `sextant zoekt index` or pass --zoekt-build"
      );
    const built = buildIndex(root, { force: false });
    if (built && built.disabled) {
      throw new Error(`Zoekt disabled for this repo (${built.reason}) — see \`sextant doctor\``);
    }
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

// Build the path filter for a root: `true` means DROP this hit.
//
// The secret denylist is a pure function and applies to every root, so the hot
// path (a git repo) pays no I/O at all. The `.gitignore` filter is loaded ONLY
// for a non-git root — that is the path where zoekt walks the live tree and the
// user's own ignore rules are the best available statement of "not source" —
// and it is cached per root because the MCP server is long-lived (hooks are
// separate processes, so for them the cache is a no-op).
const pathFilterCache = new Map();
function buildDropPath(root) {
  const { isSensitivePath } = require("./zoekt-scope");
  if (!root) return isSensitivePath;
  if (pathFilterCache.has(root)) return pathFilterCache.get(root);

  let gitignoreFilter = null;
  if (!isGitRepo(root)) {
    try {
      gitignoreFilter = require("./config").loadRepoConfig(root).gitignoreFilter || null;
    } catch {
      gitignoreFilter = null; // never let scope loading break search
    }
  }
  const dropPath = gitignoreFilter
    ? (p) => isSensitivePath(p) || gitignoreFilter(p)
    : isSensitivePath;
  pathFilterCache.set(root, dropPath);
  return dropPath;
}

function normalize(json, dropPath) {
  const result = json?.Result || json?.result || json;
  const files = result?.Files || result?.files || [];

  const hits = [];
  let dropped = 0;
  for (const f of files) {
    const fileName = f.FileName || f.fileName;
    const fileScore = f.Score || f.score || null;
    const lineMatches = f.LineMatches || f.lineMatches || [];

    // Drop the WHOLE file before any line is read. Filtering line-by-line would
    // still have materialized the secret in memory and in `before`/`after`
    // context of a neighbouring hit.
    if (typeof dropPath === "function" && dropPath(fileName)) {
      dropped++;
      continue;
    }

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
      // Surfaced, not silent: a caller (and `sextant doctor`) can see that the
      // index contains files the injection path refuses to quote.
      sensitiveFilesDropped: dropped,
    },
    hits,
  };
}

// WHY: zoekt returns every line-match of the top-scored file before any line
// of the next file, so a flat slice(0, maxHits) can return maxHits lines of a
// SINGLE big file. The merge layer groups hits by file and uses the best line
// per file, so for the A4 AND-fallback (where the top file may carry 30+ line
// matches) that starves the merge to one candidate — the fallback surfaced 30
// lines of hyperdrive/models.py and nothing else, leaving the real canonical
// router.py unreachable. Collapsing to the best (first = highest-score) hit per
// distinct file before the cap lets maxHits slots cover up to maxHits files.
// Applied ONLY to the fallback path so primary queries (which already return
// hits) stay byte-identical and no existing eval gate can shift.
function bestPerFile(hits) {
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    if (seen.has(h.path)) continue;
    seen.add(h.path);
    out.push(h);
  }
  return out;
}

// WHY: the Tier-3 OR-fallback (see searchFast) unions the query tokens, which
// matches any file containing ANY single token — including files that mention
// one common word many times. Ranking those by raw hit count would float a
// high-frequency-single-token file above the file that actually covers the
// QUESTION. Instead score each file by distinct-token COVERAGE: how many of the
// query's tokens appear anywhere in that file's matched lines. The file that
// touches the most concepts wins, then raw line score breaks ties. Collapses to
// one (best) hit per file, like bestPerFile, so the cap covers distinct files.
function rankByTokenCoverage(hits, tokens) {
  const lowered = tokens.map((t) => String(t).toLowerCase());
  const byFile = new Map();
  for (const h of hits) {
    const line = String(h.line || "").toLowerCase();
    let f = byFile.get(h.path);
    if (!f) {
      f = { best: h, covered: new Set() };
      byFile.set(h.path, f);
    }
    for (const t of lowered) if (line.includes(t)) f.covered.add(t);
    if ((h.score || 0) > (f.best.score || 0)) f.best = h;
  }
  return Array.from(byFile.values())
    .sort((a, b) => (b.covered.size - a.covered.size) || ((b.best.score || 0) - (a.best.score || 0)))
    .map((f) => f.best);
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
  const dropPath = buildDropPath(root);

  try {
    // 1. Read daemon.json to get the port
    const df = readDaemon(root);
    if (!df || !df.port) return empty;

    // IDENTITY, not liveness (docs/035 #5). This was a soft pre-filter: a dead
    // PID fell through to the probe, and "the port answers" was treated as "the
    // server is fine". Ports get REUSED. Observed on the live fleet:
    // /root/manus-api-mcp recorded pid 3880578 (dead) on port 6075, which is now
    // owned by a different zoekt-webserver serving another repo's index — so
    // `searchFast('/root/manus-api-mcp', 'manus')` returned 6 hits, every one a
    // sextant file (docs/015-handoff.md, test/watch.test.js, …). Injecting
    // another repository's paths as this repository's facts is the sharpest
    // possible breach of "silent absence over false confidence": the agent has
    // no way to tell the answer came from somewhere else.
    //
    // A dead recorded PID now DISQUALIFIES the port outright. We recorded that
    // pid when we started the daemon; if it is gone, whatever holds the port is
    // not ours to trust. Going dark here is correct — the caller degrades to the
    // graph lane, which is repo-correct by construction.
    if (!df.pid || !isPidRunning(df.pid)) return empty;
    if (!daemonServesThisRoot(root, df.pid)) return empty;

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
    let norm = normalize(json, dropPath);

    // A4 recall fallback — two tiers, each fires ONLY when the prior produced
    // zero hits, so any query that already matched is byte-identical (Swift/JS
    // code-syntax phrases like "protocol Middleware" return hits and never reach
    // these branches). Both run within the remaining shared deadline; on a tight
    // (cold-daemon) budget they are skipped rather than overrunning the 180ms.
    //
    // Tier 2 — AND: quoteIfPhrase wrapped a multi-token query as a literal
    // adjacency phrase; for a natural-language prompt whose tokens are scattered
    // the phrase matches nothing and the hook's merged set collapses to
    // incidental graph filename matches (often only test files). Retry unquoted
    // (whitespace-AND).
    if (norm.hits.length === 0 && isMultiTokenPhrase(query)) {
      const fbTimeout = deadline - Date.now();
      if (fbTimeout > 10) {
        const fbJson = await postSearch(url, escapeForZoekt(query), {
          totalMaxMatchCount: payload.Opts.TotalMaxMatchCount,
          numContextLines: payload.Opts.NumContextLines,
          timeoutMs: fbTimeout,
        });
        if (fbJson) {
          const fbNorm = normalize(fbJson, dropPath);
          // bestPerFile: the AND query's top file may own 30+ line matches;
          // diversify so the cap covers up to maxHits distinct files.
          if (fbNorm.hits.length > 0) norm = { ...fbNorm, hits: bestPerFile(fbNorm.hits) };
        }
      }
    }

    // NOTE: there is NO Tier-3 OR fallback on this hot path. Measured on a large
    // real repo, a third sequential round-trip (the OR union) pushed searchFast
    // to 247–316ms — well past the 180ms hook budget — and fired only flakily as
    // the budget allowed. The token-coverage OR fallback lives ONLY in search()
    // (CLI/MCP, 10s budget), which is the deliberate-query path where the extra
    // latency is acceptable. The hook keeps phrase + AND, which fit the budget.
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
  const dropPath = buildDropPath(root);
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
  let norm = normalize(json, dropPath);

  // A4 recall fallback — CLI/MCP parity with searchFast (see its comment).
  // Tier 2 (AND): multi-token phrase that matched nothing is retried unquoted.
  if (norm.hits.length === 0 && isMultiTokenPhrase(q)) {
    const fbJson = await postSearch(url, escapeForZoekt(q), {
      totalMaxMatchCount: payload.Opts.TotalMaxMatchCount,
      numContextLines: payload.Opts.NumContextLines,
      timeoutMs: 10000,
    });
    if (fbJson) {
      const fbNorm = normalize(fbJson, dropPath);
      // bestPerFile: diversify the fallback so the cap covers distinct files.
      if (fbNorm.hits.length > 0) norm = { ...fbNorm, hits: bestPerFile(fbNorm.hits) };
    }
  }

  // Tier 3 (token-coverage OR): AND also matched nothing — union tokens, rank by
  // distinct-token coverage.
  if (norm.hits.length === 0 && isMultiTokenPhrase(q)) {
    const tokens = String(q).trim().split(/\s+/).filter((t) => t.length >= 3);
    if (tokens.length >= 3) {
      const orJson = await postSearch(url, tokens.map(escapeForZoekt).join(" or "), {
        totalMaxMatchCount: payload.Opts.TotalMaxMatchCount,
        numContextLines: payload.Opts.NumContextLines,
        timeoutMs: 10000,
      });
      if (orJson) {
        const orNorm = normalize(orJson, dropPath);
        if (orNorm.hits.length > 0) norm = { ...orNorm, hits: rankByTokenCoverage(orNorm.hits, tokens) };
      }
    }
  }

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
  escapeForZoekt,
  rankByTokenCoverage,
  // Exported for unit testing — see test/honesty-gaps.test.js. Lets a test
  // assert the secret filter drops a whole file without standing up a daemon.
  _normalizeForTest: normalize,
  _daemonServesThisRootForTest: daemonServesThisRoot,
};
