const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { isEntryPoint } = require("./utils");
const { getGitInfo } = require("./git");

// NOTE: This module generates a static aggregate summary (file counts, resolution %,
// fan-in hotspots, module types). It does NOT use the retrieval pipeline
// (lib/retrieve.js, lib/scoring.js) — no export-graph lookup, no re-export chain
// tracing, no definition-site priority, no query-aware ranking. The only graph query
// is mostDependedOn() for the hotspot list. Everything else is rolled-up statistics
// that rarely change even when the watcher updates graph.db continuously.
//
// CONTEXT: The UserPromptSubmit hook (commands/hook-refresh.js) now uses
// graph-retrieve.js and zoekt.searchFast() for query-aware injection on code-relevant
// prompts. This summary module remains the static fallback — it's injected at session
// start and when the classifier determines a prompt doesn't warrant search.

function readJsonIfExists(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// WHY: Mirrors build-system detection in detectSignals() but specifically
// flags languages that have NO sextant extractor today. Used to emit a
// loud ALERT so users don't get a vacuously-green "100% resolution, 0
// files" summary when their repo is e.g. Go or Rust.
function detectUnsupportedLanguageSignals(rootAbs) {
  const hits = [];
  const check = (rel, label) => {
    if (fs.existsSync(path.join(rootAbs, rel))) hits.push(label);
  };
  check("go.mod", "Go (go.mod)");
  check("Cargo.toml", "Rust (Cargo.toml)");
  check("pom.xml", "Java (pom.xml)");
  check("build.gradle", "Java/Kotlin (build.gradle)");
  check("build.gradle.kts", "Kotlin (build.gradle.kts)");
  check("Gemfile", "Ruby (Gemfile)");
  check("composer.json", "PHP (composer.json)");
  check("Package.swift", "Swift (Package.swift)");
  check("mix.exs", "Elixir (mix.exs)");
  check("Cargo.lock", "Rust (Cargo.lock)");
  return hits;
}

function detectSignals(rootAbs) {
  const signals = [];
  const pkg = readJsonIfExists(path.join(rootAbs, "package.json"));

  if (pkg) {
    signals.push("Node: package.json");
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (deps.next) signals.push("Framework: Next.js");
    else if (deps["react-scripts"]) signals.push("Framework: Create React App");
    else if (deps.vite) signals.push("Tooling: Vite");
    else if (deps["@angular/core"]) signals.push("Framework: Angular");
    else if (deps.vue) signals.push("Framework: Vue");
    else if (deps.svelte) signals.push("Framework: Svelte");
  }

  if (fs.existsSync(path.join(rootAbs, "pyproject.toml"))) signals.push("Python: pyproject.toml");
  else if (fs.existsSync(path.join(rootAbs, "requirements.txt")))
    signals.push("Python: requirements.txt");

  if (fs.existsSync(path.join(rootAbs, "go.mod"))) signals.push("Go: go.mod");
  if (fs.existsSync(path.join(rootAbs, "Cargo.toml"))) signals.push("Rust: Cargo.toml");
  if (fs.existsSync(path.join(rootAbs, "Package.swift"))) signals.push("Swift: Package.swift");
  if (fs.existsSync(path.join(rootAbs, "Gemfile"))) signals.push("Ruby: Gemfile");

  return { pkg, signals };
}

// WHY: typeCounts and computeResolutionMetrics are no longer needed here.
// Type counts come from graph.typeCountsFromDb(db) and resolution stats
// come from graph.computeResolutionStats(db) — both query SQLite directly.

function mdEscapeInline(s) {
  return String(s).replace(/`/g, "\\`");
}

// WHY: Content flows into <codebase-intelligence> XML tags on hook stdout.
// Unescaped <, >, & in file paths or branch names could break the XML wrapper
// and inject arbitrary content into the LLM context.
function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function clampChars(s, maxChars) {
  if (!maxChars || maxChars <= 0) return s;
  if (s.length <= maxChars) return s;
  let cut = s.slice(0, maxChars);
  // WHY: Avoid truncating mid-XML-entity (e.g., "&amp" without trailing ";").
  // Back up to before the last unfinished entity if one exists.
  const lastAmp = cut.lastIndexOf("&");
  if (lastAmp !== -1 && !cut.slice(lastAmp).includes(";")) {
    cut = cut.slice(0, lastAmp);
  }
  return cut;
}



// getGitInfo imported from lib/git.js

function getRecentGitFiles(rootAbs, limit = 5) {
  try {
    const raw = execSync("git log --name-only --pretty=format:%ct -n 50", {
      cwd: rootAbs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const lines = raw.split(/\r?\n/).map((l) => l.trim());
    const changes = [];
    let ts = 0;
    for (const line of lines) {
      if (/^\d{9,}$/.test(line)) {
        ts = parseInt(line, 10);
        continue;
      }
      if (!ts || !line) continue;
      changes.push({ file: line, ts });
    }
    const seen = new Set();
    const uniq = [];
    for (const c of changes.sort((a, b) => b.ts - a.ts)) {
      if (seen.has(c.file)) continue;
      seen.add(c.file);
      uniq.push(c);
      if (uniq.length >= limit) break;
    }
    return uniq;
  } catch {
    return [];
  }
}

// WHY: Index age now comes from the 'generated_at' meta key in graph.db.
// Falls back to graph.db file mtime when the key is missing (pre-migration DBs).
function computeIndexAgeSec(rootAbs, graphMod, db) {
  let generatedAtMs = null;
  const val = graphMod.getMetaValue(db, "generated_at");
  if (val) {
    const t = Date.parse(val);
    if (Number.isFinite(t)) generatedAtMs = t;
  }

  if (generatedAtMs == null) {
    // Fallback: use graph.db file mtime
    const p = graphMod.graphDbPath(rootAbs);
    try {
      const s = fs.statSync(p);
      generatedAtMs = Math.floor(s.mtimeMs);
    } catch {}
  }

  if (!generatedAtMs) return null;
  return Math.max(0, Math.floor((Date.now() - generatedAtMs) / 1000));
}

function writeSummaryMarkdown(rootAbs, { db, graph }) {
  const files = graph.allFilePaths(db);
  const total = files.length;
  const nowIso = new Date().toISOString();

  // WHY compute upfront: the unsupported-language alert applies whether we
  // have zero or some files — a Rust repo with 2 Python scripts shouldn't
  // report "healthy" any more than an all-Rust repo. Both branches below
  // prepend this block when it fires.
  const unsupportedSignals = detectUnsupportedLanguageSignals(rootAbs);
  const unsupportedAlert =
    unsupportedSignals.length > 0 && total < 3
      ? `ALERT: LANGUAGE NOT SUPPORTED -- detected ${unsupportedSignals.join(", ")} but sextant only extracts JS/TS and Python. Index has ${total} files.\n\n`
      : "";

  if (!total) {
    return (
      unsupportedAlert +
      [
        "## Codebase intelligence",
        "",
        `- **Root**: \`${xmlEscape(mdEscapeInline(rootAbs))}\``,
        `- **Generated**: ${nowIso}`,
        "",
        "No indexed files yet.",
        "",
        "Run:",
        "",
        "```bash",
        "sextant rescan",
        "```",
        "",
      ].join("\n")
    );
  }

  const types = graph.typeCountsFromDb(db).slice(0, 8);
  const { signals } = detectSignals(rootAbs);
  const depended = graph.mostDependedOn(db, 6);

  const healthMetrics = health(rootAbs, { db, graph });
  const git = getGitInfo(rootAbs);
  const recent = getRecentGitFiles(rootAbs, 5);

  const lines = [];

  if (healthMetrics.localTotal > 0 && healthMetrics.resolutionPct < 90) {
    lines.push(
      `ALERT: CODEBASE INTEL HEALTH FAIL -- local import resolution ${healthMetrics.resolutionPct}% (${healthMetrics.localResolved}/${healthMetrics.localTotal})`
    );
    lines.push("");
  }

  // WHY: SB-3 — surface Swift parser failure in the same channel as health
  // failures.  The statusline greps for "ALERT: SWIFT" and shows an action
  // hint; doctor surfaces the full diagnostic.  We only emit when the parser
  // failed AND Swift files were actually seen — otherwise the user is on a
  // pure JS/Python repo and Swift is simply irrelevant.
  let swiftHealth = null;
  try { swiftHealth = graph.getSwiftHealthCounters(db); } catch {}
  if (swiftHealth && swiftHealth.filesSeen > 0 &&
      (swiftHealth.parserState === "init_failed" || swiftHealth.parserState === "unavailable")) {
    lines.push(
      `ALERT: SWIFT PARSER ${swiftHealth.parserState.toUpperCase()} -- Swift facts not indexed for ${swiftHealth.filesSeen} file(s); run \`sextant doctor\``
    );
    lines.push("");
  }

  // WHY language-coverage ALERT: sextant only has extractors for JS/TS and
  // Python. A Rust/Go/Java/Ruby/PHP repo scanned with sextant produces an
  // empty graph (isIndexable drops every file), then reports a vacuously
  // healthy "100%(0/0)" — Claude gets a green summary and zero actual
  // intelligence, violating the "degrade don't guess" invariant. When we
  // detect a build signal for an unsupported language (Cargo.toml, go.mod,
  // Gemfile, etc.) AND have indexed zero or near-zero files, surface it.
  if (unsupportedAlert) {
    lines.push(unsupportedAlert.trimEnd());
    lines.push("");
  }
  // WHY: The INDEX STALE alert used to be emitted here at write time using a
  // flat "watcher dead?" tag.  That was wrong: at write time we don't know
  // watcher status (scan is a one-shot, watcher would set generated_at if
  // alive).  refreshSummaryAge() in lib/cli.js now owns this alert end-to-end
  // — it re-decides based on the heartbeat at inject time, which is when the
  // user or Claude actually reads it.

  lines.push("## Codebase intelligence");
  lines.push("");
  lines.push(`- **Root**: \`${xmlEscape(mdEscapeInline(rootAbs))}\``);
  lines.push(`- **Indexed files**: ${total}`);
  lines.push(`- **Generated**: ${nowIso}`);
  if (git) lines.push(`- **Git**: ${xmlEscape(git.branch)} @ ${xmlEscape(git.head.slice(0, 12))}`);

  if (healthMetrics.localTotal > 0) {
    const age = healthMetrics.indexAgeSec != null ? `${healthMetrics.indexAgeSec}s` : "?";
    lines.push(
      `- **Health**: local import resolution ${healthMetrics.resolutionPct}% (${healthMetrics.localResolved}/${healthMetrics.localTotal}), index age ${age}`
    );
    if (healthMetrics.topMisses.length) {
      // WHY: Original format `${k}x${c}` rendered `./bar` (count 1) as `./barx1`,
      // looking like a filename. Use `×` + parens so `./bar (×1)` reads as
      // "specifier appeared this many times".
      const misses = healthMetrics.topMisses.map(([k, c]) => `${xmlEscape(k)} (×${c})`).join(", ");
      lines.push(`- **Misses**: ${misses}`);
    }
  }
  lines.push("");

  if (signals.length) {
    lines.push("### Signals");
    for (const s of signals) lines.push(`- ${xmlEscape(s)}`);
    lines.push("");
  }

  if (types.length) {
    lines.push("### Module types (top)");
    for (const [t, c] of types) lines.push(`- **${xmlEscape(t)}**: ${c}`);
    lines.push("");
  }

  if (depended.length) {
    lines.push("### Dependency hotspots (fan-in)");
    for (const row of depended) lines.push(`- \`${xmlEscape(mdEscapeInline(row.path))}\`: ${row.c}`);
    lines.push("");
  }

  const entrypoints = files.filter((p) => isEntryPoint(p)).slice(0, 5);
  if (entrypoints.length) {
    lines.push("### Likely entry points");
    for (const p of entrypoints) {
      const meta = graph.getFileMeta(db, p);
      const t = meta?.type || "unknown";
      lines.push(`- \`${xmlEscape(mdEscapeInline(p))}\` (${xmlEscape(t)})`);
    }
    lines.push("");
  }

  if (recent.length) {
    lines.push("### Recent changes (git)");
    for (const r of recent) {
      const d = new Date(r.ts * 1000).toISOString().split("T")[0];
      lines.push(`- ${d} \`${xmlEscape(mdEscapeInline(r.file))}\``);
    }
    lines.push("");
  }

  return clampChars(`${lines.join("\n")}\n`, 2200);
}

function health(rootAbs, { db, graph }) {
  const total = graph.countFiles(db);
  const topTypes = graph.typeCountsFromDb(db).slice(0, 10).map(([t, c]) => ({ t, c }));
  const resolution = graph.computeResolutionStats(db);
  const indexAgeSec = computeIndexAgeSec(rootAbs, graph, db);
  const generatedAt = graph.getMetaValue(db, "generated_at");

  const out = {
    root: rootAbs,
    indexedFiles: total,
    typeCounts: topTypes,
    graph: {
      files: total,
    },
    localResolved: resolution.localResolved,
    localTotal: resolution.localTotal,
    resolutionPct: resolution.resolutionPct,
    topMisses: resolution.topMisses,
    indexAgeSec,
    indexGeneratedAt: generatedAt || null,
  };

  return out;
}

module.exports = {
  writeSummaryMarkdown,
  health,
  // WHY: detectSignals and getRecentGitFiles are filesystem/git-only --
  // they never touch graph.db.  Exported so the freshness gate's stale
  // body (lib/cli.js applyFreshnessGate) can reuse the exact same
  // detection logic instead of drifting a parallel implementation.
  detectSignals,
  getRecentGitFiles,
  xmlEscape,
  mdEscapeInline,
  // exported for testing
  clampChars,
};
