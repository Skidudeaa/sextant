const fs = require("fs");
const path = require("path");
const intel = require("../lib/intel");
const { loadRepoConfig } = require("../lib/config");

async function run(ctx) {
  const r = ctx.roots[0];
  const rootAbs = path.resolve(r);
  const h = await intel.health(r);
  const cfg = loadRepoConfig(r);
  const viz = require("../lib/terminal-viz");

  const lines = [];
  lines.push(viz.c("# sextant doctor", viz.colors.bold, viz.colors.cyan));
  lines.push("");

  // State files
  lines.push(viz.header("State"));
  const sd = path.join(rootAbs, ".planning", "intel");
  const graphDb = path.join(sd, "graph.db");
  const summaryMd = path.join(sd, "summary.md");
  const claudeSettings = path.join(rootAbs, ".claude", "settings.json");

  lines.push(viz.metric("state dir", fs.existsSync(sd) ? viz.status("ok", sd) : viz.status("error", sd)));
  lines.push(viz.metric("graph.db", fs.existsSync(graphDb) ? viz.status("ok", "exists") : viz.status("error", "missing")));
  lines.push(viz.metric("summary.md", fs.existsSync(summaryMd) ? viz.status("ok", "exists") : viz.status("error", "missing")));
  lines.push(viz.metric("claude settings", fs.existsSync(claudeSettings) ? viz.status("ok", "exists") : viz.status("warn", "missing")));

  // Health metrics
  lines.push(viz.header("Health"));
  const pct = h.metrics?.resolutionPct ?? h.resolutionPct ?? 0;
  const resolved = h.metrics?.localResolved ?? h.localResolved ?? 0;
  const total = h.metrics?.localTotal ?? h.localTotal ?? 0;
  const ageSec = h.metrics?.indexAgeSec ?? h.indexAgeSec ?? 0;
  const indexed = h.metrics?.indexedFiles ?? h.indexedFiles ?? h.index?.files ?? 0;

  // Resolution with bar chart
  let resStatus = viz.status("ok", "healthy");
  if (pct < 90) resStatus = viz.status("error", "degraded (graph boosts gated)");
  else if (pct < 95) resStatus = viz.status("warn", "watch it");

  lines.push(`  ${viz.c("resolution".padEnd(18), viz.colors.dim)}${viz.bar(pct, 20)}  ${resolved}/${total}  ${resStatus}`);
  lines.push(viz.metric("indexed files", indexed));

  // Index age with color
  const ageDisplay = viz.ageStatus(ageSec, { warn: 300, danger: 3600 });
  const ageNote = ageSec > 300 ? viz.status("warn", "stale (watcher not running?)") : "";
  lines.push(`  ${viz.c("index age".padEnd(18), viz.colors.dim)}${ageDisplay}  ${ageNote}`);

  // Historical trends
  const history = require("../lib/history");
  const histSummary = history.getHistorySummary(rootAbs, 20);
  if (histSummary.snapshotCount > 1) {
    lines.push("");
    lines.push(`  ${viz.c("Trends".padEnd(18), viz.colors.dim)}(${histSummary.snapshotCount} snapshots)`);

    // Resolution trend sparkline
    if (histSummary.resolutionTrend.length > 1) {
      const resTrend = histSummary.resolutionTrend;
      const first = resTrend[0];
      const last = resTrend[resTrend.length - 1];
      const delta = last - first;
      const deltaStr = delta >= 0 ? viz.c(`+${delta}%`, viz.colors.green) : viz.c(`${delta}%`, viz.colors.red);
      const spark = viz.sparkline(resTrend);
      lines.push(`  ${viz.c("resolution".padEnd(18), viz.colors.dim)}${spark}  ${first}% → ${last}%  ${deltaStr}`);
    }

    // Files trend sparkline
    if (histSummary.filesTrend.length > 1) {
      const filesTrend = histSummary.filesTrend;
      const first = filesTrend[0];
      const last = filesTrend[filesTrend.length - 1];
      const delta = last - first;
      const deltaStr = delta >= 0 ? viz.c(`+${delta}`, viz.colors.cyan) : viz.c(`${delta}`, viz.colors.yellow);
      const spark = viz.sparkline(filesTrend);
      lines.push(`  ${viz.c("files".padEnd(18), viz.colors.dim)}${spark}  ${first} → ${last}  ${deltaStr}`);
    }

    // Time range
    if (histSummary.firstTs && histSummary.lastTs) {
      const rangeMs = histSummary.lastTs - histSummary.firstTs;
      const rangeHours = (rangeMs / 3600000).toFixed(1);
      lines.push(`  ${viz.c("period".padEnd(18), viz.colors.dim)}${rangeHours}h of history`);
    }
  }

  // Top misses
  const misses = h.metrics?.topMisses ?? h.topMisses ?? [];
  if (misses.length > 0) {
    lines.push(viz.header("Top Unresolved Imports"));
    const maxCount = Math.max(...misses.slice(0, 5).map(m => m[1]));
    for (const [spec, count] of misses.slice(0, 5)) {
      const miniBar = viz.bar((count / maxCount) * 100, 10, { showPercent: false, thresholds: { warn: 999, danger: 999 } });
      lines.push(`  ${viz.c(String(count).padStart(3), viz.colors.yellow)} ${miniBar} ${spec}`);
    }
  }

  // Config
  lines.push(viz.header("Config"));
  lines.push(viz.metric("globs", viz.dim(JSON.stringify(cfg.globs.slice(0, 2)) + (cfg.globs.length > 2 ? "..." : ""))));
  lines.push(viz.metric("ignore", viz.dim(`${cfg.ignore.length} patterns`)));

  // Search backends
  lines.push(viz.header("Search Backends"));
  // WHY: Uses "command -v" (POSIX) instead of "which" (not POSIX, missing on Alpine).
  const rgInstalled = require("child_process").spawnSync("sh", ["-lc", 'command -v "$1" 2>/dev/null', "--", "rg"], { encoding: "utf8", timeout: 5000 }).status === 0;
  const zoektInstalled = require("child_process").spawnSync("sh", ["-lc", 'command -v "$1" 2>/dev/null', "--", "zoekt-webserver"], { encoding: "utf8", timeout: 5000 }).status === 0;
  lines.push(viz.metric("ripgrep (rg)", rgInstalled ? viz.status("ok", "installed") : viz.status("error", "missing")));
  lines.push(viz.metric("zoekt", zoektInstalled ? viz.status("ok", "installed") : viz.status("info", "not installed (optional)")));

  // Zoekt per-project index status
  if (zoektInstalled) {
    const zoektIdxDir = path.join(sd, "zoekt", "index");
    let hasZoektShards = false;
    try {
      hasZoektShards = fs.existsSync(zoektIdxDir) && fs.readdirSync(zoektIdxDir).some(f => f.endsWith(".zoekt"));
    } catch {}
    lines.push(viz.metric("zoekt index", hasZoektShards ? viz.status("ok", "exists") : viz.status("warn", "missing (run sextant scan)")));

    // Reindex state
    const { readReindexState } = require("../lib/zoekt-reindex");
    const reindexState = readReindexState(rootAbs);
    if (reindexState.lastReindexMs > 0) {
      const reindexAgeSec = Math.floor((Date.now() - reindexState.lastReindexMs) / 1000);
      const reindexAgeStr = viz.ageStatus(reindexAgeSec, { warn: 600, danger: 3600 });
      const statusStr = reindexState.inProgress ? viz.status("info", "in progress") : (reindexState.lastReindexOk === false ? viz.status("warn", "last run failed") : "");
      lines.push(`  ${viz.c("last reindex".padEnd(18), viz.colors.dim)}${reindexAgeStr}  ${statusStr}`);
    } else if (reindexState.inProgress) {
      lines.push(viz.metric("reindex", viz.status("info", "in progress (first run)")));
    }
  }

  // Hints
  lines.push(viz.header("Hints"));
  if (!fs.existsSync(sd)) {
    lines.push(`  ${viz.status("info", "Run: sextant init")}`);
  } else if (indexed === 0) {
    lines.push(`  ${viz.status("info", "Run: sextant scan")}`);
  } else if (ageSec > 300) {
    lines.push(`  ${viz.status("warn", "Start watcher: sextant watch --summary-every 5")}`);
  } else if (pct < 90) {
    lines.push(`  ${viz.status("warn", "Check resolver / adjust globs in .codebase-intel.json")}`);
  } else {
    lines.push(`  ${viz.status("ok", "System looks healthy")}`);
  }
  lines.push("");

  process.stdout.write(lines.join("\n") + "\n");
}

module.exports = { run };
