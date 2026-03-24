const fs = require("fs");
const path = require("path");

const fg = require("fast-glob");

const { normalizeRelPath, posixify } = require("./utils");

const cacheByRoot = new Map();

function getMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function C(root) {
  const r = path.resolve(root);
  if (!cacheByRoot.has(r)) {
    cacheByRoot.set(r, {
      tsconfigLoaded: false,
      tsconfig: null,
      tsconfigPath: null,       // which file was loaded (for mtime check)
      tsconfigMtimeMs: null,    // mtime when loaded
      workspaceLoaded: false,
      workspacePkgs: new Map(), // name -> { dirAbs, pkg }
      workspaceMtimeMs: null,   // mtime of root package.json when loaded
    });
  }
  return cacheByRoot.get(r);
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function resolveExtendsPath(configDir, ext) {
  if (!ext || typeof ext !== "string") return null;
  // Package-based extends (e.g. "@tsconfig/node20/tsconfig.json") are ignored.
  if (!ext.startsWith(".") && !ext.startsWith("/")) return null;

  const withJson = ext.endsWith(".json") ? ext : `${ext}.json`;
  const p = path.resolve(configDir, withJson);
  return fs.existsSync(p) ? p : null;
}

function mergeCompilerOptions(base, derived) {
  const b = base && typeof base === "object" ? base : {};
  const d = derived && typeof derived === "object" ? derived : {};
  const out = { ...b, ...d };

  const bPaths = b.paths && typeof b.paths === "object" ? b.paths : null;
  const dPaths = d.paths && typeof d.paths === "object" ? d.paths : null;
  if (bPaths || dPaths) out.paths = { ...(bPaths || {}), ...(dPaths || {}) };

  return out;
}

function loadTsConfigFile(p, depth = 0) {
  if (!p || depth > 4) return null;
  const cfg = readJson(p);
  if (!cfg || typeof cfg !== "object") return null;

  const dir = path.dirname(p);
  let base = null;
  const extPath = resolveExtendsPath(dir, cfg.extends);
  if (extPath) base = loadTsConfigFile(extPath, depth + 1);

  const baseCO = base?.compilerOptions;
  const cfgCO = cfg.compilerOptions;
  const compilerOptions = mergeCompilerOptions(baseCO, cfgCO);
  return { dir, compilerOptions };
}

function loadTsConfig(root) {
  const st = C(root);

  // Mtime-based invalidation: if the cached tsconfig file changed, reload
  if (st.tsconfigLoaded && st.tsconfigPath) {
    const currentMtime = getMtimeMs(st.tsconfigPath);
    if (currentMtime !== st.tsconfigMtimeMs) {
      st.tsconfigLoaded = false;
      st.tsconfig = null;
      st.tsconfigPath = null;
      st.tsconfigMtimeMs = null;
    }
  }

  if (st.tsconfigLoaded) return st.tsconfig;
  st.tsconfigLoaded = true;

  const r = path.resolve(root);
  const candidates = [
    path.join(r, "tsconfig.json"),
    path.join(r, "tsconfig.base.json"),
    path.join(r, "jsconfig.json"),
  ];

  let loaded = null;
  let loadedPath = null;
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    loaded = loadTsConfigFile(p);
    if (loaded) { loadedPath = p; break; }
  }
  if (!loaded) {
    st.tsconfig = null;
    return null;
  }

  // Track which file was loaded and its mtime for invalidation
  st.tsconfigPath = loadedPath;
  st.tsconfigMtimeMs = getMtimeMs(loadedPath);

  const baseUrlRel = loaded.compilerOptions?.baseUrl;
  const baseUrlAbs =
    typeof baseUrlRel === "string" ? path.resolve(loaded.dir, baseUrlRel) : loaded.dir;

  const pathsMap =
    loaded.compilerOptions?.paths && typeof loaded.compilerOptions.paths === "object"
      ? loaded.compilerOptions.paths
      : null;

  st.tsconfig = {
    baseUrlAbs,
    paths: pathsMap || {},
  };
  return st.tsconfig;
}

