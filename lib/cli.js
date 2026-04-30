const fs = require("fs");
const path = require("path");

// WHY: Defense-in-depth — strip XML tags that LLMs treat as structural boundaries.
// summary.md has xmlEscape at generation time, but a tampered file could inject
// closing tags to break out of the wrapper or inject fake system instructions.
function stripUnsafeXmlTags(s) {
  return s
    .replace(/<\/?codebase-intelligence[^>]*>/gi, "")
    .replace(/<\/?codebase-retrieval[^>]*>/gi, "")
    .replace(/<\/?system-reminder[^>]*>/gi, "")
    .replace(/<\/?tool_call[^>]*>/gi, "")
    .replace(/<\/?tool_result[^>]*>/gi, "")
    .replace(/<\/?antml:[a-z_]+[^>]*>/gi, "");
}

// WHY: stdout from hooks is injected as Claude context (<system-reminder>).
// stderr from hooks goes nowhere visible (not to user, not to Claude).
// The banner/status line is written to stderr as diagnostic output only;
// the user sees the statusLine config in .claude/settings.json instead.
function getWatcherStatus(root) {
  try {
    const hbPath = path.join(root, ".planning", "intel", ".watcher_heartbeat");
    if (!fs.existsSync(hbPath)) return { running: false };
    const stat = fs.statSync(hbPath);
    const ageSec = Math.floor((Date.now() - stat.mtimeMs) / 1000);
    // Heartbeat older than 90s means watcher likely died (write interval is 30s, threshold is 3x)
    const running = ageSec < 90;

    // WHY parse JSON payload: old heartbeat was just an ISO string on line 1.
    // New writers append a JSON object on line 2 with pid, lastEventMs,
    // lastFlushMs, totalUpdates. When reading the old format we fall through
    // with the extra fields undefined — liveness still works off mtime.
    let activity = null;
    try {
      const body = fs.readFileSync(hbPath, "utf8");
      const jsonLine = body.split("\n").find((l) => l.trim().startsWith("{"));
      if (jsonLine) activity = JSON.parse(jsonLine);
    } catch {
      // legacy format or malformed — activity stays null, running already decided
    }

    return {
      running,
      ageSec,
      pid: activity?.pid ?? null,
      lastEventMs: activity?.lastEventMs ?? null,
      lastFlushMs: activity?.lastFlushMs ?? null,
      totalUpdates: activity?.totalUpdates ?? null,
    };
  } catch {
    return { running: false };
  }
}

// WHY: summary.md bakes "index age Xs" at generation time.  On re-injection
// the text still claims the original age, so we substitute the current
// elapsed time at read time -- purely cosmetic, no staleness inference.
//
// HISTORY: this function used to also inject an "ALERT: INDEX STALE" line
// when elapsed time crossed 24h.  That logic moved to applyFreshnessGate
// below, which gates on actual repo state (HEAD, status hash, versions)
// rather than wall-clock age.  An idle 5-day-old graph of an unchanged
// repo is not stale; a 1-minute-old graph after a `git checkout` is.
//
// We strip any legacy "ALERT: INDEX STALE" line that an older version of
// the code may have baked into a still-on-disk summary.md.  The new gate
// owns staleness end-to-end; remnants from the old design must not leak.
function refreshSummaryAge(rawSummary, _root) {
  if (!rawSummary) return rawSummary;
  const m = rawSummary.match(/-\s+\*\*Generated\*\*:\s*(\S+)/);
  if (!m) return rawSummary;
  const generatedMs = Date.parse(m[1]);
  if (!Number.isFinite(generatedMs)) return rawSummary;

  const ageSec = Math.max(0, Math.floor((Date.now() - generatedMs) / 1000));
  return rawSummary
    .replace(/(index age )\d+s/, `$1${ageSec}s`)
    .replace(/^ALERT: INDEX STALE[^\n]*\n\n?/m, "");
}

// applyFreshnessGate is the staleness-aware entry point used by the
// SessionStart hook, the UserPromptSubmit hook, and the `sextant summary`
// / `sextant inject` CLI commands.  It enforces the invariant: stale
// structural claims (hotspots, fan-in counts, entry points, top files)
// never enter the prompt.  When the freshness check (lib/freshness.js)
// fails, this function:
//   1. Discards the rawSummary (which holds potentially-wrong numbers).
//   2. Builds a minimal body containing only fields that derive from the
//      live filesystem and `git`, plus a terse "rescan requested|pending"
//      marker reflecting the actual single-flight state.
//   3. Triggers an atomic async rescan via freshness.enqueueRescan().
//   4. Records freshness.stale_hit and freshness.blackout_turn telemetry
//      for the future Option-5 adaptive sync/async decision.
//
// On the fresh path, rawSummary is returned with elapsed-time refreshed,
// preserving the existing UX without any staleness annotation.
//
// Async because checkFreshness needs graph.loadDb (cached, but the call
// is async).  Callers must await.  The function never throws; on internal
// failure it fails-closed (treats as stale) -- better to blacked-out one
// turn than to leak unverified structural numbers.
async function applyFreshnessGate(rawSummary, rootAbs) {
  const freshness = require("./freshness");
  const telemetry = require("./telemetry");

  if (!rootAbs) return refreshSummaryAge(rawSummary, rootAbs);

  let result;
  try {
    result = await freshness.checkFreshness(rootAbs);
  } catch (err) {
    // Freshness check itself failed -- e.g. db corrupted in a way loadDb
    // couldn't recover.  Fail closed: blackout turn is preferable to
    // shipping unverified structural claims.
    result = {
      fresh: false,
      reason: "check_failed",
      evidence: { error: err?.message || String(err) },
    };
  }

  if (result.fresh) {
    return refreshSummaryAge(rawSummary, rootAbs);
  }

  // Stale path.  Trigger async rescan first so the marker line we emit
  // can honestly say "rescan requested" or "rescan pending" depending on
  // the single-flight outcome -- never lie about the queue state.
  let rescanResult;
  try {
    rescanResult = freshness.enqueueRescan(rootAbs);
  } catch (err) {
    rescanResult = { state: "skipped", reason: err?.message || "unknown" };
  }

  telemetry.recordEvent(rootAbs, "freshness.stale_hit", {
    reason: result.reason,
    rescanState: rescanResult.state,
  });
  telemetry.recordEvent(rootAbs, "freshness.blackout_turn", {
    reason: result.reason,
  });

  return buildStaleBody(rootAbs, result, rescanResult);
}

