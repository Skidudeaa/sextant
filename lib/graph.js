const fs = require("fs");
const path = require("path");
const { constants: bufferConstants } = require("buffer");

let sqlJsPromise = null;

async function loadSqlJs() {
  if (sqlJsPromise) return sqlJsPromise;
  const initSqlJs = require("sql.js");
  const distDir = path.join(__dirname, "..", "node_modules", "sql.js", "dist");
  sqlJsPromise = initSqlJs({
    locateFile: (file) => path.join(distDir, file),
  });
  return sqlJsPromise;
}

const { stateDir } = require("./utils");

function graphDbPath(root) {
  return path.join(stateDir(root), "graph.db");
}

// graph.db is published by atomic rename. An mtime-only cache gate misses a
// replacement whose timestamp is equal to (or restored below) the cached
// timestamp, allowing an H0 in-memory graph to masquerade as H1 on disk. Cache
// the complete rename-sticky identity instead. BigInt fields avoid precision
// loss for inode numbers and nanosecond timestamps.
const dbByRoot = new Map(); // rootAbs -> { db: SQL.Database, fileIdentity: object|null }
// Persisted meta cache is deliberately separate from the mutable SQL.Database
// handle. Watchers mutate that handle before persistDb; caching values read
// from it on demand could claim unpersisted anchors. Entries here are recorded
// only after a stable disk load or our completed atomic rename.
const persistedBindingByRoot = new Map(); // rootAbs -> { fileIdentity, binding }

function fileIdentityFromStat(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    ctimeNs: stat.ctimeNs,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
  };
}

function sameFileIdentity(left, right) {
  return !!(
    left && right &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.ctimeNs === right.ctimeNs &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function inspectGraphPath(p) {
  try {
    const stat = fs.lstatSync(p, { bigint: true });
    if (!stat.isFile()) return { state: "invalid", identity: null };
    return { state: "file", identity: fileIdentityFromStat(stat) };
  } catch (error) {
    if (error && error.code === "ENOENT") return { state: "missing", identity: null };
    return { state: "unreadable", identity: null, error };
  }
}

function graphBindingFromDatabase(db) {
  return Object.freeze({
    graphGeneration: getMetaValue(db, "graph_generation") || "",
    head: getMetaValue(db, "scanned_head") || "",
    statusHash: getMetaValue(db, "scanned_status_hash") || "",
  });
}

function rememberPersistedBinding(rootAbs, fileIdentity, binding) {
  if (!fileIdentity) {
    persistedBindingByRoot.delete(rootAbs);
    return;
  }
  persistedBindingByRoot.set(rootAbs, {
    fileIdentity,
    binding: Object.freeze({ ...binding }),
  });
}

// Read graph.db through one descriptor and require the descriptor metadata and
// final path identity to agree. If an external atomic rename lands during the
// read, retry from the new path; never combine one inode's bytes with another
// inode's identity.
function readGraphFileStable(p, maxAttempts = 3) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let fd = null;
    try {
      const noFollow = fs.constants.O_NOFOLLOW || 0;
      try {
        fd = fs.openSync(p, fs.constants.O_RDONLY | noFollow);
      } catch (error) {
        if (error && error.code === "ENOENT") return null;
        throw error;
      }
      const before = fs.fstatSync(fd, { bigint: true });
      if (!before.isFile()) {
        const error = new Error(`graph.db is not a regular file: ${p}`);
        error.code = "EISDIR";
        throw error;
      }
      if (before.size > BigInt(bufferConstants.MAX_LENGTH)) {
        throw new Error(`graph.db is too large to read safely: ${p}`);
      }

      const expected = Number(before.size);
      const bytes = Buffer.allocUnsafe(expected);
      let total = 0;
      while (total < expected) {
        const count = fs.readSync(fd, bytes, total, expected - total, total);
        if (!count) break;
        total += count;
      }
      const after = fs.fstatSync(fd, { bigint: true });
      const pathState = inspectGraphPath(p);
      const descriptorIdentity = fileIdentityFromStat(before);
      if (
        total === expected &&
        sameFileIdentity(descriptorIdentity, fileIdentityFromStat(after)) &&
        pathState.state === "file" &&
        sameFileIdentity(descriptorIdentity, pathState.identity)
      ) {
        return { bytes, identity: descriptorIdentity };
      }
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
    }
  }
  throw new Error(`graph.db changed while being read: ${p}`);
}

