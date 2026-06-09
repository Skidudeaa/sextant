"use strict";

// ARCHITECTURE: Outcome-telemetry substrate (009 #1) — the PostToolUse half of
// the benefit-proof loop.
//
// The UserPromptSubmit retrieval hook (hook-refresh.js) surfaces a ranked set of
// files into Claude's context and persists that set, per session, to
// .planning/intel/.last_injected_paths.retrieval.<sessionKey> as { paths: [{path,
// source}] }.  This hook fires AFTER a file-targeting tool runs (Read/Edit/
// Write/MultiEdit/NotebookEdit) and asks one question: was the file the agent
// just touched one we surfaced?  It emits:
//   retrieval.path_hit  { source, tool }  — opened a file we surfaced
//   retrieval.path_miss { tool }          — opened a file we did NOT surface
// against the MOST RECENT injection for this session.  `sextant telemetry` then
// reports an open-rate (and a per-source breakdown), turning "did the agent use
// what we surfaced?" from unanswerable into a logged number.
//
// HONEST SCOPE (v1 — "loop wired, baseline pending", per 009 #1):
//   - This is NOT a benefit number yet.  open-rate is a correlation with no
//     counterfactual — the agent often opens the canonical file regardless of
//     injection.  The per-turn injection-OFF holdback arm that makes it a real
//     benefit metric is the explicit follow-up; this commit wires the loop and
//     the per-SOURCE attribution it needs.
//   - path_miss includes opens of unrelated files (after an injection).  That is
//     deliberate and documented in the telemetry surface; it is precision-
//     flavored, not coverage.
//
// CRITICAL CONSTRAINTS (mirror hook-refresh):
//   - MUST NEVER throw (every path caught; telemetry must never break a tool).
//   - MUST NOT write to stdout.  A PostToolUse hook's stdout can reach the
//     transcript/context; this substrate is out-of-band telemetry only → zero
//     context-budget cost (the 009 invariant).

const fs = require("fs");
const path = require("path");
const { deriveSessionKey } = require("../lib/session");
const { readStdinJson } = require("../lib/cli");
const { recordEvent } = require("../lib/telemetry");

// Tools that target a concrete file we may have surfaced.  file_path lives in
// tool_input for Read/Edit/Write/MultiEdit; NotebookEdit uses notebook_path.
// Glob/Grep/Bash/etc. don't open a single ranked file, so they're out of scope.
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

function extractFilePath(data) {
  const ti = data && data.tool_input;
  if (!ti || typeof ti !== "object") return "";
  const p = ti.file_path || ti.notebook_path || "";
  return typeof p === "string" ? p : "";
}

function injectedPathsFile(root, sessionKey) {
  return path.join(
    root,
    ".planning",
    "intel",
    `.last_injected_paths.retrieval.${sessionKey}`
  );
}

// TTL for a persisted injection set. sessionKey fallbacks (terminal_id, TMUX
// pane, ppid) recycle across days — without an age gate, a set persisted by a
// long-dead session scores TODAY's opens against a days-old surfaced corpus,
// silently corrupting open-precision. 24h is generous for one session; the
// file is overwritten on every injection anyway.
const INJECTED_SET_TTL_MS = 24 * 60 * 60 * 1000;