// Builds the minimal body that replaces the full <codebase-intelligence>
// summary on stale reads.  By construction this body contains:
//   - Repo root (filesystem path -- can't lie)
//   - Git branch + short HEAD (read fresh from `git`, not from graph.db)
//   - Recent git commits with affected files (read fresh from `git log`)
//   - Build-system signals (read fresh from disk: package.json, etc.)
//   - A clear marker line stating structural claims are unavailable, with
//     the actual rescan state ("requested" / "pending" / "unavailable")
// And does NOT contain:
//   - Hotspots / fan-in numbers / dependency counts
//   - Entry points / "top files" / module-type histograms
//   - Health percentages / resolution stats / indexed-file totals
//   - Any value derived from graph.db
//
// The format intentionally mirrors the fresh body's prefix so LLMs that
// pattern-matched on "## Codebase intelligence" still anchor on it; the
// distinguishing signal is the structural-claims-unavailable line, not a
// reformatted document.
function buildStaleBody(rootAbs, freshnessResult, rescanResult) {
  const summary = require("./summary");
  const { getGitInfo } = require("./git");

  const lines = [];
  lines.push("## Codebase intelligence");
  lines.push("");
  lines.push(`- **Root**: \`${summary.xmlEscape(summary.mdEscapeInline(rootAbs))}\``);

  const git = getGitInfo(rootAbs);
  if (git) {
    lines.push(
      `- **Git**: ${summary.xmlEscape(git.branch)} @ ${summary.xmlEscape(git.head.slice(0, 12))}`
    );
  }

  // The marker line.  Word "rescan" is the actionable hint; the state
  // ("requested" / "pending" / "unavailable") tells the reader whether
  // the next turn is likely to recover.  We never say "queued" because
  // the queue abstraction doesn't exist at this layer -- be precise.
  let rescanLabel;
  if (rescanResult?.state === "requested") rescanLabel = "rescan requested";
  else if (rescanResult?.state === "pending") rescanLabel = "rescan pending";
  else rescanLabel = "rescan unavailable";
  lines.push(
    `- **Structural claims unavailable this turn** — ${rescanLabel} (reason: ${freshnessResult.reason})`
  );
  lines.push("");

  // Build-system signals are filesystem reads only; safe under stale.
  let signals = [];
  try {
    signals = summary.detectSignals(rootAbs).signals || [];
  } catch {
    signals = [];
  }
  if (signals.length) {
    lines.push("### Signals");
    for (const s of signals) lines.push(`- ${summary.xmlEscape(s)}`);
    lines.push("");
  }

  // Recent git changes come straight from `git log` -- not from graph.db.
  let recent = [];
  try {
    recent = summary.getRecentGitFiles(rootAbs, 5);
  } catch {
    recent = [];
  }
  if (recent.length) {
    lines.push("### Recent changes (git)");
    for (const c of recent) {
      const date = new Date(c.ts * 1000).toISOString().slice(0, 10);
      lines.push(`- ${date} \`${summary.xmlEscape(summary.mdEscapeInline(c.file))}\``);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function getGitBranch(root) {
  const { getGitInfo } = require("./git");
  const info = getGitInfo(root);
  return info ? info.branch : null;
}

function getSearchBackend(root) {
  const rg = require("./rg");
  const zoektMod = require("./zoekt");
  const parts = [];
  if (rg.isInstalled()) parts.push("rg");
  if (zoektMod.isInstalled()) {
    parts.push(zoektMod.hasIndex(root) ? "zoekt (indexed)" : "zoekt");
  }
  return parts.length ? parts.join(" + ") : "none";
}

function renderBanner(healthData, root) {
  const viz = require("./terminal-viz");
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
      : viz.c("⏸ off", viz.colors.yellow) + viz.dim(" · run: sextant watch-start")),
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
  const viz = require("./terminal-viz");
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

module.exports = {
  stripUnsafeXmlTags,
  getWatcherStatus,
  refreshSummaryAge,
  applyFreshnessGate,
  buildStaleBody,
  getGitBranch,
  getSearchBackend,
  renderBanner,
  renderStatusLine,
  flag,
  hasFlag,
  readRootsFile,
  rootsFromArgs,
  readStdinJson,
};
