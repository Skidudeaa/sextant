const fs = require("fs");
const path = require("path");
const fg = require("fast-glob");

// WHY this module exists: sextant's default globs used to scope JS/TS to
// `src/`, `lib/`, `app/` while Python/Swift matched the whole tree. A repo
// with a flat layout, a monorepo (`packages/*`), or any other top-level dir
// silently indexed ZERO files and then reported a vacuously-green
// "100% resolution, 0 files" summary — the exact opposite of the
// "degrade don't guess / drift must be loud" philosophy. The default is now
// broad (see lib/config.js), but a user with custom globs can still narrow
// themselves into the same hole, and unsupported-language repos genuinely
// can't be indexed. This module turns "indexed nothing" from a silent
// non-event into a loud, actionable diagnosis, shared by every surface that
// reports coverage (scan output, summary ALERT, doctor).

// Extensions sextant has extractors for. Probing for these tells us whether
// a repo contains indexable source that the *configured* globs failed to
// match — which distinguishes "your globs are wrong" from "this language
// isn't supported".
const SUPPORTED_EXT_GLOB = "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,py,swift}";

// Build-system signals for languages sextant has NO extractor for. JS/TS,
// Python, and Swift are supported and intentionally absent from this list —
// listing Package.swift here (as an earlier version did) wrongly told Swift
// package authors their language was unsupported.
const UNSUPPORTED_LANG_SIGNALS = [
  ["go.mod", "Go (go.mod)"],
  ["Cargo.toml", "Rust (Cargo.toml)"],
  ["pom.xml", "Java (pom.xml)"],
  ["build.gradle", "Java/Kotlin (build.gradle)"],
  ["build.gradle.kts", "Kotlin (build.gradle.kts)"],
  ["Gemfile", "Ruby (Gemfile)"],
  ["composer.json", "PHP (composer.json)"],
  ["mix.exs", "Elixir (mix.exs)"],
  ["*.csproj", "C# (.csproj)"],
];

// The recommended broad config we point users at when their globs are too
// narrow. Kept in one place so the scan output, doctor, and any docs stay
// in sync.
const SUGGESTED_GLOBS = [
  "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
  "**/*.py",
  "**/*.swift",
];

function detectUnsupportedLanguageSignals(rootAbs) {
  const hits = [];
  for (const [rel, label] of UNSUPPORTED_LANG_SIGNALS) {
    if (rel.includes("*")) {
      // Cheap top-level glob check (no recursion) for wildcard signals.
      try {
        const re = new RegExp("^" + rel.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
        if (fs.readdirSync(rootAbs).some((f) => re.test(f))) hits.push(label);
      } catch {}
    } else if (fs.existsSync(path.join(rootAbs, rel))) {
      hits.push(label);
    }
  }
  return hits;
}

// Does the glob list already cover JS/TS across the whole tree? When it does,
// no JS/TS narrowing is possible, so the (extra full-tree walk) partial-
// coverage probe is skipped. The zero-match probe still runs regardless —
// it's rare and high-value.
//
// "Broad" requires the glob to be a pure `**/<file-pattern>` — no further `/`
// after the prefix. A deep-constrained glob like `**/templates/*.ts` starts
// with `**/` too, but is narrow; treating it as broad would silently skip the
// partial-coverage probe for exactly the configs that need it. The inverse
// (a genuinely broad `**/src/**/*.ts` counted not-broad) only costs one extra
// probe walk — it can't produce a false warning, since a truly-covering glob
// keeps indexedTotal/supportedAvailable above the threshold.
function hasBroadJsTsGlob(globs) {
  const list = Array.isArray(globs) ? globs : [globs];
  return list.some(
    (g) =>
      typeof g === "string" &&
      /^\*\*\/[^/]+$/.test(g) &&
      /\b(js|ts)\b/.test(g)
  );
}

async function probeSupportedFileCount(rootAbs, { ignore, gitignoreFilter }) {
  let matches = await fg(SUPPORTED_EXT_GLOB, {
    cwd: rootAbs,
    onlyFiles: true,
    unique: true,
    dot: false,
    followSymbolicLinks: false,
    ignore: Array.isArray(ignore) ? ignore : [],
  });
  if (typeof gitignoreFilter === "function") {
    matches = matches.filter((m) => !gitignoreFilter(m));
  }
  return matches.length;
}

function suggestedConfigSnippet() {
  return (
    "Add a .codebase-intel.json at the repo root:\n" +
    JSON.stringify({ globs: SUGGESTED_GLOBS }, null, 2) +
    "\nthen run: sextant scan --force"
  );
}

// The single source of truth for "is sextant actually seeing this repo's
// code?". `indexedTotal` is the number of files in the graph after the scan.
// Returns { kind, message, fix, supportedAvailable, unsupported }.
//   kind: "ok" | "globs-too-narrow" | "unsupported-language" | "empty-repo"
async function diagnoseScanCoverage({ rootAbs, globs, ignore, gitignoreFilter, indexedTotal }) {
  const unsupported = detectUnsupportedLanguageSignals(rootAbs);

  if (indexedTotal === 0) {
    const supportedAvailable = await probeSupportedFileCount(rootAbs, {
      ignore,
      gitignoreFilter,
    });
    if (supportedAvailable > 0) {
      return {
        kind: "globs-too-narrow",
        supportedAvailable,
        unsupported,
        message:
          `Indexed 0 files, but found ${supportedAvailable} supported source file(s) ` +
          `(JS/TS/Python/Swift) in this tree — your code lives outside the configured globs.`,
        fix: suggestedConfigSnippet(),
      };
    }
    if (unsupported.length > 0) {
      return {
        kind: "unsupported-language",
        supportedAvailable,
        unsupported,
        message:
          `Indexed 0 files. Detected ${unsupported.join(", ")} — sextant only extracts ` +
          `JS/TS, Python, and Swift, so this repo can't be indexed.`,
        fix: null,
      };
    }
    return {
      kind: "empty-repo",
      supportedAvailable,
      unsupported,
      message:
        "Indexed 0 files and found no JS/TS/Python/Swift sources here " +
        "(the tree may be empty or everything is git-ignored).",
      fix: null,
    };
  }

  // Partial coverage: a large fraction of indexable source sits outside the
  // configured globs. Only worth probing when JS/TS isn't already broad —
  // otherwise we'd double-walk the tree on every scan for no possible signal.
  if (!hasBroadJsTsGlob(globs)) {
    const supportedAvailable = await probeSupportedFileCount(rootAbs, {
      ignore,
      gitignoreFilter,
    });
    const gap = supportedAvailable - indexedTotal;
    if (supportedAvailable > 0 && gap >= 25 && indexedTotal / supportedAvailable < 0.5) {
      return {
        kind: "globs-too-narrow",
        supportedAvailable,
        unsupported,
        message:
          `Indexed ${indexedTotal} file(s), but ${supportedAvailable} supported source ` +
          `file(s) exist in this tree — ${gap} indexable file(s) are outside your globs.`,
        fix: suggestedConfigSnippet(),
      };
    }
    return { kind: "ok", supportedAvailable, unsupported, message: null, fix: null };
  }

  return { kind: "ok", supportedAvailable: null, unsupported, message: null, fix: null };
}

module.exports = {
  diagnoseScanCoverage,
  detectUnsupportedLanguageSignals,
  hasBroadJsTsGlob,
  probeSupportedFileCount,
  suggestedConfigSnippet,
  SUPPORTED_EXT_GLOB,
  SUGGESTED_GLOBS,
};
