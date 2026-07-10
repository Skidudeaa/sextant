"use strict";

// WHY THIS EXISTS (2026-07-10 incident): sextant's hooks adopt process.cwd()
// as the project root. A Claude Code session launched from the user's HOME
// directory made sextant treat /Users/<name> as a repo — the auto-started
// watcher then fed the whole home directory to zoekt-index every few minutes,
// growing a 101 GB search index. The guard refuses to adopt roots that are
// almost never a project (home dir, filesystem root, /Users//home themselves)
// and — in hook contexts, where adoption is AUTOMATIC — any directory with no
// evidence it's a project at all.
//
// Two strictness levels:
//   - requireMarker: false (deliberate CLI: scan/init/…) — refuse only the
//     always-wrong roots (home, fs root, home's parent). A user deliberately
//     pointing sextant at a markerless scratch dir is allowed.
//   - requireMarker: true (hooks, watcher — anything that adopts a root
//     WITHOUT the user naming it) — additionally require a project marker.
//     A refused hook exits before intel.init, so no .planning state is ever
//     created in a refused directory.
//
// Overrides (any one wins, checked first):
//   - `--allow-unsafe-root` on the command line (pass argv)
//   - SEXTANT_ALLOW_UNSAFE_ROOT=1 in the environment
//   - `"allowUnsafeRoot": true` in <root>/.codebase-intel.json

const fs = require("fs");
const os = require("os");
const path = require("path");

// Any single hit marks the directory as a deliberate project root. Kept
// deliberately broad: a false REFUSAL (sextant silently dark in a real
// project) is worse than a false accept (an odd-but-real working dir gets
// indexed — bounded, and the home/fs-root refusals above still apply).
const PROJECT_MARKERS = [
  ".git",
  ".hg",
  ".svn",
  ".codebase-intel.json",
  "package.json",
  "deno.json",
  "tsconfig.json",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "Package.swift",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
  "mix.exs",
  "CMakeLists.txt",
  "Makefile",
];

function hasProjectMarker(root) {
  for (const m of PROJECT_MARKERS) {
    try {
      if (fs.existsSync(path.join(root, m))) return true;
    } catch {}
  }
  // A pre-existing sextant state dir means someone deliberately ran
  // `sextant init`/`scan` here (both are allowed in markerless dirs) —
  // hooks honor that. This can't self-bootstrap: a hook refused by this
  // guard exits before intel.init, so it never creates the state dir it
  // would need to pass the check next time.
  try {
    if (fs.existsSync(path.join(root, ".planning", "intel"))) return true;
  } catch {}
  return false;
}

function configAllowsUnsafeRoot(root) {
  try {
    const raw = fs.readFileSync(path.join(root, ".codebase-intel.json"), "utf8");
    return JSON.parse(raw)?.allowUnsafeRoot === true;
  } catch {
    return false;
  }
}

/**
 * @param {string} rootInput directory being adopted as a project root
 * @param {{requireMarker?: boolean, env?: object, argv?: string[]}} opts
 * @returns {{ok: true} | {ok: false, reason: string, message: string}}
 */
function checkRoot(rootInput, { requireMarker = false, env = process.env, argv = null } = {}) {
  const root = path.resolve(rootInput || ".");

  if (env && (env.SEXTANT_ALLOW_UNSAFE_ROOT === "1" || env.SEXTANT_ALLOW_UNSAFE_ROOT === "true")) {
    return { ok: true };
  }
  if (Array.isArray(argv) && argv.includes("--allow-unsafe-root")) {
    return { ok: true };
  }
  if (configAllowsUnsafeRoot(root)) {
    return { ok: true };
  }

  const refuse = (reason, what) => ({
    ok: false,
    reason,
    message:
      `refusing to index ${what} (${root}). ` +
      `Run sextant from a project directory, or override with --allow-unsafe-root / ` +
      `SEXTANT_ALLOW_UNSAFE_ROOT=1 / "allowUnsafeRoot": true in .codebase-intel.json.`,
  });

  const fsRoot = path.parse(root).root;
  if (root === fsRoot) return refuse("filesystem-root", "the filesystem root");

  // Prefer env.HOME over os.homedir(): identical in production (POSIX
  // os.homedir() reads $HOME), and it makes the guard hermetically testable
  // with an injected env.
  let home = null;
  try {
    const raw = (env && env.HOME) || os.homedir() || null;
    home = raw ? path.resolve(raw) : null;
  } catch {}
  if (home && home !== fsRoot) {
    if (root === home) return refuse("home-directory", "the home directory");
    // /Users on macOS, /home on Linux — one level of blast-radius margin.
    if (root === path.dirname(home)) return refuse("home-parent", "the home directory's parent");
  }

  if (requireMarker && !hasProjectMarker(root)) {
    return {
      ok: false,
      reason: "no-project-marker",
      message:
        `no project marker in ${root} (no .git, manifest, or .planning/intel). ` +
        `Hooks only adopt directories that look like projects — run \`sextant init\` or \`sextant scan\` here to opt in.`,
    };
  }

  return { ok: true };
}

module.exports = { checkRoot, hasProjectMarker, PROJECT_MARKERS };
