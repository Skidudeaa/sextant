const intel = require("../lib/intel");
const { loadRepoConfig } = require("../lib/config");
const { hasFlag } = require("../lib/cli");
const zoekt = require("../lib/zoekt");

async function run(ctx) {
  const pruneMissing = ctx.argv[0] === "rescan";
  const forceReindex = hasFlag(process.argv, "--force");
  const viz = require("../lib/terminal-viz");
  const isTTY = process.stdout.isTTY;

  // Collect positional glob arguments (after cmd, before --flags)
  const cliGlobs = [];
  for (let i = 1; i < ctx.argv.length; i++) {
    const a = ctx.argv[i];
    if (a.startsWith("--")) break;
    cliGlobs.push(a);
  }

  for (const r of ctx.roots) {
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

    // WHY: Build Zoekt index after scan so search is ready immediately.
    // Non-critical — log but don't fail the scan if Zoekt indexing fails.
    if (zoekt.isInstalled()) {
      try {
        zoekt.buildIndex(r, { force: forceReindex });
      } catch (err) {
        process.stderr.write(`[sextant] zoekt index: ${err.message}\n`);
      }
    }
  }
}

module.exports = { run };
