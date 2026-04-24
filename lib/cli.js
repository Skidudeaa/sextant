const fs = require("fs");
const path = require("path");

// WHY: Defense-in-depth — strip XML tags that LLMs treat as structural boundaries.
// summary.md has xmlEscape at generation time, but a tampered file could inject
// closing tags to break out of the wrapper or inject fake system instructions.
function stripUnsafeXmlTags(s) {
  return s
    .replace(/<\/?codebase-intelligence[^>]*>/gi, "")
    .replace(/<\/?codebase-retrieval[^>]*>/gi, "")
    .replace(/<\/?system-reminder[^>]*>/gi, "")
    .replace(/<\/?tool_call[^>]*>/gi, "")
    .replace(/<\/?tool_result[^>]*>/gi, "")
    .replace(/<\/?antml:[a-z_]+[^>]*>/gi, "");
}

// WHY: stdout from hooks is injected as Claude context (<system-reminder>).
// stderr from hooks goes nowhere visible (not to user, not to Claude).
// The banner/status line is written to stderr as diagnostic output only;
// the user sees the statusLine config in .claude/settings.json instead.
function getWatcherStatus(root) {
  try {
    const hbPath = path.join(root, ".planning", "intel", ".watcher_heartbeat");
    if (!fs.existsSync(hbPath)) return { running: false };
    const stat = fs.statSync(hbPath);
    const ageSec = Math.floor((Date.now() - stat.mtimeMs) / 1000);
    // Heartbeat older than 90s means watcher likely died (write interval is 30s, threshold is 3x)
    const running = ageSec < 90;

    // WHY parse JSON payload: old heartbeat was just an ISO string on line 1.
    // New writers append a JSON object on line 2 with pid, lastEventMs,
    // lastFlushMs, totalUpdates. When reading the old format we fall through
    // with the extra fields undefined — liveness still works off mtime.
    let activity = null;
    try {
      const body = fs.readFileSync(hbPath, "utf8");
      const jsonLine = body.split("\n").find((l) => l.trim().startsWith("{"));
      if (jsonLine) activity = JSON.parse(jsonLine);
    } catch {
      // legacy format or malformed — activity stays null, running already decided
    }

    return {
      running,
      ageSec,
      pid: activity?.pid ?? null,
      lastEventMs: activity?.lastEventMs ?? null,
      lastFlushMs: activity?.lastFlushMs ?? null,
      totalUpdates: activity?.totalUpdates ?? null,
    };
  } catch {
    return { running: false };
  }
}

// WHY: summary.md bakes "index age Xs" at generation time. On re-injection
// (SessionStart/UserPromptSubmit) the text still claims the original age even
// when the data is days old — Claude sees a stale map dressed as fresh.
//
// We anchor on the summary's own `**Generated**: <ISO>` line rather than
// graph.db mtime: it matches the writer's `generated_at` meta value within
// milliseconds, requires zero extra I/O, and stays consistent if graph.db is
// touched without a meta-key bump (e.g., vacuum).
//
// If we cross the 24h stale threshold since write time and no ALERT is
// already present, insert one — otherwise the refresh silently drops the
// warning summary.js would have emitted at write time.
//
// `root` is unused (kept for call-site compatibility). Sync by design so
// non-async callers (injectStaticSummary) can use it without threading promises.
const STALE_ALERT_THRESHOLD_SEC = 24 * 3600;