function loadWorkspacePackages(root) {
  const st = C(root);

  // Mtime-based invalidation: if the root package.json changed, reload
  if (st.workspaceLoaded) {
    const r = path.resolve(root);
    const rootPkgPath = path.join(r, "package.json");
    const currentMtime = getMtimeMs(rootPkgPath);
    if (currentMtime !== st.workspaceMtimeMs) {
      st.workspaceLoaded = false;
      st.workspacePkgs = new Map();
      st.workspaceMtimeMs = null;
    }
  }

  if (st.workspaceLoaded) return st.workspacePkgs;
  st.workspaceLoaded = true;

  const r = path.resolve(root);
  const rootPkgPath = path.join(r, "package.json");
  if (!fs.existsSync(rootPkgPath)) return st.workspacePkgs;

  // Track mtime for invalidation
  st.workspaceMtimeMs = getMtimeMs(rootPkgPath);

  const pkg = readJson(rootPkgPath);
  if (!pkg || typeof pkg !== "object") return st.workspacePkgs;

  const ws = pkg.workspaces;
  let globs = [];
  if (Array.isArray(ws)) globs = ws;
  else if (ws && typeof ws === "object" && Array.isArray(ws.packages)) globs = ws.packages;

  if (!globs.length) return st.workspacePkgs;

  const pkgJsonPaths = fg.sync(
    globs.map((g) => posixify(path.join(g, "package.json"))),
    {
      cwd: r,
      onlyFiles: true,
      unique: true,
      dot: false,
      followSymbolicLinks: false,
      ignore: ["**/node_modules/**", "**/.git/**", "**/.planning/**"],
    }
  );

  for (const rel of pkgJsonPaths) {
    const abs = path.join(r, rel);
    const subPkg = readJson(abs);
    const name = subPkg?.name;
    if (typeof name !== "string" || !name.trim()) continue;
    st.workspacePkgs.set(name, { dirAbs: path.dirname(abs), pkg: subPkg });
  }

  return st.workspacePkgs;
}

const EXT_ORDER = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const PY_EXT_ORDER = [".py"];

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function resolveFileAbs(baseAbs) {
  const hasExt = path.extname(baseAbs) !== "";

  if (hasExt) return isFile(baseAbs) ? baseAbs : null;
  if (isFile(baseAbs)) return baseAbs;

  for (const ext of EXT_ORDER) {
    const p = `${baseAbs}${ext}`;
    if (isFile(p)) return p;
  }

  if (isDir(baseAbs)) {
    for (const ext of EXT_ORDER) {
      const p = path.join(baseAbs, `index${ext}`);
      if (isFile(p)) return p;
    }
  }

  return null;
}

function specIsAssetLike(spec) {
  const s = String(spec);
  if (s.includes("?") || s.includes("#")) return true;
  return /\.(css|scss|sass|less|styl|png|jpe?g|gif|webp|svg|ico|bmp|tiff|woff2?|ttf|otf|eot|mp4|webm|mov|mp3|wav)$/.test(
    s
  );
}

function tryTsconfigPaths(rootAbs, specifier) {
  const ts = loadTsConfig(rootAbs);
  if (!ts) return null;

  const entries = Object.entries(ts.paths || {});
  for (const [pattern, targets] of entries) {
    const list = Array.isArray(targets) ? targets : [];
    if (!list.length) continue;

    if (!pattern.includes("*")) {
      if (specifier !== pattern) continue;
      for (const target of list) {
        const absBase = path.resolve(ts.baseUrlAbs, target);
        const resolvedAbs = resolveFileAbs(absBase);
        if (!resolvedAbs) continue;
        const rel = normalizeRelPath(path.relative(rootAbs, resolvedAbs));
        if (!rel.startsWith("..")) return rel;
      }
      continue;
    }

    const re = new RegExp(
      "^" +
        pattern
          .split("*")
          .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("(.+)") +
        "$"
    );
    const m = specifier.match(re);
    if (!m) continue;
    const star = m[1] || "";

    for (const target of list) {
      const t = String(target).replace("*", star);
      const absBase = path.resolve(ts.baseUrlAbs, t);
      const resolvedAbs = resolveFileAbs(absBase);
      if (!resolvedAbs) continue;
      const rel = normalizeRelPath(path.relative(rootAbs, resolvedAbs));
      if (!rel.startsWith("..")) return rel;
    }
  }

  return null;
}

