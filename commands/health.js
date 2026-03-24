const intel = require("../lib/intel");
const { hasFlag } = require("../lib/cli");

async function run(ctx) {
  const r = ctx.roots[0];
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
}

module.exports = { run };
