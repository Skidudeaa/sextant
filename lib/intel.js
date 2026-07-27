const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const fg = require("fast-glob");

const { normalizeRelPath, isIndexable, fileTypeHeuristic } = require("./utils");
const { extractImports, extractExports, extractDeclarations, extractRelations } = require("./extractor");
const swiftExtractor = require("./extractors/swift");
const { resolveImport, clearCaches: clearResolverCaches } = require("./resolver");
const graph = require("./graph");
const summary = require("./summary");
const history = require("./history");
const freshness = require("./freshness");
const cochange = require("./cochange");
const { diagnoseScanCoverage } = require("./coverage-diagnostics");
const fileMutex = require("./file-mutex");
const {
  exactSynchronousShellHook,
  inspectClaudeHookScopes,
  matcherCovers,
  matcherOverlaps,
  ownedCommandHook,
  settingsHookConflict,
  synchronousHook,
} = require("./claude-hooks");

const stateByRoot = new Map();

function S(root) {
  const rootAbs = path.resolve(root);
  if (!stateByRoot.has(rootAbs)) {
    stateByRoot.set(rootAbs, {
      rootAbs,
      initialized: false,

      queue: Promise.resolve(),

      graphDirty: false,
      // Paths processed since the last incremental persist. They are retained
      // across the debounce so the writer can reconcile a file that changed
      // back to clean (and therefore disappeared from `git status`) before it
      // stamps the graph current.
      graphDirtyPaths: new Set(),
      graphRequiresFullScanGeneration: null,
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

  // WHY rename AFTER persist (handled by caller):
  // The old order was rename → persist, which meant a SIGKILL / ENOSPC /
  // crash between the two left index.json gone AND graph.db unchanged —
  // silent data loss. Now we flag the rename as pending; the caller
  // (initUnlocked) runs it only after persistGraphUnlocked returns
  // successfully. If persist fails, index.json stays in place and next
  // init retries the migration.
  st.pendingIndexJsonRename = indexJsonPath;

  // If v1 entries need re-extraction, flag for rescan
  if (needsRescan) {
    st.needsRescan = true;
  }
}

async function persistGraphUnlocked(st, { expectedRepoState = null } = {}) {
  if (!st.graphDirty) return false;
  // Bump generated_at on every persist so "index age" reflects the freshness
  // of graph.db itself, not the last full scan.  Without this, the watcher
  // can happily flush per-file updates for 24h while the meta still reports
  // the scan time — producing spurious "INDEX STALE" alerts on a healthy
  // index (loadDb is cached, so this is a Map lookup, not a disk read).
  const db = await graph.loadDb(st.rootAbs);
  graph.setMetaValue(db, "generated_at", new Date().toISOString());
  // WHY: record git HEAD + status fingerprint + version stamps inside the
  // same critical section that bumps generated_at, so the freshness gate
  // (lib/freshness.js) sees an atomic "this is what the world looked like
  // when graph.db was last in sync" snapshot.  Without this, the gate has
  // no ground truth to compare against and would fail-closed on every read.
  const recordedFresh = freshness.recordScanState(db, st.rootAbs, { expectedRepoState });
  // Flush Swift health counters into meta so `sextant doctor` and the
  // freshness gate's silent-absence path can surface parser status.  Only
  // write parserState if the parser was actually exercised (filesSeen > 0)
  // OR if it failed to init (so users see init failures even on JS-only
  // repos that happened to ignore Swift).
  const sc = swiftExtractor.getCounters();
  if (sc.parserState === "init_failed" || sc.parserState === "unavailable" || sc.filesSeen > 0) {
    graph.setMetaValue(db, "swift.parserState", sc.parserState || "uninitialized");
    graph.setMetaValue(db, "swift.filesSeen", String(sc.filesSeen));
    graph.setMetaValue(db, "swift.filesParsedOk", String(sc.filesParsedOk));
    graph.setMetaValue(db, "swift.filesParseErrors", String(sc.filesParseErrors));
    graph.setMetaValue(db, "swift.filesUnsupportedConstructs", String(sc.filesUnsupportedConstructs));
  }
  await graph.persistDb(st.rootAbs);
  st.graphDirty = false;
  return recordedFresh;
}

// How long to wait before re-checking when a watcher persist is deferred
// because a manual scan owns graph.db. Short enough to land queued changes
// promptly once the scan clears its marker; the marker's 90s stale window
// (freshness.SCAN_MARKER_STALE_MS) bounds the deferral if the scan crashes.
const SCAN_PERSIST_RETRY_MS = 1000;
const SUMMARY_PERSIST_RETRY_MS = 250;
const MAX_INCREMENTAL_RECONCILE_PATHS = 400;

function invalidExpectedRepoState() {
  return { head: null, statusHash: null };
}

function isGraphControlPath(relPath) {
  const rel = normalizeRelPath(relPath);
  const base = path.posix.basename(rel);
  return (
    rel === ".gitignore" ||
    rel === ".codebase-intel.json" ||
    base === "package.json" ||
    base === "tsconfig.json" ||
    base === "tsconfig.base.json" ||
    base === "jsconfig.json"
  );
}

function dirtyContentHash(files, relPath) {
  if (!files || typeof files !== "object") return undefined;
  return files[Buffer.from(normalizeRelPath(relPath), "utf8").toString("hex")];
}

async function persistIncrementalGraphUnlocked(st) {
  const db = await graph.loadDb(st.rootAbs);
  const recorded = freshness.getRecordedRepoState(db);
  const before = freshness.captureCurrentStateForIndexing(st.rootAbs);
  const canReconcile = Boolean(
    recorded.head &&
    recorded.statusHash &&
    recorded.graphGeneration &&
    recorded.scannerVersion === freshness.SCANNER_VERSION &&
    recorded.schemaVersion === freshness.SCHEMA_VERSION &&
    Array.isArray(recorded.statusPaths) &&
    before.head &&
    before.statusHash &&
    Array.isArray(before.statusPaths) &&
    recorded.head === before.head
  );

  if (!canReconcile) {
    return persistGraphUnlocked(st, { expectedRepoState: invalidExpectedRepoState() });
  }

  // Re-index the union of old dirty paths, new dirty paths, and every watcher
  // event processed in this debounce window. The third set is essential for a
  // file that changed and then returned clean before persistence: it appears in
  // neither Git status map, but the in-memory graph may contain the transient
  // extraction and must be restored before a new anchor is published.
  const candidates = [...new Set([
    ...recorded.statusPaths,
    ...before.statusPaths,
    ...st.graphDirtyPaths,
  ])].sort();
  if (candidates.length > MAX_INCREMENTAL_RECONCILE_PATHS) {
    return persistGraphUnlocked(st, { expectedRepoState: invalidExpectedRepoState() });
  }

  const evidence = [];
  const reconciledPaths = [];
  let stable = !(
    st.graphRequiresFullScanGeneration &&
    st.graphRequiresFullScanGeneration === recorded.graphGeneration
  );
  clearResolverCaches(st.rootAbs);
  for (const rel of candidates) {
    const dirtyStateMoved =
      dirtyContentHash(recorded.statusFiles, rel) !==
      dirtyContentHash(before.statusFiles?.files, rel);
    if (isGraphControlPath(rel) && dirtyStateMoved) {
      // Globs/ignores and resolver config affect corpus membership or imports
      // beyond this one path. Preserve the stale anchor until a bulk scan.
      stable = false;
    }

    const alreadyIndexed = Boolean(graph.getFileMeta(db, rel));
    const explicitlyObserved = st.graphDirtyPaths.has(rel);
    if (!alreadyIndexed && !explicitlyObserved) {
      // Git status is repo-wide, while the watcher may intentionally cover a
      // narrow glob. Do not let an unrelated dirty source outside that scope
      // pollute graph.db. A changed source can still alter resolution for an
      // in-scope importer, so keep the anchor stale until a bulk rescan.
      if (isIndexable(rel) && dirtyStateMoved) stable = false;
      continue;
    }

    const result = await indexOneFileUnlocked(st, db, rel, { force: true });
    reconciledPaths.push(rel);
    if (result?.unstable) stable = false;
    // Adding/removing a resolver target can change edges in OTHER importers
    // (including previously-unresolved imports), which a one-file update cannot
    // repair. Apply the local row change, but require a bulk rescan before the
    // whole graph may be called current.
    if (result?.membershipChanged) stable = false;
    if (result?.evidence) evidence.push(result.evidence);
  }
  if (!evidence.every((item) => verifyIndexEvidence(st.rootAbs, item))) stable = false;
  if (!verifyResolvedImports(db, st.rootAbs, reconciledPaths)) stable = false;

  const after = freshness.captureCurrentStateForIndexing(st.rootAbs);
  if (!freshness.sameRepoState(before, after)) stable = false;
  return persistGraphUnlocked(st, {
    expectedRepoState: stable ? before : invalidExpectedRepoState(),
  });
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
      // WHY: a manual `sextant scan`/`rescan` owns graph.db while its
      // .scan_in_progress marker is fresh. Persisting this watcher's
      // incremental in-memory delta now would clobber the scan with a stale
      // pre-scan snapshot — the exact race the cooperative pause prevents. The
      // watch.js flush deferral CANNOT stop this timer: it may have been armed
      // (by an updateFile) in the window before the marker appeared, so the
      // guard must live here, on the actual writer. Keep graphDirty set and
      // re-arm; once the scan clears its marker the retry runs, and by then
      // persistGraphUnlocked's full file-identity-gated loadDb has reloaded the scan's fresh
      // db. Only the incremental/timer path is guarded — the bulk scan's own
      // persistGraphUnlocked (the scan itself) must never defer.
      if (freshness.isScanInProgress(rootAbs)) {
        scheduleGraphPersist(rootAbs, SCAN_PERSIST_RETRY_MS);
        return;
      }
      try {
        await persistIncrementalGraphUnlocked(st);
        st.graphDirtyPaths.clear();
        st.graphRequiresFullScanGeneration = null;
      } catch (error) {
        // Retain the paths across a failed write so the retry/next event still
        // knows which transient extractions need reconciliation.
        throw error;
      }
    }).catch(err => { console.warn(`[sextant] graph persist failed: ${err?.message || err}`); });
  }, Math.max(0, target - now));

  st.graphTimer.unref?.();
}

