"use strict";

// PreToolUse Task/Agent hook — subagent orientation Lane A (docs/018 + 022).
//
// Fires in the PARENT session when it is about to spawn a subagent (matcher
// "Task|Agent"; the tool arrives as tool_name "Agent" with input keys
// description/prompt/subagent_type/...). Returns `updatedInput` with a
// compact facts-only <codebase-intelligence> block APPENDED to
// tool_input.prompt — the injection-equivalent for subagents, which receive
// NO hook injection of their own (0/~205 transcripts, docs/016 R4 + 022 R-B).
//
// THE PRIME DIRECTIVE — never-modify-on-doubt: a corrupted Task call breaks
// agent spawning for the whole session, which is strictly worse than an
// unoriented subagent. Every error path, guard failure, or uncertainty exits
// 0 with NO stdout (tool call proceeds byte-identical). This is stronger
// than the other hooks' never-throw rule.
//
// Field-verified output pattern (docs/recon/018-subagents/pretask-hook.js,
// R-A PASS on general-purpose + Explore): hookSpecificOutput with
// permissionDecision "allow" + updatedInput. Residual pre-registered risk:
// how updatedInput renders in the INTERACTIVE permission dialog was not
// observable headless — this hook stays dogfood-wired (not in `sextant init`)
// until that spot check happens.

const { recordEvent } = require("../lib/telemetry");
const crypto = require("crypto");

function serializedUpdate(toolInput, appended, reason) {
  const updated = { ...toolInput, prompt: toolInput.prompt + "\n\n" + appended };
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: reason,
      updatedInput: updated,
    },
  });
}

// Compare only the anchors used by the freshness gate. Unknown values are
// normalized exactly as checkFreshness does; a known anchor becoming unknown
// is therefore a mismatch (fail closed).
function sameValidatedRepo(validated, current) {
  if (!validated || !current) return false;
  return (
    (validated.head ?? "") === (current.head ?? "") &&
    (validated.statusHash ?? "") === (current.statusHash ?? "")
  );
}

