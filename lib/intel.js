const fs = require("fs");
const path = require("path");

const fg = require("fast-glob");

const { normalizeRelPath, isIndexable, fileTypeHeuristic } = require("./utils");
const { extractImports, extractExports } = require("./extractor");
const { resolveImport } = require("./resolver");
const graph = require("./graph");
const summary = require("./summary");
const history = require("./history");

// WHY: Bump triggers auto-migration of stale index entries on load.
// v1: original format (may contain absolute-path keys and string imports).
// v2: all keys are relative paths, all imports are {specifier, resolved, kind}.
const INDEX_VERSION = 2;

const stateByRoot = new Map();

function S(root) {
  const rootAbs = path.resolve(root);
  if (!stateByRoot.has(rootAbs)) {
    stateByRoot.set(rootAbs, {
      rootAbs,
      initialized: false,

      queue: Promise.resolve(),

      indexLoaded: false,
      index: null,
      indexDirty: false,
      indexTimer: null,
      indexScheduledMs: 0,

      graphDirty: false,
      graphTimer: null,
      graphScheduledMs: 0,

      summaryDirty: false,
      summaryTimer: null,
      summaryScheduledMs: 0,
      lastSummaryTimeMs: 0,
    });
  }
  return stateByRoot.get(rootAbs);
}

function withQueue(rootAbs, fn) {
  const st = S(rootAbs);
  const next = st.queue.then(() => fn());
  st.queue = next.catch(() => {});
  return next;
}

function stateDir(rootAbs) {
  return path.join(rootAbs, ".planning", "intel");
}

function indexPath(rootAbs) {
  return path.join(stateDir(rootAbs), "index.json");
}

function summaryPath(rootAbs) {
  return path.join(stateDir(rootAbs), "summary.md");
}

function claudeSettingsPath(rootAbs) {
  return path.join(rootAbs, ".claude", "settings.json");
}

