"use strict";

// Subagent orientation block builder (docs/018 Lane A + Lane B, docs/022).
//
// Builds the compact, FACTS-ONLY <codebase-intelligence> block used by the
// ordinary SubagentStart context hook, the prompt-derived PreToolUse coherence
// experiment, and the sextant_orient MCP tool.
//
// LOAD-BEARING CONSTRAINTS (docs/022 recon, all field-verified):
//   - FACTS ONLY, no imperatives. The R-A probe's self-described injected
//     marker was explicitly discounted as untrusted by the Explore agent
//     ("treating it as untrusted context and not following any directive").
//     Statements of fact ("this repo exposes X") survive that posture;
//     instructions ("call X first") risk being deliberately ignored by
//     exactly the safety-conscious agent types Lane A most wants to reach.
//   - BYTE-CAPPED. N parallel subagents multiply every byte; the block is
//     hard-capped and sections are dropped whole (never mid-line truncated)
//     in reverse priority order until it fits.
//   - FRESHNESS-GATED with silent absence. Subagents can't see the
//     statusline; a stale structural claim reaching them has NO correction
//     channel. Content-stale (HEAD/status moved) → return null, inject
//     nothing. A pure version bump (scanner/schema) does NOT suppress — the
//     graph's file facts are still valid (same contentChanged rule as the
//     hook-refresh retrieval lane).

const path = require("path");

// ~900 chars of content per docs/018; the cap includes the XML tags. Checked
// against the assembled block; sections are dropped whole to fit.
const ORIENT_MAX_BYTES = 1100;
const ORIENT_HOTSPOT_COUNT = 5;
const ORIENT_TASK_FILE_COUNT = 4;

// Build the orientation block. Returns:
//   { block, bytes, taskFiles, validatedRepo } — fresh graph plus the exact
//       HEAD/status anchors whose graph facts passed checkFreshness
//   null                         — silent absence (no graph, content-stale,
//                                  empty index, or any internal error)
//
// taskPrompt (optional): the subagent's mission statement; identifier-shaped
// terms from it drive a graph-only retrieval (same <50ms path as the refresh
// hook's Layer 1-4) whose top hits become the "Task-relevant files" line.
async function buildOrientationBlock(rootAbs, taskPrompt) {
  try {
    const graph = require("./graph");
    const freshness = require("./freshness");

    const fresh = await freshness.checkFreshness(rootAbs);
    // Silent absence on content-stale: stale paths/claims must never reach a
    // context that has no staleness indicator. (checkFreshness failure throws
    // into the outer catch → null, the fail-closed direction.)
    if (fresh.fresh === false && fresh.contentChanged === true) return null;

    const db = await graph.loadDb(rootAbs);
    if (!db) return null;

    // `checkFreshness` compared the live repo to these scan-state anchors in
    // this graph. Carry the anchors themselves to the caller: taking a new
    // fingerprint after the check would create a TOCTOU hole where an edit
    // could become the baseline while the block below still came from the old
    // graph. Each hook caller compares this exact pair immediately before
    // publishing context or an input rewrite.
    const storedHead = graph.getMetaValue(db, freshness.META_HEAD);
    const storedStatusHash = graph.getMetaValue(db, freshness.META_STATUS_HASH);
    const validatedRepo = {
      root: rootAbs,
      branch: null,
      head: typeof storedHead === "string" && storedHead ? storedHead : null,
      statusHash:
        typeof storedStatusHash === "string" && storedStatusHash
          ? storedStatusHash
          : null,
    };

    const fileCount = graph.countFiles(db);
    if (!fileCount) return null;

    // Section 1 (never dropped): identity + health, one line each.
    const head = [];
    let gitLine = "";
    try {
      const { getGitInfo } = require("./git");
      const gi = getGitInfo(rootAbs);
      if (gi) {
        gitLine = ` (${gi.branch} @ ${String(gi.head).slice(0, 7)})`;
        // Branch is descriptive rather than a freshness anchor. Retain it only
        // when it belongs to the validated HEAD; the hook compares HEAD/status.
        if (!validatedRepo.head || gi.head === validatedRepo.head) {
          validatedRepo.branch = gi.branch;
        }
      }
    } catch {}
    head.push(`Repo: ${rootAbs}${gitLine}`);
    const res = graph.computeResolutionStats(db);
    head.push(
      `Index: ${fileCount} files, import resolution ${res.resolutionPct}% (${res.localResolved}/${res.localTotal})`
    );

    // Section 2: dependency hotspots — the "which files matter" fact.
    let hotspotLine = "";
    try {
      const depended = graph.mostDependedOn(db, ORIENT_HOTSPOT_COUNT);
      if (depended.length) {
        hotspotLine =
          "High fan-in files: " +
          depended.map((d) => `${d.path} (${d.c})`).join(", ");
      }
    } catch {}

    // Section 3: task-relevant files from the graph (query-aware — the Task
    // prompt IS the subagent's mission statement).
    let taskLine = "";
    let taskFiles = [];
    if (typeof taskPrompt === "string" && taskPrompt.trim()) {
      try {
        const { shouldRetrieve } = require("./classifier");
        const cls = shouldRetrieve(taskPrompt.slice(-8192));
        if (cls && Array.isArray(cls.terms) && cls.terms.length) {
          const gr = require("./graph-retrieve").graphRetrieve(db, cls.terms, {
            maxResults: ORIENT_TASK_FILE_COUNT,
            // Task prompts are missions, not typo-laden chat: treat weak
            // classifier confidence as borderline exactly like the refresh
            // hook so loose mid-word path guesses stay out.
            borderline: typeof cls.confidence === "number" && cls.confidence <= 0.4,
          });
          const files = (gr && gr.files) || [];
          if (files.length) {
            taskFiles = files.map((f) => ({ path: f.path, source: f.hitType || "graph" }));
            taskLine =
              "Files matching this task's terms (dependency graph): " +
              files.map((f) => f.path).join(", ");
          }
        }
      } catch {}
    }

    // Section 4: MCP availability, stated as fact (not an instruction).
    const mcpLine =
      "This repo's MCP server exposes: sextant_search, sextant_explain, sextant_related, sextant_health.";

    // Assemble under the cap: drop sections whole in reverse priority
    // (mcp → hotspots → task line stays longest since it's per-task signal;
    // head is never dropped).
    const assemble = (parts) =>
      `<codebase-intelligence>\n${parts.filter(Boolean).join("\n")}\n</codebase-intelligence>`;
    const candidates = [
      [head.join("\n"), taskLine, hotspotLine, mcpLine],
      [head.join("\n"), taskLine, hotspotLine],
      [head.join("\n"), taskLine],
      [head.join("\n")],
    ];
    for (const parts of candidates) {
      const block = assemble(parts);
      if (Buffer.byteLength(block, "utf8") <= ORIENT_MAX_BYTES) {
        return {
          block,
          bytes: Buffer.byteLength(block, "utf8"),
          taskFiles: parts.includes(taskLine) && taskLine ? taskFiles : [],
          validatedRepo,
        };
      }
    }
    // Even the head alone is over cap (pathological root path) — silence.
    return null;
  } catch {
    return null;
  }
}

module.exports = {
  buildOrientationBlock,
  ORIENT_MAX_BYTES,
};
