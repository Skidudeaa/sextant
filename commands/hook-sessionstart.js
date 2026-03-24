const fs = require("fs");
const path = require("path");
const intel = require("../lib/intel");
const { stripUnsafeXmlTags, getWatcherStatus, renderBanner, readStdinJson } = require("../lib/cli");

async function run() {
  const root = process.cwd();
  const data = await readStdinJson();
  const src = data.source;
  if (src && !["startup", "resume"].includes(src)) process.exit(0);

  await intel.init(root);
  const summary = intel.readSummary(root);
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