function parseEnvThrottleMs() {
  const v = process.env.INTEL_SUMMARY_THROTTLE_MS;
  if (!v) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

async function loadIndexUnlocked(st) {
  if (st.indexLoaded && st.index) return st.index;
  st.indexLoaded = true;

  const p = indexPath(st.rootAbs);
  if (fs.existsSync(p)) {
    try {
      const raw = fs.readFileSync(p, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.files && typeof parsed.files === "object") {
        st.index = parsed;
        migrateIndexIfNeeded(st);
        return st.index;
      }
    } catch {
      // fall through
    }
  }

  st.index = {
    version: INDEX_VERSION,
    generatedAt: null,
    files: {},
  };
  st.indexDirty = true;
  await flushIndexUnlocked(st);
  return st.index;
}

// WHY: Old index entries (v1) may have absolute-path keys and/or plain-string
// import arrays.  Both silently degrade resolution metrics because
// computeResolutionMetrics treats string imports as unresolved.  Rather than
// requiring a manual re-index, we migrate on load: normalize keys to relative
// paths, clear stale imports (so metrics reflect reality, not stale data), and
// zero mtimeMs so the next scan re-extracts with proper resolution.
function migrateIndexIfNeeded(st) {
  const idx = st.index;
  if (!idx?.files) return 0;
  if (idx.version >= INDEX_VERSION) return 0;

  const files = idx.files;
  const keysToDelete = [];
  let migrated = 0;

  for (const key of Object.keys(files)) {
    const entry = files[key];

    // Fix 1: absolute-path keys → relative
    if (path.isAbsolute(key)) {
      const rel = path.relative(st.rootAbs, key);
      if (!rel.startsWith("..")) {
        // Re-key with cleared mtime and empty imports — the entry is
        // preserved so the file isn't treated as new, but its stale data
        // won't pollute resolution metrics before re-extraction.
        files[rel] = { ...entry, mtimeMs: 0, imports: [], exports: [] };
        migrated++;
      }
      keysToDelete.push(key);
      continue;
    }

    // Fix 2: string imports → clear and force re-extraction
    const imports = entry?.imports;
    if (Array.isArray(imports) && imports.some((imp) => typeof imp === "string")) {
      entry.mtimeMs = 0;
      entry.imports = [];
      entry.exports = [];
      migrated++;
    }
  }

  for (const key of keysToDelete) {
    delete files[key];
  }

  if (migrated > 0) {
    idx.version = INDEX_VERSION;
    st.indexDirty = true;
    st.needsRescan = true;
  }
  return migrated;
}

async function flushIndexUnlocked(st) {
  if (!st.indexDirty || !st.index) return;
  const p = indexPath(st.rootAbs);
  const tmp = `${p}.tmp`;

  st.index.version = INDEX_VERSION;
  st.index.generatedAt = new Date().toISOString();

  await fs.promises.writeFile(tmp, JSON.stringify(st.index, null, 2) + "\n", "utf8");
  await fs.promises.rename(tmp, p);
  st.indexDirty = false;
}

function scheduleIndexFlush(rootAbs, debounceMs = 750) {
  const st = S(rootAbs);
  if (!st.index) return;
  st.indexDirty = true;

  const now = Date.now();
  const target = now + debounceMs;

  if (st.indexTimer) {
    if (target <= st.indexScheduledMs) return;
    clearTimeout(st.indexTimer);
    st.indexTimer = null;
    st.indexScheduledMs = 0;
  }

  st.indexScheduledMs = target;
  st.indexTimer = setTimeout(() => {
    st.indexTimer = null;
    st.indexScheduledMs = 0;
    withQueue(rootAbs, async () => {
      await flushIndexUnlocked(st);
    }).catch(() => {});
  }, Math.max(0, target - now));

  st.indexTimer.unref?.();
}

async function persistGraphUnlocked(st) {
  if (!st.graphDirty) return;
  await graph.persistDb(st.rootAbs);
  st.graphDirty = false;
}

function scheduleGraphPersist(rootAbs, debounceMs = 750) {
  const st = S(rootAbs);
  st.graphDirty = true;

  const now = Date.now();
  const target = now + debounceMs;

  if (st.graphTimer) {
    if (target <= st.graphScheduledMs) return;
    clearTimeout(st.graphTimer);
    st.graphTimer = null;
    st.graphScheduledMs = 0;
  }

  st.graphScheduledMs = target;
  st.graphTimer = setTimeout(() => {
    st.graphTimer = null;
    st.graphScheduledMs = 0;
    withQueue(rootAbs, async () => {
      await persistGraphUnlocked(st);
    }).catch(() => {});
  }, Math.max(0, target - now));

  st.graphTimer.unref?.();
}

async function writeSummaryUnlocked(st, { force = false } = {}) {
  const rootAbs = st.rootAbs;
  const p = summaryPath(rootAbs);

  if (!force && !st.summaryDirty && fs.existsSync(p)) return readSummary(rootAbs) || "";

  const idx = await loadIndexUnlocked(st);
  const db = await graph.loadDb(rootAbs);

  const md = summary.writeSummaryMarkdown(rootAbs, { index: idx, db, graph });
  await fs.promises.writeFile(p, md, "utf8");

  // Record health snapshot for historical tracking
  try {
    const healthData = summary.health(rootAbs, { index: idx, db, graph });
    history.recordSnapshot(rootAbs, healthData);
  } catch {
    // Non-critical, don't fail summary write
  }

  st.lastSummaryTimeMs = Date.now();
  st.summaryDirty = false;
  return md;
}

function scheduleSummary(rootAbs, { throttleMs = 0, debounceMs = 750 } = {}) {
  const st = S(rootAbs);
  st.summaryDirty = true;

  const now = Date.now();
  const sPath = summaryPath(rootAbs);
  const hasSummary = fs.existsSync(sPath);

  const earliestByThrottle =
    throttleMs > 0 && hasSummary && st.lastSummaryTimeMs > 0
      ? st.lastSummaryTimeMs + throttleMs
      : now;

  const target = Math.max(now + debounceMs, earliestByThrottle);

  if (st.summaryTimer) {
    if (target <= st.summaryScheduledMs) return;
    clearTimeout(st.summaryTimer);
    st.summaryTimer = null;
    st.summaryScheduledMs = 0;
  }

  st.summaryScheduledMs = target;
  st.summaryTimer = setTimeout(() => {
    st.summaryTimer = null;
    st.summaryScheduledMs = 0;
    withQueue(rootAbs, async () => {
      await writeSummaryUnlocked(st, { force: true });
    }).catch(() => {});
  }, Math.max(0, target - now));

  st.summaryTimer.unref?.();
}

const refreshRelPath = "tools/codebase_intel/refresh.js";

async function ensureRefreshScriptUnlocked(rootAbs) {
  const src = path.join(__dirname, "..", refreshRelPath);
  const dst = path.join(rootAbs, refreshRelPath);

  let srcText = null;
  try {
    srcText = fs.readFileSync(src, "utf8");
  } catch {
    return;
  }

  await fs.promises.mkdir(path.dirname(dst), { recursive: true });

  let dstText = null;
  try {
    dstText = fs.readFileSync(dst, "utf8");
  } catch {}

  if (dstText !== srcText) {
    await fs.promises.writeFile(dst, srcText, "utf8");
  }
}

async function ensureClaudeSettingsUnlocked(rootAbs) {
  const dir = path.join(rootAbs, ".claude");
  const p = claudeSettingsPath(rootAbs);
  await fs.promises.mkdir(dir, { recursive: true });

  await ensureRefreshScriptUnlocked(rootAbs);

  const sessionStartCmd = "sextant hook sessionstart";
  const refreshCmd = `node ${refreshRelPath}`;

  const desired = {
    hooks: {
      SessionStart: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: sessionStartCmd }],
        },
      ],
      UserPromptSubmit: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: refreshCmd }],
        },
      ],
    },
  };

  if (!fs.existsSync(p)) {
    await fs.promises.writeFile(p, JSON.stringify(desired, null, 2) + "\n", "utf8");
    return;
  }

  let current = null;
  try {
    current = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    // Don't overwrite unreadable user config.
    return;
  }

  if (!current || typeof current !== "object") return;
  if (!current.hooks || typeof current.hooks !== "object") current.hooks = {};

  // Ensure SessionStart hook
  if (!Array.isArray(current.hooks.SessionStart)) current.hooks.SessionStart = [];
  ensureHookCommand(current.hooks.SessionStart, sessionStartCmd);

  // Ensure UserPromptSubmit hook for mid-session refresh
  if (!Array.isArray(current.hooks.UserPromptSubmit)) current.hooks.UserPromptSubmit = [];
  ensureHookCommand(current.hooks.UserPromptSubmit, refreshCmd);

  await fs.promises.writeFile(p, JSON.stringify(current, null, 2) + "\n", "utf8");
}

