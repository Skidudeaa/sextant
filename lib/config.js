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
// User overrides via `.codebase-intel.json`:
//   - "vendoredDetection": false       — disables auto-detection entirely
//   - "vendored": ["dir1", "dir2", …]  — explicit additions (always honored)
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

  return {
    globs: baseGlobs,
    ignore: [...baseIgnore, ...vendoredIgnoreGlobs],
    summaryEverySec,
    vendoredSignals,
    vendoredDetection: detectionEnabled,
  };
}

module.exports = { loadRepoConfig };
