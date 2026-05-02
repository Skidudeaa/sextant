const fs = require("fs");
const path = require("path");
const {
  detectProjectScope,
  vendoredPathsToIgnoreGlobs,
} = require("./project-scope");

// WHY: Unified repo config — was duplicated in bin/intel.js and watch.js.
// The watch.js copy was missing .claude/** from ignore, causing divergence.
//
// Vendored-detection extension (2026-05): loadRepoConfig now also runs
// detectProjectScope() against the working tree and merges the detected
// vendored subtrees into the ignore list. This prevents nested git clones,
// unpacked tarballs, and conventional vendor dirs from polluting the
// dependency graph and skewing hotspot/entry-point detection.
//
// .gitignore extension (2026-05): when a root .gitignore exists,
// loadRepoConfig builds an `ignore`-package-backed filter that the scan
// loop and watcher apply on top of the static glob ignore list. The
// `ignore` package gives us correct gitignore semantics (anchored
// patterns, negations, escape sequences) without our having to translate
// gitignore lines into fast-glob patterns. Default-on, opt-out via
// `.codebase-intel.json:gitignoreHonoring: false`.
//
// User overrides via `.codebase-intel.json`:
//   - "vendoredDetection": false       — disables auto-detection entirely
//   - "vendored": ["dir1", "dir2", …]  — explicit additions (always honored)
//   - "gitignoreHonoring": false       — disables .gitignore filtering
function loadRepoConfig(root) {
  const p = root ? path.join(root, ".codebase-intel.json") : null;
  const defaults = {
    globs: [
      // JavaScript / TypeScript
      "src/**/*.{ts,tsx,js,jsx,mjs,cjs}",
      "lib/**/*.{ts,tsx,js,jsx,mjs,cjs}",
      "app/**/*.{ts,tsx,js,jsx,mjs,cjs}",
      // Python
      "**/*.py",
      // Swift (v1: repo-local source orientation only — see docs/swift-v1-scope.md)
      "**/*.swift",
    ],
    ignore: [
      "**/node_modules/**",
      "**/.git/**",
      "**/.planning/**",
      "**/.claude/**",
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      // Python
      "**/__pycache__/**",
      "**/.venv/**",
      "**/venv/**",
      "**/.tox/**",
      "**/site-packages/**",
    ],
    summaryEverySec: 5,
  };

  let userCfg = null;
  if (p && fs.existsSync(p)) {
    try { userCfg = JSON.parse(fs.readFileSync(p, "utf8")); } catch { userCfg = null; }
  }

  const baseGlobs = userCfg?.globs?.length ? userCfg.globs : defaults.globs;
  const baseIgnore = userCfg?.ignore?.length ? userCfg.ignore : defaults.ignore;
  const summaryEverySec = Number.isFinite(userCfg?.summaryEverySec)
    ? userCfg.summaryEverySec
    : defaults.summaryEverySec;

  const detectionEnabled = userCfg?.vendoredDetection !== false;
  const userVendoredList = Array.isArray(userCfg?.vendored) ? userCfg.vendored : [];

  let autoSignals = [];
  if (detectionEnabled && root) {
    try { autoSignals = detectProjectScope(root).signals; } catch { autoSignals = []; }
  }

  const userSignals = userVendoredList
    .filter((p) => typeof p === "string" && p.length > 0)
    .map((p) => ({ path: p, reason: "user-config" }));

  // Dedupe by path; auto-detected entries win first since their reason is
  // the more informative one.
  const seen = new Set();
  const vendoredSignals = [];
  for (const s of [...autoSignals, ...userSignals]) {
    if (seen.has(s.path)) continue;
    seen.add(s.path);
    vendoredSignals.push(s);
  }

  const vendoredIgnoreGlobs = vendoredPathsToIgnoreGlobs(
    vendoredSignals.map((s) => s.path)
  );

  const gitignoreHonoring = userCfg?.gitignoreHonoring !== false;
  let gitignoreFilter = null;
  let gitignorePresent = false;
  if (gitignoreHonoring && root) {
    const gitignorePath = path.join(root, ".gitignore");
    try {
      if (fs.existsSync(gitignorePath)) {
        gitignorePresent = true;
        const content = fs.readFileSync(gitignorePath, "utf8");
        // Lazy-require `ignore` so installs without the dep (legacy)
        // don't crash at config load. The npm-install side ensures the
        // dep is present in modern installs; the try/catch keeps us
        // resilient if someone deletes node_modules and runs from a
        // partial state.
        const ignoreLib = require("ignore");
        const ig = ignoreLib().add(content);
        gitignoreFilter = (relPath) => {
          // The `ignore` package requires posix-style relative paths
          // without leading `./`. fast-glob already returns this shape
          // for `cwd: rootAbs`, but normalize defensively.
          if (typeof relPath !== "string" || !relPath) return false;
          const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
          if (!normalized || normalized.startsWith("..")) return false;
          return ig.ignores(normalized);
        };
      }
    } catch {
      /* fail-soft: a bad .gitignore must never break scanning */
      gitignoreFilter = null;
    }
  }

  return {
    globs: baseGlobs,
    ignore: [...baseIgnore, ...vendoredIgnoreGlobs],
    summaryEverySec,
    vendoredSignals,
    vendoredDetection: detectionEnabled,
    gitignoreHonoring,
    gitignorePresent,
    gitignoreFilter,
  };
}

module.exports = { loadRepoConfig };