function ensureHookCommand(arr, cmd) {
  let entry = arr.find((x) => x && typeof x === "object" && x.matcher === "*");
  if (!entry) {
    entry = { matcher: "*", hooks: [] };
    arr.push(entry);
  }
  if (!Array.isArray(entry.hooks)) entry.hooks = [];
  const hasCmd = entry.hooks.some(
    (h) => h && typeof h === "object" && h.type === "command" && h.command === cmd
  );
  if (!hasCmd) entry.hooks.push({ type: "command", command: cmd });
}

async function initUnlocked(st) {
  if (st.initialized) return;
  const rootAbs = st.rootAbs;

  await fs.promises.mkdir(stateDir(rootAbs), { recursive: true });

  // Seed summary throttle from disk.
  try {
    const p = summaryPath(rootAbs);
    if (fs.existsSync(p)) {
      const s = fs.statSync(p);
      st.lastSummaryTimeMs = Math.floor(s.mtimeMs);
    }
  } catch {}

  // Ensure state files exist.
  await graph.loadDb(rootAbs);
  if (!fs.existsSync(graph.graphDbPath(rootAbs))) {
    await graph.persistDb(rootAbs);
  }

  await loadIndexUnlocked(st);

  // WHY: If migration cleared stale entries, re-extract them now rather than
  // waiting for a manual rescan.  This makes format upgrades transparent —
  // the next sessionstart hook or health check gets fresh data automatically.
  if (st.needsRescan) {
    st.needsRescan = false;
    const db = await graph.loadDb(rootAbs);
    const staleEntries = Object.entries(st.index?.files || {}).filter(
      ([, entry]) => entry.mtimeMs === 0
    );
    for (const [rel] of staleEntries) {
      await indexOneFileUnlocked(st, db, rel, { force: true });
    }
    if (st.indexDirty) await flushIndexUnlocked(st);
    if (st.graphDirty) await persistGraphUnlocked(st);
    await writeSummaryUnlocked(st, { force: true });
  }

  if (!fs.existsSync(summaryPath(rootAbs))) {
    await fs.promises.writeFile(summaryPath(rootAbs), "", "utf8");
  }

  await ensureClaudeSettingsUnlocked(rootAbs);

  st.initialized = true;
}

