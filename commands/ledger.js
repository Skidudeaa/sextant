"use strict";

// `sextant ledger census` — every hook injection in recent Claude Code
// sessions, counted by the hook command that produced it (docs/050). This is
// the Context Ledger's first instrument. A source cannot be held back and
// scored until it is attributed. Aggregates only: no injected text is printed,
// because some transcripts carry PHI.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { flag, hasFlag } = require("../lib/cli");

// What reaches the model: additionalContext on any event, plain stdout on
// SessionStart and UserPromptSubmit, and a blocking error's reason. Plain
// stdout on any other event lands in the transcript only (docs/016 R1). Async
// hook responses are counted apart because nothing here shows whether they
// reach the model.
const STDOUT_EVENTS = new Set(["SessionStart", "UserPromptSubmit"]);
const TOP = 15;

function textOf(a) {
  const c = a.type === "hook_blocking_error" ? a.blockingError : a.type === "async_hook_response" ? a.stdout : a.content;
  if (Array.isArray(c)) return c.join("\n");
  if (typeof c === "string") return c;
  return c == null ? "" : JSON.stringify(c);
}

function visibility(a) {
  if (a.type === "hook_additional_context" || a.type === "hook_blocking_error") return "model";
  if (a.type === "async_hook_response") return "unverified";
  return a.type === "hook_success" && STDOUT_EVENTS.has(a.hookEvent) ? "model" : "transcript";
}

// Plugin paths carry a version, and a token pasted into a hook command must
// not reach the report.
const normalize = cmd => cmd.replace(/\/\d+\.\d+\.\d+[^/\s"']*/g, "/<version>").replace(/[A-Za-z0-9_-]{32,}/g, "<redacted>");

// The context a hook_success emitted as JSON, or its raw stdout.
function emitted(s) {
  const out = String(s.stdout || "");
  if (!out.trimStart().startsWith("{")) return out;
  try {
    return String(JSON.parse(out).hookSpecificOutput?.additionalContext || out);
  } catch {
    return out; // stdout that only looks like JSON is still the text the hook printed
  }
}

// additionalContext rows carry no command. The hook_success of the same run
// does, and its stdout holds the context: same tool call first, then any run
// of the same event in the session (SessionStart rows share no tool id).
function sourceOf(a, byCall, byEvent) {
  if (a.command) return normalize(a.command);
  if (a.type === "hook_additional_context") {
    const head = textOf(a).slice(0, 200);
    for (const pool of [byCall.get(`${a.toolUseID}|${a.hookEvent}`), byEvent.get(a.hookEvent)]) {
      const hit = (pool || []).find(s => emitted(s).includes(head));
      if (hit) return normalize(hit.command);
    }
  }
  return `(unattributed ${a.type === "async_hook_response" ? "async " : ""}${a.hookName || a.hookEvent || a.type})`;
}

function toolResultChars(rec) {
  let n = 0;
  for (const b of rec.message?.content || []) {
    if (b?.type !== "tool_result") continue;
    const c = b.content;
    n += typeof c === "string" ? c.length : (Array.isArray(c) ? c : []).reduce((sum, x) => sum + (typeof x?.text === "string" ? x.text.length : 0), 0);
  }
  return n;
}

function scanSession(file, project, sources, totals) {
  const hooks = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"tool_result"') && !line.includes('"attachment"')) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // the last line of a live session can be half written
    }
    if (Array.isArray(rec.message?.content)) totals.toolResult += toolResultChars(rec);
    const a = rec.attachment;
    if (a && (String(a.type).startsWith("hook_") || a.type === "async_hook_response")) hooks.push(a);
  }
  const byCall = new Map();
  const byEvent = new Map();
  for (const a of hooks) {
    if (a.type !== "hook_success" || !a.command) continue;
    for (const [map, key] of [[byCall, `${a.toolUseID}|${a.hookEvent}`], [byEvent, a.hookEvent]]) map.set(key, [...(map.get(key) || []), a]);
  }
  let modelChars = 0;
  for (const a of hooks) {
    const vis = visibility(a);
    const chars = textOf(a).length;
    totals[vis] += chars;
    if (vis === "transcript" || !chars) continue;
    if (vis === "model") modelChars += chars;
    const id = sourceOf(a, byCall, byEvent);
    if (!sources.has(id)) sources.set(id, { source: id, visibility: vis, chars: 0, injections: 0, sessions: new Set(), projects: new Set(), events: new Set() });
    const s = sources.get(id);
    s.chars += chars;
    s.injections++;
    s.sessions.add(file);
    s.projects.add(project);
    s.events.add(a.hookEvent);
  }
  return modelChars;
}

