const fs = require("fs");
const path = require("path");

const fg = require("fast-glob");

const { normalizeRelPath, isIndexable, fileTypeHeuristic } = require("./utils");
const { extractImports, extractExports } = require("./extractor");
const { resolveImport } = require("./resolver");
const graph = require("./graph");
const summary = require("./summary");
const history = require("./history");

const stateByRoot = new Map();

function S(root) {
  const rootAbs = path.resolve(root);
  if (!stateByRoot.has(rootAbs)) {
    stateByRoot.set(rootAbs, {
      rootAbs,
      initialized: false,

      queue: Promise.resolve(),

      graphDirty: false,
      graphTimer: null,
      graphScheduledMs: 0,

      summaryDirty: false,
      summaryTimer: null,
      summaryScheduledMs: 0,
      lastSummaryTimeMs: 0,

      // Set by migrateFromIndexJson when v1-format entries require re-extraction.
      needsRescan: false,
    });
  }
  return stateByRoot.get(rootAbs);
}

function withQueue(rootAbs, fn) {
  const st = S(rootAbs);
  const next = st.queue.then(() => fn());
  // WHY: Queue chain must never reject — if it does, all subsequent tasks are
  // permanently blocked. Log so failures are visible in watcher terminal, then
  // continue. Each task is independent; a failed updateFile should not block
  // all future updates.
  st.queue = next.catch((err) => {
    process.stderr.write(`[sextant] queue task failed (${rootAbs}): ${err?.message || err}\n`);
  });
  return next;
}

const { stateDir } = require("./utils");

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

// WHY: One-time migration from the legacy index.json into graph.db.
// For each entry in index.json, backfills any missing data into the graph
// (file meta, imports, exports, re-exports).  Idempotent — safe to re-run
// if the process dies mid-migration.  After migration, renames the file to
// index.json.migrated so it won't be processed again.
async function migrateFromIndexJson(st, db) {
  const indexJsonPath = path.join(stateDir(st.rootAbs), "index.json");
  if (!fs.existsSync(indexJsonPath)) return;

  let parsed = null;
  try {
    const raw = fs.readFileSync(indexJsonPath, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt/invalid — just rename it away
    try {
      await fs.promises.rename(indexJsonPath, indexJsonPath + ".migrated");
    } catch {}
    return;
  }

  if (!parsed || typeof parsed !== "object" || !parsed.files || typeof parsed.files !== "object") {
    try {
      await fs.promises.rename(indexJsonPath, indexJsonPath + ".migrated");
    } catch {}
    return;
  }

  const files = parsed.files;
  let migrated = 0;
  let needsRescan = false;

  for (const rawKey of Object.keys(files)) {
    const entry = files[rawKey];

    // Normalize key: absolute paths → relative
    let rel = rawKey;
    if (path.isAbsolute(rawKey)) {
      rel = path.relative(st.rootAbs, rawKey);
      if (rel.startsWith("..")) continue; // outside root, skip
    }

    // Detect v1 format (string imports) → flag for re-extraction
    const hasStringImports =
      Array.isArray(entry?.imports) && entry.imports.some((imp) => typeof imp === "string");
    const mtimeMs = hasStringImports || path.isAbsolute(rawKey) ? 0 : (entry?.mtimeMs || 0);

    if (hasStringImports || path.isAbsolute(rawKey)) {
      needsRescan = true;
    }

    // Check if graph already has this file with matching mtime
    const existing = graph.getFileMeta(db, rel);
    if (existing && existing.mtimeMs === mtimeMs && mtimeMs !== 0) {
      continue; // Already in graph with same data
    }

    const type = entry?.type || null;
    const sizeBytes = entry?.sizeBytes || 0;

    graph.upsertFile(db, { relPath: rel, type, sizeBytes, mtimeMs });

    // Backfill imports if not stale
    if (!hasStringImports && Array.isArray(entry?.imports) && entry.imports.length > 0) {
      const importsForGraph = entry.imports.map((imp) => ({
        specifier: imp.specifier,
        toPath: imp.resolved || null,
        kind: imp.kind || null,
        isExternal: imp.kind === "external" || imp.kind === "asset",
      }));
      graph.replaceImports(db, rel, importsForGraph);
    }

    // Backfill exports
    if (Array.isArray(entry?.exports) && entry.exports.length > 0) {
      const regularExports = [];
      const reexports = [];
      for (const ex of entry.exports) {
        if (ex.from) {
          reexports.push(ex);
        } else {
          regularExports.push(ex);
        }
      }
      graph.replaceExports(db, rel, regularExports);
      graph.replaceReexports(db, rel, reexports);
    }

    migrated++;
  }

  // Write version and generatedAt to meta table
  if (parsed.generatedAt) {
    graph.setMetaValue(db, "generated_at", parsed.generatedAt);
  }

  // Persist the migrated data
  if (migrated > 0) {
    st.graphDirty = true;
  }

  // Rename old file so migration doesn't run again
  try {
    await fs.promises.rename(indexJsonPath, indexJsonPath + ".migrated");
  } catch {}

  // If v1 entries need re-extraction, flag for rescan
  if (needsRescan) {
    st.needsRescan = true;
  }
}

async function persistGraphUnlocked(st) {
  if (!st.graphDirty) return;
  // Bump generated_at on every persist so "index age" reflects the freshness
  // of graph.db itself, not the last full scan.  Without this, the watcher
  // can happily flush per-file updates for 24h while the meta still reports
  // the scan time — producing spurious "INDEX STALE" alerts on a healthy
  // index (loadDb is cached, so this is a Map lookup, not a disk read).
  const db = await graph.loadDb(st.rootAbs);
  graph.setMetaValue(db, "generated_at", new Date().toISOString());
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
    }).catch(err => { console.warn(`[sextant] graph persist failed: ${err?.message || err}`); });
  }, Math.max(0, target - now));

  st.graphTimer.unref?.();
}