function defaultIgnore(ignore) {
  const base = [
    "**/node_modules/**",
    "**/.git/**",
    "**/.planning/**",
    "**/.claude/**",
    "**/dist/**",
    "**/build/**",
    "**/.next/**",
  ];
  const extra = Array.isArray(ignore) ? ignore : [];
  return [...new Set([...base, ...extra])];
}

async function indexOneFileUnlocked(st, db, relPath, opts = {}) {
  const rel = normalizeRelPath(relPath);
  if (!isIndexable(rel)) return { skipped: true, reason: "not-indexable" };

  const abs = path.join(st.rootAbs, rel);
  let stat;
  try {
    stat = await fs.promises.stat(abs);
  } catch {
    // deletion
    if (st.index?.files?.[rel]) {
      delete st.index.files[rel];
      st.indexDirty = true;
    }
    graph.deleteFile(db, rel);
    st.graphDirty = true;
    return { skipped: false, deleted: true };
  }

  if (!stat.isFile()) return { skipped: true, reason: "not-file" };

  const type = fileTypeHeuristic(rel);
  const sizeBytes = stat.size;
  const mtimeMs = Math.floor(stat.mtimeMs);

  // Skip extraction if file unchanged (mtime + size match) unless forced
  const cached = st.index?.files?.[rel];
  if (!opts.force && cached && cached.mtimeMs === mtimeMs && cached.sizeBytes === sizeBytes) {
    return { skipped: true, reason: "unchanged" }; // Already indexed, skip expensive extraction
  }

  let code = null;
  if (sizeBytes <= 512 * 1024) {
    try {
      code = await fs.promises.readFile(abs, "utf8");
    } catch {
      code = null;
    }
  }

  const importsRaw = code ? extractImports(code, type) : [];
  const exportsRaw = code ? extractExports(code, type) : [];

  // WHY: Separate re-exports (have a `from` field) from regular exports.
  // Re-exports go into the reexports table for barrel-file chain tracing;
  // regular exports stay in the exports table for symbol lookup.
  // Both are stored in the index for completeness.
  const regularExports = [];
  const reexports = [];
  for (const ex of exportsRaw) {
    if (ex.from) {
      reexports.push(ex);
    } else {
      regularExports.push(ex);
    }
  }

  const importsResolved = importsRaw.map((it) => resolveImport(st.rootAbs, rel, it.specifier));

  const importsForIndex = importsResolved.map((r) => ({
    specifier: r.specifier,
    resolved: r.resolved,
    kind: r.kind,
  }));

  const importsForGraph = importsResolved.map((r) => ({
    specifier: r.specifier,
    toPath: r.resolved,
    kind: r.kind,
    isExternal: r.kind === "external" || r.kind === "asset",
  }));

  const now = Date.now();
  st.index.files[rel] = {
    type,
    sizeBytes,
    mtimeMs,
    updatedAtMs: now,
    imports: importsForIndex,
    exports: exportsRaw,
  };
  st.indexDirty = true;

  graph.upsertFile(db, { relPath: rel, type, sizeBytes, mtimeMs });
  graph.replaceImports(db, rel, importsForGraph);
  graph.replaceExports(db, rel, regularExports);
  graph.replaceReexports(db, rel, reexports);
  st.graphDirty = true;
}

