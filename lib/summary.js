const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { isEntryPoint } = require("./utils");
const { getGitInfo } = require("./git");

function readJsonIfExists(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
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

function typeCounts(indexFiles) {
  const counts = new Map();
  for (const v of Object.values(indexFiles || {})) {
    const t = v?.type || "other";
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
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

function computeResolutionMetrics(index) {
  const files = Object.values(index?.files || {});
  let localTotal = 0;
  let localResolved = 0;
  const misses = new Map();

  for (const f of files) {
    const imports = Array.isArray(f?.imports) ? f.imports : [];
    for (const imp of imports) {
      const isString = typeof imp === "string";
      const specifier = isString ? imp : imp?.specifier;
      const kind = isString
        ? specifier && (specifier.startsWith(".") || specifier.startsWith("/"))
          ? "unresolved"
          : "external"
        : imp?.kind || "unknown";
      if (kind === "external" || kind === "asset") continue;
      localTotal += 1;
      const resolved = isString ? null : imp?.resolved;
      if (resolved) {
        localResolved += 1;
      } else if (specifier) {
        misses.set(specifier, (misses.get(specifier) || 0) + 1);
      }
    }
  }

  const resolutionPct =
    localTotal > 0 ? Math.round((localResolved / localTotal) * 100) : 100;
  const topMisses = [...misses.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8);

  return { localTotal, localResolved, resolutionPct, topMisses };
}

function computeIndexAgeSec(rootAbs, index) {
  let generatedAtMs = null;
  if (index?.generatedAt) {
    const t = Date.parse(index.generatedAt);
    if (Number.isFinite(t)) generatedAtMs = t;
  }

  if (generatedAtMs == null) {
    const p = path.join(rootAbs, ".planning", "intel", "index.json");
    try {
      const s = fs.statSync(p);
      generatedAtMs = Math.floor(s.mtimeMs);
    } catch {}
  }

  if (!generatedAtMs) return null;
  return Math.max(0, Math.floor((Date.now() - generatedAtMs) / 1000));
}

function writeSummaryMarkdown(rootAbs, { index, db, graph }) {
  const files = Object.keys(index?.files || {});
  const total = files.length;
  const nowIso = new Date().toISOString();

  if (!total) {
    return [
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
    ].join("\n");
  }

  const types = typeCounts(index.files).slice(0, 8);
  const { signals } = detectSignals(rootAbs);
  const depended = graph.mostDependedOn(db, 6);

  const healthMetrics = health(rootAbs, { index, db, graph });
  const git = getGitInfo(rootAbs);
  const recent = getRecentGitFiles(rootAbs, 5);

  const lines = [];

  if (healthMetrics.localTotal > 0 && healthMetrics.resolutionPct < 90) {
    lines.push(
      `ALERT: CODEBASE INTEL HEALTH FAIL -- local import resolution ${healthMetrics.resolutionPct}% (${healthMetrics.localResolved}/${healthMetrics.localTotal})`
    );
    lines.push("");
  }
  if (healthMetrics.indexAgeSec != null && healthMetrics.indexAgeSec > 24 * 3600) {
    lines.push(
      `ALERT: INDEX STALE -- last update ${(healthMetrics.indexAgeSec / 3600).toFixed(
        1
      )}h ago (watcher dead?)`
    );
    lines.push("");
  }

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
      const misses = healthMetrics.topMisses.map(([k, c]) => `${xmlEscape(k)}x${c}`).join(", ");
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
      const t = index?.files?.[p]?.type || "unknown";
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

function health(rootAbs, { index, db, graph }) {
  const files = Object.keys(index?.files || {});
  const total = files.length;
  const topTypes = typeCounts(index?.files || {}).slice(0, 10).map(([t, c]) => ({ t, c }));
  const resolution = computeResolutionMetrics(index);
  const indexAgeSec = computeIndexAgeSec(rootAbs, index);

  const out = {
    root: rootAbs,
    indexedFiles: total,
    typeCounts: topTypes,
    graph: {
      files: graph.countFiles(db),
    },
    localResolved: resolution.localResolved,
    localTotal: resolution.localTotal,
    resolutionPct: resolution.resolutionPct,
    topMisses: resolution.topMisses,
    indexAgeSec,
    indexGeneratedAt: index?.generatedAt || null,
  };

  return out;
}

module.exports = {
  writeSummaryMarkdown,
  health,
  // exported for testing
  clampChars,
};
