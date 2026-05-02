const intel = require("../lib/intel");
const { loadRepoConfig } = require("../lib/config");
const { hasFlag, getWatcherStatus } = require("../lib/cli");
const zoekt = require("../lib/zoekt");
const telemetry = require("../lib/telemetry");

async function run(ctx) {
  const pruneMissing = ctx.argv[0] === "rescan";
  const forceReindex = hasFlag(process.argv, "--force");
  const allowConcurrent = hasFlag(process.argv, "--allow-concurrent");
  const viz = require("../lib/terminal-viz");
  const isTTY = process.stdout.isTTY;

  // WHY concurrent-run guard: a live watcher and a scan both loadDb → mutate
  // → persistDb. Even with the new cross-process write lock on graph.db, the
  // two processes can interleave (watcher handles file event mid-scan), and
  // sql.js gives each process its own in-memory copy — so a watcher flush
  // landing mid-scan can clobber scan's progress with stale state. Refusing
  // loudly is safer than racing; users who know what they're doing can pass
  // --allow-concurrent.
  if (!allowConcurrent) {
    for (const r of ctx.roots) {
      const ws = getWatcherStatus(r);
      if (ws.running) {
        const msg =
          `[sextant] watcher is running for ${r} (pid ${ws.pid ?? "?"}).\n` +
          `Two writers can race on graph.db. Stop it first:\n` +
          `  sextant watch-stop\n` +
          `Or override (at your own risk) with --allow-concurrent.\n`;
        process.stderr.write(msg);
        process.exit(2);
      }
    }
  }

  // Collect positional glob arguments (after cmd, before --flags)
  const cliGlobs = [];
  for (let i = 1; i < ctx.argv.length; i++) {
    const a = ctx.argv[i];
    if (a.startsWith("--")) break;
    cliGlobs.push(a);
  }

  // WHY trigger detection: the freshness gate (lib/freshness.js) spawns
  // `sextant scan --allow-concurrent --force` with SEXTANT_RESCAN_TRIGGER
  // set when its async rescan path fires.  Every other invocation is
  // either user-initiated or fired by an internal tool (e.g. session
  // bootstrap).  Recording the trigger on scan.completed lets the audit
  // pipeline split scan-duration percentiles and success rates by source
  // -- gate-triggered rescans are the ones whose latency Option 5 will
  // need to reason about.
  const trigger =
    process.env.SEXTANT_RESCAN_TRIGGER === "freshness_gate"
      ? "freshness_gate"
      : "manual";

  for (const r of ctx.roots) {
    const scanStartMs = Date.now();
    let scanSuccess = false;
    let scanError = null;

    const cfg = loadRepoConfig(r);
    const globs = cliGlobs.length ? cliGlobs : cfg.globs;

    // Progress callback for visual feedback
    let lastRender = 0;
    let skippedCount = 0;
    let indexedCount = 0;
    const onProgress = ({ phase, total, processed, file, skipped, ghostCount }) => {
      // Track skipped vs indexed
      if (phase === "indexing") {
        if (skipped) skippedCount++;
        else indexedCount++;
      }

      // WHY: ghost files are db entries whose source file no longer exists
      // (deleted without a rescan). `scan` intentionally doesn't prune; the
      // hint tells the user how to clean up.
      const ghostHint = (!pruneMissing && ghostCount > 0)
        ? `  (${ghostCount} stale — run: sextant rescan)`
        : "";

      if (!isTTY) {
        // Non-TTY: just print dots or simple status
        if (phase === "start") process.stdout.write(`Scanning ${r}...`);
        else if (phase === "done") {
          const skipNote = skippedCount > 0 ? `, ${skippedCount} unchanged` : "";
          process.stdout.write(` done (${indexedCount} indexed${skipNote})${ghostHint}\n`);
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
        const ghostNote = (!pruneMissing && ghostCount > 0)
          ? "\n  " + viz.c(`⚠ ${ghostCount} stale entries in index`, viz.colors.yellow) + viz.dim(" — run: sextant rescan")
          : "";
        process.stdout.write(`\r\x1b[K  ${finalBar} ${viz.c(`${indexedCount} files indexed`, viz.colors.green)}${skipNote}${ghostNote}\n\n`);
      }
    };

    try {
      await intel.scan(r, globs, {
        ignore: cfg.ignore,
        gitignoreFilter: cfg.gitignoreFilter,
        pruneMissing,
        onProgress,
        force: forceReindex,
      });

      // WHY: Trigger Zoekt reindex after scan so search is ready soon.
      // Uses triggerReindex (non-blocking background spawn) instead of buildIndex
      // (synchronous spawnSync) to avoid blocking the scan for 10-60s on large repos.
      try {
        const { triggerReindex } = require("../lib/zoekt-reindex");
        if (zoekt.isInstalled()) {
          triggerReindex(r);
        }
      } catch (err) {
        process.stderr.write(`[sextant] zoekt reindex: ${err.message}\n`);
      }
      scanSuccess = true;
    } catch (err) {
      scanError = err?.message || String(err);
      throw err;
    } finally {
      // WHY clear the rescan marker here (not in intel.js's bulk scan
      // path): if intel.scan throws before reaching its persist+clear
      // sequence, the marker would otherwise sit untouched until the
      // 5-minute orphan TTL expires, blocking every subsequent stale
      // read from triggering a fresh rescan.  Clearing in finally covers
      // both success and failure with no special-casing.
      const freshness = require("../lib/freshness");
      freshness.clearRescanMarker(r);

      // WHY in finally: scan.completed is the load-bearing telemetry event
      // for Option 5's adaptive sync/async chooser -- it must record on
      // both success AND failure so the audit pipeline can compute success
      // rate, not just mean-of-successful-durations.  durationMs is the
      // metric we'll percentile to decide whether sync rescan is safe per
      // repo.  trigger separates gate-fired rescans from user-initiated
      // ones (only the former matters for the sync decision).
      telemetry.recordEvent(r, "scan.completed", {
        durationMs: Date.now() - scanStartMs,
        success: scanSuccess,
        trigger,
        pruneMissing,
        forceReindex,
        ...(scanError ? { error: scanError } : {}),
      });
    }
  }
}

module.exports = { run };