async function writeSummaryUnlocked(st, { force = false } = {}) {
  const rootAbs = st.rootAbs;
  const p = summaryPath(rootAbs);

  if (!force && !st.summaryDirty && fs.existsSync(p)) return readSummary(rootAbs) || "";

  const db = await graph.loadDb(rootAbs);

  const md = summary.writeSummaryMarkdown(rootAbs, { db, graph });
  const tmp = p + ".tmp";
  await fs.promises.writeFile(tmp, md, "utf8");
  await fs.promises.rename(tmp, p);

  // Record health snapshot for historical tracking
  try {
    const healthData = summary.health(rootAbs, { db, graph });
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
    }).catch(err => { console.warn(`[sextant] summary write failed: ${err?.message || err}`); });
  }, Math.max(0, target - now));

  st.summaryTimer.unref?.();
}

// WHY: The standalone tools/codebase_intel/refresh.js is obsolete. sextant is
// globally linked via npm link, so "sextant hook refresh" is available everywhere.
// Clean up stale copies that were deployed by older versions of sextant init.
async function cleanupLegacyRefreshScript(rootAbs) {
  const dst = path.join(rootAbs, "tools", "codebase_intel", "refresh.js");
  try {
    if (!fs.existsSync(dst)) return;
    await fs.promises.unlink(dst);
    // Remove empty directories up the chain
    const dir = path.dirname(dst);
    const entries = await fs.promises.readdir(dir).catch(() => null);
    if (entries && entries.length === 0) await fs.promises.rmdir(dir);
    const parent = path.dirname(dir);
    const parentEntries = await fs.promises.readdir(parent).catch(() => null);
    if (parentEntries && parentEntries.length === 0) await fs.promises.rmdir(parent);
  } catch {}
}

