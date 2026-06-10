"use strict";
// Per-instance surfacing analyzer — the instrument behind docs/012 and docs/013.
//
// Replays real Claude Code transcripts (~/.claude/projects) like
// lib/trajectory.js, but keeps the per-instance detail the aggregate harness
// throws away: matched term ("exports X" / "path match: X" labels), block
// rank, the triggering prompt, opens before/after the injection, and what was
// opened instead.  Dumps every instance to /tmp/exp-instances.json for ad-hoc
// slicing (term shape, match location, classifier confidence — recompute conf
// by piping the stored prompts back through lib/classifier) and prints
// per-source aggregates.
//
// Usage: node scripts/analyze-surfacings.js
// The gate simulations in docs/012/013 were built on the JSON dump — pattern:
// classify each instance offline, then report survivors/hits for a candidate
// gate BEFORE writing any retrieval code.
const path = require("path");
const traj = require(path.join(__dirname, "..", "lib", "trajectory"));

const OPEN_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

function suffixMatch(openPath, p) {
  return openPath === p || openPath.endsWith("/" + p);
}

function detailOf(line) {
  const m = line.trimEnd().match(/^-\s+`([^`]+)`(?:\s+—\s+(.*))?$/);
  return m ? { path: m[1].trim(), detail: (m[2] || "").trim() } : null;
}

const sessions = traj.discoverSessions(path.join(process.env.HOME, ".claude", "projects"));
const instances = []; // one row per surfaced file instance (exported_symbol | text_only)

for (const file of sessions) {
  const s = { file, repo: traj.repoOf(file) };
  let records;
  try { records = traj.readRecords(s.file); } catch { continue; }
  let cwd = null;
  for (const r of records) { if (r && typeof r.cwd === "string") { cwd = r.cwd; break; } }
  const toRel = (abs) => {
    if (typeof abs !== "string") return null;
    if (cwd && abs.startsWith(cwd + "/")) return abs.slice(cwd.length + 1);
    return abs;
  };

  // ordered event stream with prompts
  const ev = [];
  let lastPrompt = "";
  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    if (r.type === "user" && r.message) {
      const c = r.message.content;
      let text = "";
      if (typeof c === "string") text = c;
      else if (Array.isArray(c)) text = c.filter(x => x && x.type === "text").map(x => x.text).join(" ");
      if (text && !text.startsWith("<")) lastPrompt = text.slice(0, 160);
    }
    if (r.type === "attachment") {
      const text = (r.attachment && (typeof r.attachment.content === "string" ? r.attachment.content
        : r.attachment.content && r.attachment.content.text)) || "";
      if (text.includes("<codebase-retrieval>")) {
        const files = [];
        let rank = 0;
        for (const line of text.split("\n")) {
          const d = detailOf(line);
          if (!d || !d.path) continue;
          rank += 1;
          files.push({ ...d, rank, source: traj.classifyDetailSource(d.detail || null) });
        }
        if (files.length) ev.push({ kind: "inject", files, prompt: lastPrompt, stale: text.includes("index stale") });
      }
      continue;
    }
    if (r.type === "assistant" && r.message && Array.isArray(r.message.content)) {
      for (const c of r.message.content) {
        if (c && c.type === "tool_use" && OPEN_TOOLS.has(c.name)) {
          const rel = toRel(c.input && c.input.file_path);
          if (rel) ev.push({ kind: "open", path: rel });
        }
      }
    }
  }

  ev.forEach((e, i) => {
    if (e.kind !== "inject") return;
    const before = ev.slice(0, i).filter(x => x.kind === "open").map(x => x.path);
    const after = ev.slice(i + 1).filter(x => x.kind === "open").map(x => x.path);
    const window8 = after.slice(0, 8);
    for (const f of e.files) {
      if (!["exported_symbol","text_only","path_match"].includes(f.source)) continue;
      instances.push({
        repo: s.repo, source: f.source, path: f.path, detail: f.detail, rank: f.rank,
        blockSize: e.files.length, prompt: e.prompt, stale: e.stale,
        openedAfter: after.some(o => suffixMatch(o, f.path)),
        openedBefore: before.some(o => suffixMatch(o, f.path)),
        inWindow8: window8.some(o => suffixMatch(o, f.path)),
        windowOpens: window8.slice(0, 4),
      });
    }
  });
}

require("fs").writeFileSync("/tmp/exp-instances.json", JSON.stringify(instances, null, 1));

// ── aggregate ──
function pct(a, b) { return b ? (100 * a / b).toFixed(1) + "%" : "n/a"; }
for (const src of ["path_match", "exported_symbol", "text_only"]) {
  const rows = instances.filter(r => r.source === src);
  const opened = rows.filter(r => r.openedAfter);
  const beforeOnly = rows.filter(r => r.openedBefore && !r.openedAfter);
  const distinct = new Set(rows.map(r => r.repo + ":" + r.path));
  console.log(`\n== ${src}: ${rows.length} instances, ${distinct.size} distinct files`);
  console.log(`   openedAfter: ${opened.length} (${pct(opened.length, rows.length)})  openedBefore-only: ${beforeOnly.length} (${pct(beforeOnly.length, rows.length)})  either: ${pct(rows.filter(r => r.openedAfter || r.openedBefore).length, rows.length)}`);
  const byRepo = {};
  rows.forEach(r => { (byRepo[r.repo] = byRepo[r.repo] || { n: 0, o: 0 }).n++; if (r.openedAfter) byRepo[r.repo].o++; });
  console.log("   by repo:", Object.entries(byRepo).map(([k, v]) => `${k.replace("-root-", "")} ${v.o}/${v.n}`).join("  "));
  // spam concentration
  const byFile = {};
  rows.forEach(r => { const k = r.repo.replace("-root-", "") + ":" + r.path; (byFile[k] = byFile[k] || { n: 0, o: 0 }).n++; if (r.openedAfter) byFile[k].o++; });
  const top = Object.entries(byFile).sort((a, b) => b[1].n - a[1].n).slice(0, 8);
  console.log("   top surfaced files:", top.map(([k, v]) => `${k} ×${v.n}(${v.o} opened)`).join("\n                       "));
  // rank distribution
  const ranks = rows.reduce((m, r) => { m[r.rank] = (m[r.rank] || 0) + 1; return m; }, {});
  console.log("   rank dist:", JSON.stringify(ranks));
  const testish = rows.filter(r => /(^|\/)(test|tests|__tests__|spec)\//i.test(r.path) || /\.(test|spec)\./.test(r.path));
  console.log(`   test-path fraction: ${pct(testish.length, rows.length)}`);
}