function pkgNameFromSpecifier(spec) {
  const s = String(spec);
  if (s.startsWith("@")) {
    const parts = s.split("/");
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    return s;
  }
  return s.split("/")[0];
}

function tryWorkspacePackage(rootAbs, specifier) {
  const pkgs = loadWorkspacePackages(rootAbs);
  if (!pkgs || pkgs.size === 0) return null;

  const name = pkgNameFromSpecifier(specifier);
  const entry = pkgs.get(name);
  if (!entry) return null;

  const subpath = specifier.slice(name.length).replace(/^\/+/, "");
  const baseDir = entry.dirAbs;

  if (!subpath) {
    const pkg = entry.pkg || {};
    const candidates = [
      pkg.module,
      pkg.main,
      pkg.types,
      "src/index.ts",
      "src/index.tsx",
      "src/index.js",
      "index.ts",
      "index.js",
    ].filter((x) => typeof x === "string" && x);

    for (const c of candidates) {
      const absBase = path.resolve(baseDir, c);
      const resolvedAbs = resolveFileAbs(absBase);
      if (!resolvedAbs) continue;
      const rel = normalizeRelPath(path.relative(rootAbs, resolvedAbs));
      if (!rel.startsWith("..")) return rel;
    }
    return null;
  }

  const absBase = path.resolve(baseDir, subpath);
  const resolvedAbs = resolveFileAbs(absBase);
  if (!resolvedAbs) return null;
  const rel = normalizeRelPath(path.relative(rootAbs, resolvedAbs));
  return rel.startsWith("..") ? null : rel;
}

/**
 * Resolve a Python import specifier to a file path.
 * 
 * Python relative imports use dots for levels:
 *   .utils     → same package (1 dot = from current dir)
 *   ..core     → parent package (2 dots = parent dir)
 *   ...foo.bar → grandparent package
 */
function resolvePythonImport(rootAbs, fromRel, specifier) {
  const raw = String(specifier);
  if (!raw) return { specifier: raw, resolved: null, kind: "unresolved" };

  // Count leading dots for relative imports
  let level = 0;
  while (raw[level] === ".") level++;

  const module = raw.slice(level); // e.g., "utils" from ".utils"

  if (level === 0) {
    // Absolute import - check if it's a local top-level package
    const topPkg = module.split(".")[0];
    const topPkgDir = path.join(rootAbs, topPkg);
    const topPkgInit = path.join(topPkgDir, "__init__.py");
    const topPkgFile = path.join(rootAbs, `${topPkg}.py`);

    // If there's a local package/module with this name, resolve it
    if (isDir(topPkgDir) && isFile(topPkgInit)) {
      // It's a local package, resolve the full path
      const parts = module.split(".");
      let absBase = rootAbs;
      for (const part of parts) {
        absBase = path.join(absBase, part);
      }
      const resolved = resolvePythonFile(absBase);
      if (resolved) {
        const rel = normalizeRelPath(path.relative(rootAbs, resolved));
        if (!rel.startsWith("..")) return { specifier: raw, resolved: rel, kind: "local" };
      }
    } else if (isFile(topPkgFile)) {
      // It's a single-file module at root
      const rel = normalizeRelPath(path.relative(rootAbs, topPkgFile));
      return { specifier: raw, resolved: rel, kind: "local" };
    }

    // External package (stdlib or third-party)
    return { specifier: raw, resolved: null, kind: "external" };
  }

  // Relative import: navigate up `level` directories from current file's package
  const fromDir = path.dirname(path.join(rootAbs, fromRel));
  let baseDir = fromDir;

  // Go up (level - 1) directories (first dot means "current package")
  for (let i = 1; i < level; i++) {
    baseDir = path.dirname(baseDir);
  }

  if (!module) {
    // "from . import x" or "from .. import x" - imports from __init__.py
    const initFile = path.join(baseDir, "__init__.py");
    if (isFile(initFile)) {
      const rel = normalizeRelPath(path.relative(rootAbs, initFile));
      if (!rel.startsWith("..")) return { specifier: raw, resolved: rel, kind: "relative" };
    }
    return { specifier: raw, resolved: null, kind: "unresolved" };
  }

  // Resolve the module path
  const parts = module.split(".");
  let absBase = baseDir;
  for (const part of parts) {
    absBase = path.join(absBase, part);
  }

  const resolved = resolvePythonFile(absBase);
  if (resolved) {
    const rel = normalizeRelPath(path.relative(rootAbs, resolved));
    if (!rel.startsWith("..")) return { specifier: raw, resolved: rel, kind: "relative" };
  }

  return { specifier: raw, resolved: null, kind: "unresolved" };
}

