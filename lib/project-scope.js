/**
 * Project scope detection — separate "the project" from vendored subtrees.
 *
 * WHY: sextant's value prop is honest, health-aware orientation. When a working
 * tree contains vendored subtrees (nested git clones, unpacked tarballs,
 * conventional vendor/ dirs), indexing them as if they were part of the
 * project pollutes hotspot/entry-point detection and produces confidently-
 * wrong summaries. This module detects vendored subtrees at depth=1 using
 * three strong signals — any one is sufficient to mark the subtree as
 * vendored. Weaker signals (e.g. "different manifest in subdir") would catch
 * more cases but false-positive on polyglot monorepos, so v1 stays
 * conservative and gives users an explicit escape hatch via
 * `.codebase-intel.json` (the `vendored` array adds entries; the
 * `vendoredDetection: false` flag disables auto-detection entirely).
 *
 * TRADEOFF: depth=1 only. A deeper vendored dir (e.g. `Sources/ThirdParty/foo/`)
 * won't be auto-detected; users can list it in `.codebase-intel.json:vendored`.
 * Going deeper risks false positives in nested project structures (workspaces,
 * Swift package targets, etc.) and was not seen in the dogfooding feedback.
 */

const fs = require("fs");
const path = require("path");

// Conventional vendor directory names. Case-sensitive (Linux/macOS).
const VENDORED_DIR_NAMES = new Set([
  "vendor",
  "vendored",
  "third_party",
  "third-party",
  "external",
  "Pods",            // CocoaPods (iOS)
  "Carthage",        // Carthage (iOS)
  "bower_components",
  "deps",            // common Erlang/Elixir + a few JS projects
]);

// GitHub-tarball-extract naming: <owner>-<repo>-<short-hash>.
// Examples that should match:
//   - mbadolato-iTerm2-Color-Schemes-f279991
//   - facebook-react-abc1234
//   - paul-gauthier-aider-deadbeef
// Conservative: requires at least 6 hex chars trailing, owner+repo separated by dash.
const TARBALL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.]*(?:-[A-Za-z0-9_.]+)+-[a-f0-9]{6,40}$/;

// Strong signals — any single match is sufficient to mark vendored.
//
// We deliberately do NOT use "subdir has a different manifest from root" as a
// signal here, because that pattern legitimately appears in polyglot
// monorepos (e.g. JS root with a Python service). Users hit by that case can
// add to `.codebase-intel.json:vendored` explicitly.
function detectVendorSignal(rootAbs, relSubdir) {
  const abs = path.join(rootAbs, relSubdir);
  const baseName = path.basename(relSubdir);

  // 1. Nested .git/ directory → almost certainly a separate repo.
  //    We require it be a directory (not a worktree gitdir file pointing
  //    elsewhere — those are part of a parent repo's worktree machinery and
  //    shouldn't fire this signal).
  const gitPath = path.join(abs, ".git");
  try {
    const st = fs.statSync(gitPath);
    if (st.isDirectory()) {
      // Sanity check: real .git/ has HEAD or refs/.
      if (
        fs.existsSync(path.join(gitPath, "HEAD")) ||
        fs.existsSync(path.join(gitPath, "refs"))
      ) {
        return { reason: "nested-git-repo" };
      }
    }
  } catch {
    /* no .git/ here */
  }

  // 2. Conventionally named vendor directory.
  if (VENDORED_DIR_NAMES.has(baseName)) {
    return { reason: "vendor-dirname" };
  }

  // 3. GitHub-tarball-extract naming pattern.
  if (TARBALL_NAME_RE.test(baseName)) {
    return { reason: "tarball-name" };
  }

  return null;
}

/**
 * Walk root immediate subdirs (depth=1) and collect vendored signals.
 *
 * @param {string} rootAbs - Absolute path to the project root.
 * @returns {{ vendoredPaths: string[], signals: Array<{path: string, reason: string}> }}
 *   - vendoredPaths: relative posix paths suitable for ignore-glob conversion.
 *   - signals: same paths with the detection reason for each (used by summary header).
 */
function detectProjectScope(rootAbs) {
  let entries;
  try {
    entries = fs.readdirSync(rootAbs, { withFileTypes: true });
  } catch {
    return { vendoredPaths: [], signals: [] };
  }

  const signals = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const name = ent.name;

    // Skip dot-dirs (already handled by isIndexable's blacklist) and the
    // hardcoded build-output dirs to avoid double-counting.
    if (name.startsWith(".")) continue;
    if (name === "node_modules" || name === "dist" || name === "build") continue;

    const sig = detectVendorSignal(rootAbs, name);
    if (sig) {
      signals.push({ path: name, reason: sig.reason });
    }
  }

  // Stable ordering for deterministic summaries.
  signals.sort((a, b) => a.path.localeCompare(b.path));

  return {
    vendoredPaths: signals.map((s) => s.path),
    signals,
  };
}

/**
 * Convert vendored relative paths to fast-glob ignore patterns.
 *
 * `mcp-servers-repo` → `**\/mcp-servers-repo/**`
 *
 * WHY use `**\/X/**` (not `X/**`): fast-glob matches the relative path of each
 * file from the root. `mcp-servers-repo/...` is the path; `mcp-servers-repo/**`
 * works for a top-level dir but `**\/mcp-servers-repo/**` is robust whether
 * the dir is at root or nested (defensive — depth=1 today, future-proof).
 */
function vendoredPathsToIgnoreGlobs(vendoredPaths) {
  return vendoredPaths.map((p) => `**/${p}/**`);
}

module.exports = {
  detectProjectScope,
  detectVendorSignal,
  vendoredPathsToIgnoreGlobs,
  // Exported for testing.
  TARBALL_NAME_RE,
  VENDORED_DIR_NAMES,
};
