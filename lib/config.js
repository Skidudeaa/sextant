const fs = require("fs");
const path = require("path");

// WHY: Unified repo config — was duplicated in bin/intel.js and watch.js.
// The watch.js copy was missing .claude/** from ignore, causing divergence.
function loadRepoConfig(root) {
  const p = path.join(root, ".codebase-intel.json");
  const defaults = {
    globs: [
      // JavaScript / TypeScript
      "src/**/*.{ts,tsx,js,jsx,mjs,cjs}",
      "lib/**/*.{ts,tsx,js,jsx,mjs,cjs}",
      "app/**/*.{ts,tsx,js,jsx,mjs,cjs}",
      // Python
      "**/*.py",
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

  if (!fs.existsSync(p)) return defaults;
  try {
    const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
    return {
      globs: cfg.globs?.length ? cfg.globs : defaults.globs,
      ignore: cfg.ignore?.length ? cfg.ignore : defaults.ignore,
      summaryEverySec: Number.isFinite(cfg.summaryEverySec)
        ? cfg.summaryEverySec
        : defaults.summaryEverySec,
    };
  } catch {
    return defaults;
  }
}

module.exports = { loadRepoConfig };
