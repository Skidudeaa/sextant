const intel = require("../lib/intel");
const { loadRepoConfig } = require("../lib/config");
const { hasFlag, getWatcherStatus } = require("../lib/cli");
const zoekt = require("../lib/zoekt");
const telemetry = require("../lib/telemetry");
const freshness = require("../lib/freshness");

async function run(ctx) {
  const pruneMissing = ctx.argv[0] === "rescan";
  const forceReindex = hasFlag(process.argv, "--force");
  const allowConcurrent = hasFlag(process.argv, "--allow-concurrent");
  const viz = require("../lib/terminal-viz");
  const isTTY = process.stdout.isTTY;

  // WHY concurrent-run guard: a live watcher and a scan both loadDb → mutate
  // → persistDb from independent sql.js in-memory copies, so a watcher flush
  // landing mid-scan can clobber the scan with stale state. A CURRENT watcher
  // avoids this cooperatively: it advertises `scanPauseProtocol` in its
  // heartbeat and DEFERS its flushes while we hold the .scan_in_progress
  // marker (written per-root below). So we only refuse when the watcher is
  // running AND can't prove it'll pause — an older watcher with no
  // scanPauseProtocol field — AND the user hasn't forced it. --allow-concurrent
  // still bypasses everything (manual override). The marker is written
  // regardless, so even a forced concurrent run gets the watcher to defer.
  if (!allowConcurrent) {
    for (const r of ctx.roots) {
      const ws = getWatcherStatus(r);
      if (ws.running && !(ws.scanPauseProtocol >= 1)) {
        const msg =
          `[sextant] watcher is running for ${r} (pid ${ws.pid ?? "?"}) and predates the\n` +
          `scan-pause protocol, so it can't defer its writes while you scan.\n` +
          `Restart it (auto-restarts next Claude Code session) or stop it first:\n` +
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

    // WHY: drop the scan-in-progress marker so a live (current) watcher defers
    // its flushes and can't clobber us. Written even under --allow-concurrent
    // and even with no watcher — harmless if nobody reads it. Refreshed in
    // onProgress so a long scan keeps it fresh; cleared in finally.
    freshness.markScanInProgress(r);

    const cfg = loadRepoConfig(r);
    const globs = cliGlobs.length ? cliGlobs : cfg.globs;

    // Progress callback for visual feedback
    let lastRender = 0;
    let lastMarkerTouch = scanStartMs;
    let skippedCount = 0;
    let indexedCount = 0;
    const onProgress = ({ phase, total, processed, file, skipped, ghostCount }) => {
      // Refresh the scan-in-progress marker periodically so its mtime stays
      // within freshness.SCAN_MARKER_STALE_MS for the whole scan — otherwise a
      // long scan would let the marker go stale and the watcher would resume
      // mid-scan. Throttled so it isn't a write per file.
      const tNow = Date.now();
      if (tNow - lastMarkerTouch >= 10000) {
        lastMarkerTouch = tNow;
        freshness.markScanInProgress(r);
      }

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
      const scanResult = await intel.scan(r, globs, {
        ignore: cfg.ignore,
        gitignoreFilter: cfg.gitignoreFilter,
        // The .codebase-intel.json opt-out for the coverage diagnosis —
        // intel.scan skips the probe and clears any persisted note.
        coverageDiagnostics: cfg.coverageDiagnostics,
        pruneMissing,
        onProgress,
        force: forceReindex,
      });

      // WHY: a 0-file (or barely-populated) index is the #1 silent failure —
      // wrong globs or an unsupported language. The scan otherwise exits
      // "successfully" with a green-looking summary. Surface the diagnosis
      // loudly here, where the user is actually watching the terminal.
      const cov = scanResult && scanResult.coverage;
      if (cov && cov.kind && cov.kind !== "ok") {
        const label = cov.kind === "unsupported-language" ? "✗" : "⚠";
        const color = cov.kind === "unsupported-language" ? viz.colors.red : viz.colors.yellow;
        process.stdout.write(
          `\n  ${viz.c(`${label} ${cov.message}`, color)}\n`
        );
        if (cov.fix) {
          for (const line of String(cov.fix).split("\n")) {
            process.stdout.write(`    ${viz.dim(line)}\n`);
          }
        }
        process.stdout.write("\n");
      }

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
      // WHY clear in finally (not in intel.js's bulk scan path): if intel.scan
      // throws before reaching its persist+clear sequence, the markers would
      // sit untouched until their TTLs expire — the rescan marker blocking the
      // next stale-read rescan, the scan-in-progress marker freezing the
      // watcher's flushes. Clearing both here covers success and failure with
      // no special-casing.
      freshness.clearRescanMarker(r);
      freshness.clearScanMarker(r);

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
