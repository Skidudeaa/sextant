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
const regionsLib = require("../lib/regions");

function recordExperimentEvents(root, events) {
  for (const event of events || []) {
    if (!event || typeof event.name !== "string") continue;
    const { name, ...payload } = event;
    recordEvent(root, name, payload);
  }
}

// Tools that target a concrete file we may have surfaced.  file_path lives in
// tool_input for Read/Edit/Write/MultiEdit; NotebookEdit uses notebook_path.
// Glob/Grep/Bash/etc. don't open a single ranked file, so they're out of scope.
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

// Mutating subset: only these can trigger a blast-radius emission (a Read has
// no blast radius).  Reads still matter — they mark files "touched", which
// subtracts them from future notes.
const MUTATE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
// Parent-side subagent spawn tools. Phase F observes only the factual tool
// return boundary; it does not claim a child lifecycle/session id or attribute
// repository edits to that child.
const AGENT_TOOLS = new Set(["Agent", "Task"]);

// Emission thresholds.  MIN_FANIN keeps leaf-file edits silent (editing a
// 1-dependent helper isn't blast radius); partner floors ride on the stored
// pairs (count>=3 at mine time) plus a confidence bar so only "these really
// move together" partners surface.  Caps keep the note ~300 chars.
const BR_MIN_FANIN = 3;
const BR_PARTNER_MIN_CONFIDENCE = 0.4;
const BR_MAX_PARTNERS = 2;
const BR_MAX_DEP_NAMES = 3;
// Dir rollup (docs/021 form b, evidence docs/019/020): a bare "(+24 more)" tail
// wastes its bytes — "(+24 more: test/ 14, commands/ 9, …)" is digestible at
// nearly the same cost.  Only a remainder >= BR_ROLLUP_MIN earns the rollup
// (below that, the tail is short enough that dir grouping adds nothing).
const BR_ROLLUP_MIN = 4;
const BR_ROLLUP_DIRS = 3;
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

// TURN IDENTITY (docs/033 Tier 1 #1). The injected-set file is OVERWRITTEN once
// per injection, so its `ts` already uniquely identifies the turn every scored
// open belongs to — no new hook state, no extra write. Stamping it on each
// path_hit/path_miss lets the audit group opens by turn and report a
// session-shape-INDEPENDENT hit rate (turns with >=1 hit / turns scored).
//
// WHY this matters: per-open precision divides by every file the agent touched
// after an injection, which is unbounded and unrelated to retrieval quality. It
// fell 34.4% -> 1.6% purely because opens/turn rose 3.4 -> 28.4 (docs/033 §1).
//
// null when the set predates this field — the audit then counts the open as
// turn-unscored rather than silently folding it into a turn bucket.
function readInjectedTurn(parsed) {
  return parsed && typeof parsed.ts === "number" ? parsed.ts : null;
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
function hashSid(sessionKey) {
  if (!sessionKey) return null;
  return require("crypto").createHash("sha1").update(String(sessionKey)).digest("hex").slice(0, 12);
}

function classifyOpen(injectedMap, repoRel) {
  if (!injectedMap || !repoRel) return null;
  if (injectedMap.has(repoRel)) return { hit: true, source: injectedMap.get(repoRel) };
  return { hit: false, source: null };
}

// REGION LANE (docs/025 Phase A): the surfaced breadcrumb for one path in the
// most-recent injection set — { source, line, symbol } — or null when the path
// wasn't surfaced or carries no line to score against.  Exact-path match, same
// keying as buildInjectedMap/classifyOpen.
function readInjectedRegion(parsed, repoRel) {
  if (!parsed || !Array.isArray(parsed.paths) || !repoRel) return null;
  for (const entry of parsed.paths) {
    if (entry && entry.path === repoRel) {
      const line = typeof entry.line === "number" && entry.line > 0 ? entry.line : null;
      const symbol = typeof entry.symbol === "string" && entry.symbol ? entry.symbol : null;
      if (line == null && symbol == null) return null; // no breadcrumb to score
      return {
        source: typeof entry.source === "string" ? entry.source : "text_only",
        line,
        symbol,
      };
    }
  }
  return null;
}

function safeReadFile(absPath) {
  try {
    return fs.readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
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
    // MERGE-then-write (adversarial-review LOW-MEDIUM): parallel tool calls in
    // one assistant turn spawn concurrent hook processes; a plain last-writer-
    // wins overwrite could drop the other process's touched/emitted marks and
    // re-fire a "once per session+file" note.  Re-reading and unioning right
    // before the write shrinks the lost-update window to microseconds; the
    // tmp+rename keeps readers from ever seeing a torn file.  Residual race
    // accepted: worst case is one duplicate note, never corruption.
    const disk = readBrState(root, sessionKey);
    const touched = [...new Set([...disk.touched, ...state.touched])];
    const emitted = { ...disk.emitted, ...state.emitted };
    const merged = {
      ts: Math.min(state.ts, disk.ts),
      touched: touched.length > BR_MAX_TOUCHED ? touched.slice(-BR_MAX_TOUCHED) : touched,
      emitted,
    };
    const file = brStateFile(root, sessionKey);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(merged));
    fs.renameSync(tmp, file);
  } catch {
    // best-effort — state loss degrades to a possible duplicate note, never an error
  }
}

