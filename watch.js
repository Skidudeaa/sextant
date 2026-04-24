const chokidar = require("chokidar");
const path = require("path");
const fs = require("fs");

const intel = require("./lib/intel");
const viz = require("./lib/terminal-viz");
const { shouldReindex, triggerReindex } = require("./lib/zoekt-reindex");

// WHY: Heartbeat file lets hooks detect whether the watcher is running.
// Written on start and after each flush.  Hooks read the mtime to
// determine watcher status (alive if < 90s old, stale otherwise).
//
// WHY structured JSON body: mtime alone can't distinguish "watcher alive
// and idle with no file changes" from "watcher alive but chokidar stopped
// delivering events hours ago" — both look the same to a 30s interval
// ticking setInterval. Embedding `lastEventMs` and `lastFlushMs` lets the
// status layer separate healthy-idle from potentially-stuck. First line is
// kept as the ISO timestamp so any legacy reader that only cares about
// liveness (and reads the first line as a date) still works; the JSON body
// on the remaining lines is optional extra context.
function writeHeartbeat(root, lastFile, activity) {
  try {
    const dir = path.join(root, ".planning", "intel");
    const nowIso = new Date().toISOString();
    const payload = {
      heartbeat: nowIso,
      pid: process.pid,
      lastEventMs: activity?.lastEventMs ?? null,
      lastFlushMs: activity?.lastFlushMs ?? null,
      totalUpdates: activity?.totalUpdates ?? null,
    };
    fs.writeFileSync(
      path.join(dir, ".watcher_heartbeat"),
      nowIso + "\n" + JSON.stringify(payload) + "\n"
    );
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

// WHY: Heartbeat-based dedup is racy — during a new watcher's 100ms init window
// it hasn't written heartbeat yet, so a concurrent SessionStart sees stale heartbeat
// and spawns another. This caused 17+ zombie watchers (7 GB RSS) to accumulate over
// weeks. An atomic PID lockfile at the watcher's own startup prevents duplicates at
// the source: second spawner loses the `wx` race and exits cleanly.
function pidLockPath(root) {
  return path.join(root, ".planning", "intel", ".watcher.pid");
}

function isPidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0); // signal 0 = liveness probe, doesn't actually send
    return true;
  } catch (e) {
    // ESRCH = no such process; EPERM = exists but we can't signal it (still alive)
    return e.code === "EPERM";
  }
}

// Returns true on successful claim, false if another live watcher holds the lock.
function claimPidLock(root) {
  const lockPath = pidLockPath(root);
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch {}
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") return false;
      // Lockfile exists — check if holder is alive
      let holderPid = null;
      try {
        holderPid = parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
      } catch {}
      if (isPidAlive(holderPid) && holderPid !== process.pid) return false;
      // Stale lock — remove and retry
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }
}

function releasePidLock(root) {
  const lockPath = pidLockPath(root);
  try {
    const holderPid = parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
    if (holderPid === process.pid) fs.unlinkSync(lockPath);
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
    // WHY separate from lastUpdateTime: lastUpdateTime is when the update
    // finished flushing through the queue; lastEventTime is when chokidar
    // first saw the change. The gap between them is the queue lag. If
    // lastEventTime advances but lastUpdateTime doesn't, flushes are stuck.
    lastEventTime: null,
    lastFlushTime: null,
    recentUpdates: [],       // timestamps of recent updates (for sparkline)
    errors: 0,
    resolutionPct: null,
    indexedFiles: null,
  };
}

// Extract activity signal snapshot for the heartbeat payload.
function dashboardActivityFor(dashState) {
  return {
    lastEventMs: dashState.lastEventTime,
    lastFlushMs: dashState.lastFlushTime,
    totalUpdates: dashState.totalUpdates,
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
  const lockedRoots = [];

  for (const root of roots) {
    // WHY: Claim the PID lockfile before any expensive init. If another watcher
    // already owns this root, exit cleanly rather than accumulating duplicates.
    if (!claimPidLock(root)) {
      process.stderr.write(`[intel] ${root}: another watcher holds the lock — exiting\n`);
      for (const r of lockedRoots) releasePidLock(r);
      process.exit(0);
    }
    lockedRoots.push(root);

    const cfg = loadRepoConfig(root);
    const globs = cfg.globs;
    const ignored = cfg.ignore;

    const throttleMs = Math.floor(
      (summaryEverySecOverride ?? cfg.summaryEverySec ?? 0) * 1000
    );

    await intel.init(root);
    // Initialize dashboard state first so writeHeartbeat can read activity
    const dashState = createDashboardState(root);
    dashboardStates.push(dashState);
    writeHeartbeat(root, null, dashboardActivityFor(dashState));
    
    // Get initial health
    try {
      const h = await intel.health(root);
      dashState.resolutionPct = h.resolutionPct ?? h.metrics?.resolutionPct ?? null;
      dashState.indexedFiles = h.index?.files ?? h.metrics?.indexedFiles ?? null;
    } catch {}

    // WHY: Periodic heartbeat keeps the status line showing "live" even when
    // no files are changing.  Without this, an idle watcher looks dead after 120s.
    // Passes current activity so readers can tell "healthy idle" (recent
    // lastEventMs, no pending flushes) from "stuck" (lastEventMs unchanged
    // despite file activity).
    const heartbeatInterval = setInterval(
      () => writeHeartbeat(root, null, dashboardActivityFor(dashState)),
      30000
    );
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
      dashState.lastFlushTime = Date.now();
      writeHeartbeat(root, dashState.lastUpdateFile, dashboardActivityFor(dashState));
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

      // WHY: Piggyback on the flush cycle rather than adding a separate interval.
      // Non-blocking: triggerReindex spawns a detached child and returns immediately.
      // shouldReindex checks: binaries installed, 3min cooldown, not in progress, files changed.
      if (shouldReindex(root, { filesChanged: files.length })) {
        triggerReindex(root);
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
      // WHY record event timing separately from flushes: a healthy watcher
      // with no file changes has no flushes, but a silently-stuck watcher
      // (chokidar deaf to events on NFS/overlayfs, ENOSPC on inotify) also
      // has no flushes. Tracking lastEventMs distinguishes the two: idle
      // repos have no events AND no flushes (expected); stuck watchers have
      // files actually changing on disk but no onChange firing.
      dashState.lastEventTime = Date.now();
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
    for (const r of lockedRoots) releasePidLock(r);
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await new Promise(() => {});
}

module.exports = {
  watchRoots,
  writeHeartbeat,
  clearHeartbeat,
  claimPidLock,
  releasePidLock,
  isPidAlive,
  pidLockPath,
};

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

  const { loadRepoConfig } = require("./lib/config");

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

