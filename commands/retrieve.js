const { retrieve } = require("../lib/retrieve");
const { flag, hasFlag } = require("../lib/cli");

async function run(ctx) {
  const r = ctx.roots[0];
  const boolFlags = new Set(["--explain-hits", "--zoekt-build", "--pretty"]);
  const parts = [];
  for (let i = 1; i < ctx.argv.length; i += 1) {
    const a = ctx.argv[i];
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
}

module.exports = { run };