/**
 * Resolve a Python file path (try .py extension, then package __init__.py)
 */
function resolvePythonFile(absBase) {
  // Try as a module file: foo.py
  const pyFile = `${absBase}.py`;
  if (isFile(pyFile)) return pyFile;

  // Try as a package: foo/__init__.py
  const initFile = path.join(absBase, "__init__.py");
  if (isFile(initFile)) return initFile;

  // Try exact path (if already has extension)
  if (isFile(absBase)) return absBase;

  return null;
}

function isPythonFile(relPath) {
  return path.extname(relPath).toLowerCase() === ".py";
}

function resolveImport(root, fromRelPath, specifier) {
  const rootAbs = path.resolve(root);
  const fromRel = normalizeRelPath(fromRelPath);
  const raw = String(specifier);

  if (!raw) return { specifier: raw, resolved: null, kind: "unresolved" };

  // Dispatch Python files to Python resolver
  if (isPythonFile(fromRel)) {
    return resolvePythonImport(rootAbs, fromRel, raw);
  }

  if (raw.startsWith("node:")) return { specifier: raw, resolved: null, kind: "external" };

  // Vite/RSC style suffixes: keep raw for reporting but resolve against cleaned.
  const cleaned = raw.split(/[?#]/)[0];

  if (specIsAssetLike(raw)) {
    // If it's an asset but also happens to resolve to a local file, we still record it.
    const absTry = path.resolve(rootAbs, path.dirname(fromRel), cleaned);
    const resolvedAbs = resolveFileAbs(absTry);
    if (resolvedAbs) {
      const rel = normalizeRelPath(path.relative(rootAbs, resolvedAbs));
      if (!rel.startsWith("..")) return { specifier: raw, resolved: rel, kind: "asset" };
    }
    return { specifier: raw, resolved: null, kind: "asset" };
  }

  if (cleaned.startsWith(".")) {
    const absBase = path.resolve(rootAbs, path.dirname(fromRel), cleaned);
    const resolvedAbs = resolveFileAbs(absBase);
    if (!resolvedAbs) return { specifier: raw, resolved: null, kind: "unresolved" };
    const rel = normalizeRelPath(path.relative(rootAbs, resolvedAbs));
    return rel.startsWith("..")
      ? { specifier: raw, resolved: null, kind: "unresolved" }
      : { specifier: raw, resolved: rel, kind: "relative" };
  }

  if (cleaned.startsWith("/")) {
    const absBase = path.resolve(rootAbs, cleaned.slice(1));
    const resolvedAbs = resolveFileAbs(absBase);
    if (!resolvedAbs) return { specifier: raw, resolved: null, kind: "unresolved" };
    const rel = normalizeRelPath(path.relative(rootAbs, resolvedAbs));
    return rel.startsWith("..")
      ? { specifier: raw, resolved: null, kind: "unresolved" }
      : { specifier: raw, resolved: rel, kind: "root" };
  }

  const viaPaths = tryTsconfigPaths(rootAbs, cleaned);
  if (viaPaths) return { specifier: raw, resolved: viaPaths, kind: "tsconfig" };

  const viaWs = tryWorkspacePackage(rootAbs, cleaned);
  if (viaWs) return { specifier: raw, resolved: viaWs, kind: "workspace" };

  return { specifier: raw, resolved: null, kind: "external" };
}

function clearCaches(root) {
  if (root) {
    cacheByRoot.delete(path.resolve(root));
  } else {
    cacheByRoot.clear();
  }
}

module.exports = {
  resolveImport,
  clearCaches,
  // exported for testing/debugging
  _loadTsConfig: loadTsConfig,
  _loadWorkspacePackages: loadWorkspacePackages,
};