async function writeSummaryUnlocked(st, { force = false } = {}) {
  const rootAbs = st.rootAbs;
  const p = summaryPath(rootAbs);

  if (!force && !st.summaryDirty && fs.existsSync(p)) return readSummary(rootAbs) || "";

  const db = await graph.loadDb(rootAbs);
  const summaryBinding = require("./summary-binding");
  const prepared = await summaryBinding.renderVerifiedSummary(rootAbs, { db, graph });
  // A moving or unverifiable repository must not replace the last committed
  // bound summary. Leave summaryDirty set so a later watcher event/manual
  // retry can heal it; context-serving readers independently reject an old
  // manifest whose graph generation no longer matches.
  if (!prepared) {
    st.summaryDirty = true;
    return readSummary(rootAbs) || "";
  }

  const md = prepared.rawSummary;
  const tmp = `${p}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.promises.writeFile(tmp, md, { encoding: "utf8", flag: "wx" });
    await fs.promises.rename(tmp, p);
  } catch (error) {
    try { await fs.promises.rm(tmp, { force: true }); } catch {}
    throw error;
  }
  if (!await summaryBinding.verifiedSummaryStillCurrent(rootAbs, prepared.graphBinding)) {
    st.summaryDirty = true;
    return md;
  }
  // summary.md and graph.db are separate files. Publish the manifest last so
  // readers can prove these exact summary bytes came from the exact persisted
  // graph generation whose freshness anchors they validate.
  if (!await summaryBinding.writeManifest(rootAbs, md, {
    db,
    graph,
    expectedGraphBinding: prepared.graphBinding,
  })) {
    st.summaryDirty = true;
    return md;
  }

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
      // Never publish summary bytes from an in-memory graph whose generation
      // has not reached graph.db yet. In particular, a watcher persist may be
      // deferred by a manual scan; writing now would bind transient facts to
      // the scan's older generation, and the later graph retry would leave the
      // static summary withheld until some unrelated future event.
      if (st.graphDirty || freshness.isScanInProgress(rootAbs)) {
        scheduleSummary(rootAbs, { throttleMs: 0, debounceMs: SUMMARY_PERSIST_RETRY_MS });
        return;
      }
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

async function ensureClaudeSettingsUnlocked(rootAbs, scopeOptions = {}) {
  const dir = path.join(rootAbs, ".claude");
  const p = claudeSettingsPath(rootAbs);
  await fs.promises.mkdir(dir, { recursive: true });

  await cleanupLegacyRefreshScript(rootAbs);

  // SessionStart and prompt hooks can initialize the same repo concurrently.
  // Serialize Sextant's own read/merge/write cycle; failure is safe because a
  // later hook or explicit init will retry the additive repair.
  const settingsLock = fileMutex.acquireFileMutex(`${p}.sextant-lock`, {
    attempts: 250,
    waitMs: 2,
    staleMs: 60_000,
  });
  if (!settingsLock) return;

  try {
    const scopeState = inspectClaudeHookScopes(rootAbs, scopeOptions);
    const preTaskEnabled = require("./coherence").coherenceEnabled(rootAbs);
    await ensureClaudeSettingsLocked(p, {
      skipPreTask: !preTaskEnabled || scopeState.externalPreTaskConflicts.length > 0,
    });
  } finally {
    fileMutex.releaseFileMutex(settingsLock);
  }
}

async function ensureClaudeSettingsLocked(p, { skipPreTask = false } = {}) {
  const sessionStartCmd = "sextant hook sessionstart";
  const refreshCmd = "sextant hook refresh";
  const postToolUseCmd = "sextant hook posttooluse";
  const preTaskCmd = "sextant hook pretask";
  const subagentStartCmd = "sextant hook subagentstart";
  // WHY a tool matcher (not "*"): PostToolUse fires after EVERY tool; we only
  // score file-targeting tools. The matcher is a tool-name regex, so Claude Code
  // only invokes the hook for these — cheaper than firing on Bash/Glob/etc. and
  // returning early. Must stay in sync with FILE_TOOLS in hook-posttooluse.js.
  const postToolUseMatcher = "Read|Edit|Write|MultiEdit|NotebookEdit";
  // Parent-side Task/Agent hooks are the only verified lifecycle boundary for
  // orienting a child and then joining its return. Keep them separate from the
  // file-tool matcher: the same PostToolUse command handles both payloads, but
  // Claude should not invoke it for unrelated tools.
  const taskMatcher = "Task|Agent";

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
      // OUTCOME SUBSTRATE (009 #1): score whether the agent opens/edits the files
      // retrieval surfaced. Out-of-band telemetry — the hook writes no stdout.
      PostToolUse: [
        {
          matcher: postToolUseMatcher,
          hooks: [{ type: "command", command: postToolUseCmd }],
        },
        {
          matcher: taskMatcher,
          hooks: [{ type: "command", command: postToolUseCmd }],
        },
      ],
      // Default Lane A uses the native child-context surface, which composes
      // safely with other hooks. The handler is silent in coherence mode,
      // where the prompt-derived Phase-F path below needs tool_use_id.
      SubagentStart: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: subagentStartCmd }],
        },
      ],
    },
  };
  if (!skipPreTask) {
    desired.hooks.PreToolUse = [
      {
        matcher: taskMatcher,
        hooks: [{ type: "command", command: preTaskCmd }],
      },
    ];
  }

  // WHY atomic write + no-op skip:
  // This function is called from intel.init, which is called from intel.health,
  // which is called from the UserPromptSubmit hook on every prompt. The old
  // implementation wrote settings.json unconditionally AND non-atomically on
  // every call. Two bugs:
  //   1. If Node exits mid-write, settings.json is truncated → all hooks stop
  //      firing silently until the user hand-repairs the JSON.
  //   2. Even without a crash, every prompt caused a disk write for no reason.
  // Fix: compare desired JSON against on-disk content; skip when equal. When
  // writing, use tmp+rename so the file either contains the old valid JSON or
  // the new valid JSON, never a partial one.
  const writeAtomically = async (content, mode) => {
    // Hooks from parallel tool calls may initialize the same repo at once.
    // A fixed `.tmp` path lets one process rename another process's staging
    // file (or fail after it disappears). Unique contenders keep the final
    // rename atomic without making concurrent, identical repairs interfere.
    const tmp = `${p}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
    try {
      await fs.promises.writeFile(tmp, content, { encoding: "utf8", mode });
      // writeFile's creation mode is filtered through the process umask. Apply
      // the intended final mode explicitly so replacing an existing settings
      // file never widens or silently narrows its permissions.
      await fs.promises.chmod(tmp, mode);
      await fs.promises.rename(tmp, p);
    } finally {
      await fs.promises.unlink(tmp).catch(() => {});
    }
  };

  if (!fs.existsSync(p)) {
    await writeAtomically(JSON.stringify(desired, null, 2) + "\n", 0o600);
    return;
  }

  // Replacing a symlink would silently change its target semantics. Non-files
  // are equally ambiguous. Leave either untouched and let init status report
  // the missing surfaces for operator repair.
  let existingStat;
  try {
    existingStat = fs.lstatSync(p);
  } catch {
    return;
  }
  if (!existingStat.isFile() || existingStat.isSymbolicLink()) return;
  const existingMode = existingStat.mode & 0o777;

  const existingRaw = fs.readFileSync(p, "utf8");
  let current = null;
  try {
    current = JSON.parse(existingRaw);
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

  // Ensure PostToolUse hook for the outcome-telemetry substrate (009 #1). Scoped
  // to file-targeting tools via its own matcher so it doesn't merge into the "*"
  // entry the other two hooks share.
  if (!Array.isArray(current.hooks.PostToolUse)) current.hooks.PostToolUse = [];
  ensureHookCommand(current.hooks.PostToolUse, postToolUseCmd, postToolUseMatcher);
  ensureHookCommand(current.hooks.PostToolUse, postToolUseCmd, taskMatcher);

  if (!Array.isArray(current.hooks.SubagentStart)) current.hooks.SubagentStart = [];
  ensureHookCommand(current.hooks.SubagentStart, subagentStartCmd);

  // Ensure parent-side child orientation. This also self-repairs older repos:
  // any later sextant command that initializes the repo merges the hook without
  // replacing user-authored PreToolUse groups.
  if (skipPreTask) {
    if (Array.isArray(current.hooks.PreToolUse)) {
      removeOwnedHookCommand(current.hooks.PreToolUse, preTaskCmd, taskMatcher);
    }
  } else {
    if (!Array.isArray(current.hooks.PreToolUse)) current.hooks.PreToolUse = [];
    ensureHookCommand(current.hooks.PreToolUse, preTaskCmd, taskMatcher, {
      skipOnOverlap: true,
    });
  }

  const nextRaw = JSON.stringify(current, null, 2) + "\n";
  if (nextRaw === existingRaw) return; // no-op; avoid touching disk
  await writeAtomically(nextRaw, existingMode);
}