// Open-attribution map for the blast-radius lane (docs/017 lever #1): the
// UNION of every note's surfaced {path, source} this session → Map<path,
// source>.  Unlike lane 1 (most-recent injection only — retrieval sets
// overwrite each other), blast-radius notes are independent per-file facts
// that stay actionable all session, so they accumulate.  First-wins on a
// path surfaced by two notes (attribution goes to whichever note surfaced it
// first).  null when no note has been emitted yet — an unscoreable open, not
// a miss (same no-denominator rule as lane 1).
function buildEmittedMap(brState) {
  if (!brState || !brState.emitted || typeof brState.emitted !== "object") return null;
  const notes = Object.values(brState.emitted)
    .filter((n) => n && Array.isArray(n.paths))
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const map = new Map();
  for (const note of notes) {
    for (const entry of note.paths) {
      if (entry && typeof entry.path === "string" && !map.has(entry.path)) {
        map.set(entry.path, typeof entry.source === "string" ? entry.source : "dependent");
      }
    }
  }
  return map.size ? map : null;
}

// Per-dir rollup of a path list: "test/ 14, commands/ 9, …" — top dirs by
// count desc (name asc on ties), capped at BR_ROLLUP_DIRS with a "…" tail.
// Root-level files group under "./".
function dirRollup(paths) {
  const byDir = new Map();
  for (const p of paths) {
    const i = p.indexOf("/");
    const dir = i === -1 ? "./" : p.slice(0, i + 1);
    byDir.set(dir, (byDir.get(dir) || 0) + 1);
  }
  const sorted = [...byDir.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const shown = sorted.slice(0, BR_ROLLUP_DIRS).map(([d, n]) => `${d} ${n}`);
  return shown.join(", ") + (sorted.length > BR_ROLLUP_DIRS ? ", …" : "");
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
  let rollup = false;
  if (depWorthy) {
    const names = untouchedDeps.slice(0, BR_MAX_DEP_NAMES);
    const rest = untouchedDeps.slice(names.length);
    // Dir rollup (docs/021 form b): a large remainder gets grouped by top-level
    // dir instead of a bare count.  The SURFACED set is unchanged — dirs are
    // not openable paths, so open-attribution semantics stay identical; the
    // rollup only makes the tail informative.
    rollup = rest.length >= BR_ROLLUP_MIN;
    const tail =
      rest.length === 0
        ? ""
        : rollup
          ? ` (+${rest.length} more: ${dirRollup(rest)})`
          : ` (+${rest.length} more)`;
    parts.push(
      `${dependents.length} files import it; not yet opened this session: ${names.join(", ")}${tail}`
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
    // Stamped onto blastradius.injected so the open-rate comparison the 021
    // measurement plan calls for (rollup vs non-rollup notes) has its split.
    rollup,
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

// Phase F join report: PreToolUse recorded the exact facts prepared for this
// spawn under top-level tool_use_id. The matching PostToolUse tells us only
// that the parent-side tool returned; it does NOT prove which process changed
// a file. Re-check every recorded claim now and report overlap/invalidation to
// the parent via the already field-verified additionalContext channel.
async function maybeReportAgentReturn(root, data) {
  let reportAnalysisAttempt = null;
  let reportAnalysisRecorded = false;
  let reportAnalysisMeta = null;
  try {
    const coherence = require("../lib/coherence");
    if (!coherence.coherenceEnabled(root)) return;
    const metrics = require("../lib/coherence-metrics");
    const sessionKey = deriveSessionKey(data);
    const lifecycleStarted = Date.now();
    const toolUseId = typeof data.tool_use_id === "string" ? data.tool_use_id : "";
    if (!toolUseId) {
      recordEvent(root, "coherence.skipped", { reason: "no_return_id" });
      recordEvent(root, "coherence.lifecycle", metrics.buildLifecyclePayload({
        stage: "tool_return",
        kind: "child",
        outcome: "missing",
        reason: "no_return_id",
        durationMs: Date.now() - lifecycleStarted,
      }));
      return;
    }
    const { rawSessionIdentity } = require("../lib/session");
    const parentKey = coherence.parentAgentKey(rawSessionIdentity(data));
    const childKey = coherence.childAgentKey(parentKey, toolUseId);
    if (!childKey) {
      recordEvent(root, "coherence.skipped", { reason: "return_identity_unavailable" });
      recordEvent(root, "coherence.lifecycle", metrics.buildLifecyclePayload({
        parentAgentKey: parentKey,
        stage: "tool_return",
        kind: "child",
        outcome: "missing",
        reason: "return_identity_unavailable",
        durationMs: Date.now() - lifecycleStarted,
      }));
      return;
    }
    const prepared = coherence.readAgentSnapshot(root, childKey);
    const recordLifecycle = (outcome, reason, snapshot = prepared) => {
      const worksetPaths = snapshot && snapshot.workset
        ? ["primary", "support", "witnesses", "context"].reduce(
            (total, role) => total + (
              Array.isArray(snapshot.workset[role]) ? snapshot.workset[role].length : 0
            ),
            0
          )
        : 0;
      recordEvent(root, "coherence.lifecycle", metrics.buildLifecyclePayload({
        taskId: snapshot && snapshot.taskId,
        agentKey: childKey,
        parentAgentKey: parentKey,
        stage: "tool_return",
        kind: "child",
        state: snapshot && snapshot.state,
        outcome,
        reason,
        generation: snapshot && snapshot.generation,
        claims: snapshot && Array.isArray(snapshot.servedClaims)
          ? snapshot.servedClaims.length
          : 0,
        worksetPaths,
        durationMs: Date.now() - lifecycleStarted,
      }));
    };
    // This is an identity join, not a reporting query. The matching child must
    // remain addressable even when 64 newer peer agents fill the report cap.
    let transition;
    try {
      transition = coherence.registerReturnSnapshot(root, childKey);
    } catch {
      recordLifecycle("failed", "return_transition_exception");
      return;
    }
    if (transition.status === "missing") {
      recordEvent(root, "coherence.skipped", { reason: "no_spawn_snapshot" });
      recordLifecycle("missing", "no_spawn_snapshot");
      return;
    }
    if (transition.status === "ambiguous") {
      recordEvent(root, "coherence.skipped", { reason: "spawn_identity_ambiguous" });
      recordLifecycle("ambiguous", "spawn_identity_ambiguous", transition.snapshot);
      return;
    }
    if (transition.status === "withheld") {
      recordEvent(root, "coherence.skipped", { reason: "spawn_preparation_withheld" });
      recordLifecycle("withheld", "spawn_preparation_withheld", transition.snapshot);
      return;
    }
    if (!transition.snapshot || transition.status === "failed") {
      recordEvent(root, "coherence.skipped", { reason: "return_transition_failed" });
      recordLifecycle("failed", "return_transition_failed", transition.snapshot);
      return;
    }
    const child = transition.snapshot;
    if (transition.status === "written") {
      recordEvent(root, "coherence.agent_returned", {
        agentType: child.agentType,
        claims: child.servedClaims.length,
      });
    }

    recordLifecycle(
      transition.status === "retry" ? "retry" : "written",
      null,
      child
    );

    const reportStarted = Date.now();
    const reportBoundaryId = metrics.randomBoundaryId();
    reportAnalysisAttempt = {
      metrics,
      startedAt: reportStarted,
      boundaryId: reportBoundaryId,
      taskId: child.taskId,
      surface: "tool_return",
    };
    const result = coherence.analyzeCoherence(root, {
      taskId: child.taskId,
      currentAgentKey: parentKey,
    });
    const analysis = metrics.buildAnalysisPayload(result, {
      boundaryId: reportBoundaryId,
      surface: "tool_return",
    });
    recordEvent(root, "coherence.report", {
      ...analysis,
      stage: "analysis",
      outcome: analysis.reportFindings > 0 ? "eligible" : "none",
      durationMs: Math.max(0, Date.now() - reportStarted),
    });
    reportAnalysisRecorded = true;
    reportAnalysisMeta = analysis.reportFindings > 0 ? analysis : null;
    if (!coherence.hasFindings(result)) return;
    const crossGroups = result.agentClaims.filter((g) => g.agentKey !== parentKey);
    recordEvent(root, "coherence.report_eligible", {
      agents: result.snapshotCount,
      overlaps: result.overlapPairTotal,
      changed: crossGroups.reduce((n, g) => n + g.changed.length, 0),
      invalidated: crossGroups.reduce((n, g) => n + g.invalidated.length, 0),
      surface: "tool_return",
    });
    const wouldRender = coherence.renderCoherenceDetailed(result, { maxChars: 1000 });
    let experimentMeta = null;
    if (wouldRender.delivered.overlapPairs > 0 && wouldRender.overlapPaths.length > 0) {
      const experiment = require("../lib/coherence-experiment");
      const paths = experiment.eligiblePaths({
        overlaps: [{ sharedPaths: wouldRender.overlapPaths }],
      });
      const assignment = experiment.assignArm(child.taskId, {
        config: require("../lib/config").loadRepoConfig(root),
        env: process.env,
        force: data && data._coherenceHoldbackForce,
      });
      const opportunityId = experiment.opportunityKey(
        analysis.incidentId,
        "tool_return"
      );
      if (assignment.enabled && opportunityId && paths.length > 0) {
        const candidate = {
          schemaVersion: 1,
          experiment: experiment.EXPERIMENT_NAME,
          opportunityId,
          incidentId: analysis.incidentId,
          taskKey: assignment.taskKey,
          arm: assignment.arm,
          assignmentMode: assignment.assignmentMode,
          surface: "tool_return",
          targetPathCount: paths.length,
          eligibleOverlapPairs: wouldRender.delivered.overlapPairs,
          paths,
        };
        // This is the intention-to-treat denominator. Recording it before the
        // state write makes enrollment failures observable instead of silently
        // selecting tasks out of the experiment.
        recordEvent(root, "coherence.experiment.assigned", {
          schemaVersion: 1,
          experiment: experiment.EXPERIMENT_NAME,
          taskKey: assignment.taskKey,
          arm: assignment.arm,
          assignmentMode: assignment.assignmentMode,
          holdbackPct: assignment.holdbackPct,
        });
        // Intention-to-treat enrollment is symmetric. `exposed` is emitted only
        // after output succeeds, so compliance remains separately auditable.
        const exposureEvents = experiment.openExposure(root, sessionKey, {
          enabled: true,
          opportunityId,
          taskKey: assignment.taskKey,
          arm: assignment.arm,
          assignmentMode: assignment.assignmentMode,
          surface: "tool_return",
          paths,
        });
        const enrolled = exposureEvents.some(
          (event) => event && event.name === experiment.EVENT_OPENED &&
            event.opportunityId === opportunityId
        );
        if (enrolled) {
          experimentMeta = candidate;
          const { paths: ignoredPaths, ...opportunity } = experimentMeta;
          recordEvent(root, "coherence.overlap.opportunity", opportunity);
        } else {
          const activeHoldback = experiment.activeHoldbackEvent(
            exposureEvents,
            assignment.taskKey
          );
          if (activeHoldback) {
            // Preserve the original control policy until its outcome window
            // closes, but never register or resolve a duplicate opportunity.
            experimentMeta = {
              ...candidate,
              opportunityId: activeHoldback.enrolledOpportunityId,
              arm: "holdback",
              assignmentMode: activeHoldback.activeAssignmentMode || assignment.assignmentMode,
              continuedHoldback: true,
            };
          }
        }
        recordExperimentEvents(root, exposureEvents);
        if (experimentMeta && experimentMeta.arm === "holdback") {
          const { paths: ignoredPaths, ...opportunity } = experimentMeta;
          recordEvent(root, "coherence.report", {
            schemaVersion: 1,
            incidentId: analysis.incidentId,
            boundaryId: reportBoundaryId,
            taskKey: assignment.taskKey,
            surface: "tool_return",
            stage: "holdback",
            outcome: "intentional_overlap_holdback",
            experiment: experiment.EXPERIMENT_NAME,
            experimentArm: "holdback",
            continuedHoldback: experimentMeta.continuedHoldback === true,
            heldbackOverlapPairs: wouldRender.delivered.overlapPairs,
            heldbackChanged: 0,
            heldbackInvalidated: 0,
          });
          if (enrolled) recordEvent(root, "coherence.overlap.withheld", opportunity);
        }
      }
    }
    const rendered = experimentMeta && experimentMeta.arm === "holdback"
      ? coherence.renderCoherenceDetailed(result, { maxChars: 1000, includeOverlaps: false })
      : wouldRender;
    if (!rendered.text) return;
    const safe = require("../lib/cli").stripUnsafeXmlTags(rendered.text);
    const deliveredMeta = {
      agents: result.snapshotCount,
      overlaps: rendered.delivered.overlapPairs,
      changed: rendered.delivered.changed,
      invalidated: rendered.delivered.invalidated,
      surface: "tool_return",
    };
    emitAdditionalContext(
      `<sextant-agent-coherence>\n${safe}\n</sextant-agent-coherence>`
    );
    recordEvent(root, "coherence.delta_delivered", deliveredMeta);
    recordEvent(root, "coherence.report", {
      ...metrics.buildDeliveryPayload(result, rendered.delivered, {
        boundaryId: reportBoundaryId,
        surface: "tool_return",
      }),
      stage: "delivery",
      outcome: "delivered",
      reportBytes: Buffer.byteLength(safe, "utf8"),
      experiment: experimentMeta && experimentMeta.experiment,
      experimentArm: experimentMeta && experimentMeta.arm,
    });
    if (experimentMeta && experimentMeta.arm === "armed") {
      const { paths, ...event } = experimentMeta;
      recordEvent(root, "coherence.overlap.exposed", event);
    }
  } catch {
    try {
      if (reportAnalysisAttempt && !reportAnalysisRecorded) {
        recordEvent(root, "coherence.report", {
          ...reportAnalysisAttempt.metrics.buildFailedAnalysisPayload({
            taskId: reportAnalysisAttempt.taskId,
            boundaryId: reportAnalysisAttempt.boundaryId,
            surface: reportAnalysisAttempt.surface,
          }),
          stage: "analysis",
          outcome: "failed",
          reason: "analysis_exception",
          durationMs: Math.max(0, Date.now() - reportAnalysisAttempt.startedAt),
        });
      } else if (reportAnalysisRecorded && reportAnalysisMeta) {
        recordEvent(root, "coherence.report", {
          schemaVersion: 1,
          incidentId: reportAnalysisMeta.incidentId,
          boundaryId: reportAnalysisMeta.boundaryId,
          taskKey: reportAnalysisMeta.taskKey,
          surface: "tool_return",
          stage: "suppression",
          outcome: "not_delivered",
          reason: "report_pipeline_exception",
        });
      }
    } catch {}
    // Join reporting is best-effort and may never break an Agent tool result.
  }
}

// Decide-and-emit for a mutating tool call.  Ordering is cheapest-first:
// per-session dedupe (fs read) → graph queries (in-memory sqlite) → freshness
// (two git subprocesses, only paid when a note would actually be emitted).
// ANTI-SPRAWL (docs/030 Phase E): a NEW source file has no dependents/co-change,
// so it falls through the blast-radius composer. Fill that slot: surface the
// existing files whose names/symbols already match, so a parallel implementation
// is a visible choice. Matches recorded in emitted{} with source "sprawl_match"
// so the open-attribution lane scores whether the agent opened a suggestion
// ("nudges ignored?"). Capsule-gated; freshness handled like blast-radius
// (a new file self-causes drift; the MATCHES are existing graph files).
async function maybeEmitSprawl(root, repoRel, brState, db, graph) {
  try {
    const AS = require("../lib/anti-sprawl");
    const content = safeReadFile(path.resolve(root, repoRel)); // exists post-Write
    const matches = AS.findExistingMatches(graph, db, repoRel, content);
    if (!matches.length) return false;

    const freshnessMod = require("../lib/freshness");
    const freshness = await freshnessMod.checkFreshness(root);
    if (freshness && freshness.fresh === false && freshness.contentChanged === true) {
      const touchedSet = new Set([...brState.touched, repoRel]);
      if (!freshnessMod.isSelfCausedStatusDrift(db, root, touchedSet)) return false;
    }

    emitAdditionalContext(AS.composeSprawlNote(repoRel, matches));
    brState.emitted[repoRel] = {
      ts: Date.now(),
      paths: matches.map((m) => ({ path: m.path, source: "sprawl_match" })),
    };
    recordEvent(root, "sprawl.nudge", { path: repoRel, matchCount: matches.length });
    return true;
  } catch {
    return false;
  }
}

async function maybeEmitBlastRadius(root, sessionKey, repoRel, brState) {
  if (brState.emitted[repoRel]) return false; // once per (session, file)

  let db;
  try {
    const graph = require("../lib/graph");
    db = await graph.loadDb(root);
    if (!db) return false;

    // Phase E: a NEW indexable source file → anti-sprawl (capsule-gated). Default
    // behavior is unchanged when off (a new file emits nothing either way).
    try {
      const capsuleLib = require("../lib/capsule");
      const { isNewSourceFile } = require("../lib/anti-sprawl");
      const { isTestPath } = require("../lib/retrieve");
      // A NEW non-test source file. New TEST files aren't sprawl (a test for X is
      // legitimate), so they don't earn a nudge — keeps the lane low-noise.
      if (capsuleLib.capsuleEnabled(root) && !isTestPath(repoRel) && isNewSourceFile(graph, db, repoRel)) {
        return await maybeEmitSprawl(root, repoRel, brState, db, graph);
      }
    } catch {}

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
    // same distinction hook-refresh draws.  SELF-CAUSED-DRIFT exception
    // (found by the headless end-to-end gate): the agent's OWN edit makes the
    // tree content-stale at exactly the moment this note should fire, so
    // without a live watcher re-stamping scan state the lane would never
    // speak.  Drift confined to files this session touched does not
    // invalidate claims about OTHER files (the dependents/partners named in
    // the note); foreign drift still suppresses.
    const freshnessMod = require("../lib/freshness");
    const freshness = await freshnessMod.checkFreshness(root);
    if (freshness && freshness.fresh === false && freshness.contentChanged === true) {
      const touchedSet = new Set([...brState.touched, repoRel]);
      if (!freshnessMod.isSelfCausedStatusDrift(db, root, touchedSet)) {
        return false;
      }
    }

    emitAdditionalContext(composed.note);
    brState.emitted[repoRel] = {
      ts: Date.now(),
      paths: composed.surfaced,
    };
    recordEvent(root, "blastradius.injected", {
      dependents: composed.dependentCount,
      cochange: composed.cochangeCount,
      rollup: composed.rollup === true,
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
    // WHY: hooks adopt cwd — never score or annotate from a refused root
    // (home dir / non-project dir; see lib/root-guard.js). Out-of-band lane,
    // so the exit is silent by construction.
    const { checkRoot } = require("../lib/root-guard");
    if (!checkRoot(root, { requireMarker: true }).ok) return;
    const data = await readStdinJson();

    const tool = data && data.tool_name;
    if (AGENT_TOOLS.has(tool)) {
      await maybeReportAgentReturn(root, data);
      return;
    }
    if (!FILE_TOOLS.has(tool)) return; // not a file-targeting tool → nothing to score

    const filePath = extractFilePath(data);
    if (!filePath) return;

    const sessionKey = deriveSessionKey(data);
    const repoRel = toRepoRel(root, filePath);
    if (repoRel == null) return; // outside the repo → not ours to score or annotate

    // Score the next bounded file-touch window for the overlap-only randomized
    // trial. Reads and mutations remain distinct; an edit before a read of the
    // same target path is the pre-registered primary behavior outcome.
    try {
      const experiment = require("../lib/coherence-experiment");
      // Default-off installs have no exposure state, and completed experiments
      // retain only dedupe history. Neither case pays the lock/write path.
      if (experiment.hasActiveExposure(root, sessionKey)) {
        recordExperimentEvents(root, experiment.scoreTouch(root, sessionKey, {
          path: repoRel,
          action: MUTATE_TOOLS.has(tool) ? "mutation" : "read",
        }));
      }
    } catch {}

    // --- Lane 1: outcome scoring (out-of-band telemetry, semantics unchanged) ---
    const parsed = readInjectedRaw(root, sessionKey);
    const injectedMap = buildInjectedMap(parsed);
    if (injectedMap) {
      // arm stamps EVERY event so open-precision can be split armed vs holdback —
      // the armed−holdback delta is the actual benefit signal (009 #1 follow-up).
      // On a holdback turn the block was NOT shown, so these opens are the baseline.
      const arm = readInjectedArm(parsed);
      // turn = which injection this open scores against (docs/033 Tier 1 #1).
      const turn = readInjectedTurn(parsed);
      // sid (docs/035 #1): the hashed session this open happened in. decideArm
      // is Math.random() per TURN with no persisted assignment, so a single
      // session can contain both arms; without a session id that carryover is
      // undetectable and silently contaminates the contrast. NOT added to
      // path_miss as a `source` field — a miss is by construction an open of a
      // file we did NOT surface (classifyOpen returns source:null), so the
      // per-source DENOMINATOR has to come from the injection side instead. It
      // does: retrieval.turn_outcome.surfacedBySource.
      const sid = hashSid(sessionKey);
      const verdict = classifyOpen(injectedMap, repoRel);
      if (verdict) {
        if (verdict.hit) {
          // source = the signal that surfaced this file → per-signal open attribution.
          recordEvent(root, "retrieval.path_hit", { source: verdict.source, tool, arm, turn, sid });
        } else {
          recordEvent(root, "retrieval.path_miss", { tool, arm, turn, sid });
        }
      }

      // --- Lane 1r: region-level attribution (docs/025 Phase A) ---
      // Sharper than the path hit: on a MUTATION of a file we surfaced, did the
      // edit land in the REGION we pointed at (region_hit) or in a DIFFERENT
      // region of the right file (region_miss = reclaimable within-file
      // navigation, the Phase-A headroom signal)?  In-process languages only on
      // the hot path (allowSpawn:false → no python3 spawn); python/swift edits
      // score OFFLINE in eval-trajectory.  Additive — never replaces path events;
      // wrapped so a resolution failure can never break the hook.
      if (verdict && verdict.hit && MUTATE_TOOLS.has(tool)) {
        try {
          const region = readInjectedRegion(parsed, repoRel);
          if (region) {
            const tr = data.tool_response || data.toolUseResult || null;
            // Post-edit content: prefer the tool_response payload; else read disk
            // (PostToolUse fires AFTER the edit applied, so disk is post-edit too).
            let content =
              tr && typeof tr.content === "string"
                ? tr.content
                : tr && typeof tr.originalFile === "string"
                  ? tr.originalFile
                  : null;
            if (content == null) content = safeReadFile(path.resolve(root, repoRel));
            if (content != null) {
              const editedLines = regionsLib.deriveEditedLines(data.tool_input, tr, content);
              const regions = regionsLib.editedRegions(repoRel, content, editedLines, {
                allowSpawn: false,
              });
              const rv = regionsLib.scoreEditedRegion(region.line, region.symbol, regions);
              if (rv) {
                const evt = rv.hit ? "retrieval.region_hit" : "retrieval.region_miss";
                recordEvent(root, evt, {
                  source: region.source,
                  tool,
                  arm,
                  regionKind: rv.regionKind,
                });
              }
            }
          }
        } catch {
          // region lane is best-effort; path events above already recorded.
        }
      }
    }

    // --- Lane 3: structural delta (docs/029 Phase D) — capsule-gated ---
    // After a mutation, diff the file's NEW structure against the graph's stored
    // pre-image (exports/imports added/removed) and record it into the capsule's
    // touchedRegions so the closure report can summarize what the task changed.
    // Capsule-gated (dogfood-only), out-of-band telemetry, never throws.
    if (MUTATE_TOOLS.has(tool)) {
      try {
        const capsuleLib = require("../lib/capsule");
        if (capsuleLib.capsuleEnabled(root)) {
          const tr = data.tool_response || data.toolUseResult || null;
          // POST-edit content for the "new" structure (NOT originalFile — that's
          // pre-edit and would show a reversed delta). tool_response.content is
          // post-edit; disk is post-edit (hook fires after apply).
          let content = tr && typeof tr.content === "string" ? tr.content : null;
          if (content == null) content = safeReadFile(path.resolve(root, repoRel));
          if (content != null) {
            const graph = require("../lib/graph");
            const db = await graph.loadDb(root);
            if (db) {
              const SD = require("../lib/structural-delta");
              const delta = SD.computeStructuralDelta(db, graph, repoRel, content);
              if (delta.changed) {
                recordEvent(root, "structure.delta", {
                  exportsAdded: delta.exportsAdded.length,
                  exportsRemoved: delta.exportsRemoved.length,
                  importsAdded: delta.importsAdded.length,
                  importsRemoved: delta.importsRemoved.length,
                });
                capsuleLib.appendTouchedRegion(root, sessionKey, {
                  path: repoRel,
                  ts: Date.now(),
                  exportsAdded: delta.exportsAdded,
                  exportsRemoved: delta.exportsRemoved,
                  importsAdded: delta.importsAdded,
                  importsRemoved: delta.importsRemoved,
                });
              }
            }
          }
        }
      } catch {
        // structural-delta lane is best-effort; never breaks the hook.
      }
    }

    // --- Lane 2: blast-radius emitter (docs/016 Sprint 1) ---
    // Touched-tracking runs for EVERY file tool (a Read marks the dependent as
    // seen); emission only for mutations.  The file being edited is excluded
    // from its own note inside the composer, so touch-ordering is immaterial.
    const brState = readBrState(root, sessionKey);

    // --- Lane 1b: blast-radius open-attribution (docs/017 lever #1) ---
    // Same question as lane 1, asked of the notes: did the agent go look at a
    // file a blast-radius note named?  Scored against the state AS READ —
    // before this call's own emission is recorded below — so the edit that
    // triggers a note can never score against that note's own surfaced set.
    // Session-cumulative and precision-flavored (misses include opens of files
    // no note ever named), same caveats as lane 1; no arm (no holdback here).
    const emittedMap = buildEmittedMap(brState);
    if (emittedMap) {
      const brVerdict = classifyOpen(emittedMap, repoRel);
      if (brVerdict) {
        if (brVerdict.hit) {
          recordEvent(root, "blastradius.path_hit", { source: brVerdict.source, tool });
        } else {
          recordEvent(root, "blastradius.path_miss", { tool });
        }
      }
    }

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
  readInjectedTurn,
  readInjectedRegion,
  injectedPathsFile,
  buildEmittedMap,
  composeBlastRadiusNote,
  dirRollup,
  FILE_TOOLS,
  AGENT_TOOLS,
};
