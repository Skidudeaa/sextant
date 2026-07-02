"use strict";
// R3 task 2-4: pull instance-level (session, ts, source, path, opened) rows
// from the real trajectory corpus, with session-level timestamps so we can
// do a temporal (earlier vs later) split for the prior-stability + offline
// reranking simulation. Reuses lib/trajectory.js internals directly (no
// mutation of that file — read-only recon).
const fs = require("fs");
const path = require("path");
const traj = require("/root/sextant/lib/trajectory");

const OPEN_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);
const projectsRoot = path.join(process.env.HOME, ".claude", "projects");

function detailOf(line) {
  const m = line.trimEnd().match(/^-\s+`([^`]+)`(?:\s+—\s+(.*))?$/);
  return m ? { path: m[1].trim(), detail: (m[2] || "").trim() } : null;
}

function suffixMatch(openPath, p) {
  return openPath === p || openPath.endsWith("/" + p);
}

const sessions = traj.discoverSessions(projectsRoot); // excludes subagents/workflows by default
const sessionRows = []; // one per session: {file, repo, sessionTs (first record ts), instances: [...]}

for (const file of sessions) {
  let records;
  try {
    records = traj.readRecords(file);
  } catch {
    continue;
  }
  if (!records.length) continue;
  const repo = traj.repoOf(file, projectsRoot);

  let cwd = null;
  for (const r of records) {
    if (r && typeof r.cwd === "string") {
      cwd = r.cwd;
      break;
    }
  }
  const toRel = (abs) => {
    if (typeof abs !== "string") return null;
    if (cwd && abs.startsWith(cwd + "/")) return abs.slice(cwd.length + 1);
    return abs;
  };

  // Ordered event stream with timestamps, mirroring analyze-surfacings.js but
  // retaining ts so we can temporally split.
  const ev = [];
  let firstTs = null;
  let lastTs = null;
  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    const ts = r.timestamp || null;
    if (ts) {
      if (!firstTs || ts < firstTs) firstTs = ts;
      if (!lastTs || ts > lastTs) lastTs = ts;
    }
    if (r.type === "attachment") {
      const text =
        (r.attachment &&
          (typeof r.attachment.content === "string"
            ? r.attachment.content
            : r.attachment.content && r.attachment.content.text)) ||
        "";
      if (text.includes("<codebase-retrieval>")) {
        const files = [];
        let rank = 0;
        for (const line of text.split("\n")) {
          const d = detailOf(line);
          if (!d || !d.path) continue;
          rank += 1;
          files.push({ ...d, rank, source: traj.classifyDetailSource(d.detail || null) });
        }
        if (files.length) ev.push({ kind: "inject", ts, files });
      }
      continue;
    }
    if (r.type === "assistant" && r.message && Array.isArray(r.message.content)) {
      for (const c of r.message.content) {
        if (c && c.type === "tool_use" && OPEN_TOOLS.has(c.name)) {
          const rel = toRel(c.input && c.input.file_path);
          if (rel) ev.push({ kind: "open", ts, path: rel });
        }
      }
    }
  }
  if (!ev.some((e) => e.kind === "inject")) continue;

  const instances = [];
  ev.forEach((e, i) => {
    if (e.kind !== "inject") return;
    const after = ev.slice(i + 1).filter((x) => x.kind === "open").map((x) => x.path);
    for (const f of e.files) {
      instances.push({
        source: f.source,
        path: f.path,
        rank: f.rank,
        blockSize: e.files.length,
        injIdx: i,
        opened: after.some((o) => suffixMatch(o, f.path)),
      });
    }
  });

  sessionRows.push({
    file,
    repo,
    firstTs,
    lastTs,
    instances,
  });
}

fs.writeFileSync(
  path.join(__dirname, "session_instances.json"),
  JSON.stringify(sessionRows)
);

console.log(`sessions with injections: ${sessionRows.length}`);
const withTs = sessionRows.filter((s) => s.firstTs);
console.log(`sessions with a timestamp: ${withTs.length}`);
if (withTs.length) {
  const tss = withTs.map((s) => s.firstTs).sort();
  console.log(`window: ${tss[0]} .. ${tss[tss.length - 1]}`);
  console.log(`window (iso): ${new Date(tss[0]).toISOString()} .. ${new Date(tss[tss.length - 1]).toISOString()}`);
}