async function run() {
  try {
    const root = process.cwd();

    // Root guard: hooks adopt cwd without the user naming it; refuse
    // non-project roots BEFORE touching any state (no telemetry either —
    // recordEvent would mkdir .planning/intel and self-bootstrap the refusal
    // away, the exact bug class the guard exists to stop).
    const { checkRoot } = require("../lib/root-guard");
    if (!checkRoot(root, { requireMarker: true }).ok) return;

    const { readStdinJson } = require("../lib/cli");
    const data = await readStdinJson();
    if (!data || typeof data !== "object") return;

    const ti = data.tool_input;
    if (!ti || typeof ti !== "object" || Array.isArray(ti)) return;
    if (typeof ti.prompt !== "string" || !ti.prompt) return;

    // Never double-inject: a re-fired hook, a retried Task call, or a
    // subagent spawning its own subagent may already carry a block.
    if (ti.prompt.includes("</codebase-intelligence>")) {
      recordEvent(root, "pretask.skipped", { reason: "already_injected" });
      return;
    }

    const { buildOrientationBlock, ORIENT_MAX_BYTES } = require("../lib/orient");
    const built = await buildOrientationBlock(root, ti.prompt);
    if (!built) {
      // Silent absence: content-stale graph / no graph / internal error.
      recordEvent(root, "pretask.skipped", { reason: "no_block" });
      return;
    }

    let appended = built.block;
    let snapshot = null;
    let ambiguitySnapshot = false;
    let coherenceSkipReason = null;
    let coherenceReportMeta = null;
    let coherenceEligibleMeta = null;

    // PHASE F — a child capsule is the immutable record of facts this hook
    // prepared for one Agent/Task spawn. It does not prove the tool accepted
    // the rewrite or the child ran. Claude Code 2.0.43+ provides top-level
    // tool_use_id on both PreToolUse and PostToolUse; without it there is no
    // collision-free child identity, so only the orientation lane runs.
    try {
      const coherence = require("../lib/coherence");
      if (coherence.coherenceEnabled(root)) {
        const toolUseId = typeof data.tool_use_id === "string" ? data.tool_use_id : "";
        const { deriveSessionKey, rawSessionIdentity } = require("../lib/session");
        const parentSessionKey = deriveSessionKey(data);
        const parentKey = coherence.parentAgentKey(rawSessionIdentity(data));
        const childKey = coherence.childAgentKey(parentKey, toolUseId);
        if (!childKey) {
          recordEvent(root, "coherence.skipped", { reason: "no_spawn_id" });
        } else {
          const capsuleLib = require("../lib/capsule");
          const rootCapsule = capsuleLib.readCapsule(root, parentSessionKey);
          const taskId = rootCapsule && rootCapsule.taskId
            ? rootCapsule.taskId
            : "task_" + capsuleLib.shortHash(parentSessionKey);
          const workset = coherence.contextPathWorkset(built.taskFiles || []);
          const servedClaims = require("../lib/claims").mintClaims(root, built.taskFiles || [], {
            nowMs: Date.now(),
          });
          snapshot = coherence.buildSnapshot({
            taskId,
            agentKey: childKey,
            parentAgentKey: parentKey,
            spawnToolUseId: toolUseId,
            kind: "child",
            agentType: typeof ti.subagent_type === "string" ? ti.subagent_type : null,
            state: "spawn_prepared",
            createdAt: Date.now(),
            // This is the graph scan-state fingerprint that freshness actually
            // validated, not a later fingerprint taken after graph retrieval.
            repo: built.validatedRepo,
            intent: { text: ti.prompt.slice(0, 500), declaredBy: "parent" },
            workset,
            servedClaims,
            // Filled after the optional coherence report is finalized. Retry
            // identity must cover the complete rewritten payload, not only
            // the Lane-A orientation prefix.
            blockHash: "",
          });

          // The candidate consumes one of the bounded 64 report identities,
          // including when an exact retry sits outside the newest peers.
          const maxPeers = 63;
          const existing = coherence.listSnapshots(root, { taskId, max: maxPeers });
          const analyzed = coherence.analyzeCoherence(root, {
            taskId,
            currentAgentKey: childKey,
            maxSnapshots: maxPeers,
          });
          // Add only overlaps involving this candidate; peer-vs-peer overlap
          // is already visible to the parent and would waste child context.
          const candidateOverlaps = [];
          for (const peer of existing) {
            if (peer.agentKey === childKey) continue;
            const overlap = coherence.worksetOverlap(snapshot, peer);
            if (!overlap.sharedPathTotal && !overlap.sharedRegionTotal) continue;
            candidateOverlaps.push({
              agentA: childKey < peer.agentKey ? childKey : peer.agentKey,
              agentB: childKey < peer.agentKey ? peer.agentKey : childKey,
              involvesCurrent: true,
              ...overlap,
            });
          }
          candidateOverlaps.sort((a, b) =>
            a.agentA.localeCompare(b.agentA) || a.agentB.localeCompare(b.agentB)
          );
          analyzed.overlaps = candidateOverlaps;
          analyzed.overlapPairTotal = candidateOverlaps.length;
          analyzed.snapshotCount = new Set([
            childKey,
            ...existing.map((entry) => entry.agentKey),
          ]).size;

          if (coherence.hasFindings(analyzed)) {
            const crossGroups = analyzed.agentClaims.filter((g) => g.agentKey !== childKey);
            coherenceEligibleMeta = {
              overlaps: analyzed.overlapPairTotal,
              changed: crossGroups.reduce((n, g) => n + g.changed.length, 0),
              invalidated: crossGroups.reduce((n, g) => n + g.invalidated.length, 0),
              surface: "child_spawn",
            };
            const tagOverhead = Buffer.byteLength(
              "\n<sextant-agent-coherence>\n\n</sextant-agent-coherence>",
              "utf8"
            );
            const remaining = ORIENT_MAX_BYTES - built.bytes - tagOverhead;
            if (remaining > 40) {
              const rendered = coherence.renderCoherenceDetailed(analyzed, { maxChars: remaining });
              const report = rendered.text;
              const deliveredFindings =
                rendered.delivered.overlapPairs +
                rendered.delivered.changed +
                rendered.delivered.invalidated;
              if (report && deliveredFindings > 0) {
                const safeReport = require("../lib/cli").stripUnsafeXmlTags(report);
                const block =
                  `<sextant-agent-coherence>\n${safeReport}\n</sextant-agent-coherence>`;
                if (Buffer.byteLength(built.block + "\n" + block, "utf8") <= ORIENT_MAX_BYTES) {
                  appended = built.block + "\n" + block;
                  coherenceReportMeta = {
                    overlaps: rendered.delivered.overlapPairs,
                    changed: rendered.delivered.changed,
                    invalidated: rendered.delivered.invalidated,
                    surface: "child_spawn",
                  };
                }
              }
            }
          }

        }
      }
    } catch {
      // Phase F absence must never endanger the proven Lane-A spawn rewrite.
      snapshot = null;
      appended = built.block;
      coherenceEligibleMeta = null;
    }

    // Serialize both possible outputs before registration. The atomic
    // registrar decides whether this identity may carry Phase-F context; a
    // reused/failed identity receives the already-proven Lane-A rewrite only.
    let coherenceOut;
    let laneOut;
    try {
      coherenceOut = serializedUpdate(
        ti,
        appended,
        snapshot
          ? "sextant: appended codebase orientation and spawn coherence"
          : "sextant: appended codebase orientation block"
      );
      laneOut = serializedUpdate(
        ti,
        built.block,
        "sextant: appended codebase orientation block"
      );
      if (snapshot) {
        // Hash the exact serialized rewrite, including every original
        // tool_input field and the complete appended payload. Same prompt text
        // with a changed model/type/description is not the same spawn attempt.
        snapshot.blockHash = crypto
          .createHash("sha256")
          .update(coherenceOut)
          .digest("hex");
      }
    } catch {
      return;
    }

    let registration = null;
    let out = coherenceOut;
    if (snapshot) {
      try {
        registration = require("../lib/coherence").registerSpawnSnapshot(root, snapshot);
      } catch {
        registration = { status: "failed" };
      }
      if (registration.status === "ambiguous") {
        ambiguitySnapshot = true;
        coherenceSkipReason = "spawn_id_reused";
        coherenceReportMeta = null;
        coherenceEligibleMeta = null;
        out = laneOut;
      } else if (registration.status === "withheld") {
        ambiguitySnapshot = true;
        coherenceSkipReason = "spawn_preparation_withheld";
        coherenceReportMeta = null;
        coherenceEligibleMeta = null;
        out = laneOut;
      } else if (registration.status === "failed") {
        coherenceSkipReason = "snapshot_write_failed";
        coherenceReportMeta = null;
        coherenceEligibleMeta = null;
        out = laneOut;
      } else if (registration.status === "moved") {
        // The registrar rechecked the graph anchors while holding the identity
        // lock and persisted nothing. Lane A is stale too, so preserve the
        // original tool call byte-for-byte.
        recordEvent(root, "pretask.skipped", { reason: "fingerprint_moved" });
        recordEvent(root, "coherence.skipped", { reason: "fingerprint_moved" });
        return;
      }
    }

    // Final stdout fence after registration and its storage GC. If the graph
    // anchors moved during publication, terminally hide the new preparation so
    // a later PostToolUse cannot join context this hook never emitted.
    try {
      const current = require("../lib/freshness").captureCurrentState(root);
      if (!sameValidatedRepo(built.validatedRepo, current)) {
        if (snapshot && registration && registration.status === "written") {
          try {
            require("../lib/coherence").suppressSpawnSnapshot(
              root,
              snapshot.agentKey,
              snapshot.blockHash
            );
          } catch {}
        }
        recordEvent(root, "pretask.skipped", { reason: "fingerprint_moved" });
        if (snapshot) {
          recordEvent(root, "coherence.skipped", { reason: "fingerprint_moved" });
        }
        return;
      }
    } catch {
      return;
    }

    // The persisted boundary means "prepared by this hook", not proof that
    // the tool or child received it. Emit immediately after the atomic identity
    // and freshness decision; all telemetry follows the stdout boundary.
    process.stdout.write(out);
    recordEvent(root, "pretask.injected", {
      subagentType: typeof ti.subagent_type === "string" ? ti.subagent_type : null,
      bytes: built.bytes,
      taskFiles: built.taskFiles.length,
    });

    if (snapshot) {
      if (registration.status === "written") {
        recordEvent(root, "coherence.agent_registered", {
          kind: "child",
          state: snapshot.state,
          claims: snapshot.servedClaims.length,
          agentType: snapshot.agentType,
        });
      }
    }
    if (coherenceSkipReason) {
      recordEvent(root, "coherence.skipped", { reason: coherenceSkipReason });
    }
    if (coherenceEligibleMeta && !ambiguitySnapshot) {
      recordEvent(root, "coherence.report_eligible", coherenceEligibleMeta);
    }
    if (coherenceReportMeta && !ambiguitySnapshot) {
      recordEvent(root, "coherence.delta_delivered", coherenceReportMeta);
    }
  } catch {
    // never-modify-on-doubt: silence = unmodified Task call.
  }
}

module.exports = { run };
