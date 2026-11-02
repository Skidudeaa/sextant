"use strict";

// `sextant atoms` — the first instruments of the instruction compiler
// (docs/052). Instruction files load whole into every session: a median of
// 126,428 characters over 124 sessions to 2026-11-01. An atom is one section
// of an instruction file with one trigger. A path atom maps onto a Claude Code
// `paths` rule, which loads only when an agent opens a matching file.
//
//   compile --dry-run  split each CLAUDE.md into atoms and bind them to the files they cite
//   replay             would each decision's atoms have reached the deciding agent in time?
//   exposure           InstructionsLoaded hook: one row per instruction-file load
//
// Aggregates only: somaNotes transcripts carry PHI.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { flag, hasFlag } = require("../lib/cli");

const USAGE = "usage: sextant atoms compile --dry-run [--roots a,b] [--json] | atoms replay [--roots a,b] [--projects <path>] [--days <N>] [--json] | atoms exposure";
const EXPOSURE_LOG = path.join(__dirname, "..", ".planning", "atoms", "exposure.jsonl");
// Hook strings are capped at 10,000 characters, so a larger atom cannot travel
// through the hook lane whole.
const ATOM_MAX = 9000;
// A cited directory with more files than this binds too broadly to be a trigger.
const DIR_MAX = 400;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const CHANNELS = ["native", "+cmd", "+output", "+child"];

const sum = atoms => atoms.reduce((n, a) => n + a.chars, 0);

function repoIndex(root) {
  const list = execFileSync("git", ["-C", root, "ls-files"], { maxBuffer: 1 << 28 }).toString().split("\n").filter(Boolean);
  const byBase = new Map();
  for (const f of list) byBase.set(path.basename(f), (byBase.get(path.basename(f)) || []).concat(f));
  return { root, list, files: new Set(list), byBase };
}

// Sections start at a heading or a top-level numbered bold item (sextant's
// pipeline list). A heading inside a fenced block is text, not a boundary.
function splitAtoms(md) {
  const atoms = [];
  let cur = { title: "(preamble)", text: "" };
  let fenced = false;
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && (/^#{1,4} /.test(line) || /^\d+\. \*\*/.test(line))) {
      if (cur.text.trim()) atoms.push(cur);
      cur = { title: line.slice(0, 80), text: "" };
    }
    cur.text += line + "\n";
  }
  if (cur.text.trim()) atoms.push(cur);
  return atoms;
}

