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
// BLAST-RADIUS EMITTER (docs/016 Sprint 1): this hook ALSO owns sextant's only
// action-time injection.  After the agent EDITS a file, it may emit one small
// factual note — the file's not-yet-touched dependents and top co-change
// partners — via the structured-JSON channel.  R1 field-verified (Claude Code
// 2.1.198): plain stdout from PostToolUse goes to the debug log ONLY (never
// context, never transcript); exit 0 with
//   {"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"…"}}
// IS injected into Claude's context as a system-reminder, cap 10k chars.
//
// CRITICAL CONSTRAINTS (mirror hook-refresh):
//   - MUST NEVER throw (every path caught; telemetry must never break a tool).
//   - Telemetry scoring stays out-of-band: NOTHING is written to stdout except
//     the deliberate additionalContext JSON envelope, and only on an emission
//     turn.  Non-emission turns write zero bytes (the 009 invariant preserved).
//   - Structural claims obey the freshness gate: a content-stale graph emits
//     NOTHING (silent absence over false confidence).  A pure version-stale
//     graph (contentChanged=false) still emits — same distinction hook-refresh
//     draws (the cried-wolf guard).
//   - At most ONE emission per (session, file): editing the same file again
//     stays silent, so a tight edit loop is never nagged.

const fs = require("fs");
const path = require("path");
const { deriveSessionKey } = require("../lib/session");
const { readStdinJson } = require("../lib/cli");
const { recordEvent } = require("../lib/telemetry");

// Tools that target a concrete file we may have surfaced.  file_path lives in
// tool_input for Read/Edit/Write/MultiEdit; NotebookEdit uses notebook_path.
// Glob/Grep/Bash/etc. don't open a single ranked file, so they're out of scope.
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

// Mutating subset: only these can trigger a blast-radius emission (a Read has
// no blast radius).  Reads still matter — they mark files "touched", which
// subtracts them from future notes.
const MUTATE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// Emission thresholds.  MIN_FANIN keeps leaf-file edits silent (editing a
// 1-dependent helper isn't blast radius); partner floors ride on the stored
// pairs (count>=3 at mine time) plus a confidence bar so only "these really
// move together" partners surface.  Caps keep the note ~300 chars.
const BR_MIN_FANIN = 3;
const BR_PARTNER_MIN_CONFIDENCE = 0.4;
const BR_MAX_PARTNERS = 2;
const BR_MAX_DEP_NAMES = 3;
const BR_STATE_TTL_MS = 24 * 60 * 60 * 1000; // matches INJECTED_SET_TTL_MS rationale
const BR_MAX_TOUCHED = 500;

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

// ---------------------------------------------------------------------------
// Blast-radius emitter (docs/016 Sprint 1)

function brStateFile(root, sessionKey) {
  return path.join(root, ".planning", "intel", `.blastradius.${sessionKey}`);
}

// Per-session blast-radius state: which files the agent has touched (any
// FILE_TOOL), and which files we've already emitted a note for (with the
// surfaced paths, so a future open-scoring pass can attribute).  Same TTL
// rationale as the injected set: sessionKey fallbacks recycle across days.
function readBrState(root, sessionKey) {
  try {
    const parsed = JSON.parse(fs.readFileSync(brStateFile(root, sessionKey), "utf8"));
    if (!parsed || typeof parsed.ts !== "number" || Date.now() - parsed.ts > BR_STATE_TTL_MS) {
      return { ts: Date.now(), touched: [], emitted: {} };
    }
    return {
      ts: parsed.ts,
      touched: Array.isArray(parsed.touched) ? parsed.touched : [],
      emitted: parsed.emitted && typeof parsed.emitted === "object" ? parsed.emitted : {},
    };
  } catch {
    return { ts: Date.now(), touched: [], emitted: {} };
  }
}

function writeBrState(root, sessionKey, state) {
  try {
    if (state.touched.length > BR_MAX_TOUCHED) {
      state.touched = state.touched.slice(-BR_MAX_TOUCHED);
    }
    fs.writeFileSync(brStateFile(root, sessionKey), JSON.stringify(state));
  } catch {
    // best-effort — state loss degrades to a possible duplicate note, never an error
  }
}

