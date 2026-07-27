const fs = require("fs");
const path = require("path");
const intel = require("../lib/intel");
const graph = require("../lib/graph");
const { loadRepoConfig } = require("../lib/config");
const { getWatcherStatus } = require("../lib/cli");
const { diagnoseScanCoverage } = require("../lib/coverage-diagnostics");

async function run(ctx) {
  const r = ctx.roots[0];
  const rootAbs = path.resolve(r);
  const h = await intel.health(r);
  const cfg = loadRepoConfig(r);
  const viz = require("../lib/terminal-viz");

  const lines = [];
  lines.push(viz.c("# sextant doctor", viz.colors.bold, viz.colors.cyan));
  lines.push("");

  const sd = path.join(rootAbs, ".planning", "intel");
  const graphDb = path.join(sd, "graph.db");
  const summaryMd = path.join(sd, "summary.md");
  const claudeSettings = path.join(rootAbs, ".claude", "settings.json");

  // Compute actions FIRST so they appear at the top of the output -- this
  // is the "what should I do?" surface the user wants when they don't
  // remember the exact command for the current state.  Each action item
  // ships its literal command; the user copies, sextant doesn't auto-run.
  // Conditions are checked in dependency order so we don't suggest, e.g.,
  // a scan before init has run.
  const watcher = getWatcherStatus(rootAbs);
  const heartbeatPath = path.join(sd, ".watcher_heartbeat");
  const pct = h.metrics?.resolutionPct ?? h.resolutionPct ?? 0;
  const resolved = h.metrics?.localResolved ?? h.localResolved ?? 0;
  const total = h.metrics?.localTotal ?? h.localTotal ?? 0;
  const ageSec = h.metrics?.indexAgeSec ?? h.indexAgeSec ?? 0;
  const indexed = h.metrics?.indexedFiles ?? h.indexedFiles ?? h.index?.files ?? 0;

  // WHY a live coverage probe here (doctor is on-demand, the walk cost is
  // fine): distinguishes "never scanned" from "scanned but globs don't match
  // the layout" from "unsupported language" — three very different fixes that
  // an "empty index" message alone conflates.
  let coverage = null;
  if (fs.existsSync(graphDb) && cfg.coverageDiagnostics !== false) {
    try {
      coverage = await diagnoseScanCoverage({
        rootAbs,
        globs: cfg.globs,
        ignore: cfg.ignore,
        gitignoreFilter: cfg.gitignoreFilter,
        indexedTotal: indexed,
      });
    } catch {
      coverage = null;
    }
  }

  const actions = [];

  // Root-sanity guard (lib/root-guard.js): tell the user when sextant refuses
  // this root outright, or when the CLI works here but hooks stay dark (no
  // project marker) — otherwise "sextant is silent" is undiagnosable.
  {
    const { checkRoot } = require("../lib/root-guard");
    const hard = checkRoot(rootAbs);
    if (!hard.ok) {
      actions.push({ msg: `Root refused (${hard.reason}) — ${hard.message}`, cmd: null });
    } else {
      const strict = checkRoot(rootAbs, { requireMarker: true });
      if (!strict.ok) {
        actions.push({
          msg: "Hooks inactive here — no project marker (hooks only adopt directories that look like projects)",
          cmd: "sextant init",
        });
      }
    }
  }

  // Zoekt lane disabled (corpus/index-size cap — lib/zoekt-scope.js): search
  // silently degrades to rg, so the reason + re-enable path must be loud here.
  {
    const zscope = require("../lib/zoekt-scope");
    const zdisabled = zscope.readDisabled(rootAbs);
    if (zdisabled) {
      actions.push({
        msg: `Zoekt search disabled (${zdisabled.reason}): ${zdisabled.detail || ""} — fix scope/caps in .codebase-intel.json (zoektMaxCorpusBytes / zoektMaxIndexBytes), then re-enable`,
        cmd: "sextant zoekt index --force",
      });
    }
  }

  if (!fs.existsSync(sd)) {
    actions.push({ msg: "State dir missing — sextant not initialized in this repo", cmd: "sextant init" });
  } else if (!fs.existsSync(graphDb)) {
    actions.push({ msg: "graph.db missing — index has never been built", cmd: "sextant scan --force" });
  } else if (coverage && coverage.kind === "globs-too-narrow") {
    actions.push({
      msg: coverage.message,
      cmd: 'edit .codebase-intel.json "globs" to match your layout, then: sextant scan --force',
    });
  } else if (coverage && coverage.kind === "unsupported-language") {
    // No runnable command exists for this one — cmd:null keeps the prose out
    // of the copy-pasteable `→` slot (the render loop skips it).
    actions.push({
      msg: `${coverage.message} No action available.`,
      cmd: null,
    });
  } else if (indexed === 0) {
    actions.push({ msg: "graph.db exists but is empty", cmd: "sextant scan --force" });
  }
  if (!watcher.running) {
    if (fs.existsSync(heartbeatPath)) {
      actions.push({ msg: "Watcher heartbeat stale — process likely died", cmd: "sextant watch-stop && sextant watch-start" });
    } else {
      actions.push({ msg: "Watcher not running", cmd: "sextant watch-start" });
    }
  } else {
    // 017 lever #4: a live watcher running pre-upgrade code rewrites
    // summary.md in the OLD shape on its next flush (bitten twice on
    // somaNotes). The heartbeat carries the stamp the watcher baked in at
    // startup; compare against the code on disk NOW. A running watcher with
    // no stamp predates stamping entirely — same fix.
    const currentCode = require("../lib/utils").codeVersionStamp();
    if (watcher.codeVersion !== currentCode) {
      const ran = watcher.codeVersion || "pre-stamp";
      actions.push({
        msg: `Watcher running outdated code (${ran}, current ${currentCode}) — its next flush rewrites summary.md in the old shape`,
        cmd: "sextant watch-stop && sextant watch-start",
      });
    }
  }
  if (pct > 0 && pct < 90) {
    actions.push({ msg: `Resolution degraded (${pct}%) — graph boosts gated below 90%`, cmd: "sextant scan --force" });
  }
  if (!fs.existsSync(claudeSettings)) {
    actions.push({ msg: "Claude Code settings.json missing — hooks not wired", cmd: "sextant init" });
  }

  // Read Swift health from graph.db (recorded by intel.js after each scan).
  // The values are "as of last scan" — accurate for the user-facing question
  // "is my Swift extractor working?" even when the graph is otherwise stale.
  let swiftHealth = null;
  if (fs.existsSync(graphDb)) {
    try {
      const db = await graph.loadDb(rootAbs);
      swiftHealth = graph.getSwiftHealthCounters(db);
    } catch {}
  }
  if (swiftHealth && (swiftHealth.parserState === "init_failed" || swiftHealth.parserState === "unavailable") && swiftHealth.filesSeen > 0) {
    actions.push({
      msg: `Swift parser ${swiftHealth.parserState} — Swift facts not indexed for ${swiftHealth.filesSeen} file(s)`,
      cmd: "Reinstall sextant: npm install (verify vendor/tree-sitter-swift.wasm exists)",
    });
  }

  // Zoekt text-lane state (docs/035 #5). Computed HERE, not in the zoekt
  // section below: the Actions block is rendered into `lines` at the next
  // statement, so anything pushed further down never appears in it. That
  // ordering is exactly why the dead-daemon condition had no action for so
  // long — all 16 existing push sites are above this line.
  //
  // The hook path deliberately never starts a daemon (searchFast does not call
  // ensureWebserver), so a dead or foreign daemon is NOT self-healing: query
  // retrieval silently degrades to graph-only until someone runs a CLI/MCP
  // search. That is a real capability loss and the user is the only one who
  // can see it.
  let zoektLane = null;
  try {
    const zoektMod = require("../lib/zoekt");
    const dPath = path.join(sd, "zoekt", "daemon.json");
    let d = null;
    try { d = JSON.parse(fs.readFileSync(dPath, "utf8")); } catch {}
    if (!d?.pid || !d?.port) {
      zoektLane = { state: "absent" };
      actions.push({
        msg: "Zoekt webserver has never run for this repo — hook retrieval is graph-only (no text search)",
        cmd: "sextant zoekt index --force",
      });
    } else {
      let alive = false;
      try { process.kill(d.pid, 0); alive = true; } catch {}
      if (!alive) {
        zoektLane = { state: "dead", pid: d.pid, port: d.port };
        actions.push({
          msg: `Zoekt daemon is dead (pid ${d.pid}) — hook retrieval is graph-only; the hook path never restarts one`,
          cmd: "sextant zoekt index --force",
        });
      } else if (!zoektMod._daemonServesThisRootForTest(rootAbs, d.pid)) {
        zoektLane = { state: "foreign", pid: d.pid, port: d.port };
        actions.push({
          msg: `Zoekt daemon on port ${d.port} serves a DIFFERENT repo's index — text search is refused for this repo (it would return another repository's files)`,
          cmd: "sextant zoekt index --force",
        });
      } else {
        zoektLane = { state: "ok", pid: d.pid, port: d.port };
      }
    }
  } catch {
    zoektLane = null; // doctor must never fail because of a diagnostic
  }

  // Top-of-output Actions block.  No-op when everything is healthy so
  // the user can scan the rest of the report without waste.
  lines.push(viz.header("Actions"));
  if (actions.length === 0) {
    lines.push(`  ${viz.status("ok", "no actions needed — system healthy")}`);
  } else {
    for (const a of actions) {
      lines.push(`  ${viz.c("[ACT]", viz.colors.yellow)} ${a.msg}`);
      // cmd is null for conditions with no runnable fix (e.g. unsupported
      // language) — the `→` slot is reserved for copy-pasteable commands.
      if (a.cmd) {
        lines.push(`        ${viz.c("→", viz.colors.dim)} ${viz.c(a.cmd, viz.colors.cyan)}`);
      }
    }
  }

  // State files
  lines.push(viz.header("State"));
  lines.push(viz.metric("state dir", fs.existsSync(sd) ? viz.status("ok", sd) : viz.status("error", sd)));
  lines.push(viz.metric("graph.db", fs.existsSync(graphDb) ? viz.status("ok", "exists") : viz.status("error", "missing")));
  lines.push(viz.metric("summary.md", fs.existsSync(summaryMd) ? viz.status("ok", "exists") : viz.status("error", "missing")));
  lines.push(viz.metric("claude settings", fs.existsSync(claudeSettings) ? viz.status("ok", "exists") : viz.status("warn", "missing")));

  // Health metrics
  lines.push(viz.header("Health"));

  // Resolution with bar chart
  let resStatus = viz.status("ok", "healthy");
  if (pct < 90) resStatus = viz.status("error", "degraded (graph boosts gated)");
  else if (pct < 95) resStatus = viz.status("warn", "watch it");

  lines.push(`  ${viz.c("resolution".padEnd(18), viz.colors.dim)}${viz.bar(pct, 20)}  ${resolved}/${total}  ${resStatus}`);
  lines.push(viz.metric("indexed files", indexed));

  // Index age with color.  The age warning reflects watcher state: if the
  // heartbeat file is fresh, the watcher is alive and just idle (no file
  // changes since last flush), which is not a failure mode.  Only warn
  // "stale" when the watcher is actually dead.  (watcher already computed
  // for the Actions block at the top -- reuse.)
  const ageDisplay = viz.ageStatus(ageSec, { warn: 300, danger: 3600 });
  let ageNote = "";
  if (ageSec > 300) {
    if (watcher.running) {
      ageNote = viz.c("idle (no file changes)", viz.colors.dim);
    } else {
      ageNote = viz.status("warn", "stale (watcher dead — run: sextant watch-start)");
    }
  }
  lines.push(`  ${viz.c("index age".padEnd(18), viz.colors.dim)}${ageDisplay}  ${ageNote}`);
  const watcherDisplay = watcher.running
    ? viz.status("ok", `running (heartbeat ${watcher.ageSec}s ago)`)
    : viz.status("warn", "not running");
  lines.push(`  ${viz.c("watcher".padEnd(18), viz.colors.dim)}${watcherDisplay}`);

  // Historical trends
  const history = require("../lib/history");
  const histSummary = history.getHistorySummary(rootAbs, 20);
  if (histSummary.snapshotCount > 1) {
    lines.push("");
    lines.push(`  ${viz.c("Trends".padEnd(18), viz.colors.dim)}(${histSummary.snapshotCount} snapshots)`);

    // Resolution trend sparkline
    if (histSummary.resolutionTrend.length > 1) {
      const resTrend = histSummary.resolutionTrend;
      const first = resTrend[0];
      const last = resTrend[resTrend.length - 1];
      const delta = last - first;
      const deltaStr = delta >= 0 ? viz.c(`+${delta}%`, viz.colors.green) : viz.c(`${delta}%`, viz.colors.red);
      const spark = viz.sparkline(resTrend);
      lines.push(`  ${viz.c("resolution".padEnd(18), viz.colors.dim)}${spark}  ${first}% → ${last}%  ${deltaStr}`);
    }

    // Files trend sparkline
    if (histSummary.filesTrend.length > 1) {
      const filesTrend = histSummary.filesTrend;
      const first = filesTrend[0];
      const last = filesTrend[filesTrend.length - 1];
      const delta = last - first;
      const deltaStr = delta >= 0 ? viz.c(`+${delta}`, viz.colors.cyan) : viz.c(`${delta}`, viz.colors.yellow);
      const spark = viz.sparkline(filesTrend);
      lines.push(`  ${viz.c("files".padEnd(18), viz.colors.dim)}${spark}  ${first} → ${last}  ${deltaStr}`);
    }

    // Time range
    if (histSummary.firstTs && histSummary.lastTs) {
      const rangeMs = histSummary.lastTs - histSummary.firstTs;
      const rangeHours = (rangeMs / 3600000).toFixed(1);
      lines.push(`  ${viz.c("period".padEnd(18), viz.colors.dim)}${rangeHours}h of history`);
    }
  }

  // Swift health (only show when Swift was exercised OR parser failed)
  if (swiftHealth && (swiftHealth.filesSeen > 0 || swiftHealth.parserState === "init_failed" || swiftHealth.parserState === "unavailable")) {
    lines.push(viz.header("Swift health"));
    let parserStatus;
    if (swiftHealth.parserState === "ok") {
      parserStatus = viz.status("ok", "ok");
    } else if (swiftHealth.parserState === "init_failed" || swiftHealth.parserState === "unavailable") {
      parserStatus = viz.status("error", `${swiftHealth.parserState} (tree-sitter Swift WASM failed to load)`);
    } else {
      parserStatus = viz.status("warn", swiftHealth.parserState || "uninitialized");
    }
    lines.push(viz.metric("parser", parserStatus));

    if (swiftHealth.filesSeen > 0) {
      const okPct = Math.round((swiftHealth.filesParsedOk / swiftHealth.filesSeen) * 100);
      lines.push(viz.metric("files seen", swiftHealth.filesSeen));
      lines.push(viz.metric("files parsed ok", `${swiftHealth.filesParsedOk} (${okPct}%)`));
      if (swiftHealth.filesParseErrors > 0) {
        lines.push(viz.metric("files with errors", viz.status("warn", String(swiftHealth.filesParseErrors))));
      }
      if (swiftHealth.filesUnsupportedConstructs > 0) {
        lines.push(viz.metric("files unsupported", `${swiftHealth.filesUnsupportedConstructs}  ${viz.dim("(.swiftinterface, macros, deferred)")}`));
      }
      lines.push(viz.metric("declarations indexed", swiftHealth.declarationsIndexed));
      const relSummary = `${swiftHealth.relationsIndexedTotal}  ${viz.dim(`(${swiftHealth.relationsIndexedDirect} direct, ${swiftHealth.relationsIndexedHeuristic} heuristic)`)}`;
      lines.push(viz.metric("relations indexed", relSummary));
    }
    if (swiftHealth.parserState === "init_failed" || swiftHealth.parserState === "unavailable") {
      lines.push("");
      lines.push(`  ${viz.c("ACTION:", viz.colors.yellow)} verify vendor/tree-sitter-swift.wasm exists; reinstall sextant if needed.`);
      lines.push(`  ${viz.c("       ", viz.colors.yellow)} See vendor/README.md for the WASM update procedure.`);
    }
  }

  // Top misses
  const misses = h.metrics?.topMisses ?? h.topMisses ?? [];
  if (misses.length > 0) {
    lines.push(viz.header("Top Unresolved Imports"));
    const maxCount = Math.max(...misses.slice(0, 5).map(m => m[1]));
    for (const [spec, count] of misses.slice(0, 5)) {
      const miniBar = viz.bar((count / maxCount) * 100, 10, { showPercent: false, thresholds: { warn: 999, danger: 999 } });
      lines.push(`  ${viz.c(String(count).padStart(3), viz.colors.yellow)} ${miniBar} ${spec}`);
    }
  }

  // Config
  lines.push(viz.header("Config"));
  lines.push(viz.metric("globs", viz.dim(JSON.stringify(cfg.globs.slice(0, 2)) + (cfg.globs.length > 2 ? "..." : ""))));
  lines.push(viz.metric("ignore", viz.dim(`${cfg.ignore.length} patterns`)));
  if (cfg.coverageDiagnostics === false) {
    lines.push(viz.metric("coverage", viz.dim("disabled by config (coverageDiagnostics: false)")));
  } else if (coverage) {
    if (coverage.kind === "ok") {
      const avail = coverage.supportedAvailable != null ? ` (${coverage.supportedAvailable} supported sources in tree)` : "";
      lines.push(viz.metric("coverage", viz.status("ok", `indexing all in scope${avail}`)));
    } else if (coverage.kind === "globs-too-narrow") {
      lines.push(viz.metric("coverage", viz.status("error", coverage.message)));
    } else if (coverage.kind === "unsupported-language") {
      lines.push(viz.metric("coverage", viz.status("warn", coverage.message)));
    } else if (coverage.kind === "empty-repo") {
      lines.push(viz.metric("coverage", viz.status("warn", coverage.message)));
    }
  }

  // Search backends
  lines.push(viz.header("Search Backends"));
  // WHY: Uses "command -v" (POSIX) instead of "which" (not POSIX, missing on Alpine).
  const rgInstalled = require("child_process").spawnSync("sh", ["-lc", 'command -v "$1" 2>/dev/null', "--", "rg"], { encoding: "utf8", timeout: 5000 }).status === 0;
  const zoektInstalled = require("child_process").spawnSync("sh", ["-lc", 'command -v "$1" 2>/dev/null', "--", "zoekt-webserver"], { encoding: "utf8", timeout: 5000 }).status === 0;
  lines.push(viz.metric("ripgrep (rg)", rgInstalled ? viz.status("ok", "installed") : viz.status("error", "missing")));
  lines.push(viz.metric("zoekt", zoektInstalled ? viz.status("ok", "installed") : viz.status("info", "not installed (optional)")));

  // Zoekt per-project index status
  if (zoektInstalled) {
    const zoektIdxDir = path.join(sd, "zoekt", "index");
    const zscope = require("../lib/zoekt-scope");
    let hasZoektShards = false;
    try {
      hasZoektShards = fs.existsSync(zoektIdxDir) && fs.readdirSync(zoektIdxDir).some(f => f.endsWith(".zoekt"));
    } catch {}
    const zdisabled = zscope.readDisabled(rootAbs);
    if (zdisabled) {
      lines.push(viz.metric("zoekt index", viz.status("error", `disabled (${zdisabled.reason}) — see Actions above`)));
    } else {
      lines.push(viz.metric("zoekt index", hasZoektShards ? viz.status("ok", "exists") : viz.status("warn", "missing (run sextant scan)")));
    }
    if (hasZoektShards) {
      // Size next to the caps — the 101 GB incident was invisible until the
      // user's disk filled; a growing index should be visible on demand.
      try {
        const idxBytes = zscope.dirSizeBytes(zoektIdxDir);
        const capBytes = zscope.readZoektCaps(rootAbs).maxIndexBytes;
        const mb = (n) => `${Math.round(n / (1024 * 1024))} MiB`;
        const sizeStatus = idxBytes > capBytes * 0.8 ? viz.status("warn", `${mb(idxBytes)} (cap ${mb(capBytes)})`) : viz.dim(`${mb(idxBytes)} (cap ${mb(capBytes)})`);
        lines.push(viz.metric("zoekt index size", sizeStatus));
      } catch {}
    }

    // Webserver status — check daemon.json, PID, and probe
    const zoekt = require("../lib/zoekt");
    const daemonPath = path.join(sd, "zoekt", "daemon.json");
    let daemonInfo = null;
    try { daemonInfo = JSON.parse(fs.readFileSync(daemonPath, "utf8")); } catch {}

    if (daemonInfo?.pid && daemonInfo?.port) {
      let pidAlive = false;
      try { process.kill(daemonInfo.pid, 0); pidAlive = true; } catch {}

      // Identity, not just liveness (docs/035 #5). Reuses the state computed
      // before the Actions block; the action itself is pushed there, because
      // this section runs after the block has already been rendered.
      const servesUs = zoektLane?.state === "ok";
      if (pidAlive && servesUs) {
        lines.push(viz.metric("webserver", viz.status("ok", `running (pid ${daemonInfo.pid}, port ${daemonInfo.port})`)));
      } else if (pidAlive) {
        lines.push(viz.metric("webserver", viz.status("warn", `foreign (pid ${daemonInfo.pid} serves another index, port ${daemonInfo.port})`)));
      } else {
        lines.push(viz.metric("webserver", viz.status("warn", `stale (pid ${daemonInfo.pid} dead, port ${daemonInfo.port})`)));
      }
    } else {
      lines.push(viz.metric("webserver", viz.status("warn", "not running (hook search is graph-only until a CLI/MCP search starts it)")));
    }

    // Reindex state
    const { readReindexState } = require("../lib/zoekt-reindex");
    const reindexState = readReindexState(rootAbs);
    if (reindexState.lastReindexMs > 0) {
      const reindexAgeSec = Math.floor((Date.now() - reindexState.lastReindexMs) / 1000);
      const reindexAgeStr = viz.ageStatus(reindexAgeSec, { warn: 600, danger: 3600 });
      const statusStr = reindexState.inProgress ? viz.status("info", "in progress") : (reindexState.lastReindexOk === false ? viz.status("warn", "last run failed") : "");
      lines.push(`  ${viz.c("last reindex".padEnd(18), viz.colors.dim)}${reindexAgeStr}  ${statusStr}`);
    } else if (reindexState.inProgress) {
      lines.push(viz.metric("reindex", viz.status("info", "in progress (first run)")));
    }
  }

  // The bottom "Hints" block was removed -- it duplicated the
  // top-of-output Actions block and only ever surfaced a single hint
  // via if/elif.  Actions covers the same ground exhaustively now.
  lines.push("");

  process.stdout.write(lines.join("\n") + "\n");
}

module.exports = { run };