/**
 * Count hook injections in top-level sessions under projectsRoot whose
 * transcript changed in the last `days` days. Subagent transcripts (in
 * per-session subdirectories) are not read. Returns totals in characters
 * and every source sorted by characters, model-visible sources first.
 */
function census(projectsRoot, { days = 60, now = Date.now() } = {}) {
  const cutoff = now - days * 86400e3;
  const sources = new Map();
  const totals = { model: 0, unverified: 0, transcript: 0, toolResult: 0 };
  const perSession = [];
  for (const dir of fs.readdirSync(projectsRoot)) {
    const projectDir = path.join(projectsRoot, dir);
    if (!fs.statSync(projectDir).isDirectory()) continue;
    for (const name of fs.readdirSync(projectDir)) {
      const file = path.join(projectDir, name);
      if (!name.endsWith(".jsonl") || fs.statSync(file).mtimeMs < cutoff) continue;
      perSession.push(scanSession(file, dir.replace(/^-root-/, ""), sources, totals));
    }
  }
  perSession.sort((a, b) => a - b);
  const list = [...sources.values()]
    .map(s => ({ ...s, sessions: s.sessions.size, projects: [...s.projects].sort(), events: [...s.events].sort() }))
    .sort((a, b) => (a.visibility === b.visibility ? b.chars - a.chars : a.visibility === "model" ? -1 : 1));
  return {
    projectsRoot, days, sessions: perSession.length,
    medianModelCharsPerSession: perSession.length ? perSession[Math.floor(perSession.length / 2)] : null,
    totals, sources: list,
  };
}

function render(r) {
  const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "n/a");
  const out = [
    `Hook injections, last ${r.days} days, ${r.sessions} top-level sessions (${r.projectsRoot})`,
    `  reaches the model:   ${r.totals.model.toLocaleString()} chars (${pct(r.totals.model, r.totals.toolResult)} of tool-result chars), median ${r.medianModelCharsPerSession?.toLocaleString()} per session`,
    `  async, unverified:   ${r.totals.unverified.toLocaleString()} chars`,
    `  transcript only:     ${r.totals.transcript.toLocaleString()} chars`,
    `  tool results:        ${r.totals.toolResult.toLocaleString()} chars`,
    "",
    "     chars  share  inject  sess  events / projects / source",
  ];
  for (const s of r.sources.slice(0, TOP)) {
    const share = s.visibility === "model" ? pct(s.chars, r.totals.model) : "async";
    out.push(`${s.chars.toLocaleString().padStart(10)} ${share.padStart(6)} ${String(s.injections).padStart(7)} ${String(s.sessions).padStart(5)}  ${s.events.join(",")} / ${s.projects.slice(0, 4).join(",")}${s.projects.length > 4 ? ",…" : ""}`);
    out.push(`${" ".repeat(32)}${s.source.length > 110 ? `${s.source.slice(0, 109)}…` : s.source}`);
  }
  if (r.sources.length > TOP) out.push(`  … ${r.sources.length - TOP} more sources (--json for all)`);
  return out.join("\n");
}

async function run(ctx) {
  if (ctx.argv[1] !== "census") throw new Error("usage: sextant ledger census [--projects <path>] [--days <N>] [--json]");
  const projectsRoot = flag(process.argv, "--projects") || path.join(os.homedir(), ".claude", "projects");
  const days = Number(flag(process.argv, "--days") || 60);
  const report = census(projectsRoot, { days });
  console.log(hasFlag(process.argv, "--json") ? JSON.stringify(report, null, 2) : render(report));
}

module.exports = { run, census, visibility, normalize };