function ensureSchema(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      type TEXT,
      size_bytes INTEGER,
      mtime_ms INTEGER,
      updated_at_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS imports (
      from_path TEXT NOT NULL,
      specifier TEXT NOT NULL,
      to_path TEXT,
      kind TEXT,
      is_external INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER,
      PRIMARY KEY (from_path, specifier)
    );
    CREATE INDEX IF NOT EXISTS idx_imports_from ON imports(from_path);
    CREATE INDEX IF NOT EXISTS idx_imports_to ON imports(to_path);

    CREATE TABLE IF NOT EXISTS exports (
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      updated_at_ms INTEGER,
      PRIMARY KEY (path, name, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_exports_path ON exports(path);
    CREATE INDEX IF NOT EXISTS idx_exports_name ON exports(LOWER(name));

    -- EXPORT TOKENS (docs/035 #4). findExportsBySymbol matches on
    -- LOWER(name) = LOWER(?) — pure exact match — so the export lane is
    -- reachable only when the user types a symbol. Measured on 1,185 real
    -- prompts across 11 repos: the lane is reached on 6.0% of classifier fires
    -- (sextant's own repo: 0 of 35), while driving it with a repo's OWN exported
    -- symbols hits 95-100%. The lane works; users type prose. This table is the
    -- lexical bridge: FLAG_REGISTRY -> {flag, registry}, so "where do we
    -- normalize the flag registry" can reach app/feature_gate.py.
    CREATE TABLE IF NOT EXISTS export_tokens (
      token TEXT NOT NULL,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      PRIMARY KEY (token, path, name)
    );
    CREATE INDEX IF NOT EXISTS idx_export_tokens_token ON export_tokens(token);
    CREATE INDEX IF NOT EXISTS idx_export_tokens_path ON export_tokens(path);

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- WHY: reexports table enables barrel-file tracing.  When a file does
    -- 'export { useState } from "./ReactHooks"', we store the re-export chain
    -- so findReexportChain can follow it from the barrel file to the original
    -- definition.  This is separate from exports because re-exports carry a
    -- source specifier (to_specifier) that regular exports don't have.
    CREATE TABLE IF NOT EXISTS reexports (
      from_path TEXT NOT NULL,
      name TEXT NOT NULL,
      to_specifier TEXT NOT NULL,
      kind TEXT NOT NULL,
      updated_at_ms INTEGER,
      PRIMARY KEY (from_path, name, to_specifier)
    );
    CREATE INDEX IF NOT EXISTS idx_reexports_name ON reexports(LOWER(name));

    -- WHY: Swift declarations get span-based identity instead of (path,name,kind).
    -- Swift permits overloads (e.g. two func update with different argument
    -- labels), repeated extension blocks in the same file, and same-named
    -- members across types -- a (path,name,kind) PK silently overwrites these.
    -- Span columns (start_byte/end_byte) come straight from tree-sitter and
    -- uniquely identify each source-level declaration.  Queries still index by
    -- name and parent_name; ranking handles disambiguation.
    CREATE TABLE IF NOT EXISTS swift_declarations (
      path TEXT NOT NULL,
      start_byte INTEGER NOT NULL,
      end_byte INTEGER NOT NULL,
      start_line INTEGER,
      start_col INTEGER,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      parent_name TEXT,
      parent_kind TEXT,
      signature_hint TEXT,
      updated_at_ms INTEGER,
      PRIMARY KEY (path, start_byte, end_byte)
    );
    CREATE INDEX IF NOT EXISTS idx_swiftdecls_name ON swift_declarations(LOWER(name));
    CREATE INDEX IF NOT EXISTS idx_swiftdecls_parent ON swift_declarations(LOWER(parent_name));
    CREATE INDEX IF NOT EXISTS idx_swiftdecls_name_parent ON swift_declarations(LOWER(name), LOWER(parent_name));
    CREATE INDEX IF NOT EXISTS idx_swiftdecls_path ON swift_declarations(path);
    CREATE INDEX IF NOT EXISTS idx_swiftdecls_kind ON swift_declarations(kind);

    -- WHY: Swift structural relations carry confidence + a span link back to
    -- the specific declaration that emitted them.  Without span linkage, two
    -- extension blocks of the same type in the same file would produce
    -- indistinguishable relation rows.  The confidence column lets downstream
    -- code filter heuristic edges (the inherits-vs-conforms split for class
    -- heritage) from direct syntactic facts (extension targets, struct/protocol
    -- heritage).
    CREATE TABLE IF NOT EXISTS swift_relations (
      from_path TEXT NOT NULL,
      source_start_byte INTEGER NOT NULL,
      source_end_byte INTEGER NOT NULL,
      source_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      target_name TEXT NOT NULL,
      confidence TEXT NOT NULL,
      updated_at_ms INTEGER,
      PRIMARY KEY (from_path, source_start_byte, source_end_byte, kind, target_name)
    );
    CREATE INDEX IF NOT EXISTS idx_swift_relations_target ON swift_relations(LOWER(target_name));
    CREATE INDEX IF NOT EXISTS idx_swift_relations_kind_target ON swift_relations(kind, LOWER(target_name));
    CREATE INDEX IF NOT EXISTS idx_swift_relations_from ON swift_relations(from_path);

    -- WHY: Swift entry-point files (those with @main attribute on a top-level
    -- type, or that match a Swift-specific filename heuristic) need to surface
    -- in the summary's entry-point section.  Storing as a per-path table (not
    -- a meta JSON blob) keeps watcher updates incremental: when a file's
    -- @main is added/removed, we INSERT/DELETE this row alongside the file's
    -- other extractions inside the same indexOneFile critical section.
    CREATE TABLE IF NOT EXISTS swift_entry_files (
      path TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      updated_at_ms INTEGER
    );

    -- WHY: git co-change pairs (blast-radius lane, docs/016 Sprint 1).  Rows
    -- are replaced wholesale on each bulk scan (never incrementally by the
    -- watcher -- git history only moves on commit, and per-file flushes must
    -- stay cheap).  file_a < file_b canonical ordering; both sides are
    -- graph-member source files (filtered at mine time, R2's v1 requirement).
    CREATE TABLE IF NOT EXISTS cochange_pairs (
      file_a TEXT NOT NULL,
      file_b TEXT NOT NULL,
      count INTEGER NOT NULL,
      confidence REAL NOT NULL,
      updated_at_ms INTEGER,
      PRIMARY KEY (file_a, file_b)
    );
    CREATE INDEX IF NOT EXISTS idx_cochange_a ON cochange_pairs(file_a);
    CREATE INDEX IF NOT EXISTS idx_cochange_b ON cochange_pairs(file_b);

    -- WHY: per-file co-change degree (distinct partners), computed at mine
    -- time.  The hub dampener (R2's other v1 requirement) needs each
    -- PARTNER's degree at query time; storing it beats a correlated COUNT
    -- subquery per partner and cannot drift because both tables are replaced
    -- in the same scan finalize.
    CREATE TABLE IF NOT EXISTS cochange_degree (
      path TEXT PRIMARY KEY,
      degree INTEGER NOT NULL,
      updated_at_ms INTEGER
    );
  `);
}

async function loadDb(root) {
  const rootAbs = path.resolve(root);
  const p = graphDbPath(rootAbs);
  const cached = dbByRoot.get(rootAbs);
  const diskState = inspectGraphPath(p);

  // Exact identity match means this path still names the inode whose bytes
  // seeded the cached handle. Ordering comparisons are intentionally absent:
  // an older/restored timestamp can still belong to a newer atomic rename.
  if (
    cached && diskState.state === "file" &&
    sameFileIdentity(cached.fileIdentity, diskState.identity)
  ) return cached.db;

  // Preserve the historical general-cache contract when the file is manually
  // removed: an in-memory writer may still persist its working copy. Security-
  // sensitive publication fences use readPersistedGraphBinding below, which
  // never accepts this missing-disk fallback.
  if (cached && diskState.state === "missing") return cached.db;

  // Cache stale (path identity changed) or cache miss: evict and
  // reload.  Closing the old SQL.Database releases its WASM-backed memory --
  // sql.js doesn't free this automatically when we drop the JS reference.
  if (cached) {
    try { cached.db.close(); } catch {}
    dbByRoot.delete(rootAbs);
  }

  const SQL = await loadSqlJs();

  // Stable descriptor/path read plus a post-parse identity check. The latter
  // catches a rename that lands after the bytes were read but before the SQL
  // handle is placed in cache.
  for (let attempt = 0; attempt < 3; attempt++) {
    const loaded = readGraphFileStable(p);
    if (!loaded) {
      const db = new SQL.Database();
      ensureSchema(db);
      dbByRoot.set(rootAbs, { db, fileIdentity: null });
      persistedBindingByRoot.delete(rootAbs);
      return db;
    }

    let db = null;
    try {
      db = new SQL.Database(new Uint8Array(loaded.bytes));
      // sql.js may defer corrupt-buffer errors until the first SQL statement.
      ensureSchema(db);
    } catch (err) {
      try { db?.close(); } catch {}
      const current = inspectGraphPath(p);
      if (
        current.state === "file" &&
        !sameFileIdentity(loaded.identity, current.identity) &&
        attempt < 2
      ) continue;
      console.warn(`[sextant] corrupt graph.db detected, rebuilding: ${err.message}`);
      // Delete only when the path still names the exact corrupt inode read.
      if (current.state === "file" && sameFileIdentity(loaded.identity, current.identity)) {
        try { fs.unlinkSync(p); } catch (_) {}
      }
      db = new SQL.Database();
      ensureSchema(db);
      dbByRoot.set(rootAbs, { db, fileIdentity: null });
      persistedBindingByRoot.delete(rootAbs);
      return db;
    }

    const current = inspectGraphPath(p);
    if (current.state === "file" && sameFileIdentity(loaded.identity, current.identity)) {
      dbByRoot.set(rootAbs, { db, fileIdentity: loaded.identity });
      rememberPersistedBinding(rootAbs, loaded.identity, graphBindingFromDatabase(db));
      return db;
    }
    try { db.close(); } catch {}
  }
  throw new Error(`graph.db changed while loading: ${p}`);
}

// Read freshness/publication anchors from persisted bytes only. Unlike loadDb,
// this never serves an in-memory working copy when graph.db is missing and it
// never mutates or populates the general cache. A final path-identity check
// makes replacement during SQL parsing fail closed.
async function readPersistedGraphBinding(root) {
  const rootAbs = path.resolve(root);
  const p = graphDbPath(rootAbs);
  let db = null;
  try {
    const before = inspectGraphPath(p);
    if (before.state !== "file") {
      persistedBindingByRoot.delete(rootAbs);
      return null;
    }
    const remembered = persistedBindingByRoot.get(rootAbs);
    if (
      remembered &&
      sameFileIdentity(remembered.fileIdentity, before.identity)
    ) {
      const after = inspectGraphPath(p);
      if (
        after.state !== "file" ||
        !sameFileIdentity(before.identity, after.identity)
      ) return null;
      return { ...remembered.binding };
    }

    const loaded = readGraphFileStable(p);
    if (!loaded) return null;
    const SQL = await loadSqlJs();
    db = new SQL.Database(new Uint8Array(loaded.bytes));
    const binding = graphBindingFromDatabase(db);
    const current = inspectGraphPath(p);
    if (
      current.state !== "file" ||
      !sameFileIdentity(loaded.identity, current.identity)
    ) return null;
    persistedBindingByRoot.set(rootAbs, {
      fileIdentity: loaded.identity,
      binding,
    });
    return { ...binding };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

// WHY cross-process write lock:
// sql.js is in-memory. Two sextant processes (scan + watcher, or two MCP
// requests, etc.) each loadDb the same on-disk file, mutate independently,
// then persistDb. Without a lock, last rename wins — the other process's
// updates silently vanish. withQueue() only serializes WITHIN a process.
// A short-held lockfile (`.graphdb.write.lock`) serializes writes across
// processes long enough for one to finish its tmp+rename cycle, which is
// bounded by file size (tens of ms for typical graphs).
//
// This is belt-and-suspenders: the atomic rename already prevents torn
// writes on-disk; the lock prevents last-writer-wins silent data loss.
// It does NOT guarantee read-modify-write coherence across processes —
// that would require full SQLite file locking, which sql.js doesn't expose.
// For the most common collision (concurrent scan + watcher flush) the scan
// command also refuses to run while the watcher is alive unless the user
// passes --allow-concurrent.
function isPidAliveSimple(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

async function acquireWriteLock(dbPath, timeoutMs = 3000) {
  const lockPath = dbPath + ".write.lock";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return lockPath;
    } catch (e) {
      if (e.code !== "EEXIST") return null;
      // Lock exists — check if holder is alive. Steal if not.
      let retryImmediate = false;
      try {
        const pid = parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
        if (!isPidAliveSimple(pid)) {
          try {
            fs.unlinkSync(lockPath);
            retryImmediate = true; // unlink succeeded — skip the jitter sleep
          } catch {}
          // WHY: if unlink fails (EPERM/EACCES) fall through to jitter sleep
          // rather than busy-spinning.  Tight spin here burns CPU for nothing
          // since the undeletable lock won't clear until the timeout.
        }
      } catch {}
      if (retryImmediate) continue;
      // Live holder (or unlink failed) — wait with jitter and retry.
      await new Promise((r) => setTimeout(r, 40 + Math.random() * 40));
    }
  }
  return null;
}

function releaseWriteLock(lockPath) {
  if (!lockPath) return;
  try {
    const held = parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
    if (held === process.pid) fs.unlinkSync(lockPath);
  } catch {}
}

async function persistDb(root) {
  const rootAbs = path.resolve(root);
  const p = graphDbPath(rootAbs);

  const lockPath = await acquireWriteLock(p);
  if (!lockPath) {
    // Contention we couldn't resolve. Fail loud rather than clobber — upstream
    // sees the error in the queue-task catch and moves on to the next update.
    throw new Error(`graph.db write lock timeout at ${p}.write.lock`);
  }

  try {
    // WHY loadDb INSIDE the lock: loading before acquiring the lock is a TOCTOU
    // — another writer's persist landing between the load and our export would
    // be silently overwritten by our (now stale) snapshot. loadDb is gated by
    // descriptor-stable full file identity, so reloading here picks up any write that landed while we
    // waited for the lock; in the common single-writer case the on-disk file
    // identity still matches our cache, so this returns our in-memory mutations
    // unchanged. Holding the lock across the (bounded) reload is the
    // price of guaranteeing the exported bytes reflect the latest on-disk state.
    const db = await loadDb(rootAbs);
    // Capture the binding before the first await, from the exact synchronous DB
    // state exported below. The mutable sql.js handle may receive another
    // watcher update while the tmp write/rename awaits; rereading it afterward
    // would bind unpersisted H2 metadata to H1's published inode identity.
    const exportedBinding = graphBindingFromDatabase(db);
    const bytes = db.export(); // Uint8Array
    // WHY: Atomic write prevents corrupt graph.db from partial writes during crash.
    // Same tmp+rename pattern used for index.json and summary.md.
    const tmp = p + ".tmp";
    await fs.promises.writeFile(tmp, Buffer.from(bytes));
    await fs.promises.rename(tmp, p);
    // Update the cache to the exact post-rename inode identity so our own
    // atomic publication does not self-invalidate on the next loadDb call.
    const cached = dbByRoot.get(rootAbs);
    if (cached) {
      const published = inspectGraphPath(p);
      if (published.state === "file") {
        cached.fileIdentity = published.identity;
        rememberPersistedBinding(rootAbs, published.identity, exportedBinding);
      }
    }
  } finally {
    releaseWriteLock(lockPath);
  }
}

function upsertFile(db, { relPath, type, sizeBytes, mtimeMs }) {
  const now = Date.now();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO files(path, type, size_bytes, mtime_ms, updated_at_ms) VALUES (?,?,?,?,?)"
  );
  stmt.run([relPath, type || null, sizeBytes || 0, mtimeMs || 0, now]);
  stmt.free();
}

function deleteFile(db, relPath) {
  const delF = db.prepare("DELETE FROM files WHERE path = ?");
  delF.run([relPath]);
  delF.free();

  const delIFrom = db.prepare("DELETE FROM imports WHERE from_path = ?");
  delIFrom.run([relPath]);
  delIFrom.free();

  // WHY: NULL out to_path rather than deleting.  These import records are owned
  // by OTHER files (they imported the file being deleted).  Deleting them would
  // silently destroy those files' import metadata.  Setting to_path = NULL marks
  // the imports as unresolved, which is semantically correct and keeps the
  // resolution metric accurate (unresolved imports are visible in health checks).
  const nullITo = db.prepare("UPDATE imports SET to_path = NULL WHERE to_path = ?");
  nullITo.run([relPath]);
  nullITo.free();

  const delE = db.prepare("DELETE FROM exports WHERE path = ?");
  delE.run([relPath]);
  delE.free();

  const delR = db.prepare("DELETE FROM reexports WHERE from_path = ?");
  delR.run([relPath]);
  delR.free();

  const delSD = db.prepare("DELETE FROM swift_declarations WHERE path = ?");
  delSD.run([relPath]);
  delSD.free();

  const delSR = db.prepare("DELETE FROM swift_relations WHERE from_path = ?");
  delSR.run([relPath]);
  delSR.free();

  const delSEF = db.prepare("DELETE FROM swift_entry_files WHERE path = ?");
  delSEF.run([relPath]);
  delSEF.free();
}

function replaceImports(db, fromRelPath, imports) {
  const del = db.prepare("DELETE FROM imports WHERE from_path = ?");
  del.run([fromRelPath]);
  del.free();

  if (!imports || !imports.length) return;
  const now = Date.now();
  const ins = db.prepare(
    "INSERT OR REPLACE INTO imports(from_path, specifier, to_path, kind, is_external, updated_at_ms) VALUES (?,?,?,?,?,?)"
  );

  for (const it of imports) {
    ins.run([
      fromRelPath,
      it.specifier,
      it.toPath || null,
      it.kind || null,
      it.isExternal ? 1 : 0,
      now,
    ]);
  }
  ins.free();
}

// Split an exported symbol into lowercase lexical tokens (docs/035 #4).
// FLAG_REGISTRY -> [flag, registry] · createElement -> [create, element] ·
// HTTPServer -> [http, server]. Tokens shorter than 3 chars are dropped: they
// are almost always noise ("id", "on", "to") and they are what a df cap would
// have to fight hardest. Pure string splitting — no stemming, no dictionary, no
// model: this stays a FACT about the name the author wrote.
function tokenizeExportName(name) {
  if (typeof name !== "string" || !name) return [];
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase boundary
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2"); // HTTPServer -> HTTP Server
  const out = new Set();
  for (const part of spaced.split(/[\0_\-.$\s]+/)) {
    const t = part.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (t.length >= 3) out.add(t);
  }
  return [...out];
}

function replaceExports(db, relPath, exportsList) {
  const del = db.prepare("DELETE FROM exports WHERE path = ?");
  del.run([relPath]);
  del.free();

  // Tokens are maintained per-file alongside the exports themselves, not
  // rebuilt globally at scan finalize: a watcher flush must not leave the token
  // index describing a previous version of the file.
  const delTok = db.prepare("DELETE FROM export_tokens WHERE path = ?");
  delTok.run([relPath]);
  delTok.free();

  if (!exportsList || !exportsList.length) return;
  const now = Date.now();
  const ins = db.prepare(
    "INSERT OR REPLACE INTO exports(path, name, kind, updated_at_ms) VALUES (?,?,?,?)"
  );
  const insTok = db.prepare(
    "INSERT OR REPLACE INTO export_tokens(token, path, name, kind) VALUES (?,?,?,?)"
  );
  for (const ex of exportsList) {
    ins.run([relPath, ex.name, ex.kind, now]);
    for (const token of tokenizeExportName(ex.name)) {
      insTok.run([token, relPath, ex.name, ex.kind]);
    }
  }
  ins.free();
  insTok.free();
}

// Document frequency of a token: how many DISTINCT files export a symbol
// containing it. Computed at query time (indexed, 1-4 lookups per retrieval)
// rather than denormalized onto the row, so it can never disagree with the
// table it summarizes.
function exportTokenDocFrequency(db, token) {
  const stmt = db.prepare(
    "SELECT COUNT(DISTINCT path) AS df FROM export_tokens WHERE token = ?"
  );
  stmt.bind([String(token || "").toLowerCase()]);
  let df = 0;
  if (stmt.step()) df = stmt.getAsObject().df || 0;
  stmt.free();
  return df;
}

// THE PRECISION GUARD for the token lane, and a deliberate departure from what
// docs/035's verifier recommended — recorded here because the departure is
// evidence-driven, not a shortcut.
//
// The verifier said to reuse docs/012's guards: exclude test paths AND require
// the target file's fan-in >= EXPORT_INJECT_MIN_FANIN (5). The test-path
// exclusion is kept. The FAN-IN FLOOR IS NOT, because it would break this
// candidate's own kill-gate: the committed fixture's gold file
// `app/feature_gate.py` has fan-in 4, so the floor would exclude the very file
// the FAIL-pre exists to recover. Fan-in asks "is this file important"; for a
// lexical lane the question is "is this token discriminating", and df answers
// that directly.
//
// The cap is a per-repo PERCENTILE, not a constant. docs/035 proposed `df > 12`,
// but measured df distributions differ by an order of magnitude — p95 is 3 on
// the fixture, 5 on sextant, 15 on jan25, 27 on somaNotes — so 12 is p99 on one
// repo and roughly p85 on another, i.e. two different strictnesses wearing one
// number. p95 with a floor of 3 excludes the real offenders everywhere measured
// (`default` df=82 on sextant, `test` df=666 on somaNotes, `test` df=159 on
// jan25) while keeping the fixture's `registry` (df=3).
const EXPORT_TOKEN_DF_FLOOR = 3;
function exportTokenDfCap(db) {
  const dfs = [];
  const stmt = db.prepare(
    "SELECT COUNT(DISTINCT path) AS df FROM export_tokens GROUP BY token"
  );
  while (stmt.step()) dfs.push(stmt.getAsObject().df || 0);
  stmt.free();
  if (!dfs.length) return EXPORT_TOKEN_DF_FLOOR;
  dfs.sort((a, b) => a - b);
  const p95 = dfs[Math.floor((dfs.length - 1) * 0.95)];
  return Math.max(EXPORT_TOKEN_DF_FLOOR, p95);
}

// Files whose exports contain `token`, excluding tokens too generic to
// discriminate. Returns [] for an over-cap token so the caller cannot
// accidentally surface a `test`/`default`-class match.
function findExportsByToken(db, token, dfCap, limit = 20) {
  const t = String(token || "").toLowerCase();
  if (t.length < 3) return [];
  const df = exportTokenDocFrequency(db, t);
  if (!df || df > dfCap) return [];
  const out = [];
  const stmt = db.prepare(
    "SELECT path, name, kind FROM export_tokens WHERE token = ? ORDER BY kind, path LIMIT ?"
  );
  stmt.bind([t, Math.max(1, Math.floor(limit))]);
  while (stmt.step()) out.push(Object.assign(stmt.getAsObject(), { df }));
  stmt.free();
  return out;
}

function queryImports(db, relPath) {
  const out = [];
  const stmt = db.prepare(
    "SELECT specifier, to_path AS toPath, kind, is_external AS isExternal FROM imports WHERE from_path = ? ORDER BY specifier"
  );
  stmt.bind([relPath]);
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

function queryDependents(db, relPath) {
  const out = [];
  const stmt = db.prepare(
    "SELECT from_path AS fromPath, specifier, kind FROM imports WHERE to_path = ? ORDER BY from_path, specifier"
  );
  stmt.bind([relPath]);
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

function queryExports(db, relPath) {
  const out = [];
  const stmt = db.prepare(
    "SELECT name, kind FROM exports WHERE path = ? ORDER BY kind, name"
  );
  stmt.bind([relPath]);
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

// WHY: Export-graph symbol lookup.  For a query like "useState", this finds
// which files EXPORT that symbol — bypassing rg hit order entirely.  Solves
// the "common term in large repo" failure class where the definition file
// never reaches the scorer through text search alone.
//
// WHY LIMIT: Common export names (default, run, index) can appear in hundreds
// of files in monorepos or plugin-pattern codebases. Without a cap we dragged
// the full set into the caller, which then sliced the first 10 alphabetically
// — producing an arbitrary slice of test/fixture files instead of the real
// definition. Cap high enough that the caller can re-rank; the caller is
// responsible for final slicing by relevance, not us.
function findExportsBySymbol(db, symbolName, limit = 50) {
  const out = [];
  const stmt = db.prepare(
    "SELECT path, name, kind FROM exports WHERE LOWER(name) = LOWER(?) ORDER BY kind, path LIMIT ?"
  );
  stmt.bind([symbolName, Math.max(1, Math.floor(limit))]);
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

// WHY: Same replace-all pattern as replaceExports — delete then reinsert.
// Ensures stale re-exports don't persist when a barrel file is edited.
function replaceReexports(db, relPath, reexportsList) {
  const del = db.prepare("DELETE FROM reexports WHERE from_path = ?");
  del.run([relPath]);
  del.free();

  if (!reexportsList || !reexportsList.length) return;
  const now = Date.now();
  const ins = db.prepare(
    "INSERT OR REPLACE INTO reexports(from_path, name, to_specifier, kind, updated_at_ms) VALUES (?,?,?,?,?)"
  );
  for (const re of reexportsList) {
    if (!re.from) continue; // safety: skip entries without a source specifier
    ins.run([relPath, re.name, re.from, re.kind, now]);
  }
  ins.free();
}

// WHY: Follow re-export chains to trace a symbol back to its original source.
// Given "useState", finds barrel files that re-export it and follows the chain
// up to maxDepth hops.  Returns an array of chain entries ordered from the
// first re-exporter to the deepest source found.  Each entry has:
//   { path: string, name: string, toSpecifier: string, kind: string }
// The last entry's toSpecifier (combined with resolver) points to the likely
// original definition file.
function findReexportChain(db, symbolName, maxDepth) {
  if (maxDepth === undefined) maxDepth = 5;
  const chain = [];
  const visited = new Set();

  // Seed: find all files that re-export this symbol name
  const stmt = db.prepare(
    "SELECT from_path, name, to_specifier, kind FROM reexports WHERE LOWER(name) = LOWER(?) ORDER BY from_path"
  );
  stmt.bind([symbolName]);
  const seeds = [];
  while (stmt.step()) seeds.push(stmt.getAsObject());
  stmt.free();

  // BFS through the chain (most re-export chains are 1-2 hops)
  const queue = seeds.map((s) => ({ ...s, depth: 0 }));

  while (queue.length > 0) {
    const entry = queue.shift();
    const key = `${entry.from_path}\0${entry.name}\0${entry.to_specifier}`;
    if (visited.has(key)) continue;
    visited.add(key);

    chain.push({
      path: entry.from_path,
      name: entry.name,
      toSpecifier: entry.to_specifier,
      kind: entry.kind,
    });

    if (entry.depth >= maxDepth) continue;

    // Follow: find the next hop in the re-export chain.
    //
    // WHY this uses basename matching instead of full resolution:
    // to_specifier is an unresolved import path (e.g., "./ReactHooks").
    // graph.js is a lower-level module and doesn't have access to the
    // resolver (which needs root, tsconfig, etc.).  Instead we extract
    // the basename from to_specifier and look for reexporters whose
    // from_path contains that basename.  This follows the chain
    // directionally — when A re-exports from "./ReactHooks", we look
    // for files whose path includes "ReactHooks" that also re-export
    // the same symbol.  This is a pragmatic approximation: it can
    // over-match if unrelated files share a basename segment, but the
    // visited set prevents cycles and the depth cap limits expansion.
    // True resolution would require the resolver, which belongs in a
    // higher-level module (retrieve.js / intel.js).
    const specBasename = entry.to_specifier
      .replace(/^.*[\\/]/, "")  // last path segment
      .replace(/\.[^.]+$/, ""); // strip extension if present
    const likePattern = specBasename ? `%/${specBasename}%` : null;

    // Directional query: prefer entries whose from_path matches the
    // to_specifier basename, so BFS traces A -> B -> C rather than
    // gathering all reexporters globally.
    const nextStmt = likePattern
      ? db.prepare(
          "SELECT from_path, name, to_specifier, kind FROM reexports WHERE LOWER(name) = LOWER(?) AND from_path != ? AND from_path LIKE ? ORDER BY from_path"
        )
      : db.prepare(
          "SELECT from_path, name, to_specifier, kind FROM reexports WHERE LOWER(name) = LOWER(?) AND from_path != ? ORDER BY from_path"
        );
    nextStmt.bind(likePattern ? [symbolName, entry.from_path, likePattern] : [symbolName, entry.from_path]);
    while (nextStmt.step()) {
      const next = nextStmt.getAsObject();
      const nk = `${next.from_path}\0${next.name}\0${next.to_specifier}`;
      if (!visited.has(nk)) {
        queue.push({ ...next, depth: entry.depth + 1 });
      }
    }
    nextStmt.free();
  }

  return chain;
}

function countFiles(db) {
  const stmt = db.prepare("SELECT COUNT(*) AS c FROM files");
  stmt.step();
  const c = Number(stmt.getAsObject().c || 0);
  stmt.free();
  return c;
}

function mostDependedOn(db, limit = 10) {
  const out = [];
  const stmt = db.prepare(
    "SELECT to_path AS path, COUNT(*) AS c FROM imports WHERE to_path IS NOT NULL GROUP BY to_path ORDER BY c DESC, to_path ASC LIMIT ?"
  );
  stmt.bind([limit]);
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

function fileMetaByPaths(db, paths) {
  const out = new Map();
  const list = Array.isArray(paths) ? [...new Set(paths.filter(Boolean))] : [];
  if (!list.length) return out;

  const placeholders = list.map(() => "?").join(",");
  const stmt = db.prepare(
    `SELECT path, type, size_bytes AS sizeBytes, mtime_ms AS mtimeMs FROM files WHERE path IN (${placeholders})`
  );
  stmt.bind(list);
  while (stmt.step()) {
    const row = stmt.getAsObject();
    out.set(row.path, {
      path: row.path,
      type: row.type || "unknown",
      sizeBytes: row.sizeBytes ?? null,
      mtimeMs: row.mtimeMs ?? null,
    });
  }
  stmt.free();
  return out;
}

function fanInByPaths(db, paths) {
  const out = new Map();
  const list = Array.isArray(paths) ? [...new Set(paths.filter(Boolean))] : [];
  if (!list.length) return out;

  const placeholders = list.map(() => "?").join(",");
  const stmt = db.prepare(
    `SELECT to_path AS path, COUNT(*) AS c FROM imports WHERE to_path IN (${placeholders}) AND is_external = 0 GROUP BY to_path`
  );
  stmt.bind(list);
  while (stmt.step()) {
    const row = stmt.getAsObject();
    out.set(row.path, Number(row.c || 0));
  }
  stmt.free();
  return out;
}

function fanOutByPaths(db, paths) {
  const out = new Map();
  const list = Array.isArray(paths) ? [...new Set(paths.filter(Boolean))] : [];
  if (!list.length) return out;

  const placeholders = list.map(() => "?").join(",");
  const stmt = db.prepare(
    `SELECT from_path AS path, COUNT(*) AS c FROM imports WHERE from_path IN (${placeholders}) AND is_external = 0 GROUP BY from_path`
  );
  stmt.bind(list);
  while (stmt.step()) {
    const row = stmt.getAsObject();
    out.set(row.path, Number(row.c || 0));
  }
  stmt.free();
  return out;
}

function neighbors(db, relPath, { maxImports = 15, maxDependents = 15 } = {}) {
  const imports = [];
  const dependents = [];

  const outStmt = db.prepare(
    "SELECT DISTINCT to_path AS path FROM imports WHERE from_path = ? AND to_path IS NOT NULL LIMIT ?"
  );
  outStmt.bind([relPath, maxImports]);
  while (outStmt.step()) {
    const row = outStmt.getAsObject();
    if (row.path) imports.push(row.path);
  }
  outStmt.free();

  const inStmt = db.prepare(
    "SELECT DISTINCT from_path AS path FROM imports WHERE to_path = ? LIMIT ?"
  );
  inStmt.bind([relPath, maxDependents]);
  while (inStmt.step()) {
    const row = inStmt.getAsObject();
    if (row.path) dependents.push(row.path);
  }
  inStmt.free();

  return { imports, dependents };
}

// WHY: Filename matching catches terms that aren't exported symbols.
// For example, "watcher" matches watch.js, "heartbeat" matches no exports
// but might match file paths.  This complements findExportsBySymbol by
// covering cases where the relevant concept lives in the filename, not
// in an export name.
function filePathsMatching(db, substring) {
  // WHY: Escape LIKE metacharacters (% and _) so that snake_case terms like
  // "get_user" match literally, not as single-char wildcards.
  // NOTE: The LIMIT 20 is intentionally larger than MAX_PATH_MATCHES (10) in
  // graph-retrieve.js. graph-retrieve uses paths.length > MAX_PATH_MATCHES to
  // skip generic terms. If LIMIT is reduced below MAX_PATH_MATCHES + 1 the
  // guard will stop firing correctly.
  const escaped = substring
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
  const stmt = db.prepare(
    "SELECT path FROM files WHERE LOWER(path) LIKE '%' || LOWER(?) || '%' ESCAPE '\\' LIMIT 20"
  );
  stmt.bind([escaped]);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject().path);
  }
  stmt.free();
  return results;
}

// --- Index-in-SQLite query functions (Phase 1 of index.json migration) ---

function allFilePaths(db) {
  const out = [];
  const stmt = db.prepare("SELECT path FROM files ORDER BY path");
  while (stmt.step()) out.push(stmt.getAsObject().path);
  stmt.free();
  return out;
}

function allFileEntries(db) {
  const out = [];
  const stmt = db.prepare(
    "SELECT path, type, size_bytes AS sizeBytes, mtime_ms AS mtimeMs FROM files ORDER BY path"
  );
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

function filePathsWithPrefix(db, prefix) {
  const out = [];
  if (!prefix) return out;
  // Escape % and _ in the prefix for LIKE safety, then append %
  const escaped = prefix.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
  const stmt = db.prepare(
    "SELECT path FROM files WHERE path LIKE ? ESCAPE '\\' ORDER BY path"
  );
  stmt.bind([escaped + "%"]);
  while (stmt.step()) out.push(stmt.getAsObject().path);
  stmt.free();
  return out;
}

function getFileMeta(db, relPath) {
  const stmt = db.prepare(
    "SELECT path, type, size_bytes AS sizeBytes, mtime_ms AS mtimeMs FROM files WHERE path = ?"
  );
  stmt.bind([relPath]);
  let result = null;
  if (stmt.step()) result = stmt.getAsObject();
  stmt.free();
  return result;
}

function computeResolutionStats(db) {
  // Count local imports and how many are resolved
  const countStmt = db.prepare(
    "SELECT COUNT(*) AS localTotal, SUM(CASE WHEN to_path IS NOT NULL AND to_path != '' THEN 1 ELSE 0 END) AS localResolved FROM imports WHERE is_external = 0"
  );
  countStmt.step();
  const row = countStmt.getAsObject();
  countStmt.free();

  const localTotal = Number(row.localTotal || 0);
  const localResolved = Number(row.localResolved || 0);
  const resolutionPct = localTotal > 0 ? Math.round((localResolved / localTotal) * 100) : 100;

  // Top unresolved specifiers
  const missStmt = db.prepare(
    "SELECT specifier, COUNT(*) AS c FROM imports WHERE (to_path IS NULL OR to_path = '') AND is_external = 0 GROUP BY specifier ORDER BY c DESC, specifier ASC LIMIT 8"
  );
  const topMisses = [];
  while (missStmt.step()) {
    const m = missStmt.getAsObject();
    topMisses.push([m.specifier, Number(m.c)]);
  }
  missStmt.free();

  return { localTotal, localResolved, resolutionPct, topMisses };
}

function typeCountsFromDb(db) {
  const out = [];
  const stmt = db.prepare(
    "SELECT type, COUNT(*) AS c FROM files GROUP BY type ORDER BY c DESC, type ASC"
  );
  while (stmt.step()) {
    const row = stmt.getAsObject();
    out.push([row.type || "other", Number(row.c)]);
  }
  stmt.free();
  return out;
}

function setMetaValue(db, key, value) {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)"
  );
  stmt.run([key, String(value)]);
  stmt.free();
}

function getMetaValue(db, key) {
  const stmt = db.prepare("SELECT value FROM meta WHERE key = ?");
  stmt.bind([key]);
  let result = null;
  if (stmt.step()) result = stmt.getAsObject().value;
  stmt.free();
  return result;
}

// --- Swift v1: declarations + relations ---

// Same delete-then-bulk-insert pattern as replaceExports/replaceReexports —
// keeps a file's declarations consistent on edit without orphan rows.
// Each row's PK is (path, start_byte, end_byte) which preserves overloads
// and repeated extensions of the same type.
function replaceSwiftDeclarations(db, relPath, declList) {
  const del = db.prepare("DELETE FROM swift_declarations WHERE path = ?");
  del.run([relPath]);
  del.free();

  if (!declList || !declList.length) return;
  const now = Date.now();
  const ins = db.prepare(
    "INSERT OR REPLACE INTO swift_declarations(path, start_byte, end_byte, start_line, start_col, name, kind, parent_name, parent_kind, signature_hint, updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  );
  for (const d of declList) {
    if (!d || typeof d.name !== "string" || typeof d.kind !== "string") continue;
    if (!Number.isFinite(d.start_byte) || !Number.isFinite(d.end_byte)) continue;
    ins.run([
      relPath,
      d.start_byte,
      d.end_byte,
      Number.isFinite(d.start_line) ? d.start_line : null,
      Number.isFinite(d.start_col) ? d.start_col : null,
      d.name,
      d.kind,
      d.parent_name || null,
      d.parent_kind || null,
      d.signature_hint || null,
      now,
    ]);
  }
  ins.free();
}

function replaceSwiftRelations(db, fromRelPath, relList) {
  const del = db.prepare("DELETE FROM swift_relations WHERE from_path = ?");
  del.run([fromRelPath]);
  del.free();

  if (!relList || !relList.length) return;
  const now = Date.now();
  const ins = db.prepare(
    "INSERT OR REPLACE INTO swift_relations(from_path, source_start_byte, source_end_byte, source_name, kind, target_name, confidence, updated_at_ms) VALUES (?,?,?,?,?,?,?,?)"
  );
  for (const r of relList) {
    if (!r || typeof r.kind !== "string" || typeof r.target_name !== "string") continue;
    if (!Number.isFinite(r.source_start_byte) || !Number.isFinite(r.source_end_byte)) continue;
    if (r.confidence !== "direct" && r.confidence !== "heuristic") continue;
    ins.run([
      fromRelPath,
      r.source_start_byte,
      r.source_end_byte,
      r.source_name || "",
      r.kind,
      r.target_name,
      r.confidence,
      now,
    ]);
  }
  ins.free();
}

// Swift entry-file helpers.  Used by intel.js to mark files containing a
// top-level @main attribute (the Swift program entry point), and by
// summary.js to surface them as "Likely entry points".
function setSwiftEntryFile(db, relPath, reason = "@main") {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO swift_entry_files(path, reason, updated_at_ms) VALUES (?,?,?)"
  );
  stmt.run([relPath, reason, Date.now()]);
  stmt.free();
}

function clearSwiftEntryFile(db, relPath) {
  const stmt = db.prepare("DELETE FROM swift_entry_files WHERE path = ?");
  stmt.run([relPath]);
  stmt.free();
}

function getSwiftEntryFiles(db) {
  const out = [];
  const stmt = db.prepare(
    "SELECT path, reason FROM swift_entry_files ORDER BY path ASC"
  );
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

// Mirror of findExportsBySymbol but against swift_declarations — returns the
// richer row shape (parent_name, parent_kind, span, signature_hint).  Hook
// fast path calls BOTH this and findExportsBySymbol so JS/Python and Swift
// queries flow through one merge.
function findDeclarationsBySymbol(db, symbolName, opts = {}) {
  const limit = Math.max(1, Math.floor(opts.limit ?? 50));
  const out = [];
  const stmt = db.prepare(
    "SELECT path, start_byte AS startByte, end_byte AS endByte, start_line AS startLine, start_col AS startCol, name, kind, parent_name AS parentName, parent_kind AS parentKind, signature_hint AS signatureHint FROM swift_declarations WHERE LOWER(name) = LOWER(?) ORDER BY kind, path, start_byte LIMIT ?"
  );
  stmt.bind([symbolName, limit]);
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

// Find structural edges that POINT AT a target name.  Optional kind filter
// ("extends" / "conforms_to" / "inherits_from").  Optional confidence filter
// lets callers limit to "direct" syntactic facts and exclude heuristic edges.
function findRelationsByTarget(db, targetName, opts = {}) {
  const filters = ["LOWER(target_name) = LOWER(?)"];
  const params = [targetName];
  if (opts.kind) {
    filters.push("kind = ?");
    params.push(opts.kind);
  }
  if (opts.confidence) {
    filters.push("confidence = ?");
    params.push(opts.confidence);
  }
  const limit = Math.max(1, Math.floor(opts.limit ?? 100));
  params.push(limit);
  const out = [];
  const stmt = db.prepare(
    `SELECT from_path AS fromPath, source_start_byte AS sourceStartByte, source_end_byte AS sourceEndByte, source_name AS sourceName, kind, target_name AS targetName, confidence FROM swift_relations WHERE ${filters.join(" AND ")} ORDER BY from_path, source_start_byte LIMIT ?`
  );
  stmt.bind(params);
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

// Read Swift health counters from meta + derived counts from the tables.
// Counters are written by lib/intel.js after a scan completes.  Used by
// `sextant doctor` and the freshness gate's silent-absence path.
function getSwiftHealthCounters(db) {
  const meta = (key) => {
    const v = getMetaValue(db, key);
    if (v === null || v === undefined) return null;
    if (key === "swift.parserState") return v;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const declCountStmt = db.prepare("SELECT COUNT(*) AS c FROM swift_declarations");
  declCountStmt.step();
  const declarationsIndexed = Number(declCountStmt.getAsObject().c || 0);
  declCountStmt.free();

  const relCountStmt = db.prepare(
    "SELECT confidence, COUNT(*) AS c FROM swift_relations GROUP BY confidence"
  );
  let relDirect = 0, relHeuristic = 0;
  while (relCountStmt.step()) {
    const row = relCountStmt.getAsObject();
    if (row.confidence === "direct") relDirect = Number(row.c);
    else if (row.confidence === "heuristic") relHeuristic = Number(row.c);
  }
  relCountStmt.free();

  return {
    parserState: meta("swift.parserState"),
    filesSeen: meta("swift.filesSeen") ?? 0,
    filesParsedOk: meta("swift.filesParsedOk") ?? 0,
    filesParseErrors: meta("swift.filesParseErrors") ?? 0,
    filesUnsupportedConstructs: meta("swift.filesUnsupportedConstructs") ?? 0,
    declarationsIndexed,
    relationsIndexedDirect: relDirect,
    relationsIndexedHeuristic: relHeuristic,
    relationsIndexedTotal: relDirect + relHeuristic,
  };
}

// ---------------------------------------------------------------------------
// Co-change (blast-radius lane, docs/016 Sprint 1)

// Replace ALL co-change rows (pairs + degrees) with this scan's result.
// Wholesale replacement mirrors the mine-time contract: the two tables are a
// single atomic fact about one git-log parse, never patched incrementally.
function replaceCoChangePairs(db, pairs, degree) {
  // Transaction backs the atomicity this function promises: a throw partway
  // through must not leave an emptied-but-unrefilled table that the caller's
  // best-effort catch would then persist to disk.
  db.run("BEGIN");
  try {
    db.run("DELETE FROM cochange_pairs");
    db.run("DELETE FROM cochange_degree");
    const now = Date.now();
    if (pairs && pairs.length) {
      const ins = db.prepare(
        "INSERT OR REPLACE INTO cochange_pairs(file_a, file_b, count, confidence, updated_at_ms) VALUES (?,?,?,?,?)"
      );
      for (const p of pairs) {
        const a = p.a < p.b ? p.a : p.b;
        const b = p.a < p.b ? p.b : p.a;
        ins.run([a, b, p.count, p.confidence, now]);
      }
      ins.free();
    }
    if (degree) {
      const insD = db.prepare(
        "INSERT OR REPLACE INTO cochange_degree(path, degree, updated_at_ms) VALUES (?,?,?)"
      );
      for (const [p, d] of degree.entries()) insD.run([p, d, now]);
      insD.free();
    }
    db.run("COMMIT");
  } catch (err) {
    try { db.run("ROLLBACK"); } catch {}
    throw err;
  }
}

// Partners of relPath, hub-dampened and ranked.  Hub dampening (R2 v1
// requirement): a god file co-changes with everything, so surfacing it as a
// "partner" of whatever you just edited is noise — partners whose own degree
// exceeds hubMaxDegree are dropped.  Ranking: confidence desc, count desc.
function findCoChangePartners(
  db,
  relPath,
  { limit = 8, minCount = 3, minConfidence = 0, hubMaxDegree = 25 } = {}
) {
  const out = [];
  const stmt = db.prepare(
    `SELECT
       CASE WHEN file_a = ? THEN file_b ELSE file_a END AS partner,
       count, confidence,
       COALESCE((SELECT degree FROM cochange_degree d
                 WHERE d.path = CASE WHEN file_a = ? THEN file_b ELSE file_a END), 0) AS degree
     FROM cochange_pairs
     WHERE (file_a = ? OR file_b = ?) AND count >= ? AND confidence >= ?
     ORDER BY confidence DESC, count DESC`
  );
  stmt.bind([relPath, relPath, relPath, relPath, minCount, minConfidence]);
  while (stmt.step()) {
    const row = stmt.getAsObject();
    if (row.degree > hubMaxDegree) continue;
    out.push(row);
    if (out.length >= limit) break;
  }
  stmt.free();
  return out;
}

function countCoChangePairs(db) {
  const stmt = db.prepare("SELECT COUNT(*) AS n FROM cochange_pairs");
  stmt.step();
  const n = stmt.getAsObject().n;
  stmt.free();
  return n;
}

module.exports = {
  graphDbPath,
  loadDb,
  readPersistedGraphBinding,
  persistDb,
  upsertFile,
  deleteFile,
  replaceImports,
  replaceExports,
  replaceReexports,
  queryImports,
  queryDependents,
  queryExports,
  findExportsBySymbol,
  findExportsByToken,
  tokenizeExportName,
  exportTokenDfCap,
  exportTokenDocFrequency,
  findReexportChain,
  countFiles,
  mostDependedOn,
  fileMetaByPaths,
  fanInByPaths,
  fanOutByPaths,
  neighbors,
  filePathsMatching,
  // Index-in-SQLite query functions
  allFilePaths,
  allFileEntries,
  filePathsWithPrefix,
  getFileMeta,
  computeResolutionStats,
  typeCountsFromDb,
  setMetaValue,
  getMetaValue,
  // Swift v1
  replaceSwiftDeclarations,
  replaceSwiftRelations,
  setSwiftEntryFile,
  clearSwiftEntryFile,
  getSwiftEntryFiles,
  findDeclarationsBySymbol,
  findRelationsByTarget,
  getSwiftHealthCounters,
  // Co-change (blast-radius lane)
  replaceCoChangePairs,
  findCoChangePartners,
  countCoChangePairs,
};