function staticPrefixFromGlob(glob) {
  const g = String(glob).replace(/\\/g, "/");
  const wildcardIdx = g.search(/[\*\?\[\{]/);
  const prefix = wildcardIdx === -1 ? g : g.slice(0, wildcardIdx);
  if (!prefix) return "";
  if (prefix.endsWith("/")) return prefix;
  const dir = path.posix.dirname(prefix);
  if (dir === "." || dir === "/") return "";
  return dir.endsWith("/") ? dir : `${dir}/`;
}

async function pruneMissingUnderPrefixUnlocked(st, db, prefix) {
  if (!prefix) return 0;
  const files = st.index?.files || {};
  const keys = Object.keys(files).filter((k) => k.startsWith(prefix));
  let pruned = 0;

  for (const rel of keys) {
    const abs = path.join(st.rootAbs, rel);
    if (fs.existsSync(abs)) continue;
    delete files[rel];
    graph.deleteFile(db, rel);
    pruned += 1;
  }

  if (pruned) {
    st.indexDirty = true;
    st.graphDirty = true;
  }
  return pruned;
}

async function init(root) {
  const rootAbs = path.resolve(root);
  return withQueue(rootAbs, async () => {
    const st = S(rootAbs);
    await initUnlocked(st);
  });
}

async function scan(root, globs, opts = {}) {
  const rootAbs = path.resolve(root);
  const ignore = defaultIgnore(opts.ignore);
  const pruneMissing = Boolean(opts.pruneMissing);
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;

  return withQueue(rootAbs, async () => {
    const st = S(rootAbs);
    await initUnlocked(st);

    await loadIndexUnlocked(st);
    const db = await graph.loadDb(rootAbs);

    const globList = Array.isArray(globs) ? globs : [globs];
    
    // Collect all matches first to get total count
    const allMatches = [];
    for (const g of globList) {
      const matches = await fg(g, {
        cwd: rootAbs,
        onlyFiles: true,
        unique: true,
        dot: false,
        followSymbolicLinks: false,
        ignore,
      });
      allMatches.push({ glob: g, matches });
    }
    
    const totalFiles = allMatches.reduce((sum, m) => sum + m.matches.length, 0);
    let processed = 0;
    
    // Signal start
    if (onProgress) onProgress({ phase: "start", total: totalFiles, processed: 0 });
    
    const forceReindex = Boolean(opts.force);
    
    for (const { glob: g, matches } of allMatches) {
      for (const rel of matches) {
        const result = await indexOneFileUnlocked(st, db, rel, { force: forceReindex });
        processed += 1;
        if (onProgress) onProgress({ phase: "indexing", total: totalFiles, processed, file: rel, skipped: result?.skipped });
      }

      if (pruneMissing) {
        const prefix = staticPrefixFromGlob(g);
        await pruneMissingUnderPrefixUnlocked(st, db, prefix);
      }
    }

    // Force flush after a scan/rescan.
    if (onProgress) onProgress({ phase: "flushing", total: totalFiles, processed });
    
    st.indexDirty = true;
    st.graphDirty = true;
    await flushIndexUnlocked(st);
    await persistGraphUnlocked(st);
    await writeSummaryUnlocked(st, { force: true });
    
    // Signal completion
    if (onProgress) onProgress({ phase: "done", total: totalFiles, processed });
  });
}

async function updateFile(root, relPath, opts = {}) {
  const rootAbs = path.resolve(root);
  const rel = normalizeRelPath(relPath);
  const throttleMs =
    Number.isFinite(opts.summaryThrottleMs) && opts.summaryThrottleMs >= 0
      ? Math.floor(opts.summaryThrottleMs)
      : parseEnvThrottleMs() ?? 0;

  return withQueue(rootAbs, async () => {
    const st = S(rootAbs);
    await initUnlocked(st);

    await loadIndexUnlocked(st);
    const db = await graph.loadDb(rootAbs);

    await indexOneFileUnlocked(st, db, rel);

    if (!st.indexDirty && !st.graphDirty) return;

    scheduleIndexFlush(rootAbs);
    scheduleGraphPersist(rootAbs);
    scheduleSummary(rootAbs, { throttleMs });
  });
}

function readSummary(root) {
  const rootAbs = path.resolve(root);
  const p = summaryPath(rootAbs);
  if (!fs.existsSync(p)) return null;
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

async function writeSummary(root, opts = {}) {
  const rootAbs = path.resolve(root);
  return withQueue(rootAbs, async () => {
    const st = S(rootAbs);
    await initUnlocked(st);
    return await writeSummaryUnlocked(st, { force: Boolean(opts.force) });
  });
}

async function health(root) {
  const rootAbs = path.resolve(root);
  return withQueue(rootAbs, async () => {
    const st = S(rootAbs);
    await initUnlocked(st);
    const idx = await loadIndexUnlocked(st);
    const db = await graph.loadDb(rootAbs);

    const metrics = summary.health(rootAbs, { index: idx, db, graph });

    const state = {
      root: rootAbs,
      stateDir: stateDir(rootAbs),
      graphDb: {
        path: graph.graphDbPath(rootAbs),
        exists: fs.existsSync(graph.graphDbPath(rootAbs)),
      },
      index: {
        path: indexPath(rootAbs),
        exists: fs.existsSync(indexPath(rootAbs)),
        files: Object.keys(idx.files || {}).length,
      },
      summary: {
        path: summaryPath(rootAbs),
        exists: fs.existsSync(summaryPath(rootAbs)),
      },
      claudeSettings: {
        path: claudeSettingsPath(rootAbs),
        exists: fs.existsSync(claudeSettingsPath(rootAbs)),
      },
      metrics,
      localResolved: metrics.localResolved,
      localTotal: metrics.localTotal,
      resolutionPct: metrics.resolutionPct,
      topMisses: metrics.topMisses,
      indexAgeSec: metrics.indexAgeSec,
      indexGeneratedAt: metrics.indexGeneratedAt,
    };

    return state;
  });
}

async function queryImports(root, relPath) {
  const rootAbs = path.resolve(root);
  const rel = normalizeRelPath(relPath);
  return withQueue(rootAbs, async () => {
    const st = S(rootAbs);
    await initUnlocked(st);
    const db = await graph.loadDb(rootAbs);
    return graph.queryImports(db, rel);
  });
}

async function queryDependents(root, relPath) {
  const rootAbs = path.resolve(root);
  const rel = normalizeRelPath(relPath);
  return withQueue(rootAbs, async () => {
    const st = S(rootAbs);
    await initUnlocked(st);
    const db = await graph.loadDb(rootAbs);
    return graph.queryDependents(db, rel);
  });
}

async function queryExports(root, relPath) {
  const rootAbs = path.resolve(root);
  const rel = normalizeRelPath(relPath);
  return withQueue(rootAbs, async () => {
    const st = S(rootAbs);
    await initUnlocked(st);
    const db = await graph.loadDb(rootAbs);
    return graph.queryExports(db, rel);
  });
}

module.exports = {
  init,
  scan,
  updateFile,
  readSummary,
  writeSummary,
  health,
  queryImports,
  queryDependents,
  queryExports,
};
