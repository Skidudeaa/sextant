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
      // WHY: advertised by watchers that honor the .scan_in_progress pause
      // marker. null/undefined = a pre-pause-protocol (older) watcher, so
      // `sextant scan` keeps refusing rather than risk a clobber it can't pause.
      scanPauseProtocol: activity?.scanPauseProtocol ?? null,
      // Code identity the watcher baked in at startup (017 lever #4); null =
      // a watcher that predates version stamping (by definition old code).
      codeVersion: activity?.codeVersion ?? null,
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
async function applyFreshnessGateDetailed(rawSummary, rootAbs) {
  const freshness = require("./freshness");
  const telemetry = require("./telemetry");
  const resultOf = (body, freshnessResult, structural, sourceSummary = null) => ({
    body,
    freshness: freshnessResult || null,
    structural: structural === true,
    sourceSummary,
  });

  if (!rootAbs) {
    return resultOf(refreshSummaryAge(rawSummary, rootAbs), null, true, rawSummary);
  }

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
    // WHY record fresh_hit: stale_hit alone gives no denominator -- "10
    // stale_hits this week" is meaningless without "out of how many reads."
    // Pairing fresh_hit lets the audit pipeline compute stale_rate, which
    // is what the future Option-5 chooser needs as a baseline before any
    // adaptive sync/async decision can be made.
    telemetry.recordEvent(rootAbs, "freshness.fresh_hit", {});
    return resultOf(refreshSummaryAge(rawSummary, rootAbs), result, true, rawSummary);
  }

  // Stale path.  Option-5 adaptive arm first: when this repo's OWN recorded
  // scan history proves rescans are fast (p95 under ~2.5s at >=5 samples),
  // run one synchronously and inject a FRESH body instead of the blackout —
  // ~1-2s of prompt latency buys back the turn's orientation.  Everything
  // about the decision is per-repo and evidence-based; a repo with no
  // history, a slow history, or a recent sync failure falls through to the
  // async path unchanged (degrade, don't guess).
  try {
    // VERSION-ONLY staleness (docs/033 Tier 2 #5): the scanner/schema stamp
    // moved but HEAD and the status fingerprint did not, i.e. WE invalidated
    // the graph by shipping, not the user by editing. contentChanged is
    // computed independently of which reason won the single-valued race, so a
    // version bump that COINCIDES with a checkout is correctly excluded here.
    const versionOnly =
      (result.reason === "scanner_version_changed" ||
        result.reason === "schema_version_changed") &&
      result.contentChanged === false;
    const decision = freshness.shouldSyncRescan(rootAbs, { versionOnly });
    if (decision.sync) {
      const syncResult = freshness.syncRescan(rootAbs, decision.timeoutMs);
      telemetry.recordEvent(rootAbs, "freshness.sync_rescan", {
        ok: syncResult.state === "completed",
        state: syncResult.state,
        durationMs: syncResult.durationMs ?? null,
        // Which arm authorised the attempt — lets the audit separate
        // "history said it was fast" from "nothing but our own version moved".
        gate: decision.reason || "stats",
        ...(syncResult.timedOut ? { timedOut: true } : {}),
      });
      if (syncResult.state === "completed") {
        // The scan wrote graph.db + summary.md synchronously before exiting.
        // Re-verify rather than assume: if the tree moved again mid-scan the
        // recheck stays stale and we fall through to the blackout body.
        const recheck = await freshness.checkFreshness(rootAbs);
        if (recheck.fresh) {
          telemetry.recordEvent(rootAbs, "freshness.stale_hit", {
            reason: result.reason,
            rescanState: "sync",
          });
          // No blackout_turn: the read found stale state (stale_hit keeps the
          // denominator honest) but a minimal body was never emitted.
          const summaryPath = path.join(rootAbs, ".planning", "intel", "summary.md");
          const freshSummary = fs.readFileSync(summaryPath, "utf8");
          return resultOf(refreshSummaryAge(freshSummary, rootAbs), recheck, true, freshSummary);
        }
      }
      // Sync attempt didn't rescue the turn (failed / timed out / pending /
      // still stale on recheck) — fall through to the async arm + blackout.
    }
  } catch {
    // The adaptive arm must never break the gate; fall through to async.
  }

  // Async arm.  Trigger the rescan first so the marker line we emit can
  // honestly say "rescan requested" or "rescan pending" depending on the
  // single-flight outcome -- never lie about the queue state.
  let rescanResult;
  if (result.rescanUseless) {
    // A rescan cannot change this verdict (docs/035 #2): a root with no git
    // repository has no anchor to re-record, so scanning again produces the
    // identical stale result. Enqueueing one burned a successful scan per read
    // forever. Say so instead of claiming a rescan is on the way.
    rescanResult = { state: "unavailable", reason: result.reason };
  } else {
    try {
      rescanResult = freshness.enqueueRescan(rootAbs);
    } catch (err) {
      rescanResult = { state: "skipped", reason: err?.message || "unknown" };
    }
  }

  telemetry.recordEvent(rootAbs, "freshness.stale_hit", {
    reason: result.reason,
    rescanState: rescanResult.state,
  });
  telemetry.recordEvent(rootAbs, "freshness.blackout_turn", {
    reason: result.reason,
  });

  return resultOf(await buildStaleBody(rootAbs, result, rescanResult), result, false, null);
}

