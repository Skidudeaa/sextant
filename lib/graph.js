const fs = require("fs");
const path = require("path");

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

// WHY: cache value carries the on-disk mtime at the moment we synchronized
// with disk (initial load, or our own persistDb).  loadDb() compares this to
// the current mtime on each call; if disk is newer, another process wrote
// graph.db and our in-memory copy is stale -- evict and reload.  Without
// this gate, a process-global cache (notably the per-session MCP server)
// served indefinitely-stale results to one session while a sibling session
// or the watcher updated graph.db on disk.
const dbByRoot = new Map(); // rootAbs -> { db: SQL.Database, mtimeMs: number }

// Returns the file's mtimeMs, or null if it doesn't exist / can't be stat'd.
// Some filesystems round mtime to 1s -- writes inside the same second won't
// bump it.  The pre-existing acquireWriteLock + tmp+rename pattern serializes
// concurrent writers at sub-second timescales, so this is bounded to "one
// stale call" rather than session-long divergence.  Acceptable.
function statMtimeMs(p) {
  try { return fs.statSync(p).mtimeMs; }
  catch { return null; }
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
  `);
}

async function loadDb(root) {
  const rootAbs = path.resolve(root);
  const p = graphDbPath(rootAbs);
  const cached = dbByRoot.get(rootAbs);
  const diskMtime = statMtimeMs(p);

  // Cache hit + disk hasn't moved past our snapshot: serve cached.
  // (diskMtime <= cached.mtimeMs covers both "exact match" and the rare case
  //  where another process replaced the file with an older copy -- if disk
  //  isn't strictly newer than what we have, we trust the in-memory state.)
  if (cached && diskMtime !== null && diskMtime <= cached.mtimeMs) {
    return cached.db;
  }
  // Cache hit but file is gone (tests or manual cleanup).  Don't crash --
  // serve the cached in-memory db; it's still a valid working copy and
  // persistDb will recreate the file on next write.
  if (cached && diskMtime === null) {
    return cached.db;
  }
  // Cache stale (disk is newer than our snapshot) or cache miss: evict and
  // reload.  Closing the old SQL.Database releases its WASM-backed memory --
  // sql.js doesn't free this automatically when we drop the JS reference.
  if (cached) {
    try { cached.db.close(); } catch {}
    dbByRoot.delete(rootAbs);
  }

  const SQL = await loadSqlJs();

  let db;
  if (fs.existsSync(p)) {
    const buf = fs.readFileSync(p);
    try {
      db = new SQL.Database(new Uint8Array(buf));
      // WHY: sql.js may accept a corrupt buffer without throwing — the error
      // only surfaces when actual SQL is executed.  Running ensureSchema inside
      // the try/catch ensures we catch both constructor failures and deferred
      // "file is not a database" errors from the first db.run() call.
      ensureSchema(db);
    } catch (err) {
      console.warn(`[sextant] corrupt graph.db detected, rebuilding: ${err.message}`);
      try { fs.unlinkSync(p); } catch (_) {}
      db = new SQL.Database();
      ensureSchema(db);
    }
  } else {
    db = new SQL.Database();
    ensureSchema(db);
  }
  // Re-stat after load to capture the actual on-disk mtime (or 0 if the file
  // doesn't exist yet -- next disk write will bump it past 0 and trigger a
  // correct reload for any other reader).
  dbByRoot.set(rootAbs, { db, mtimeMs: statMtimeMs(p) ?? 0 });
  return db;
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
  const db = await loadDb(rootAbs);
  const p = graphDbPath(rootAbs);

  const lockPath = await acquireWriteLock(p);
  if (!lockPath) {
    // Contention we couldn't resolve. Fail loud rather than clobber — upstream
    // sees the error in the queue-task catch and moves on to the next update.
    throw new Error(`graph.db write lock timeout at ${p}.write.lock`);
  }

  try {
    const bytes = db.export(); // Uint8Array
    // WHY: Atomic write prevents corrupt graph.db from partial writes during crash.
    // Same tmp+rename pattern used for index.json and summary.md.
    const tmp = p + ".tmp";
    await fs.promises.writeFile(tmp, Buffer.from(bytes));
    await fs.promises.rename(tmp, p);
    // WHY: bump our cached mtime to the post-rename value so the next loadDb
    // call doesn't see "disk newer than cache" and self-evict the in-memory
    // state we just persisted.  This is the writer-side half of the mtime
    // gate -- without it, every persist would force an immediate reload from
    // disk on the next read, throwing away any subsequent in-memory mutations
    // that haven't been persisted yet.
    const cached = dbByRoot.get(rootAbs);
    if (cached) {
      const newMtime = statMtimeMs(p);
      if (newMtime !== null) cached.mtimeMs = newMtime;
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

function replaceExports(db, relPath, exportsList) {
  const del = db.prepare("DELETE FROM exports WHERE path = ?");
  del.run([relPath]);
  del.free();

  if (!exportsList || !exportsList.length) return;
  const now = Date.now();
  const ins = db.prepare(
    "INSERT OR REPLACE INTO exports(path, name, kind, updated_at_ms) VALUES (?,?,?,?)"
  );
  for (const ex of exportsList) {
    ins.run([relPath, ex.name, ex.kind, now]);
  }
  ins.free();
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

module.exports = {
  graphDbPath,
  loadDb,
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
};