function ensureHookCommand(arr, cmd, matcher = "*", { skipOnOverlap = false } = {}) {
  const overlapsNonSextantSynchronousHandler = arr.some((candidate) =>
    candidate && typeof candidate === "object" &&
    matcherOverlaps(candidate.matcher, matcher) &&
    Array.isArray(candidate.hooks) &&
    candidate.hooks.some((hook) =>
      synchronousHook(hook) && !ownedCommandHook(hook, cmd))
  );
  if (skipOnOverlap && overlapsNonSextantSynchronousHandler) {
    // If another scope or a later local edit introduces a competing input
    // rewriter, remove Sextant's own project handler so the repair is truly
    // fail-closed rather than merely warning while both continue to race.
    removeOwnedHookCommand(arr, cmd, matcher);
    return;
  }

  let repairable = null;
  const alreadyCovered = arr.some((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    if (!matcherCovers(candidate.matcher, matcher)) return false;
    if (!Array.isArray(candidate.hooks)) return false;
    return candidate.hooks.some((hook) => {
      if (!ownedCommandHook(hook, cmd)) return false;
      if (exactSynchronousShellHook(hook, cmd)) return true;
      if (!repairable) repairable = hook;
      return false;
    });
  });
  if (alreadyCovered) return;
  // PreToolUse updatedInput values from matching hooks are not composed: the
  // host runs handlers concurrently and one complete replacement wins. Never
  // auto-install Sextant into an overlapping user matcher whose output is
  // unknowable. Status reports the conflict for deliberate reconciliation.
  // Repair a covering Sextant handler that was accidentally configured in
  // exec/filtered/background form. Those forms either cannot execute a
  // space-containing shell command or cannot return lifecycle context.
  if (repairable) {
    repairable.type = "command";
    repairable.command = cmd;
    delete repairable.args;
    delete repairable.if;
    delete repairable.async;
    delete repairable.asyncRewake;
    return;
  }

  let entry = arr.find((x) => x && typeof x === "object" && x.matcher === matcher);
  if (!entry) {
    entry = { matcher, hooks: [] };
    arr.push(entry);
  }
  if (!Array.isArray(entry.hooks)) entry.hooks = [];
  const hasCmd = entry.hooks.some(
    (h) => h && typeof h === "object" && h.type === "command" && h.command === cmd
  );
  if (!hasCmd) entry.hooks.push({ type: "command", command: cmd });
}

