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

const dbByRoot = new Map(); // rootAbs -> SQL.Database

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
  `);
}

async function loadDb(root) {
  const rootAbs = path.resolve(root);
  if (dbByRoot.has(rootAbs)) return dbByRoot.get(rootAbs);

  const SQL = await loadSqlJs();
  const p = graphDbPath(rootAbs);

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
  dbByRoot.set(rootAbs, db);
  return db;
}

async function persistDb(root) {
  const rootAbs = path.resolve(root);
  const db = await loadDb(rootAbs);
  const p = graphDbPath(rootAbs);
  const bytes = db.export(); // Uint8Array
  // WHY: Atomic write prevents corrupt graph.db from partial writes during crash.
  // Same tmp+rename pattern used for index.json and summary.md.
  const tmp = p + ".tmp";
  await fs.promises.writeFile(tmp, Buffer.from(bytes));
  await fs.promises.rename(tmp, p);
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
function findExportsBySymbol(db, symbolName) {
  const out = [];
  // Exact match (case-insensitive) on the export name.
  const stmt = db.prepare(
    "SELECT path, name, kind FROM exports WHERE LOWER(name) = LOWER(?) ORDER BY kind, path"
  );
  stmt.bind([symbolName]);
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
};
