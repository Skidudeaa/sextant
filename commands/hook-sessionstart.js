const fs = require("fs");
const path = require("path");
const intel = require("../lib/intel");
const { stripUnsafeXmlTags, getWatcherStatus, renderBanner, readStdinJson, applyFreshnessGate } = require("../lib/cli");

async function run() {
  const root = process.cwd();
  const data = await readStdinJson();
  const src = data.source;
  if (src && !["startup", "resume"].includes(src)) process.exit(0);

  await intel.init(root);
  const rawSummary = intel.readSummary(root);

  // WHY: gate the injection on real repo state, not elapsed time.  When
  // graph.db's structural claims are out of sync with HEAD / status / code
  // versions, applyFreshnessGate returns a minimal body (root + git +
  // signals + recent commits + "rescan requested|pending" marker) instead
  // of the full summary -- so we never ship hotspots/fan-in numbers that
  // could mislead Claude.  It also kicks off an atomic single-flight async
  // rescan in that case.  See lib/cli.js applyFreshnessGate for invariants.
  //
  // WHY call even when rawSummary is empty: on fresh init, summary.md is a
  // zero-byte placeholder and the early-exit guard would skip the gate.
  // But the gate is also what triggers the background rescan -- calling it
  // unconditionally ensures the first sextant scan is enqueued on first
  // SessionStart, not silently skipped.
  const summary = await applyFreshnessGate(rawSummary || "", root);
  if (!summary || !summary.trim()) process.exit(0);

  // stdout → Claude context
  const safeSummary = stripUnsafeXmlTags(summary.trim());
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

module.exports = { run };