// Pure note composer.  Returns null when there's nothing worth saying —
// silence is the default; the note must earn its context budget.  Facts only,
// no imperatives (R1: command-like hook output can trip injection defenses).
function composeBlastRadiusNote(repoRel, { dependents, partners, touchedSet }) {
  const untouchedDeps = dependents.filter((d) => !touchedSet.has(d) && d !== repoRel);
  const freshPartners = partners.filter(
    (p) => !touchedSet.has(p.partner) && p.partner !== repoRel && !untouchedDeps.includes(p.partner)
  );

  const depWorthy = dependents.length >= BR_MIN_FANIN && untouchedDeps.length > 0;
  const partnerWorthy = freshPartners.length > 0;
  if (!depWorthy && !partnerWorthy) return null;

  const parts = [];
  const surfaced = [];
  if (depWorthy) {
    const names = untouchedDeps.slice(0, BR_MAX_DEP_NAMES);
    const more = untouchedDeps.length - names.length;
    parts.push(
      `${dependents.length} files import it; not yet opened this session: ${names.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`
    );
    surfaced.push(...names.map((p) => ({ path: p, source: "dependent" })));
  }
  if (partnerWorthy) {
    const shown = freshPartners.slice(0, BR_MAX_PARTNERS);
    parts.push(
      `historically co-changes with ${shown
        .map((p) => `${p.partner} (${p.count} commits)`)
        .join(", ")}`
    );
    surfaced.push(...shown.map((p) => ({ path: p.partner, source: "cochange" })));
  }

  return {
    note: `Blast radius of ${repoRel}: ${parts.join("; ")}.`,
    surfaced,
    dependentCount: depWorthy ? Math.min(untouchedDeps.length, BR_MAX_DEP_NAMES) : 0,
    cochangeCount: partnerWorthy ? Math.min(freshPartners.length, BR_MAX_PARTNERS) : 0,
  };
}

// The one deliberate stdout write in this hook (see CRITICAL CONSTRAINTS).
function emitAdditionalContext(note) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: note,
      },
    })
  );
}

// Decide-and-emit for a mutating tool call.  Ordering is cheapest-first:
// per-session dedupe (fs read) → graph queries (in-memory sqlite) → freshness
// (two git subprocesses, only paid when a note would actually be emitted).
async function maybeEmitBlastRadius(root, sessionKey, repoRel, brState) {
  if (brState.emitted[repoRel]) return false; // once per (session, file)

  let db;
  try {
    const graph = require("../lib/graph");
    db = await graph.loadDb(root);
    if (!db) return false;

    const dependents = [
      ...new Set(graph.queryDependents(db, repoRel).map((r) => r.fromPath)),
    ];
    const partners = graph.findCoChangePartners(db, repoRel, {
      limit: BR_MAX_PARTNERS + 2, // headroom: some get subtracted as touched
      minConfidence: BR_PARTNER_MIN_CONFIDENCE,
    });

    const composed = composeBlastRadiusNote(repoRel, {
      dependents,
      partners,
      touchedSet: new Set(brState.touched),
    });
    if (!composed) return false;

    // Freshness gate LAST: structural claims only from a content-fresh graph.
    // Pure version staleness (contentChanged=false) keeps the claims valid —
    // same distinction hook-refresh draws.
    const freshness = await require("../lib/freshness").checkFreshness(root);
    if (freshness && freshness.fresh === false && freshness.contentChanged === true) {
      return false;
    }

    emitAdditionalContext(composed.note);
    brState.emitted[repoRel] = {
      ts: Date.now(),
      paths: composed.surfaced,
    };
    recordEvent(root, "blastradius.injected", {
      dependents: composed.dependentCount,
      cochange: composed.cochangeCount,
    });
    return true;
  } catch {
    return false;
  }
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
    const repoRel = toRepoRel(root, filePath);
    if (repoRel == null) return; // outside the repo → not ours to score or annotate

    // --- Lane 1: outcome scoring (out-of-band telemetry, semantics unchanged) ---
    const parsed = readInjectedRaw(root, sessionKey);
    const injectedMap = buildInjectedMap(parsed);
    if (injectedMap) {
      // arm stamps EVERY event so open-precision can be split armed vs holdback —
      // the armed−holdback delta is the actual benefit signal (009 #1 follow-up).
      // On a holdback turn the block was NOT shown, so these opens are the baseline.
      const arm = readInjectedArm(parsed);
      const verdict = classifyOpen(injectedMap, repoRel);
      if (verdict) {
        if (verdict.hit) {
          // source = the signal that surfaced this file → per-signal open attribution.
          recordEvent(root, "retrieval.path_hit", { source: verdict.source, tool, arm });
        } else {
          recordEvent(root, "retrieval.path_miss", { tool, arm });
        }
      }
    }

    // --- Lane 2: blast-radius emitter (docs/016 Sprint 1) ---
    // Touched-tracking runs for EVERY file tool (a Read marks the dependent as
    // seen); emission only for mutations.  The file being edited is excluded
    // from its own note inside the composer, so touch-ordering is immaterial.
    const brState = readBrState(root, sessionKey);
    const alreadyTouched = brState.touched.includes(repoRel);
    let emitted = false;
    if (MUTATE_TOOLS.has(tool)) {
      emitted = await maybeEmitBlastRadius(root, sessionKey, repoRel, brState);
    }
    if (!alreadyTouched) brState.touched.push(repoRel);
    if (emitted || !alreadyTouched) writeBrState(root, sessionKey, brState);
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
