const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { isEntryPoint } = require("./utils");
const { getGitInfo } = require("./git");
const { loadRepoConfig } = require("./config");

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

  // Agent / editor convention files the author hand-declared — the most
  // authoritative orientation artifact in a repo, and one sextant otherwise
  // ignores.  Pure presence over a fixed allowlist (no content read, no
  // inference).  Surfaced INSIDE the Signals block (high line-order) so the
  // 2200-char clamp — which truncates from the END — can't silently drop it.
  // CLAUDE.md is included regardless of whether any one consumer auto-loads it:
  // its presence is the orientation fact.
  const conventions = [];
  const conv = (rel, label) => {
    if (fs.existsSync(path.join(rootAbs, rel))) conventions.push(label);
  };
  conv("AGENTS.md", "AGENTS.md");
  conv("CLAUDE.md", "CLAUDE.md");
  conv("GEMINI.md", "GEMINI.md");
  conv(".cursorrules", ".cursorrules");
  conv(".cursor/rules", ".cursor/rules");
  conv(".github/copilot-instructions.md", "Copilot instructions");
  if (conventions.length) signals.push("Conventions: " + conventions.join(", "));

  return { pkg, signals };
}

// WHY: typeCounts and computeResolutionMetrics are no longer needed here.
// Type counts come from graph.typeCountsFromDb(db) and resolution stats
// come from graph.computeResolutionStats(db) — both query SQLite directly.

