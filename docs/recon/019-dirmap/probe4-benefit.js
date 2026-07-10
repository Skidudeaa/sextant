// Probe 4 (docs/019): ground the benefit hypothesis.
// From real Claude Code session transcripts, measure the WRONG-DIRECTORY-START
// rate: how often the first file the agent opens lives in a different top-level
// directory than the modal directory of its subsequent EDITS (the session's
// real worksite). Also reports how many opens it takes to first touch the
// worksite dir (dir-level orientation latency).
//
// Reuses lib/trajectory.js transcript parsing (same OPEN_TOOLS, same cwd
// normalization). Sessions need >=3 opens and >=2 edits to score.
//
// Usage: node probe4-benefit.js [--projects <path>] [--min-opens N]
"use strict";

const os = require("os");
const path = require("path");
const traj = require("../../../lib/trajectory");
const { dirKey } = require("./common");

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function modal(list) {
  const c = new Map();
  for (const x of list) c.set(x, (c.get(x) || 0) + 1);
  let best = null, bestN = 0;
  for (const [k, n] of c) if (n > bestN) { best = k; bestN = n; }
  return { value: best, n: bestN, of: list.length };
}

function main() {
  const argv = process.argv.slice(2);
  const pArg = argv.indexOf("--projects");
  const projectsRoot = pArg > -1 ? argv[pArg + 1] : path.join(os.homedir(), ".claude", "projects");

  const files = traj.discoverSessions(projectsRoot);
  const perRepo = new Map();
  let scored = 0, skippedSmall = 0, skippedNoCwd = 0;

  for (const f of files) {
    const records = traj.readRecords(f);
    if (!records.length) continue;
    const { events, cwd } = traj.extractEvents(records);
    if (!cwd) { skippedNoCwd += 1; continue; }

    // clean repo-relative opens only (skip absolute/outside-root paths)
    const opens = events.filter((e) => e.kind === "open" && !e.path.startsWith("/"));
    const edits = opens.filter((e) => EDIT_TOOLS.has(e.tool));
    if (opens.length < 3 || edits.length < 2) { skippedSmall += 1; continue; }

    const editDirs = edits.map((e) => dirKey(e.path, 1));
    const site = modal(editDirs);
    // require a real modal worksite (strict majority of edits in one dir)
    if (site.n / site.of < 0.5) { skippedSmall += 1; continue; }

    const firstOpenDir = dirKey(opens[0].path, 1);
    const wrongStart = firstOpenDir !== site.value;
    let firstTouchRank = null;
    for (let i = 0; i < opens.length; i++) {
      if (dirKey(opens[i].path, 1) === site.value) { firstTouchRank = i + 1; break; }
    }

    const repo = traj.repoOf(f, projectsRoot);
    let agg = perRepo.get(repo);
    if (!agg) { agg = { sessions: 0, wrong: 0, ranks: [] }; perRepo.set(repo, agg); }
    agg.sessions += 1;
    if (wrongStart) agg.wrong += 1;
    if (firstTouchRank != null) agg.ranks.push(firstTouchRank);
    scored += 1;
  }

  console.log(`projectsRoot=${projectsRoot} sessionFiles=${files.length} scored=${scored} skippedSmall=${skippedSmall} skippedNoCwd=${skippedNoCwd}`);
  let totWrong = 0;
  const allRanks = [];
  const repos = [...perRepo.entries()].sort((a, b) => b[1].sessions - a[1].sessions);
  for (const [repo, a] of repos) {
    const med = a.ranks.length ? a.ranks.sort((x, y) => x - y)[Math.floor(a.ranks.length / 2)] : "n/a";
    console.log(`  ${repo.padEnd(44)} sessions=${String(a.sessions).padStart(3)} wrongStart=${String(a.wrong).padStart(3)} (${((a.wrong / a.sessions) * 100).toFixed(0)}%) medianFirstTouchRank=${med}`);
    totWrong += a.wrong;
    allRanks.push(...a.ranks);
  }
  allRanks.sort((x, y) => x - y);
  const med = allRanks.length ? allRanks[Math.floor(allRanks.length / 2)] : "n/a";
  const p90 = allRanks.length ? allRanks[Math.floor(allRanks.length * 0.9)] : "n/a";
  console.log(`overall: wrongStartRate=${scored ? ((totWrong / scored) * 100).toFixed(1) : "n/a"}% (${totWrong}/${scored}) firstTouchRank median=${med} p90=${p90}`);
}

main();
