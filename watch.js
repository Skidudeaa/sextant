const chokidar = require("chokidar");
const path = require("path");
const fs = require("fs");

const intel = require("./lib/intel");
const viz = require("./lib/terminal-viz");

// WHY: Heartbeat file lets hooks detect whether the watcher is running.
// Written on start and after each flush.  Hooks read the mtime to
// determine watcher status (alive if < 60s old, stale otherwise).
function writeHeartbeat(root, lastFile) {
  try {
    const dir = path.join(root, ".planning", "intel");
    fs.writeFileSync(path.join(dir, ".watcher_heartbeat"), new Date().toISOString() + "\n");
    // WHY: Persist last processed file so the status line can show what
    // the watcher is actually doing — not git log, not guesses.
    if (lastFile) {
      fs.writeFileSync(path.join(dir, ".watcher_last_file"), lastFile + "\n");
    }
  } catch {}
}

function clearHeartbeat(root) {
  try {
    const p = path.join(root, ".planning", "intel", ".watcher_heartbeat");
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {}
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/**
 * Live dashboard state for a single root
 */
function createDashboardState(root) {
  return {
    root,
    startTime: Date.now(),
    totalUpdates: 0,
    lastUpdateTime: null,
    lastUpdateFile: null,
    recentUpdates: [],       // timestamps of recent updates (for sparkline)
    errors: 0,
    resolutionPct: null,
    indexedFiles: null,
  };
}

/**
 * Render the live dashboard (overwrites previous output)
 */
function renderDashboard(states, isTTY) {
  if (!isTTY) return; // Skip rendering in non-TTY mode
  
  const lines = [];
  const now = Date.now();
  
  lines.push("");
  lines.push(viz.c("━".repeat(60), viz.colors.dim));
  lines.push(viz.c(" sextant watcher", viz.colors.bold, viz.colors.cyan));
  lines.push(viz.c("━".repeat(60), viz.colors.dim));
  
  for (const st of states) {
    const uptime = Math.floor((now - st.startTime) / 1000);
    const uptimeStr = uptime < 60 ? `${uptime}s` : `${Math.floor(uptime / 60)}m ${uptime % 60}s`;
    
    // Activity sparkline (last 20 time buckets, 3s each)
    const buckets = new Array(20).fill(0);
    const bucketMs = 3000;
    for (const ts of st.recentUpdates) {
      const age = now - ts;
      const bucketIdx = Math.floor(age / bucketMs);
      if (bucketIdx >= 0 && bucketIdx < buckets.length) {
        buckets[buckets.length - 1 - bucketIdx] += 1;
      }
    }
    const activitySparkline = viz.sparkline(buckets);
    
    // Last update age
    let lastUpdateStr = viz.dim("none");
    if (st.lastUpdateTime) {
      const ageSec = Math.floor((now - st.lastUpdateTime) / 1000);
      lastUpdateStr = viz.ageStatus(ageSec, { warn: 60, danger: 300 });
    }
    
    // Resolution bar
    let resBar = viz.dim("--");
    if (st.resolutionPct != null) {
      resBar = viz.bar(st.resolutionPct, 12, { showPercent: true });
    }
    
    // Truncate root path
    const maxRootLen = 40;
    let displayRoot = st.root;
    if (displayRoot.length > maxRootLen) {
      displayRoot = "..." + displayRoot.slice(-maxRootLen + 3);
    }
    
    lines.push("");
    lines.push(`  ${viz.c(displayRoot, viz.colors.bold)}`);
    lines.push(`  ${viz.dim("Uptime:")} ${uptimeStr}  ${viz.dim("Updates:")} ${st.totalUpdates}  ${viz.dim("Errors:")} ${st.errors > 0 ? viz.c(String(st.errors), viz.colors.red) : viz.c("0", viz.colors.green)}`);
    lines.push(`  ${viz.dim("Resolution:")} ${resBar}  ${viz.dim("Files:")} ${st.indexedFiles ?? "?"}`);
    lines.push(`  ${viz.dim("Activity:")} ${activitySparkline}  ${viz.dim("Last:")} ${lastUpdateStr}`);
    
    if (st.lastUpdateFile) {
      let displayFile = st.lastUpdateFile;
      if (displayFile.length > 45) {
        displayFile = "..." + displayFile.slice(-42);
      }
      lines.push(`  ${viz.dim("File:")} ${displayFile}`);
    }
  }
  
  lines.push("");
  lines.push(viz.c("━".repeat(60), viz.colors.dim));
  lines.push(viz.dim("  Press Ctrl+C to stop"));
  lines.push("");
  
  // Move cursor up and clear, then render
  const output = lines.join("\n");
  const lineCount = lines.length;
  
  // Clear previous output and render new
  process.stderr.write(`\x1b[${lineCount}A\x1b[J${output}`);
}

async function watchRoots(roots, { loadRepoConfig, summaryEverySecOverride = null, dashboard = true }) {
  const watchers = [];
  const isTTY = process.stderr.isTTY && dashboard;
  const dashboardStates = [];
  const heartbeatIntervals = [];
  const healthCache = new Map(); // root -> { data, ts }

  for (const root of roots) {
    const cfg = loadRepoConfig(root);
    const globs = cfg.globs;
    const ignored = cfg.ignore;

    const throttleMs = Math.floor(
      (summaryEverySecOverride ?? cfg.summaryEverySec ?? 0) * 1000
    );

    await intel.init(root);
    writeHeartbeat(root);

    // Initialize dashboard state
    const dashState = createDashboardState(root);
    dashboardStates.push(dashState);
    
    // Get initial health
    try {
      const h = await intel.health(root);
      dashState.resolutionPct = h.resolutionPct ?? h.metrics?.resolutionPct ?? null;
      dashState.indexedFiles = h.index?.files ?? h.metrics?.indexedFiles ?? null;
    } catch {}

    // WHY: Periodic heartbeat keeps the status line showing "live" even when
    // no files are changing.  Without this, an idle watcher looks dead after 120s.
    const heartbeatInterval = setInterval(() => writeHeartbeat(root), 30000);
    heartbeatIntervals.push(heartbeatInterval);

    const pending = new Set();
    const flush = debounce(async () => {
      const files = [...pending];
      pending.clear();
      if (!files.length) return;

      for (const rel of files) {
        try {
          await intel.updateFile(root, rel, { summaryThrottleMs: throttleMs });
          
          // Update dashboard state
          dashState.totalUpdates += 1;
          dashState.lastUpdateTime = Date.now();
          dashState.lastUpdateFile = rel;
          dashState.recentUpdates.push(Date.now());
          
          // Keep only last 60 seconds of updates
          const cutoff = Date.now() - 60000;
          dashState.recentUpdates = dashState.recentUpdates.filter(t => t > cutoff);
          
        } catch (e) {
          dashState.errors += 1;
          if (!isTTY) {
            process.stderr.write(`[intel] ${root}: update failed ${rel}: ${e.message}\n`);
          }
        }
      }
      
      // Refresh health metrics + heartbeat after each flush
      writeHeartbeat(root, dashState.lastUpdateFile);
      // WHY: Health check iterates all files/imports in the index (~6ms at 10k files).
      // Dashboard renders once per second, so computing health more often is wasted work
      // that also blocks the queue.
      const now = Date.now();
      const cached = healthCache.get(root);
      if (!cached || now - cached.ts >= 1000) {
        try {
          const h = await intel.health(root);
          healthCache.set(root, { data: h, ts: now });
          dashState.resolutionPct = h.resolutionPct ?? h.metrics?.resolutionPct ?? null;
          dashState.indexedFiles = h.index?.files ?? h.metrics?.indexedFiles ?? null;
        } catch {}
      } else {
        dashState.resolutionPct = cached.data.resolutionPct ?? cached.data.metrics?.resolutionPct ?? null;
        dashState.indexedFiles = cached.data.index?.files ?? cached.data.metrics?.indexedFiles ?? null;
      }
      
    }, 250);

    const w = chokidar.watch(globs, {
      cwd: root,
      ignoreInitial: true,
      ignored,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });

    const onChange = (rel) => {
      pending.add(rel);
      flush();
    };

    w.on("add", onChange)
      .on("change", onChange)
      .on("unlink", (rel) => {
        // deletion drift is handled by nightly rescan; keep unlink cheap
        if (!isTTY) {
          process.stderr.write(`[intel] ${root}: unlink ignored ${rel}\n`);
        }
      })
      .on("error", (err) => {
        dashState.errors += 1;
        if (!isTTY) {
          process.stderr.write(`[intel] ${root}: watcher error: ${err}\n`);
        }
      })
      .on("ready", () => {
        if (!isTTY) {
          process.stderr.write(`[intel] watching ${root} (${globs.join(", ")})\n`);
        }
      });

    watchers.push(w);
  }

  // Start dashboard refresh loop
  let dashboardInterval = null;
  if (isTTY) {
    // Print initial blank lines to make room for dashboard
    const initialLines = 12 + dashboardStates.length * 6;
    process.stderr.write("\n".repeat(initialLines));
    
    dashboardInterval = setInterval(() => {
      renderDashboard(dashboardStates, isTTY);
    }, 1000);
    dashboardInterval.unref();
    
    // Initial render
    renderDashboard(dashboardStates, isTTY);
  }

  const shutdown = async (sig) => {
    if (dashboardInterval) clearInterval(dashboardInterval);
    
    if (isTTY) {
      process.stderr.write(`\n${viz.status("info", `Shutting down (${sig})...`)}\n`);
    } else {
      process.stderr.write(`[intel] shutting down (${sig})\n`);
    }
    
    for (const w of watchers) {
      try {
        await w.close();
      } catch {}
    }
    for (const iv of heartbeatIntervals) clearInterval(iv);
    for (const r of roots) clearHeartbeat(r);
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await new Promise(() => {});
}

module.exports = { watchRoots };

// Standalone runner (optional)
if (require.main === module) {
  const flag = (argv, name) => {
    const i = argv.indexOf(name);
    if (i === -1) return null;
    const v = argv[i + 1];
    return v && !v.startsWith("--") ? v : null;
  };

  const readRootsFile = (p) => {
    const txt = fs.readFileSync(p, "utf8");
    return txt
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => path.resolve(l));
  };

  const rootsFromArgs = (argv) => {
    const one = flag(argv, "--root");
    const many = flag(argv, "--roots");
    const file = flag(argv, "--roots-file");
    if (file) return readRootsFile(file);
    if (many) return many.split(",").map((s) => path.resolve(s.trim())).filter(Boolean);
    if (one) return [path.resolve(one)];
    return [process.cwd()];
  };

  const loadRepoConfig = (root) => {
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
  };

  const secStr = flag(process.argv, "--summary-every");
  const sec = secStr ? Number.parseFloat(secStr) : null;
  if (secStr && (!Number.isFinite(sec) || sec < 0)) {
    process.stderr.write("Invalid --summary-every value\n");
    process.exit(1);
  }

  const roots = rootsFromArgs(process.argv);
  watchRoots(roots, { loadRepoConfig, summaryEverySecOverride: sec }).catch((e) => {
    console.error(e?.stack || e?.message || String(e));
    process.exit(1);
  });
}