// WHY: The authoritative entry points of a project are DECLARED in its
// manifest (package.json `bin`, pyproject `[project.scripts]`), not guessed
// from filenames.  The filename heuristic (isEntryPoint) both misses real
// dispatchers — e.g. sextant's own `bin/intel.js` matches no canonical
// basename — and false-positives on barrels (`lib/extractors/index.js`) and
// substrings.  This is pure manifest parsing: no inference, no graph, just
// reading the fields the author already wrote down.  Returns POSIX-normalized
// relative file paths (no leading `./`).
function normalizeManifestTarget(p) {
  let s = posixifyLocal(String(p || "")).trim();
  s = s.replace(/^\.\//, "").replace(/^\/+/, "");
  return s;
}

function posixifyLocal(p) {
  return String(p).replace(/\\/g, "/");
}

// package.json `bin`: either a string (single binary) or an object map of
// name -> path.  Either form points at one-or-more real files.
function entriesFromPackageBin(pkg) {
  const out = [];
  if (!pkg || pkg.bin == null) return out;
  if (typeof pkg.bin === "string") {
    const t = normalizeManifestTarget(pkg.bin);
    if (t) out.push(t);
  } else if (typeof pkg.bin === "object") {
    for (const v of Object.values(pkg.bin)) {
      if (typeof v === "string") {
        const t = normalizeManifestTarget(v);
        if (t) out.push(t);
      }
    }
  }
  return out;
}

// pyproject `[project.scripts]`: each value is a console-entry-point spec.
// The common forms are `module.path:func` (an importable module) or a bare
// `module.path`.  We map the module portion to a candidate source file:
//   `demo.cli:main`  -> `demo/cli.py`
// We emit BOTH the `pkg/mod.py` form and the `pkg/mod/__init__.py` form as
// candidates; the caller keeps only the ones that are actually indexed files.
// Hand-parsed (~20 lines) — no TOML dependency, scoped to this one table.
function entriesFromPyprojectScripts(rootAbs) {
  const tomlPath = path.join(rootAbs, "pyproject.toml");
  let raw;
  try {
    raw = fs.readFileSync(tomlPath, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split(/\r?\n/);
  const candidates = [];
  let inScripts = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^\[/.test(t)) {
      // New table header — we only consume rows inside [project.scripts].
      inScripts = /^\[project\.scripts\]\s*$/.test(t);
      continue;
    }
    if (!inScripts) continue;
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    let val = t.slice(eq + 1).trim();
    // Strip a trailing inline comment, then surrounding quotes.
    val = val.replace(/\s+#.*$/, "").trim();
    const m = val.match(/^["']([^"']+)["']$/);
    if (!m) continue;
    const spec = m[1].trim();
    if (!spec) continue;
    const mod = spec.split(":")[0].trim(); // `module.path` portion
    if (!mod) continue;
    const relBase = mod.split(".").join("/");
    candidates.push(`${relBase}.py`);
    candidates.push(`${relBase}/__init__.py`);
  }
  return candidates;
}

// package.json `scripts`: a map of name -> shell command the author declared.
// The most authoritative answer to "how do I build / test / run this" — a
// VERBATIM transcription (no inference, no graph), ending the "npm test? make?
// pytest?" guess an agent otherwise makes on an unfamiliar repo.  Twin of
// entriesFromPackageBin: reads the same already-loaded `pkg` object.  Canonical
// lifecycle names sort first so the orientation-critical ones survive the N-cap
// and the 2200-char clamp; ties keep declaration order.  Returns
// [{name, command}].
const LIFECYCLE_SCRIPTS = [
  "dev", "start", "serve", "build", "test", "lint", "typecheck", "format", "check",
];
function commandsFromPackageScripts(pkg) {
  if (!pkg || !pkg.scripts || typeof pkg.scripts !== "object" || Array.isArray(pkg.scripts)) {
    return [];
  }
  const rank = (name) => {
    const i = LIFECYCLE_SCRIPTS.indexOf(name);
    return i === -1 ? LIFECYCLE_SCRIPTS.length : i;
  };
  return Object.entries(pkg.scripts)
    .filter(([k, v]) => typeof k === "string" && k && typeof v === "string" && v.trim())
    .map(([name, command], idx) => ({ name, command: command.trim(), idx }))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.idx - b.idx)
    .map(({ name, command }) => ({ name, command }));
}

// Required env vars DECLARED in a committed `.env.example`/`.sample` template —
// the cold-start "what must be configured to run this" contract, more
// authoritative than grepping scattered process.env.X.  KEYS ONLY: the regex
// capture group stops at `=`, so a value/secret is structurally never read
// (`JWT_SECRET=supersekret` → `JWT_SECRET`, never the value).  Sourced via
// `git ls-files` so only TRACKED templates surface — an edit to a tracked file
// moves the git-status fingerprint the freshness gate watches, so the keys can
// never go stale-without-detection (a gitignored .env.example would be invisible
// to that gate, the one freshness hole keys-only can't otherwise close).
// Degrades to [] when not a git repo or no tracked template exists.
const ENV_EXAMPLE_FILES = [".env.example", ".env.sample", ".env.template", ".env.dist"];
function requiredEnvKeys(rootAbs) {
  let tracked;
  try {
    const pathspec = ENV_EXAMPLE_FILES.map((f) => `'${f}'`).join(" ");
    const raw = execSync(`git ls-files -z -- ${pathspec}`, {
      cwd: rootAbs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    tracked = raw.split("\0").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
  if (!tracked.length) return [];
  const keys = [];
  const seen = new Set();
  for (const rel of tracked) {
    let content;
    try {
      content = fs.readFileSync(path.join(rootAbs, rel), "utf8");
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      // `KEY=...` or `export KEY=...` — capture ONLY the key, never the value.
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (!m) continue;
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      keys.push(m[1]);
    }
  }
  return keys;
}

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
  const { pkg, signals } = detectSignals(rootAbs);
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

  // WHY: Surface vendored exclusion transparently. The dogfooding feedback
  // (Swift app + vendored Python under cwd) hit confidently-wrong hotspots
  // because indexing pulled in vendored subtrees. Now sextant excludes them
  // by default — and the user must be told what got excluded so they can
  // override via `.codebase-intel.json` if any detection was wrong.
  try {
    const cfg = loadRepoConfig(rootAbs);
    const vs = cfg.vendoredSignals || [];
    if (vs.length > 0) {
      const top = vs.slice(0, 4).map((s) => `\`${xmlEscape(mdEscapeInline(s.path))}\``);
      const more = vs.length > 4 ? `, +${vs.length - 4} more` : "";
      lines.push(`- **Vendored excluded**: ${vs.length} (${top.join(", ")}${more})`);
    }
  } catch { /* config load is best-effort here */ }

  lines.push("");

  if (signals.length) {
    lines.push("### Signals");
    for (const s of signals) lines.push(`- ${xmlEscape(s)}`);
    lines.push("");
  }

  // "How do I run this" — verbatim from package.json `scripts`.  Placed high
  // (right after Signals: stack → how-to-run) so it survives the 2200-char
  // clamp, which truncates from the END.  N-capped, with long command bodies
  // truncated since the script NAME is the primary orientation signal.  Pure
  // package.json read, so it is a fresh-body-only fact: on a stale turn the
  // freshness gate rebuilds a minimal body and Commands is correctly absent.
  const commands = commandsFromPackageScripts(pkg);
  if (commands.length) {
    const MAX_COMMANDS = 8;
    const MAX_CMD_CHARS = 50;
    lines.push("### Commands");
    for (const { name, command } of commands.slice(0, MAX_COMMANDS)) {
      const cmd = command.length > MAX_CMD_CHARS
        ? command.slice(0, MAX_CMD_CHARS - 1) + "…"
        : command;
      lines.push(`- \`${xmlEscape(mdEscapeInline(name))}\` — ${xmlEscape(mdEscapeInline(cmd))}`);
    }
    if (commands.length > MAX_COMMANDS) {
      lines.push(`- …and ${commands.length - MAX_COMMANDS} more`);
    }
    lines.push("");
  }

  // "What must be configured to run this" — keys only, from a tracked
  // .env.example template.  Operational orientation, paired with Commands; same
  // clamp-survival placement (high line-order).  Fresh-body-only fact.
  const envKeys = requiredEnvKeys(rootAbs);
  if (envKeys.length) {
    const MAX_ENV = 12;
    const shown = envKeys.slice(0, MAX_ENV).map((k) => `\`${xmlEscape(k)}\``);
    const more = envKeys.length > MAX_ENV ? `, …+${envKeys.length - MAX_ENV} more` : "";
    lines.push("### Required env");
    lines.push(`- ${shown.join(", ")}${more}`);
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

  // WHY three-tier, manifest-AUTHORITATIVE union (T1.1).  The author already
  // wrote down the real entry points in the manifest; we read them rather than
  // guess from filenames.  Precedence, highest first:
  //   1. "— declared" — package.json `bin` / pyproject `[project.scripts]`.
  //      Pure manifest parse, intersected with indexed files.  Catches real
  //      dispatchers the filename heuristic misses (e.g. `bin/intel.js`).
  //   2. "— @main"   — Swift @main-attribute scan (graph.getSwiftEntryFiles).
  //   3. "(heuristic)" — isEntryPoint filename match (canonical basenames).
  // When a manifest declares entries, heuristic `index.*` barrels are dropped:
  // a re-export barrel is not an entry point, and the manifest is the
  // authority on what is.  This REPLACES the wrong rows (substring false
  // positives are already gone via the utils.js basename anchor) rather than
  // adding net rows — the list stays capped at 5.
  const fileSet = new Set(files);
  const TEST_PATH_RE = /(^|\/)(fixtures?|tests?|__tests__|specs?|examples?|demos?|samples?|e2e|mocks?)\//i;

  // Tier 1: manifest-declared, kept only when the target is an indexed file.
  const declaredOrdered = [];
  const declaredSeen = new Set();
  const pushDeclared = (p) => {
    const n = normalizeManifestTarget(p);
    if (n && fileSet.has(n) && !declaredSeen.has(n) && !TEST_PATH_RE.test(n)) {
      declaredSeen.add(n);
      declaredOrdered.push(n);
    }
  };
  for (const t of entriesFromPackageBin(pkg)) pushDeclared(t);
  for (const t of entriesFromPyprojectScripts(rootAbs)) pushDeclared(t);
  const hasManifestEntries = declaredOrdered.length > 0;

  // Tier 2: Swift @main attribute (graph-tracked).
  let fromAtMain = [];
  try { fromAtMain = (graph.getSwiftEntryFiles(db) || []).map((r) => r.path); } catch {}
  const fromAtMainFiltered = fromAtMain.filter((p) => !TEST_PATH_RE.test(p) && !declaredSeen.has(p));

  // Tier 3: filename heuristic.  When the manifest is authoritative, drop bare
  // `index.*` barrels — they're re-export hubs, not entry points.
  const fromFilename = files.filter((p) => {
    if (!isEntryPoint(p) || declaredSeen.has(p)) return false;
    if (hasManifestEntries && /(^|\/)index\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(p)) return false;
    return true;
  });

  const atMainSet = new Set(fromAtMainFiltered);
  const entrypoints = Array.from(
    new Set([...declaredOrdered, ...fromAtMainFiltered, ...fromFilename])
  ).slice(0, 5);
  if (entrypoints.length) {
    lines.push("### Likely entry points");
    for (const p of entrypoints) {
      const meta = graph.getFileMeta(db, p);
      const t = meta?.type || "unknown";
      // Source-tag every row so the user can audit which signal won.
      let tag;
      if (declaredSeen.has(p)) tag = " — declared";
      else if (atMainSet.has(p)) tag = " — @main";
      else tag = " (heuristic)";
      lines.push(`- \`${xmlEscape(mdEscapeInline(p))}\` (${xmlEscape(t)})${tag}`);
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
  commandsFromPackageScripts,
  requiredEnvKeys,
};
