#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const intel = require("../lib/intel");
const { retrieve } = require("../lib/retrieve");
const zoekt = require("../lib/zoekt");
const viz = require("../lib/terminal-viz");

// WHY: stderr goes to the user as visible hook output in Claude Code.
// stdout goes to Claude as injected context.  The banner gives the user
// visual confirmation that sextant is active and what it sees.
function getWatcherStatus(root) {
  try {
    const hbPath = path.join(root, ".planning", "intel", ".watcher_heartbeat");
    if (!fs.existsSync(hbPath)) return { running: false };
    const stat = fs.statSync(hbPath);
    const ageSec = Math.floor((Date.now() - stat.mtimeMs) / 1000);
    // Heartbeat older than 120s means watcher likely died
    return { running: ageSec < 120, ageSec };
  } catch {
    return { running: false };
  }
}

function getGitBranch(root) {
  try {
    const { execSync } = require("child_process");
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function getSearchBackend(root) {
  const rg = require("../lib/rg");
  const zoektMod = require("../lib/zoekt");
  const parts = [];
  if (rg.isInstalled()) parts.push("rg");
  if (zoektMod.isInstalled()) {
    parts.push(zoektMod.hasIndex(root) ? "zoekt (indexed)" : "zoekt");
  }
  return parts.length ? parts.join(" + ") : "none";
}

function renderBanner(healthData, root) {
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
      : viz.c("⏸ off", viz.colors.yellow) + viz.dim(" · run: sextant watch")),
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

function usage(exitCode = 1) {
  const pkg = require("../package.json");
  console.log(`sextant v${pkg.version}

Usage:
  sextant init [--root <path> | --roots <a,b> | --roots-file <file>]
  sextant scan [--root/--roots/--roots-file] [--force]
  sextant rescan [--root/--roots/--roots-file] [--force]
  sextant update --file <relPath> [--root <path>]
  sextant watch [--root/--roots/--roots-file] [--summary-every <sec>] [--no-dashboard]
  sextant summary [--root <path>]
  sextant health [--root <path>] [--pretty]
  sextant doctor [--root <path>]
  sextant query <imports|dependents|exports> --file <relPath> [--root <path>]
  sextant hook sessionstart
  sextant hook refresh
  sextant inject
  sextant retrieve <query>
  sextant zoekt <index|serve|search>`);
  process.exit(exitCode);
}

(async () => {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  // ---- version ----
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    const pkg = require("../package.json");
    console.log(`sextant v${pkg.version}`);
    process.exit(0);
  }

  // ---- hook sessionstart (Claude Code) ----
  if (cmd === "hook" && argv[1] === "sessionstart") {
    const root = process.cwd();
    const data = await readStdinJson();
    const src = data.source;
    if (src && !["startup", "resume"].includes(src)) process.exit(0);

    await intel.init(root);
    const summary = intel.readSummary(root);
    if (!summary || !summary.trim()) process.exit(0);

    // stdout → Claude context
    // WHY: Strip XML-closing-tag patterns as defense-in-depth — summary.md has
    // xmlEscape at generation time, but a tampered file could inject a closing
    // tag to break out of the wrapper. Full re-escape would double-encode.
    const safeSummary = summary.trim().replace(/<\/?codebase-intelligence[^>]*>/gi, "");
    process.stdout.write(
      `<codebase-intelligence>\n${safeSummary}\n</codebase-intelligence>`
    );

    // stderr → visible to user in terminal
    try {
      const health = await intel.health(root);
      // Parse hotspots from summary — handles both formats:
      //   `lib/intel.js`: 5         (new format)
      //   `lib-intel` (fan-in 5)    (old format)
      const hotspotRe = /`([^`]+)`(?:\s*:\s*(\d+)|\s*\(fan-in\s+(\d+)\))/g;
      const hotspots = [];
      let hm;
      while ((hm = hotspotRe.exec(summary)) !== null) {
        hotspots.push({ path: hm[1], fanIn: parseInt(hm[2] || hm[3], 10) });
      }
      if (health.metrics) health.metrics.hotspots = hotspots;
      process.stderr.write(renderBanner(health, root) + "\n");
    } catch {}

    // Auto-start watcher if not running
    try {
      const ws = getWatcherStatus(root);
      if (!ws.running) {
        const { spawn: spawnChild } = require("child_process");
        const child = spawnChild("sextant", ["watch"], {
          cwd: root,
          stdio: "ignore",
          detached: true,
        });
        child.unref();
      }
    } catch {}

    process.exit(0);
  }

  // ---- hook refresh (mid-session, on UserPromptSubmit) ----
  if (cmd === "hook" && argv[1] === "refresh") {
    const crypto = require("crypto");
    const root = process.cwd();
    const summaryPath = path.join(root, ".planning", "intel", "summary.md");

    const data = await readStdinJson();

    if (!fs.existsSync(summaryPath)) process.exit(0);

    const summary = fs.readFileSync(summaryPath, "utf8").trim();
    if (!summary) process.exit(0);

    // Per-session dedupe: derive session key from hook payload or env
    const sessionKey = (
      data?.session_id ||
      data?.conversation_id ||
      data?.run_id ||
      data?.terminal_id ||
      process.env.CURSOR_SESSION_ID ||
      process.env.TMUX_PANE ||
      process.env.SSH_TTY ||
      String(process.ppid || process.pid)
    )
      .toString()
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 80);

    const cachePath = path.join(
      root,
      ".planning",
      "intel",
      `.last_injected_hash.${sessionKey}`
    );

    const h = crypto.createHash("sha256").update(summary).digest("hex");
    const last = fs.existsSync(cachePath)
      ? fs.readFileSync(cachePath, "utf8").trim()
      : "";

    // Only inject if changed since last injection for this session
    const changed = last !== h;

    // stderr → status line visible to user on every prompt
    try {
      const health = await intel.health(root);
      process.stderr.write(renderStatusLine(health, changed, root) + "\n");
    } catch {}

    if (!changed) process.exit(0);

    fs.writeFileSync(cachePath, h);

    // stdout → Claude context (only when changed)
    const safeRefresh = summary.replace(/<\/?codebase-intelligence[^>]*>/gi, "");
    process.stdout.write(
      `<codebase-intelligence>\n(refreshed: ${new Date().toISOString()})\n${safeRefresh}\n</codebase-intelligence>`
    );
    process.exit(0);
  }

  if (cmd === "inject") {
    const root = process.cwd();
    await intel.init(root);
    const summary = intel.readSummary(root);
    if (!summary || !summary.trim()) process.exit(0);
    const safeInject = summary.trim().replace(/<\/?codebase-intelligence[^>]*>/gi, "");
    process.stdout.write(
      `<codebase-intelligence>\n${safeInject}\n</codebase-intelligence>`
    );
    process.exit(0);
  }

  // ---- watch-start: start watcher in background ----
  if (cmd === "watch-start") {
    const root = process.cwd();
    const ws = getWatcherStatus(root);
    if (ws.running) {
      console.log("watcher already running (" + ws.ageSec + "s ago)");
      process.exit(0);
    }
    const { spawn: spawnChild } = require("child_process");
    const child = spawnChild("sextant", ["watch"], {
      cwd: root,
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    console.log("watcher started (pid " + child.pid + ")");
    process.exit(0);
  }

  // ---- watch-stop: kill the watcher ----
  if (cmd === "watch-stop") {
    const root = process.cwd();
    const hbPath = path.join(root, ".planning", "intel", ".watcher_heartbeat");
    // Find and kill the watcher process
    try {
      const { execSync } = require("child_process");
      const pids = execSync("pgrep -f 'sextant watch'", { encoding: "utf8" }).trim().split("\n");
      for (const pid of pids) {
        if (pid && pid !== String(process.pid)) {
          process.kill(parseInt(pid, 10), "SIGTERM");
        }
      }
      if (fs.existsSync(hbPath)) fs.unlinkSync(hbPath);
      console.log("watcher stopped");
    } catch {
      console.log("no watcher running");
    }
    process.exit(0);
  }

  const roots = rootsFromArgs(process.argv);

  switch (cmd) {
    case "init": {
      for (const r of roots) await intel.init(r);
      break;
    }

    case "scan":
    case "rescan": {
      const pruneMissing = cmd === "rescan";
      const forceReindex = hasFlag(process.argv, "--force");
      const viz = require("../lib/terminal-viz");
      const isTTY = process.stdout.isTTY;
      
      // Collect positional glob arguments (after cmd, before --flags)
      const cliGlobs = [];
      for (let i = 1; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith("--")) break;
        cliGlobs.push(a);
      }

      for (const r of roots) {
        const cfg = loadRepoConfig(r);
        const globs = cliGlobs.length ? cliGlobs : cfg.globs;
        
        // Progress callback for visual feedback
        let lastRender = 0;
        let skippedCount = 0;
        let indexedCount = 0;
        const onProgress = ({ phase, total, processed, file, skipped }) => {
          // Track skipped vs indexed
          if (phase === "indexing") {
            if (skipped) skippedCount++;
            else indexedCount++;
          }
          
          if (!isTTY) {
            // Non-TTY: just print dots or simple status
            if (phase === "start") process.stdout.write(`Scanning ${r}...`);
            else if (phase === "done") {
              const skipNote = skippedCount > 0 ? `, ${skippedCount} unchanged` : "";
              process.stdout.write(` done (${indexedCount} indexed${skipNote})\n`);
            }
            return;
          }
          
          const now = Date.now();
          // Throttle renders to ~60fps max
          if (phase === "indexing" && now - lastRender < 16) return;
          lastRender = now;
          
          const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
          const barWidth = 30;
          const progressBar = viz.bar(pct, barWidth, { showPercent: false, thresholds: { warn: 0, danger: 0 } });
          
          // Truncate filename to fit
          const maxFileLen = 40;
          let displayFile = file || "";
          if (displayFile.length > maxFileLen) {
            displayFile = "..." + displayFile.slice(-maxFileLen + 3);
          }
          
          if (phase === "start") {
            process.stdout.write(`\n${viz.c(`Scanning ${r}`, viz.colors.bold)}${forceReindex ? viz.c(" (forced)", viz.colors.yellow) : ""}\n`);
          } else if (phase === "indexing") {
            const skipIndicator = skipped ? viz.dim(" [skip]") : "";
            const status = `  ${progressBar} ${processed}/${total}  ${viz.dim(displayFile)}${skipIndicator}`;
            process.stdout.write(`\r\x1b[K${status}`);
          } else if (phase === "flushing") {
            process.stdout.write(`\r\x1b[K  ${progressBar} ${processed}/${total}  ${viz.dim("writing index...")}`);
          } else if (phase === "done") {
            const finalBar = viz.bar(100, barWidth, { showPercent: false, thresholds: { warn: 0, danger: 0 } });
            const skipNote = skippedCount > 0 ? viz.dim(` (${skippedCount} unchanged)`) : "";
            process.stdout.write(`\r\x1b[K  ${finalBar} ${viz.c(`${indexedCount} files indexed`, viz.colors.green)}${skipNote}\n\n`);
          }
        };
        
        await intel.scan(r, globs, { ignore: cfg.ignore, pruneMissing, onProgress, force: forceReindex });
      }
      break;
    }

    case "update": {
      const r = roots[0];
      const rel = flag(process.argv, "--file") || argv[1];
      if (!rel) usage(1);
      await intel.updateFile(r, rel);
      break;
    }

    case "watch": {
      const secStr = flag(process.argv, "--summary-every");
      const sec = secStr ? Number.parseFloat(secStr) : null;
      if (secStr && (!Number.isFinite(sec) || sec < 0)) {
        console.error("Invalid --summary-every value");
        process.exit(1);
      }
      
      const noDashboard = hasFlag(process.argv, "--no-dashboard");

      const { watchRoots } = require("../watch");
      await watchRoots(roots, {
        loadRepoConfig,
        summaryEverySecOverride: sec,
        dashboard: !noDashboard,
      });
      break;
    }

    case "summary": {
      const r = roots[0];
      const s = intel.readSummary(r);
      process.stdout.write(s && s.trim() ? s : "No summary\n");
      break;
    }

    case "health": {
      const r = roots[0];
      const h = await intel.health(r);
      
      // --pretty flag for visual output
      if (hasFlag(process.argv, "--pretty")) {
        const viz = require("../lib/terminal-viz");
        const lines = [];
        
        lines.push(viz.c("# Health Report", viz.colors.bold, viz.colors.cyan));
        lines.push("");
        
        // Resolution bar
        const pct = h.resolutionPct ?? 0;
        const resolved = h.localResolved ?? 0;
        const total = h.localTotal ?? 0;
        lines.push(`  ${viz.c("Resolution".padEnd(14), viz.colors.dim)}${viz.bar(pct, 25)} ${resolved}/${total}`);
        
        // Index stats
        const indexed = h.metrics?.indexedFiles ?? h.index?.files ?? h.indexedFiles ?? 0;
        lines.push(`  ${viz.c("Indexed".padEnd(14), viz.colors.dim)}${indexed} files`);
        const ageSec = h.metrics?.indexAgeSec ?? h.indexAgeSec ?? null;
        lines.push(`  ${viz.c("Index Age".padEnd(14), viz.colors.dim)}${viz.ageStatus(ageSec)}`);
        
        // Type distribution (if available)
        const typeCounts = h.metrics?.typeCounts ?? h.typeCounts ?? [];
        if (typeCounts.length > 0) {
          lines.push("");
          lines.push(viz.c("  File Types", viz.colors.dim));
          const maxTypeCount = Math.max(...typeCounts.map(x => x.c));
          for (const { t, c: count } of typeCounts.slice(0, 5)) {
            const pctOfMax = (count / maxTypeCount) * 100;
            lines.push(`    ${t.padEnd(12)} ${viz.bar(pctOfMax, 12, { showPercent: false, thresholds: { warn: 0, danger: 0 } })} ${count}`);
          }
        }
        
        // Top misses
        if (h.topMisses && h.topMisses.length > 0) {
          lines.push("");
          lines.push(viz.c("  Unresolved Imports", viz.colors.dim));
          for (const [spec, count] of h.topMisses.slice(0, 5)) {
            lines.push(`    ${viz.c(String(count).padStart(3), viz.colors.yellow)} ${spec}`);
          }
        }
        
        lines.push("");
        process.stdout.write(lines.join("\n") + "\n");
      } else {
        process.stdout.write(JSON.stringify(h, null, 2) + "\n");
      }
      break;
    }

    case "doctor": {
      const r = roots[0];
      const rootAbs = path.resolve(r);
      const h = await intel.health(r);
      const cfg = loadRepoConfig(r);
      const viz = require("../lib/terminal-viz");

      const lines = [];
      lines.push(viz.c("# sextant doctor", viz.colors.bold, viz.colors.cyan));
      lines.push("");

      // State files
      lines.push(viz.header("State"));
      const stateDir = path.join(rootAbs, ".planning", "intel");
      const graphDb = path.join(stateDir, "graph.db");
      const indexJson = path.join(stateDir, "index.json");
      const summaryMd = path.join(stateDir, "summary.md");
      const claudeSettings = path.join(rootAbs, ".claude", "settings.json");

      lines.push(viz.metric("state dir", fs.existsSync(stateDir) ? viz.status("ok", stateDir) : viz.status("error", stateDir)));
      lines.push(viz.metric("graph.db", fs.existsSync(graphDb) ? viz.status("ok", "exists") : viz.status("error", "missing")));
      lines.push(viz.metric("index.json", fs.existsSync(indexJson) ? viz.status("ok", "exists") : viz.status("error", "missing")));
      lines.push(viz.metric("summary.md", fs.existsSync(summaryMd) ? viz.status("ok", "exists") : viz.status("error", "missing")));
      lines.push(viz.metric("claude settings", fs.existsSync(claudeSettings) ? viz.status("ok", "exists") : viz.status("warn", "missing")));

      // Health metrics
      lines.push(viz.header("Health"));
      const pct = h.metrics?.resolutionPct ?? h.resolutionPct ?? 0;
      const resolved = h.metrics?.localResolved ?? h.localResolved ?? 0;
      const total = h.metrics?.localTotal ?? h.localTotal ?? 0;
      const ageSec = h.metrics?.indexAgeSec ?? h.indexAgeSec ?? 0;
      const indexed = h.metrics?.indexedFiles ?? h.index?.files ?? 0;

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
      const rgInstalled = require("child_process").spawnSync("which", ["rg"]).status === 0;
      const zoektInstalled = require("child_process").spawnSync("which", ["zoekt-webserver"]).status === 0;
      lines.push(viz.metric("ripgrep (rg)", rgInstalled ? viz.status("ok", "installed") : viz.status("error", "missing")));
      lines.push(viz.metric("zoekt", zoektInstalled ? viz.status("ok", "installed") : viz.status("info", "not installed (optional)")));

      // Hints
      lines.push(viz.header("Hints"));
      if (!fs.existsSync(stateDir)) {
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
      break;
    }

    case "query": {
      const sub = argv[1];
      const r = roots[0];
      const rel = flag(process.argv, "--file") || argv[2];
      if (!sub || !rel) usage(1);

      if (sub === "imports") {
        const out = await intel.queryImports(r, rel);
        process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      } else if (sub === "dependents") {
        const out = await intel.queryDependents(r, rel);
        process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      } else if (sub === "exports") {
        const out = await intel.queryExports(r, rel);
        process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      } else {
        usage(1);
      }
      break;
    }

    case "retrieve": {
      const r = roots[0];
      const boolFlags = new Set(["--explain-hits", "--zoekt-build", "--pretty"]);
      const parts = [];
      for (let i = 1; i < argv.length; i += 1) {
        const a = argv[i];
        if (a.startsWith("--")) {
          if (boolFlags.has(a)) continue;
          i += 1;
          continue;
        }
        parts.push(a);
      }
      const q = parts.join(" ").trim();
      if (!q) {
        console.error(
          "Usage: sextant retrieve <query> [--backend auto|zoekt|rg] [--context N] [--context-mode lines|function|class] [--max-scope-lines N] [--max-hits N] [--max-files N] [--expand imports,dependents] [--max-related N] [--hits-per-file N] [--explain-hits] [--rerank-min-resolution N] [--zoekt-build] [--zoekt-port N] [--pretty]"
        );
        process.exit(1);
      }

      const backend = flag(process.argv, "--backend");
      const contextLines = parseInt(flag(process.argv, "--context") || "", 10);
      const contextModeRaw = (flag(process.argv, "--context-mode") || "").toLowerCase();
      const contextMode = ["lines", "function", "class"].includes(contextModeRaw)
        ? contextModeRaw
        : "lines";
      const maxScopeLines = parseInt(flag(process.argv, "--max-scope-lines") || "", 10);
      const maxHits = parseInt(flag(process.argv, "--max-hits") || "", 10);
      const maxFiles = parseInt(flag(process.argv, "--max-files") || "", 10);
      const maxRelated = parseInt(flag(process.argv, "--max-related") || "", 10);
      const hitsPerFile = parseInt(flag(process.argv, "--hits-per-file") || "", 10);
      const rerankMinResolution = parseInt(flag(process.argv, "--rerank-min-resolution") || "", 10);
      const expandRaw = flag(process.argv, "--expand");
      const zoektPort = parseInt(flag(process.argv, "--zoekt-port") || "", 10);
      const prettyOutput = hasFlag(process.argv, "--pretty");

      const out = await retrieve(r, q, {
        backend: backend || "auto",
        contextLines: Number.isFinite(contextLines) ? contextLines : 1,
        contextMode,
        maxScopeLines: Number.isFinite(maxScopeLines) ? maxScopeLines : 200,
        maxHits: Number.isFinite(maxHits) ? maxHits : 50,
        maxSeedFiles: Number.isFinite(maxFiles) ? maxFiles : 10,
        expand: expandRaw
          ? expandRaw
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : ["imports", "dependents"],
        maxRelated: Number.isFinite(maxRelated) ? maxRelated : 30,
        hitsPerFileCap: Number.isFinite(hitsPerFile) ? hitsPerFile : 5,
        explainHits: hasFlag(process.argv, "--explain-hits") || prettyOutput,
        rerankMinResolutionPct: Number.isFinite(rerankMinResolution)
          ? rerankMinResolution
          : 90,
        zoektBuild: hasFlag(process.argv, "--zoekt-build"),
        zoektPort: Number.isFinite(zoektPort) ? zoektPort : 6070,
      });

      if (prettyOutput) {
        const viz = require("../lib/terminal-viz");
        const lines = [];
        
        lines.push(viz.c(`# Search: "${q}"`, viz.colors.bold, viz.colors.cyan));
        lines.push("");
        
        // Provider info
        const provider = out.providers?.search?.name || "unknown";
        const graphAvail = out.providers?.graph?.available ? viz.status("ok", "yes") : viz.status("warn", "no");
        lines.push(`  ${viz.dim("Provider:")} ${provider}  ${viz.dim("Graph:")} ${graphAvail}`);
        lines.push("");
        
        // Files with relevance bars
        const files = out.results?.files || [];
        if (files.length > 0) {
          lines.push(viz.header("Top Files"));
          
          // Find max score for normalization
          const maxScore = Math.max(...files.map(f => f.bestAdjustedHitScore || f.bestHitScore || 0), 0.01);
          
          for (const f of files.slice(0, 10)) {
            const score = f.bestAdjustedHitScore || f.bestHitScore || 0;
            const pct = Math.round((score / maxScore) * 100);
            const relBar = viz.bar(pct, 12, { showPercent: false, thresholds: { warn: 0, danger: 0 } });
            
            // Badges
            const badges = [];
            if (f.isEntryPoint) badges.push(viz.c("entry", viz.colors.green));
            if (f.isHotspot) badges.push(viz.c("hotspot", viz.colors.yellow));
            if (f.fanIn > 0) badges.push(viz.dim(`↓${f.fanIn}`));
            
            const badgeStr = badges.length ? ` ${badges.join(" ")}` : "";
            const scoreStr = score.toFixed(2).padStart(5);
            
            lines.push(`  ${relBar} ${viz.c(scoreStr, viz.colors.cyan)} ${f.path}${badgeStr}`);
          }
          lines.push("");
        }
        
        // Hits with context
        const hits = out.results?.hits || [];
        if (hits.length > 0) {
          lines.push(viz.header("Hits"));
          
          const maxHitScore = Math.max(...hits.map(h => h.adjustedScore || 0), 0.01);
          let lastPath = null;
          
          for (const h of hits.slice(0, 15)) {
            // Group by file
            if (h.path !== lastPath) {
              if (lastPath !== null) lines.push("");
              lines.push(`  ${viz.c(h.path, viz.colors.bold)}`);
              lastPath = h.path;
            }
            
            const score = h.adjustedScore || 0;
            const pct = Math.round((score / maxHitScore) * 100);
            const miniBar = viz.bar(pct, 8, { showPercent: false, thresholds: { warn: 0, danger: 0 } });
            
            const lineNum = h.lineNumber != null ? viz.dim(`:${h.lineNumber}`) : "";
            const lineText = (h.line || "").trim().slice(0, 60);
            const signals = h.signals?.length ? viz.dim(` [${h.signals.join(", ")}]`) : "";
            
            lines.push(`    ${miniBar} ${lineNum.padEnd(6)} ${lineText}${signals}`);
          }
          lines.push("");
        }
        
        // Related files
        const related = out.results?.related || [];
        if (related.length > 0) {
          lines.push(viz.header("Related Files"));
          
          const imports = related.filter(r => r.relation === "imports").slice(0, 5);
          const dependents = related.filter(r => r.relation === "depended_on_by").slice(0, 5);
          
          if (imports.length) {
            lines.push(`  ${viz.dim("Imports:")}`);
            for (const r of imports) {
              lines.push(`    → ${r.path} ${viz.dim(`(from ${r.from})`)}`);
            }
          }
          if (dependents.length) {
            lines.push(`  ${viz.dim("Depended on by:")}`);
            for (const r of dependents) {
              lines.push(`    ← ${r.path} ${viz.dim(`(uses ${r.from})`)}`);
            }
          }
          lines.push("");
        }
        
        // Warnings
        if (out.warnings?.length) {
          lines.push(viz.header("Warnings"));
          for (const w of out.warnings) {
            lines.push(`  ${viz.status("warn", w)}`);
          }
          lines.push("");
        }
        
        process.stdout.write(lines.join("\n") + "\n");
      } else {
        process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      }
      break;
    }

    case "zoekt": {
      const sub = argv[1];
      const r = roots[0];
      if (!sub) {
        console.error("Usage: sextant zoekt <index|serve|search> ...");
        process.exit(1);
      }

      if (sub === "index") {
        const force = hasFlag(process.argv, "--force");
        const res = zoekt.buildIndex(r, { force });
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
        break;
      }

      if (sub === "serve") {
        const port = parseInt(flag(process.argv, "--port") || "", 10);
        const autoIndex = hasFlag(process.argv, "--build");
        const res = await zoekt.ensureWebserver(r, {
          port: Number.isFinite(port) ? port : 6070,
          autoIndex,
        });
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
        break;
      }

      if (sub === "search") {
        const parts = [];
        for (let i = 2; i < argv.length; i += 1) {
          const a = argv[i];
          if (a.startsWith("--")) {
            i += 1;
            continue;
          }
          parts.push(a);
        }
        const q = parts.join(" ").trim();
        if (!q) {
          console.error("Usage: sextant zoekt search <query>");
          process.exit(1);
        }
        const port = parseInt(flag(process.argv, "--port") || "", 10);
        const contextLines = parseInt(flag(process.argv, "--context") || "", 10);
        const maxHits = parseInt(flag(process.argv, "--max-hits") || "", 10);

        const res = await zoekt.search(r, q, {
          port: Number.isFinite(port) ? port : 6070,
          contextLines: Number.isFinite(contextLines) ? contextLines : 1,
          maxHits: Number.isFinite(maxHits) ? maxHits : 50,
        });
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
        break;
      }

      console.error("Usage: sextant zoekt <index|serve|search> ...");
      process.exit(1);
    }

    default:
      usage(1);
  }
})().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});