function refreshSummaryAge(rawSummary, root) {
  if (!rawSummary) return rawSummary;
  const m = rawSummary.match(/-\s+\*\*Generated\*\*:\s*(\S+)/);
  if (!m) return rawSummary;
  const generatedMs = Date.parse(m[1]);
  if (!Number.isFinite(generatedMs)) return rawSummary;

  const ageSec = Math.max(0, Math.floor((Date.now() - generatedMs) / 1000));
  // Strip any pre-existing stale-alert block before re-deciding — we may have
  // been called on a summary written when stale, but the watcher has since
  // flushed and the actual data is now fresh.  Without this, the alert
  // persists forever once baked in.
  let out = rawSummary
    .replace(/(index age )\d+s/, `$1${ageSec}s`)
    .replace(/^ALERT: INDEX STALE[^\n]*\n\n?/m, "");

  if (ageSec > STALE_ALERT_THRESHOLD_SEC) {
    const hours = (ageSec / 3600).toFixed(1);
    // Check the heartbeat to honestly report WHY the data is old: a dead
    // watcher is an actionable problem; an idle watcher with no file changes
    // in 24h is not.  The old wording (`watcher dead?`) mislabelled the
    // common-case idle as failure.
    const watcher = root ? getWatcherStatus(root) : { running: false };
    const reason = watcher.running
      ? "watcher idle, no file changes"
      : "watcher not running — run: sextant watch-start";
    out = out.replace(
      /^(## Codebase intelligence\n)/m,
      `ALERT: INDEX STALE -- last update ${hours}h ago (${reason})\n\n$1`
    );
  }
  return out;
}

function getGitBranch(root) {
  const { getGitInfo } = require("./git");
  const info = getGitInfo(root);
  return info ? info.branch : null;
}

function getSearchBackend(root) {
  const rg = require("./rg");
  const zoektMod = require("./zoekt");
  const parts = [];
  if (rg.isInstalled()) parts.push("rg");
  if (zoektMod.isInstalled()) {
    parts.push(zoektMod.hasIndex(root) ? "zoekt (indexed)" : "zoekt");
  }
  return parts.length ? parts.join(" + ") : "none";
}

function renderBanner(healthData, root) {
  const viz = require("./terminal-viz");
  const m = healthData?.metrics || healthData || {};
  const resPct = m.resolutionPct ?? healthData?.resolutionPct ?? 0;
  const resolved = m.localResolved ?? healthData?.localResolved ?? 0;
  const total = m.localTotal ?? healthData?.localTotal ?? 0;
  const files = m.indexedFiles ?? 0;
  const ageSec = m.indexAgeSec ?? 0;
  const graphFiles = m.graph?.files ?? 0;

  const hotspots = m.hotspots || [];
  const topMisses = m.topMisses ?? healthData?.topMisses ?? [];

  // Derived labels
  const healthStatus = resPct >= 90 ? "ok" : resPct >= 70 ? "warn" : "error";
  const boostLabel = resPct >= 90 ? viz.c("✓", viz.colors.green) : viz.c("gated", viz.colors.yellow);
  const branch = getGitBranch(root);
  const watcher = getWatcherStatus(root);
  const search = getSearchBackend(root);

  // Header line: name + branch + search
  const headerRight = [
    branch ? viz.c(branch, viz.colors.magenta) : null,
    viz.dim(search),
  ].filter(Boolean).join(viz.dim(" · "));

  // Build hotspot mini-bars
  const maxFanIn = hotspots.length > 0 ? Math.max(...hotspots.map(h => h.fanIn || 1)) : 1;
  const hotspotLines = hotspots.slice(0, 5).map(h => {
    const name = (h.path || h).split("/").pop();
    const fi = h.fanIn || 0;
    const barLen = Math.max(1, Math.round((fi / maxFanIn) * 8));
    return `  ${viz.dim("▪".repeat(barLen))}${"·".repeat(Math.max(0, 8 - barLen))} ${viz.c(name, viz.colors.white)} ${viz.dim(String(fi))}`;
  });

  // Assemble sections
  const lines = [
    viz.c("sextant v1.0.0", viz.colors.bold, viz.colors.cyan) + "                   " + headerRight,
    "",
    viz.status(healthStatus, `${resPct}%`) + "  " + viz.bar(resPct, 20, { showPercent: false }) + "  " + viz.dim(`${resolved}/${total} imports resolved`),
    "",
    viz.dim("  files ")  + viz.c(String(files), viz.colors.white) + viz.dim("  ·  graph ") + viz.c(String(graphFiles), viz.colors.white) + viz.dim(" nodes  ·  boosts ") + boostLabel + viz.dim("  ·  age ") + viz.ageStatus(ageSec),
    viz.dim("  watcher ") + (watcher.running
      ? viz.c("⟳ live", viz.colors.green) + viz.dim(" · " + viz.formatAge(watcher.ageSec) + " ago")
      : viz.c("⏸ off", viz.colors.yellow) + viz.dim(" · run: sextant watch-start")),
  ];

  // Hotspots section (after divider)
  if (hotspotLines.length > 0) {
    lines.push("");
    lines.push(viz.dim("  dependency hotspots") + "                          " + viz.dim("fan-in"));
    lines.push(...hotspotLines);
  }

  // Unresolved misses (only when health is bad)
  if (resPct < 90 && topMisses.length > 0) {
    lines.push("");
    lines.push(viz.dim("  unresolved ") + topMisses.slice(0, 4).map(m =>
      viz.c(m[0], viz.colors.yellow) + viz.dim("×" + m[1])
    ).join(viz.dim("  ")));
  }

  const dividerIdx = 5; // after the watcher line
  return viz.box(lines, { title: viz.c(" ◆ ", viz.colors.bold, viz.colors.cyan), rounded: true, dividerAfter: hotspotLines.length > 0 ? dividerIdx : -1 });
}

function renderStatusLine(healthData, changed, root) {
  const viz = require("./terminal-viz");
  const m = healthData?.metrics || healthData || {};
  const resPct = m.resolutionPct ?? healthData?.resolutionPct ?? 0;
  const files = m.indexedFiles ?? 0;
  const ageSec = m.indexAgeSec ?? 0;

  const dot = resPct >= 90 ? viz.c("◆", viz.colors.green) : resPct >= 70 ? viz.c("◆", viz.colors.yellow) : viz.c("◆", viz.colors.red);
  const watcher = getWatcherStatus(root);
  const watchIcon = watcher.running ? viz.c("⟳", viz.colors.green) : viz.c("⏸", viz.colors.yellow);
  const changeNote = changed ? "  " + viz.c("↻ context refreshed", viz.colors.cyan) : "";

  return `${dot} ${viz.dim("intel")} ${resPct}% ${viz.dim("·")} ${files} files ${viz.dim("·")} ${watchIcon} ${viz.dim("·")} ${viz.ageStatus(ageSec)}${changeNote}`;
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : null;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function readRootsFile(p) {
  const txt = fs.readFileSync(p, "utf8");
  return txt
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => path.resolve(l));
}

function rootsFromArgs(argv) {
  const one = flag(argv, "--root");
  const many = flag(argv, "--roots");
  const file = flag(argv, "--roots-file");

  if (file) return readRootsFile(file);
  if (many) return many.split(",").map((s) => path.resolve(s.trim())).filter(Boolean);
  if (one) return [path.resolve(one)];
  return [process.cwd()];
}

async function readStdinJson() {
  return new Promise((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (input += c));
    process.stdin.on("end", () => {
      try {
        resolve(input ? JSON.parse(input) : {});
      } catch {
        resolve({});
      }
    });
  });
}

module.exports = {
  stripUnsafeXmlTags,
  getWatcherStatus,
  refreshSummaryAge,
  getGitBranch,
  getSearchBackend,
  renderBanner,
  renderStatusLine,
  flag,
  hasFlag,
  readRootsFile,
  rootsFromArgs,
  readStdinJson,
};