const relTo = (t, root) => (t.startsWith(root + "/") ? t.slice(root.length + 1) : t.replace(/^\.\//, ""));

// The binding a `paths` rule would use: tracked files the text names, a cited
// directory as dir/**, and a bare basename only when one tracked file has it.
function citedGlobs(text, index) {
  const out = new Set();
  for (const m of text.matchAll(/[`(\s"']([A-Za-z0-9_.\-/]+\/?)(?::[A-Za-z0-9_]+)?(?=[`)\s,"';:]|$)/g)) {
    const t = relTo(m[1], index.root).replace(/[.,]+$/, "");
    if (t.length < 4) continue;
    if (index.files.has(t)) out.add(t);
    else if (t.endsWith("/")) {
      const n = index.list.filter(f => f.startsWith(t)).length;
      if (n && n <= DIR_MAX) out.add(t + "**");
    } else if (/\.[A-Za-z]{1,5}$/.test(t)) {
      const hit = index.byBase.get(path.basename(t));
      if (hit && hit.length === 1) out.add(hit[0]);
    }
  }
  return [...out].sort();
}

const globMatch = (g, rel) => (g.endsWith("/**") ? rel.startsWith(g.slice(0, -2)) : g === rel);

function compileRepo(root) {
  const md = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
  const index = repoIndex(root);
  const atoms = splitAtoms(md).map(a => ({ title: a.title, chars: a.text.length, globs: citedGlobs(a.text, index) }));
  const bound = atoms.filter(a => a.globs.length);
  return { root, chars: md.length, atoms, boundAtoms: bound.length, boundChars: sum(bound), oversize: atoms.filter(a => a.chars > ATOM_MAX).length, index };
}

// ---- replay ----
//
// Decision events: an Edit/Write (edit), a `git diff`/`git show` whose output
// names files (review), a spawn prompt that names files (spawn), and a
// subagent finishing (return; its governing atoms are those of the files it
// edited). For each event, the governing atoms are the path atoms of its files.
//
// Channel sets, each a superset of the one before:
//   native  Claude Code loads a `paths` rule on Read/Write/Edit of a match or a
//           one-file cat/head (docs; verified 2026-11-01 on 2.1.309)
//   +cmd    a relay delivers the atoms of bound files a Bash command names, or
//           that a `git diff`/`git show` prints
//   +output the same relay also reads every other Bash output (git status, grep -r, ls)
//   +child  a relay hands the parent the atoms its subagent received, when it finishes
//
// An edit or spawn is in time only if the atom arrived BEFORE that tool call:
// a rule the call itself loads arrives with its result. A review or return is
// in time when the atom arrives with the output being judged, which is the
// moment each relay fires; those two rows are covered by construction under
// their own relay, so their native column is the informative one.

const newAgent = () => ({ got: CHANNELS.map(() => new Set()), carried: CHANNELS.map(() => 0), occupancy: CHANNELS.map(() => 0), calls: 0, read: new Set(), edited: new Set() });
function deliver(agent, ids, from, ctx) {
  for (let c = from; c < CHANNELS.length; c++) for (const id of ids) {
    if (agent.got[c].has(id)) continue;
    agent.got[c].add(id);
    agent.carried[c] += ctx.chars[id];
  }
}
const atomsOf = (files, ctx) => [...new Set([...files].flatMap(f => ctx.gov.get(f) || []))];

function score(tally, type, agent, ids) {
  if (!ids.length) return;
  const t = tally[type] || (tally[type] = { events: 0, pairs: 0, covered: CHANNELS.map(() => 0), full: CHANNELS.map(() => 0) });
  t.events++;
  t.pairs += ids.length;
  for (let c = 0; c < CHANNELS.length; c++) {
    const n = ids.filter(id => agent.got[c].has(id)).length;
    t.covered[c] += n;
    if (n === ids.length) t.full[c]++;
  }
}

function namedFiles(text, ctx) {
  const out = new Set();
  for (const m of String(text).matchAll(/[A-Za-z0-9_.\-/]+/g)) {
    const t = relTo(m[0], ctx.root);
    // git diff names files as a/<path> and b/<path>.
    const u = t.replace(/^[ab]\//, "");
    if (ctx.gov.has(t)) out.add(t);
    else if (ctx.gov.has(u)) out.add(u);
  }
  return out;
}

// What the Claude Code docs call a Bash command that counts as a read.
function bashReadTarget(cmd) {
  const m = /^\s*(?:cat|head)\s+((?:-[nc]\s*\d+\s+|-\S+\s+)*)(\S+)\s*$/.exec(String(cmd));
  return m ? m[2].replace(/^["']|["']$/g, "") : null;
}

const resultText = c => (Array.isArray(c) ? c.map(x => (typeof x === "string" ? x : x.text || "")).join("\n") : String(c ?? ""));

function readLines(file) {
  const rows = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a torn final line is not a record */ }
  }
  return rows;
}

// One agent's transcript. `children` is set for a parent: each child is
// replayed first and returns at the first parent record at or after its end.
function replayAgent(rows, ctx, tally, children) {
  const agent = newAgent();
  const pending = new Map();
  let end = 0;
  for (const r of rows) {
    const ts = Date.parse(r.timestamp) || 0;
    end = Math.max(end, ts);
    for (const ch of children || []) {
      if (ch.returned || !ts || ch.end > ts) continue;
      ch.returned = true;
      deliver(agent, [...ch.agent.got[2]], 3, ctx);
      score(tally, "return", agent, atomsOf(ch.agent.edited, ctx));
    }
    const content = r.message && Array.isArray(r.message.content) ? r.message.content : [];
    for (const c of content) {
      if (c.type === "tool_use") {
        // Each call is one more request that carries everything delivered so far.
        agent.calls++;
        for (let k = 0; k < CHANNELS.length; k++) agent.occupancy[k] += agent.carried[k];
        const inp = c.input || {};
        const file = typeof (inp.file_path || inp.notebook_path) === "string" ? relTo(inp.file_path || inp.notebook_path, ctx.root) : null;
        const inRepo = file && ctx.gov.has(file) ? file : null;
        if (EDIT_TOOLS.has(c.name) && inRepo) {
          score(tally, "edit", agent, atomsOf([inRepo], ctx));
          if (c.name === "Write" && !agent.read.has(inRepo)) tally.writeBlind = (tally.writeBlind || 0) + 1;
          agent.edited.add(inRepo);
        }
        if ((c.name === "Agent" || c.name === "Task") && inp.prompt) score(tally, "spawn", agent, atomsOf(namedFiles(inp.prompt, ctx), ctx));
        const effect = { native: new Set(), bash: null, review: false };
        if ((c.name === "Read" || EDIT_TOOLS.has(c.name)) && inRepo) effect.native.add(inRepo);
        if (c.name === "Bash") {
          const target = bashReadTarget(inp.command);
          if (target && ctx.gov.has(relTo(target, ctx.root))) effect.native.add(relTo(target, ctx.root));
          effect.bash = String(inp.command || "");
          // Global options may precede the subcommand: `git -C <root> diff`, `git --no-pager show`.
          effect.review = /\bgit\s+(?:-[Cc]\s+\S+\s+|--\S+\s+)*(diff|show)\b/.test(effect.bash);
        }
        pending.set(c.id, effect);
      } else if (c.type === "tool_result" && pending.has(c.tool_use_id)) {
        const e = pending.get(c.tool_use_id);
        pending.delete(c.tool_use_id);
        for (const f of e.native) agent.read.add(f);
        deliver(agent, atomsOf(e.native, ctx), 0, ctx);
        if (e.bash === null) continue;
        const out = resultText(c.content);
        deliver(agent, atomsOf(namedFiles(e.review ? e.bash + "\n" + out : e.bash, ctx), ctx), 1, ctx);
        deliver(agent, atomsOf(namedFiles(out, ctx), ctx), 2, ctx);
        if (e.review) score(tally, "review", agent, atomsOf(namedFiles(out, ctx), ctx));
      }
    }
  }
  return { agent, end };
}

function replayRepo(root, projectsRoot, days, compiled = compileRepo(root)) {
  const gov = new Map();
  compiled.atoms.forEach((a, i) => {
    for (const f of compiled.index.list) if (a.globs.some(g => globMatch(g, f))) gov.set(f, (gov.get(f) || []).concat(i));
  });
  const ctx = { root, gov, chars: compiled.atoms.map(a => a.chars) };
  // Claude Code names the directory by replacing only "/" (2.1.309 keeps dots: -root-.claude).
  const tdir = path.join(projectsRoot, root.split("/").join("-"));
  const cutoff = Date.now() - days * 864e5;
  const tally = {};
  let sessions = 0, subagents = 0;
  const shares = [];
  for (const f of fs.readdirSync(tdir).filter(f => f.endsWith(".jsonl"))) {
    const file = path.join(tdir, f);
    if (fs.statSync(file).mtimeMs < cutoff) continue;
    sessions++;
    const subdir = path.join(tdir, f.slice(0, -6), "subagents");
    const children = (fs.existsSync(subdir) ? fs.readdirSync(subdir) : [])
      .filter(n => /^agent-.*\.jsonl$/.test(n))
      .map(n => replayAgent(readLines(path.join(subdir, n)), ctx, tally, null));
    subagents += children.length;
    const { agent } = replayAgent(readLines(file), ctx, tally, children);
    // Cost against eager delivery of the whole file. The unbound atoms stay
    // ambient. "end" is what the parent carries when the session stops; "per
    // request" averages over its tool calls, which is what each request pays.
    const base = compiled.chars - compiled.boundChars;
    if (agent.calls) shares.push({
      end: agent.carried.map(n => (base + n) / compiled.chars),
      perRequest: agent.occupancy.map(n => (base + n / agent.calls) / compiled.chars),
    });
  }
  return { root, sessions, subagents, boundAtoms: compiled.boundAtoms, tally, shares };
}

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : "-");

function printReplay(results) {
  const pooled = {};
  for (const r of results) {
    console.log(`${path.basename(r.root)}: ${r.sessions} sessions, ${r.subagents} subagents, ${r.boundAtoms} path atoms, ${r.tally.writeBlind || 0} Writes to a file the agent never read`);
    for (const [type, t] of Object.entries(r.tally)) {
      if (type === "writeBlind") { pooled.writeBlind = (pooled.writeBlind || 0) + t; continue; }
      const p = pooled[type] || (pooled[type] = { events: 0, pairs: 0, covered: CHANNELS.map(() => 0), full: CHANNELS.map(() => 0) });
      p.events += t.events; p.pairs += t.pairs;
      for (let c = 0; c < CHANNELS.length; c++) { p.covered[c] += t.covered[c]; p.full[c] += t.full[c]; }
    }
  }
  const shares = results.flatMap(r => r.shares);
  const med = (k, c) => { const v = shares.map(s => s[k][c]).sort((a, b) => a - b); return v.length ? pct(v[Math.floor(v.length / 2)], 1) : "-"; };
  console.log(`\nMedian share of CLAUDE.md characters in context, eager = 100%:`);
  for (const k of ["end", "perRequest"]) console.log(`  ${k.padEnd(11)}${CHANNELS.map((c, i) => `${c} ${med(k, i)}`).join(", ")}`);
  console.log(`\nPooled atom recall (share of governing atoms in context in time), by channel set:`);
  console.log(`${"event".padEnd(8)}${"events".padStart(8)}${"pairs".padStart(8)}${CHANNELS.map(c => c.padStart(9)).join("")}   all atoms in time (events)`);
  for (const type of ["edit", "review", "spawn", "return"]) {
    const t = pooled[type];
    if (!t) continue;
    console.log(`${type.padEnd(8)}${String(t.events).padStart(8)}${String(t.pairs).padStart(8)}${t.covered.map(n => pct(n, t.pairs).padStart(9)).join("")}   ${t.full.map(n => pct(n, t.events)).join(" / ")}`);
  }
  const all = ["edit", "review", "spawn", "return"].map(k => pooled[k]).filter(Boolean);
  const pairs = all.reduce((n, t) => n + t.pairs, 0);
  console.log(`${"all".padEnd(8)}${String(all.reduce((n, t) => n + t.events, 0)).padStart(8)}${String(pairs).padStart(8)}${CHANNELS.map((_, c) => pct(all.reduce((n, t) => n + t.covered[c], 0), pairs).padStart(9)).join("")}`);
}

// ---- exposure ----

// InstructionsLoaded payload fields (Claude Code 2.1.309, verified
// 2026-11-01). The payload carries paths only, never instruction text.
const EXPOSURE_FIELDS = ["session_id", "agent_id", "agent_type", "cwd", "file_path", "memory_type", "load_reason", "globs", "trigger_file_path", "parent_file_path"];

function appendExposure(payload, out = EXPOSURE_LOG) {
  const row = { ts: new Date().toISOString() };
  for (const k of EXPOSURE_FIELDS) if (payload[k] !== undefined) row[k] = payload[k];
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.appendFileSync(out, JSON.stringify(row) + "\n", { mode: 0o600 });
}

async function run(ctx) {
  const sub = ctx.argv[1];
  if (sub === "exposure") return appendExposure(JSON.parse(fs.readFileSync(0, "utf8")));
  const json = hasFlag(process.argv, "--json");
  if (sub === "compile") {
    if (!hasFlag(process.argv, "--dry-run")) throw new Error("atoms compile: writing rule files is not built yet; pass --dry-run");
    const out = ctx.roots.map(root => compileRepo(root));
    if (json) return console.log(JSON.stringify(out.map(({ index, ...r }) => r), null, 1));
    for (const r of out) {
      console.log(`${r.root}: ${r.chars} chars, ${r.atoms.length} atoms, ${r.boundAtoms} path atoms holding ${pct(r.boundChars, r.chars)} of the text, ${r.oversize} over ${ATOM_MAX} chars`);
      for (const a of [...r.atoms].sort((x, y) => y.chars - x.chars).slice(0, 12)) {
        console.log(`  ${String(a.chars).padStart(6)}  ${a.globs.length ? `path ${String(a.globs.length).padStart(3)} globs` : "unbound       "}  ${a.title}`);
      }
    }
    return;
  }
  if (sub === "replay") {
    const projectsRoot = flag(process.argv, "--projects") || path.join(os.homedir(), ".claude", "projects");
    const days = Number(flag(process.argv, "--days") || 60);
    const results = ctx.roots.map(root => replayRepo(root, projectsRoot, days));
    return json ? console.log(JSON.stringify(results, null, 1)) : printReplay(results);
  }
  throw new Error(USAGE);
}

module.exports = { run, splitAtoms, citedGlobs, repoIndex, compileRepo, replayRepo, bashReadTarget, appendExposure };