// Parse the most-recent injection set file for this session into its raw object.
// null on missing/malformed/expired file (expired ⇒ the caller emits NO event —
// an unscoreable open, not a miss).
function readInjectedRaw(root, sessionKey) {
  let raw;
  try {
    raw = fs.readFileSync(injectedPathsFile(root, sessionKey), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed.ts !== "number" ||
      Date.now() - parsed.ts > INJECTED_SET_TTL_MS
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// Build the Map<relPath, source> from a parsed set object. null when there's
// nothing to score against (no paths / empty) — the caller emits NO event then,
// so path_hit/path_miss only count opens that had a real surfaced set.
function buildInjectedMap(parsed) {
  if (!parsed || !Array.isArray(parsed.paths)) return null;
  const map = new Map();
  for (const entry of parsed.paths) {
    if (entry && typeof entry.path === "string") {
      map.set(entry.path, typeof entry.source === "string" ? entry.source : "text_only");
    }
  }
  return map.size ? map : null;
}

// The arm tag (009 #1 follow-up) of a parsed set: "armed" (block was shown) or
// "holdback" (block was withheld — this turn is the counterfactual baseline).
// Legacy sets written before the holdback arm carry no `arm` field → "armed"
// (they were all effectively armed), so historical scoring is unchanged.
function readInjectedArm(parsed) {
  return parsed && typeof parsed.arm === "string" ? parsed.arm : "armed";
}

// Back-compat wrapper kept for existing callers/tests: Map<relPath, source>.
function readInjectedSet(root, sessionKey) {
  return buildInjectedMap(readInjectedRaw(root, sessionKey));
}

// Normalize an opened file path to the repo-relative form the injected set uses
// (graph-retrieve emits forward-slash repo-relative paths).  tool_input.file_path
// is typically absolute; relative paths are resolved against root.  Returns null
// when the path resolves OUTSIDE root — an open we have no business scoring.
//
// WHY realpath both sides (SPM-1): process.cwd()/the graph scan root and the
// tool's file_path can reach the SAME file through different symlink
// representations — macOS /tmp→/private/tmp, /var→/private/var, or a symlinked
// checkout. A purely-lexical path.relative would then yield "../…" and false-MISS
// every open, silently zeroing open-precision while the loop is in fact working
// (the exact "make the number trustworthy" purpose the substrate exists for).
// realpathSync collapses both to the canonical form; the try/catch falls back to
// the lexical path when a target doesn't exist yet (e.g. a Write creating a new
// file — which wasn't surfaced anyway, so it correctly won't match).
function toRepoRel(root, filePath) {
  if (!filePath || typeof filePath !== "string") return null;
  let rootR;
  try {
    rootR = fs.realpathSync(root);
  } catch {
    rootR = root;
  }
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(rootR, filePath);
  let absR;
  try {
    absR = fs.realpathSync(abs);
  } catch {
    absR = abs;
  }
  const rel = path.relative(rootR, absR);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel;
}

// Pure, unit-testable verdict.  Returns { hit, source } or null when not
// scoreable (no set / no path).
function classifyOpen(injectedMap, repoRel) {
  if (!injectedMap || !repoRel) return null;
  if (injectedMap.has(repoRel)) return { hit: true, source: injectedMap.get(repoRel) };
  return { hit: false, source: null };
}

async function run() {
  // Belt-and-suspenders: the whole body is best-effort.  A telemetry substrate
  // must never be the reason a tool-use errors.
  try {
    const root = process.cwd();
    const data = await readStdinJson();

    const tool = data && data.tool_name;
    if (!FILE_TOOLS.has(tool)) return; // not a file-targeting tool → nothing to score

    const filePath = extractFilePath(data);
    if (!filePath) return;

    const sessionKey = deriveSessionKey(data);
    const parsed = readInjectedRaw(root, sessionKey);
    const injectedMap = buildInjectedMap(parsed);
    if (!injectedMap) return; // no surfaced set this session → no denominator, emit nothing
    // arm stamps EVERY event so open-precision can be split armed vs holdback —
    // the armed−holdback delta is the actual benefit signal (009 #1 follow-up).
    // On a holdback turn the block was NOT shown, so these opens are the baseline.
    const arm = readInjectedArm(parsed);

    const repoRel = toRepoRel(root, filePath);
    if (repoRel == null) return; // outside the repo → not ours to score

    const verdict = classifyOpen(injectedMap, repoRel);
    if (!verdict) return;

    if (verdict.hit) {
      // source = the signal that surfaced this file → per-signal open attribution.
      recordEvent(root, "retrieval.path_hit", { source: verdict.source, tool, arm });
    } else {
      recordEvent(root, "retrieval.path_miss", { tool, arm });
    }
  } catch {
    // Never throw on the hook hot path (see CRITICAL CONSTRAINTS).
  }
}

module.exports = {
  run,
  // exported for unit tests:
  classifyOpen,
  toRepoRel,
  extractFilePath,
  readInjectedSet,
  readInjectedRaw,
  buildInjectedMap,
  readInjectedArm,
  injectedPathsFile,
  FILE_TOOLS,
};