async function applyFreshnessGate(rawSummary, rootAbs) {
  const detailed = await applyFreshnessGateDetailed(rawSummary, rootAbs);
  return detailed.body;
}

function sameRepoValidation(left, right) {
  if (!left || !right) return false;
  return (
    (left.head ?? "") === (right.head ?? "") &&
    (left.statusHash ?? "") === (right.statusHash ?? "")
  );
}

async function readValidatedBoundSummary(rootAbs, freshnessResult) {
  try {
    const binding = require("./summary-binding");
    const firstBound = binding.readBoundSummary(rootAbs);
    const graphBinding = await binding.readGraphBinding(rootAbs);
    const secondBound = binding.readBoundSummary(rootAbs);
    if (!firstBound || !secondBound || firstBound.manifestBytes !== secondBound.manifestBytes) return null;
    if (!binding.matchesFreshness(firstBound, freshnessResult)) return null;
    if (!binding.matchesFreshness(secondBound, freshnessResult)) return null;
    if (!binding.matchesGraphBinding(secondBound, graphBinding)) return null;
    return {
      // Preserve pre-binding hook/CLI bytes while the manifest continues to
      // hash exact raw bytes, including the generated trailing newline.
      body: refreshSummaryAge(secondBound.rawSummary.trim(), rootAbs),
      manifestBytes: secondBound.manifestBytes,
      freshness: freshnessResult,
    };
  } catch {
    return null;
  }
}

async function boundSummaryStillValid(rootAbs, validated) {
  if (!validated) return false;
  try {
    const freshness = require("./freshness");
    const binding = require("./summary-binding");
    const graphBinding = await binding.readGraphBinding(rootAbs);
    const bound = binding.readBoundSummary(rootAbs);
    const current = freshness.captureCurrentState(rootAbs);
    return !!(
      bound && bound.manifestBytes === validated.manifestBytes &&
      binding.matchesFreshness(bound, validated.freshness) &&
      binding.matchesGraphBinding(bound, graphBinding) &&
      sameRepoValidation(validated.freshness.validatedRepo, current)
    );
  } catch {
    return false;
  }
}

// Context-serving summary surfaces use this stricter wrapper. A fresh graph is
// not sufficient by itself: summary.md must be the exact manifest-bound body
// for that generation. Stale minimal bodies remain safe and do not require a
// structural binding.
async function applyBoundFreshnessGateDetailed(rawSummary, rootAbs) {
  const gated = await applyFreshnessGateDetailed(rawSummary, rootAbs);
  if (!gated.structural || !rootAbs) return { ...gated, validation: null };
  let validation = await readValidatedBoundSummary(rootAbs, gated.freshness);
  if (!validation) {
    try {
      if (await require("./summary-binding").repairBoundSummary(rootAbs)) {
        validation = await readValidatedBoundSummary(rootAbs, gated.freshness);
      }
    } catch {}
  }
  return {
    ...gated,
    body: validation ? validation.body : "",
    validation,
  };
}

async function applyBoundFreshnessGate(rawSummary, rootAbs) {
  const detailed = await applyBoundFreshnessGateDetailed(rawSummary, rootAbs);
  if (detailed.validation && !(await boundSummaryStillValid(rootAbs, detailed.validation))) {
    return "";
  }
  return detailed.body;
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
async function buildStaleBody(rootAbs, freshnessResult, rescanResult) {
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
  if (freshnessResult.reason === "git_absent") {
    // Name the actual condition and the one action that resolves it. "rescan
    // unavailable (reason: git_absent)" is true but reads as a transient fault;
    // this state is permanent until the root becomes a git repository, and the
    // reader is the only party who can change that.
    lines.push(
      "- **Structural claims unavailable this turn** — no git repository at this root, " +
        "so index freshness cannot be verified and a rescan cannot resolve it " +
        "(run `git init` to enable freshness tracking)"
    );
  } else {
    lines.push(
      `- **Structural claims unavailable this turn** — ${rescanLabel} (reason: ${freshnessResult.reason})`
    );
  }

  // SB-3: Even in the stale path, Swift parser failure is independently
  // important — a rescan won't fix it (the rescan would also fail to load
  // the WASM grammar).  Surface it here so the user/agent isn't left
  // wondering why the next turn produces no Swift facts either.  Read from
  // the (stale but still-readable) graph.db.
  try {
    const graph = require("./graph");
    const db = await graph.loadDb(rootAbs);
    const sh = graph.getSwiftHealthCounters(db);
    if (sh.filesSeen > 0 && (sh.parserState === "init_failed" || sh.parserState === "unavailable")) {
      lines.push(
        `- **Swift parser ${sh.parserState}** — Swift facts not indexed for ${sh.filesSeen} file(s); rescan won't fix this (run \`sextant doctor\`)`
      );
    }
  } catch {}
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
    // WHY: if the hook runner never closes stdin (CI TTY, runner bug, pipe
    // stall), we must not block forever and burn the 200ms hook budget.
    const timer = setTimeout(() => resolve({}), 3000);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (input += c));
    process.stdin.on("end", () => {
      clearTimeout(timer);
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
  applyFreshnessGateDetailed,
  applyBoundFreshnessGate,
  applyBoundFreshnessGateDetailed,
  boundSummaryStillValid,
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