function removeOwnedHookCommand(arr, command, matcher) {
  for (let index = arr.length - 1; index >= 0; index--) {
    const group = arr[index];
    if (!group || typeof group !== "object" || !matcherOverlaps(group.matcher, matcher)) continue;
    if (!Array.isArray(group.hooks)) continue;
    group.hooks = group.hooks.filter((hook) => !ownedCommandHook(hook, command));
    if (group.hooks.length === 0) arr.splice(index, 1);
  }
}

async function initUnlocked(st, initOptions = {}) {
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

  // WHY: Migration writes to in-memory SQLite and flags a pending rename.
  // Persist FIRST so the new data is durable, THEN rename index.json so the
  // migration doesn't repeat. If the process dies between persist and rename,
  // the worst case is a repeat migration on next init (idempotent). The old
  // order was rename → persist, which risked losing every file's imports/
  // exports if a crash hit in between — exactly the pattern CLAUDE.md warns
  // against ("persist the new store before removing/renaming the old file").
  if (st.graphDirty) await persistGraphUnlocked(st);
  if (st.pendingIndexJsonRename) {
    try {
      await fs.promises.rename(st.pendingIndexJsonRename, st.pendingIndexJsonRename + ".migrated");
    } catch {}
    st.pendingIndexJsonRename = null;
  }

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

  await ensureClaudeSettingsUnlocked(rootAbs, initOptions.claudeScopeOptions || {});

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

const MAX_EXTRACT_BYTES = 512 * 1024;

function sameStableStat(a, b) {
  return Boolean(
    a && b &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

function statEvidence(relPath, stat) {
  return {
    kind: "file",
    path: relPath,
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
}

// Read one extraction input through a descriptor and bind the parsed bytes to
// stable inode metadata. A plain stat -> readFile permits replacement/growth
// races and, more subtly, lets an A -> B -> A edit be extracted as B while the
// scan's outer start/end Git fingerprints both observe A. The returned
// evidence is rechecked immediately before persistence, making any intervening
// inode/ctime/size movement sticky even when Git later returns to A.
function readIndexSourceStable(rootAbs, relPath) {
  const abs = path.join(rootAbs, relPath);
  let fd = null;
  try {
    let pathBefore;
    try {
      pathBefore = fs.lstatSync(abs, { bigint: true });
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return { kind: "missing", evidence: { kind: "missing", path: relPath } };
      }
      return { kind: "unstable" };
    }
    if (!pathBefore.isFile()) {
      return { kind: "not-file", evidence: { kind: "not-file", path: relPath } };
    }
    if (pathBefore.size > BigInt(Number.MAX_SAFE_INTEGER)) return { kind: "unstable" };

    const noFollow = fs.constants.O_NOFOLLOW || 0;
    fd = fs.openSync(abs, fs.constants.O_RDONLY | noFollow);
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || !sameStableStat(pathBefore, before)) return { kind: "unstable" };

    let code = null;
    if (before.size <= BigInt(MAX_EXTRACT_BYTES)) {
      const limit = Number(before.size) + 1;
      const content = Buffer.allocUnsafe(limit);
      let total = 0;
      while (total < limit) {
        const n = fs.readSync(fd, content, total, limit - total, total);
        if (!n) break;
        total += n;
      }
      if (total > MAX_EXTRACT_BYTES || BigInt(total) !== before.size) {
        return { kind: "unstable" };
      }
      code = content.subarray(0, total).toString("utf8");
    }

    const after = fs.fstatSync(fd, { bigint: true });
    const pathAfter = fs.lstatSync(abs, { bigint: true });
    if (!sameStableStat(before, after) || !sameStableStat(after, pathAfter)) {
      return { kind: "unstable" };
    }
    return {
      kind: "file",
      code,
      sizeBytes: Number(before.size),
      mtimeMs: Number(before.mtimeNs / 1000000n),
      evidence: statEvidence(relPath, before),
    };
  } catch {
    return { kind: "unstable" };
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function verifyIndexEvidence(rootAbs, evidence) {
  if (!evidence || typeof evidence.path !== "string") return false;
  const abs = path.join(rootAbs, evidence.path);
  try {
    const current = fs.lstatSync(abs, { bigint: true });
    if (evidence.kind === "missing") return false;
    if (evidence.kind === "not-file") return !current.isFile();
    if (evidence.kind !== "file" || !current.isFile()) return false;
    return (
      String(current.dev) === evidence.dev &&
      String(current.ino) === evidence.ino &&
      String(current.mode) === evidence.mode &&
      String(current.size) === evidence.size &&
      String(current.mtimeNs) === evidence.mtimeNs &&
      String(current.ctimeNs) === evidence.ctimeNs
    );
  } catch (error) {
    return evidence.kind === "missing" && error && error.code === "ENOENT";
  }
}

function captureCurrentIndexEvidence(rootAbs, relPath) {
  try {
    const current = fs.lstatSync(path.join(rootAbs, relPath), { bigint: true });
    if (!current.isFile()) return { kind: "not-file", path: relPath };
    return statEvidence(relPath, current);
  } catch (error) {
    if (error && error.code === "ENOENT") return { kind: "missing", path: relPath };
    return null;
  }
}

function updateEvidenceDigest(hash, evidence) {
  if (!evidence) return false;
  // Fixed field order avoids JSON/key-order ambiguity. The full relative path
  // participates so identical inode metadata on two hard links cannot swap.
  hash.update([
    evidence.kind || "",
    evidence.path || "",
    evidence.dev || "",
    evidence.ino || "",
    evidence.mode || "",
    evidence.size || "",
    evidence.mtimeNs || "",
    evidence.ctimeNs || "",
  ].join("\0"));
  hash.update("\n");
  return true;
}

function verifyResolvedImports(db, rootAbs, relPaths) {
  try {
    // Resolver caches are performance state, not freshness evidence. Reload
    // final tsconfig/workspace inputs before comparing persisted edges with
    // the filesystem that will receive the scan stamp.
    clearResolverCaches(rootAbs);
    for (const rel of relPaths) {
      if (!isIndexable(rel) || !graph.getFileMeta(db, rel)) continue;
      for (const stored of graph.queryImports(db, rel)) {
        const current = resolveImport(rootAbs, rel, stored.specifier);
        if ((current.resolved ?? null) !== (stored.toPath ?? null)) return false;
        if ((current.kind ?? null) !== (stored.kind ?? null)) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function indexOneFileUnlocked(st, db, relPath, opts = {}) {
  const rel = normalizeRelPath(relPath);
  if (!isIndexable(rel)) return { skipped: true, reason: "not-indexable" };

  const source = readIndexSourceStable(st.rootAbs, rel);
  if (source.kind === "unstable") {
    return { skipped: true, reason: "unstable", unstable: true };
  }
  if (source.kind === "missing") {
    // File doesn't exist on disk.  Differentiate "was previously indexed
    // and is now gone" (deleted) from "never existed here" (not-found) —
    // both CLI callers and the watcher benefit from knowing which case
    // this is.  Previously both paths reported deleted:true.
    const existedInGraph = Boolean(graph.getFileMeta(db, rel));
    if (existedInGraph) {
      graph.deleteFile(db, rel);
      st.graphDirty = true;
      return {
        skipped: false,
        deleted: true,
        membershipChanged: true,
        evidence: source.evidence,
      };
    }
    return { skipped: true, reason: "not-found", evidence: source.evidence };
  }

  if (source.kind === "not-file") {
    const existedInGraph = Boolean(graph.getFileMeta(db, rel));
    if (existedInGraph) {
      graph.deleteFile(db, rel);
      st.graphDirty = true;
      return {
        skipped: false,
        deleted: true,
        membershipChanged: true,
        evidence: source.evidence,
      };
    }
    return { skipped: true, reason: "not-file", evidence: source.evidence };
  }

  const type = fileTypeHeuristic(rel);
  const sizeBytes = source.sizeBytes;
  const mtimeMs = source.mtimeMs;

  // Skip extraction if file unchanged (mtime + size match) unless forced
  const cached = graph.getFileMeta(db, rel);
  if (!opts.force && cached && cached.mtimeMs === mtimeMs && cached.sizeBytes === sizeBytes) {
    return { skipped: true, reason: "unchanged", evidence: source.evidence };
  }

  const code = source.code;

  const importsRaw      = code ? extractImports(code, type)      : [];
  const exportsRaw      = code ? extractExports(code, type)      : [];
  const declarationsRaw = code ? extractDeclarations(code, type) : [];
  const relationsRaw    = code ? extractRelations(code, type)    : [];

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
  graph.replaceSwiftDeclarations(db, rel, declarationsRaw);
  graph.replaceSwiftRelations(db, rel, relationsRaw);

  // WHY: Swift entry-file marker (@main attribute presence) lives in its
  // own table per-file so watcher updates remain idempotent — when @main
  // is added to or removed from a file, the next index pass will toggle
  // the row in lockstep with the file's other extractions.  Setting on
  // every Swift file (with the cheap regex) means a renamed/deleted-then-
  // recreated file converges to the right state.
  if (type === "swift") {
    if (code && swiftExtractor.hasAtMain(code)) {
      graph.setSwiftEntryFile(db, rel, "@main");
    } else {
      graph.clearSwiftEntryFile(db, rel);
    }
  }

  st.graphDirty = true;
  return { skipped: false, membershipChanged: !cached, evidence: source.evidence };
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

async function init(root, options = {}) {
  const rootAbs = path.resolve(root);
  return withQueue(rootAbs, async () => {
    const st = S(rootAbs);
    await initUnlocked(st, options);
  });
}

// Bounds for the Python batch warm-up (see warmPythonWindow in scan()). The
// window is additionally capped at AST_CACHE_MAX files by the cache itself;
// these cap the MEMORY one window may hold, since the warm-up reads content
// eagerly. A single very large .py file is skipped rather than batched — it
// would dominate a window's byte budget for one spawn's worth of saving.
const WARM_MAX_BYTES = 4 * 1024 * 1024;
const WARM_MAX_FILE_BYTES = 1024 * 1024;
const pythonExtractor = require("./extractors/python");

async function scan(root, globs, opts = {}) {
  const rootAbs = path.resolve(root);
  const ignore = defaultIgnore(opts.ignore);
  const gitignoreFilter =
    typeof opts.gitignoreFilter === "function" ? opts.gitignoreFilter : null;
  const pruneMissing = Boolean(opts.pruneMissing);
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;

  return withQueue(rootAbs, async () => {
    const st = S(rootAbs);
    await initUnlocked(st);

    // Bind the entire bulk extraction to one stable repository state. Without
    // a pre-scan anchor, a file can move after it was extracted but before the
    // final freshness stamp; recording only the end state would then bless old
    // graph facts as current. persistGraphUnlocked compares this start anchor
    // to the same-pass end capture and invalidates scan-state on any movement.
    const scanStartState = freshness.captureCurrentStateForIndexing(rootAbs);

    const db = await graph.loadDb(rootAbs);
    const recordedState = freshness.getRecordedRepoState(db);

    const globList = Array.isArray(globs) ? globs : [globs];

    const collectMatches = async () => {
      const collected = [];
      for (const g of globList) {
        let matches = await fg(g, {
          cwd: rootAbs,
          onlyFiles: true,
          unique: true,
          dot: false,
          followSymbolicLinks: false,
          ignore,
        });
        if (gitignoreFilter) matches = matches.filter((m) => !gitignoreFilter(m));
        collected.push({ glob: g, matches });
      }
      return collected;
    };

    // Collect all matches first to get total count
    // WHY: fast-glob's `ignore` array can't express full .gitignore semantics
    // (negations, anchored patterns). The callback is the correctness backstop.
    const allMatches = await collectMatches();

    const totalFiles = allMatches.reduce((sum, m) => sum + m.matches.length, 0);
    let processed = 0;

    // WHY: Swift parser is async-init via WASM. For incremental watcher updates
    // we tolerate the rare race where the first .swift event lands before init
    // completes (it counts as filesUnsupportedConstructs).  For bulk scans we
    // can and should pre-warm: await readiness if any .swift file is in scope.
    // Also reset counters so the meta reflects THIS scan's totals, not lifetime.
    const hasSwift = allMatches.some(m => m.matches.some(f => f.toLowerCase().endsWith(".swift")));
    if (hasSwift) {
      swiftExtractor.resetCounters();
      await swiftExtractor.ensureReady();
    }

    // Signal start
    if (onProgress) onProgress({ phase: "start", total: totalFiles, processed: 0 });

    const recordedBaselineUsable = Boolean(
      recordedState.head &&
      recordedState.statusHash &&
      recordedState.graphGeneration &&
      recordedState.scannerVersion === freshness.SCANNER_VERSION &&
      recordedState.schemaVersion === freshness.SCHEMA_VERSION &&
      Array.isArray(recordedState.statusPaths) &&
      scanStartState.head &&
      scanStartState.statusHash &&
      Array.isArray(scanStartState.statusPaths) &&
      recordedState.head === scanStartState.head
    );
    // A moved HEAD/version (or an untrusted old graph) can change any clean
    // file while preserving mtime+size, so re-extract all. With a trusted,
    // same-HEAD baseline, only the union of old/new dirty paths needs forcing;
    // unchanged clean files remain safe to skip.
    const forceAll =
      Boolean(opts.force) ||
      !recordedBaselineUsable ||
      recordedState.statusHash !== scanStartState.statusHash;
    const forcePaths = new Set([
      ...(recordedState.statusPaths || []),
      ...(scanStartState.statusPaths || []),
    ]);
    // Hash per-file evidence as we go instead of retaining O(file-count)
    // evidence objects. The final pass hashes the same ordered corpus from
    // current lstat values; digest equality binds every extraction to its
    // observed inode/ctime/size with constant additional memory.
    const extractionEvidenceHash = crypto.createHash("sha256");
    let extractionEvidenceCount = 0;
    let extractionStable = true;
    clearResolverCaches(rootAbs);

    // PYTHON BATCH WARM-UP (docs/035 #9). Python extraction is 42-94% of scan
    // p50 across the fleet, and essentially all of it is python3 PROCESS
    // startup: the per-file path pays one spawn per file (~46ms), the batch
    // path pays one spawn per window. Measured on the committed generator
    // fixture (scripts/bench-python-extract.js): 200 files, 9,227ms -> 115ms,
    // byte-identical output.
    //
    // WHY A PRE-PASS RATHER THAN A PHASE SPLIT: docs/035 priced this as "M
    // effort" because AST_CACHE_MAX = 100 was thought to force a real split of
    // indexOneFileUnlocked into extract/persist halves. It does not. Warming in
    // WINDOWS of at most AST_CACHE_MAX files means every entry a window puts in
    // the cache is consumed by the indexer before the next window can evict it
    // (eviction is insertion-ordered, so the oldest — already-consumed — go
    // first). indexOneFileUnlocked is untouched, and so are its other 4 call
    // sites.
    //
    // FAILURE IS FREE: the warm-up only populates a content-hash cache. If the
    // batch subprocess fails, the file changes between the pre-read and the
    // indexer's read, or python3 is missing, the hash simply misses and the
    // normal per-file path runs exactly as before. Nothing here can change what
    // is extracted — only how many processes it costs.
    const warmPythonWindow = (paths) => {
      const items = [];
      let bytes = 0;
      for (const rel of paths) {
        if (items.length >= pythonExtractor.AST_CACHE_MAX) break;
        if (bytes >= WARM_MAX_BYTES) break;
        try {
          const abs = path.join(rootAbs, rel);
          const st2 = fs.statSync(abs);
          if (!st2.isFile() || st2.size > WARM_MAX_FILE_BYTES) continue;
          const content = fs.readFileSync(abs, "utf8");
          bytes += content.length;
          items.push({ relPath: rel, content });
        } catch {
          // Unreadable/vanished — the indexer will handle it on its own terms.
        }
      }
      if (items.length < 2) return; // one file is not worth a batch spawn
      try {
        pythonExtractor.extractBatch(items);
      } catch {
        // Warming is best-effort by construction.
      }
    };

    for (const { matches } of allMatches) {
      const pyQueue = matches.filter((m) => /\.py$/i.test(m));
      let pyCursor = 0;
      for (const rel of matches) {
        // Refill the cache just before we reach the next uncached .py file.
        if (/\.py$/i.test(rel) && pyQueue[pyCursor] === rel) {
          warmPythonWindow(pyQueue.slice(pyCursor, pyCursor + pythonExtractor.AST_CACHE_MAX));
          pyCursor += pythonExtractor.AST_CACHE_MAX;
        }
        const result = await indexOneFileUnlocked(st, db, rel, {
          force: forceAll || forcePaths.has(normalizeRelPath(rel)),
        });
        if (result?.unstable) extractionStable = false;
        if (result?.evidence) {
          updateEvidenceDigest(extractionEvidenceHash, result.evidence);
          extractionEvidenceCount += 1;
        }
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

    // WHY: turn "indexed nothing / barely anything" from a silent non-event
    // into a loud, actionable diagnosis. The note is persisted to graph meta
    // so the summary (injected every session) can surface it WITHOUT
    // re-walking the tree on each flush — the expensive probe runs once here.
    // TRADE: the note is per-SCAN, not per-flush — incremental watcher writes
    // never recompute it, so its embedded counts can drift until the next bulk
    // scan (self-limiting: narrow globs blind the watcher to the same files).
    // `totalFiles` is the count matched by this scan's globs == graph size.
    // opts.coverageDiagnostics === false (the .codebase-intel.json knob,
    // passed through by commands/scan.js — lib stays config-agnostic) skips
    // the probe AND clears any previously-persisted note.
    let coverage = null;
    if (opts.coverageDiagnostics !== false) {
      try {
        coverage = await diagnoseScanCoverage({
          rootAbs: st.rootAbs,
          globs: globList,
          ignore,
          gitignoreFilter,
          indexedTotal: totalFiles,
        });
      } catch {
        coverage = null;
      }
    }
    // Persist (or clear) the note so a fixed repo stops warning. Store the
    // minimal shape the summary needs; "ok" → empty string clears it.
    graph.setMetaValue(
      db,
      "coverage_note",
      coverage && coverage.kind !== "ok"
        ? JSON.stringify({ kind: coverage.kind, message: coverage.message })
        : ""
    );

    // Co-change mining (blast-radius lane, docs/016 Sprint 1).  Bulk-scan
    // only: git history moves on commit, not on file save, so the watcher's
    // incremental flushes never recompute this.  Strictly best-effort — a
    // non-git repo, git failure, or anything else leaves empty tables and
    // never fails the scan.  The isIncluded filter is scan membership AND
    // isIndexable: scan membership carries the repo's ignore/gitignore/
    // vendored exclusions plus "the file exists at HEAD", isIndexable drops
    // doc/config files a user's custom globs may have matched (CHANGELOG/md
    // pairs were 40-86% of raw top-50 junk in R2) — together the strongest
    // form of R2's v1 filter: history-only files never produce pairs.
    if (opts.cochange !== false) {
      try {
        // Signal the phase BEFORE the synchronous git-log parse: mining emits
        // no progress callbacks while it runs, and the scan-in-progress marker
        // is refreshed inside onProgress — without this tick a slow `git log`
        // could let the marker go stale and a paused watcher resume mid-scan.
        if (onProgress) onProgress({ phase: "cochange", total: totalFiles, processed });
        const matchedSet = new Set();
        for (const { matches } of allMatches) for (const r of matches) matchedSet.add(r);
        const cc = cochange.mineCoChange(st.rootAbs, {
          isIncluded: (rel) => matchedSet.has(rel) && isIndexable(rel),
        });
        graph.replaceCoChangePairs(db, cc.pairs, cc.degree);
        graph.setMetaValue(
          db,
          "cochange_note",
          JSON.stringify({
            pairs: cc.pairs.length,
            usedCommits: cc.usedCommits,
            excludedCommits: cc.excludedCommits,
          })
        );
      } catch {
        // best-effort: leave whatever the schema created (empty tables)
      }
    }

    // Bulk scans may run while editors/agents keep writing. The outer Git
    // fence catches lasting movement; per-file inode/ctime evidence makes an
    // A -> B -> A mutation sticky instead of letting equal outer fingerprints
    // bless facts extracted from transient B. Re-running the glob set likewise
    // fences a transient add/delete during enumeration/pruning.
    const beforeEvidenceCheck = freshness.captureCurrentStateForIndexing(rootAbs);
    const currentEvidenceHash = crypto.createHash("sha256");
    let currentEvidenceCount = 0;
    for (const { matches } of allMatches) {
      for (const rawRel of matches) {
        const rel = normalizeRelPath(rawRel);
        if (!isIndexable(rel)) continue;
        const currentEvidence = captureCurrentIndexEvidence(rootAbs, rel);
        if (!updateEvidenceDigest(currentEvidenceHash, currentEvidence)) extractionStable = false;
        else currentEvidenceCount += 1;
      }
    }
    if (
      currentEvidenceCount !== extractionEvidenceCount ||
      currentEvidenceHash.digest("hex") !== extractionEvidenceHash.digest("hex")
    ) {
      extractionStable = false;
    }
    const finalMatches = await collectMatches();
    const initialSet = new Set(allMatches.flatMap(({ matches }) => matches.map(normalizeRelPath)));
    const finalSet = new Set(finalMatches.flatMap(({ matches }) => matches.map(normalizeRelPath)));
    if (
      initialSet.size !== finalSet.size ||
      [...initialSet].some((rel) => !finalSet.has(rel))
    ) {
      extractionStable = false;
    }
    if (!verifyResolvedImports(db, rootAbs, initialSet)) extractionStable = false;
    const scanEndState = freshness.captureCurrentStateForIndexing(rootAbs);
    if (
      !freshness.sameRepoState(scanStartState, beforeEvidenceCheck) ||
      !freshness.sameRepoState(beforeEvidenceCheck, scanEndState)
    ) {
      extractionStable = false;
    }
    await persistGraphUnlocked(st, {
      expectedRepoState: extractionStable ? scanEndState : invalidExpectedRepoState(),
    });
    // A completed bulk pass supersedes any same-process incremental membership
    // alarm that predated it; the corpus and every importer were just rebuilt
    // under the bulk fences above.
    st.graphDirtyPaths.clear();
    st.graphRequiresFullScanGeneration = null;
    // NOTE: clearRescanMarker has moved to commands/scan.js's finally block
    // so the marker is released on BOTH success and failure paths -- a
    // crash here used to leave the marker stuck for 5 minutes (orphan TTL).

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

    // WHY return a result: the CLI command (commands/scan.js) needs the
    // coverage diagnosis to print a loud warning, and the matched/ghost
    // counts let callers report without re-querying. Additive — earlier
    // callers ignored the (undefined) return value.
    return { totalFiles, processed, ghostCount, coverage };
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
    const indexableEvent = isIndexable(rel);
    if (indexableEvent) st.graphDirtyPaths.add(rel);
    // A filesystem event is stronger evidence than cached mtime+size. Force
    // the read so same-size edits with a restored mtime cannot leave old facts
    // in memory; the delayed writer rechecks it again against the final repo
    // state before publishing a freshness anchor.
    const result = await indexOneFileUnlocked(st, db, rel, { force: indexableEvent });
    if (result?.membershipChanged && !st.graphRequiresFullScanGeneration) {
      st.graphRequiresFullScanGeneration =
        graph.getMetaValue(db, freshness.META_GRAPH_GENERATION) || "unanchored";
    }

    // Even a transient/unchanged/not-found event may have advanced the Git
    // fingerprint or left a transient extraction that must be reconciled.
    if (indexableEvent) st.graphDirty = true;

    if (st.graphDirty) {
      scheduleGraphPersist(rootAbs);
      scheduleSummary(rootAbs, { throttleMs });
    }

    const { evidence: _evidence, ...publicResult } = result || {};
    return { path: rel, ...publicResult };
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
    const swift = graph.getSwiftHealthCounters(db);

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
      swift,
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
  matcherCovers,
  exactSynchronousShellHook,
  settingsHookConflict,
  inspectClaudeHookScopes,
};