async function ensureClaudeSettingsUnlocked(rootAbs) {
  const dir = path.join(rootAbs, ".claude");
  const p = claudeSettingsPath(rootAbs);
  await fs.promises.mkdir(dir, { recursive: true });

  await cleanupLegacyRefreshScript(rootAbs);

  const sessionStartCmd = "sextant hook sessionstart";
  const refreshCmd = "sextant hook refresh";

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
  const db = await graph.loadDb(rootAbs);
  if (!fs.existsSync(graph.graphDbPath(rootAbs))) {
    await graph.persistDb(rootAbs);
  }

  // Migrate legacy index.json into graph.db if it exists
  await migrateFromIndexJson(st, db);

  // WHY: Migration writes to in-memory SQLite then renames index.json.
  // If the process exits before persist (e.g., hook-sessionstart), the data
  // would be lost — index.json is gone and graph.db never got the updates.
  // Persist immediately to make migration crash-safe.
  if (st.graphDirty) await persistGraphUnlocked(st);

  // WHY: If migration flagged stale entries (v1 format), re-extract them now
  // rather than waiting for a manual rescan.  This makes format upgrades
  // transparent — the next sessionstart hook gets fresh data automatically.
  if (st.needsRescan) {
    st.needsRescan = false;
    // Find files in graph with mtimeMs=0 (flagged for re-extraction)
    const allEntries = graph.allFileEntries(db);
    const staleEntries = allEntries.filter((e) => e.mtimeMs === 0);
    for (const entry of staleEntries) {
      await indexOneFileUnlocked(st, db, entry.path, { force: true });
    }
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
    // File doesn't exist on disk.  Differentiate "was previously indexed
    // and is now gone" (deleted) from "never existed here" (not-found) —
    // both CLI callers and the watcher benefit from knowing which case
    // this is.  Previously both paths reported deleted:true.
    const existedInGraph = Boolean(graph.getFileMeta(db, rel));
    if (existedInGraph) {
      graph.deleteFile(db, rel);
      st.graphDirty = true;
      return { skipped: false, deleted: true };
    }
    return { skipped: true, reason: "not-found" };
  }

  if (!stat.isFile()) return { skipped: true, reason: "not-file" };

  const type = fileTypeHeuristic(rel);
  const sizeBytes = stat.size;
  const mtimeMs = Math.floor(stat.mtimeMs);

  // Skip extraction if file unchanged (mtime + size match) unless forced
  const cached = graph.getFileMeta(db, rel);
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

  const importsForGraph = importsResolved.map((r) => ({
    specifier: r.specifier,
    toPath: r.resolved,
    kind: r.kind,
    isExternal: r.kind === "external" || r.kind === "asset",
  }));

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
  const keys = graph.filePathsWithPrefix(db, prefix);
  let pruned = 0;

  for (const rel of keys) {
    const abs = path.join(st.rootAbs, rel);
    if (fs.existsSync(abs)) continue;
    graph.deleteFile(db, rel);
    pruned += 1;
  }

  if (pruned) {
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

    for (const { matches } of allMatches) {
      for (const rel of matches) {
        const result = await indexOneFileUnlocked(st, db, rel, { force: forceReindex });
        processed += 1;
        if (onProgress) onProgress({ phase: "indexing", total: totalFiles, processed, file: rel, skipped: result?.skipped });
      }
    }

    // WHY: prune globally from the matched set, not per-glob-prefix.  The
    // prefix-based pruning below (pruneMissingUnderPrefixUnlocked) bails
    // out on prefix === "" — which is the common case for patterns like
    // "**/*.{js,ts}" — so rescan silently did nothing for typical configs.
    // Globally: a db entry survives iff it's matched by some glob in
    // this scan.  Any other entry is a ghost and gets deleted.
    if (pruneMissing) {
      const matchedSet = new Set();
      for (const { matches } of allMatches) for (const r of matches) matchedSet.add(r);
      const dbFiles = graph.allFilePaths(db);
      for (const rel of dbFiles) {
        if (matchedSet.has(rel)) continue;
        graph.deleteFile(db, rel);
        st.graphDirty = true;
      }
    }

    // Force flush after a scan/rescan.
    if (onProgress) onProgress({ phase: "flushing", total: totalFiles, processed });

    st.graphDirty = true;
    graph.setMetaValue(db, "generated_at", new Date().toISOString());
    await persistGraphUnlocked(st);

    // Count ghost files: db entries not matched by any glob in this scan.
    // Without pruneMissing they linger silently; the CLI surfaces this so
    // the user knows to run `rescan`.  Skipped when pruneMissing is on
    // because pruning already cleaned them up.
    let ghostCount = 0;
    if (!pruneMissing) {
      const matchedSet = new Set();
      for (const { matches } of allMatches) for (const r of matches) matchedSet.add(r);
      const dbFiles = graph.allFilePaths(db);
      for (const f of dbFiles) if (!matchedSet.has(f)) ghostCount++;
    }
    await writeSummaryUnlocked(st, { force: true });

    // Signal completion
    if (onProgress) onProgress({ phase: "done", total: totalFiles, processed, ghostCount });
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

    const db = await graph.loadDb(rootAbs);

    // WHY: return the indexing result so CLI callers can report "indexed",
    // "unchanged", "deleted" etc.  Previously we discarded it and the CLI
    // printed nothing, making it impossible to tell success from silent
    // failure.
    const result = await indexOneFileUnlocked(st, db, rel);

    if (st.graphDirty) {
      scheduleGraphPersist(rootAbs);
      scheduleSummary(rootAbs, { throttleMs });
    }

    return { path: rel, ...result };
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
    const db = await graph.loadDb(rootAbs);

    const metrics = summary.health(rootAbs, { db, graph });
    const fileCount = graph.countFiles(db);

    const state = {
      root: rootAbs,
      stateDir: stateDir(rootAbs),
      graphDb: {
        path: graph.graphDbPath(rootAbs),
        exists: fs.existsSync(graph.graphDbPath(rootAbs)),
      },
      index: {
        path: graph.graphDbPath(rootAbs),
        exists: fs.existsSync(graph.graphDbPath(rootAbs)),
        files: fileCount,
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
