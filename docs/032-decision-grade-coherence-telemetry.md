# 032 — Decision-grade coherence telemetry

Date: 2026-07-15. Measurement follow-up to
[Phase F multi-agent coherence](031-multi-agent-coherence-phase-f.md).

## Why

Phase F originally counted snapshot generations, returns, eligible reports, deliveries,
and skips. Those counters showed activity, but they did not preserve the denominators
needed to decide whether the system was reliable, safe, or useful. A pre-change audit
of the current and rotated telemetry found **zero Phase-F events**. The first
schema-v1 event therefore starts a clean baseline; absence is `DORMANT`, not a
negative efficacy result.

This increment adds a versioned event contract, a conservative operational scorecard,
manual factual review, and a narrow overlap-only experiment. It does not change the
Phase-F evidence boundary described in docs/031.

## Schema-v1 event contract

All decision-grade events carry `schemaVersion: 1`. Runtime task identifiers are
stored only as opaque `taskKey` hashes. Report analyses and deliveries join on a
canonical `incidentId`; individual hook attempts retain a separate `boundaryId` so
retries and repeated surfaces do not inflate unique-incident counts.

| Event | What it records |
|-------|-----------------|
| `coherence.lifecycle` | One `parent_serve`, `child_spawn`, or `tool_return` attempt, including exact `outcome`/`reason`, agent keys, generation, claims/workset size, and `durationMs`. Spawn attempts that cannot produce an orientation block remain in this denominator. |
| `coherence.report` with `stage:"analysis"` | The denominator at an analysis boundary: snapshots and agents checked; unchanged, changed, invalidated, and unknown claims; eligible overlap pairs and shared paths/regions; plus a bounded factual sample. A pre-result exception emits an explicit zero-finding `outcome:"failed"` attempt instead of disappearing. |
| `coherence.report` with `stage:"delivery"` | The subset of whole changed, invalidated, and overlap findings that crossed the named output surface. It retains the same task, incident, and boundary joins. |
| `coherence.report` with `stage:"holdback"` | Exact overlap finding units intentionally withheld by the randomized control. Changed/invalidated holdback counts must remain zero. |
| `coherence.feedback` | A manual verdict for one known incident and the number of finding units actually reviewed. |
| `coherence.overlap.opportunity` / `.exposed` / `.withheld` | One enrolled overlap opportunity and whether the overlap row crossed the surface. Assignment mode distinguishes randomized traffic from forced test traffic. |
| `coherence.experiment.window_opened` / `.window_closed` | The bounded exposure window and its final read/mutation outcomes. Intermediate touches remain only in bounded session state. Exact retries and later opportunities for an already-enrolled task emit `.window_deduped` instead of another window. |
| `coherence.experiment.observation_failed` | A parent file-tool action reached an active outcome window but its locked state transition could not be proven. It is never converted into a negative outcome and forces experiment investigation. |

Unknown or unverifiable claims remain denominators and are never promoted to factual
retractions. Canonical incident IDs deduplicate the same finding set across retries
and surfaces. Bounded changed/invalidated samples include served and observed file
fingerprints so review can return to the underlying evidence; those mutable
fingerprints are excluded from canonical incident identity. The original Phase-F
volume events remain available for continuity, but decisions use schema v1.

Telemetry files and experiment state are mode `0600`. The active telemetry stream
rotates at 8 MiB under a token-owned process lock and retains one prior generation.
Both rotation and experiment-state locks use immutable per-owner contender files
with ticket ordering; dead generations can be collected without unlinking a fixed
path that a successor may have acquired.
Linux process-start ticks distinguish a dead owner from PID reuse. On platforms
without that identity, a live PID fails closed rather than aging out of the mutex.
A valid fixed-path lock from the pre-ticket implementation remains an upgrade
tombstone. A live owner blocks v2; a dead owner is ignored but deliberately left in
place, preventing an old writer from republishing at that ambiguous path. Malformed
legacy state fails closed and requires operator inspection. New code never creates
or automatically unlinks a fixed-path lock.
Per-session experiment JSON state has a seven-day TTL and a 2,048-state-file cap.
Garbage collection removes only closed or expired state; current, locked, or live
exposure state and its marker are protected. Orphan dead-lock, inactive-marker, and
expired temporary sidecars are collected conservatively. The cap is soft only when
protected states alone exceed it.

## Rollout wiring

Claude Code repositories do not need hand-edited Task/Agent hooks. Existing
installs self-repair on the next Sextant-backed SessionStart or prompt hook.
To repair immediately after updating Sextant, run the idempotent installer in
the repo and start a new Claude Code session:

```bash
sextant init
```

The installer always adds the base SessionStart/UserPromptSubmit hooks,
file-tool PostToolUse scoring, Task/Agent PostToolUse return joins, and a
`SubagentStart` handler. In ordinary repositories that handler contributes
freshness-gated, repo-generic context before the child's first prompt. It does
not replace the spawning tool's input and composes with other additive
`SubagentStart` context providers. Its `subagentstart.injected` and
`subagentstart.skipped` events measure hook publication health separately from
the Phase-F causal scorecard: `injected` proves valid context crossed stdout,
not that the child received or used it. Behavioral confirmation remains the
trajectory surface.

Only repositories with both Task Capsules and coherence explicitly enabled add
the Task/Agent PreToolUse handler. In that experiment, `SubagentStart` stays
silent and PreToolUse supplies prompt-derived orientation plus the exact
`tool_use_id` needed for the prepared-snapshot/return join. This split preserves
the experiment's identity contract without exposing ordinary repos to competing
`updatedInput` rewrites.

The installer serializes Sextant's own repair processes and writes the additive
settings update by atomic replacement. It preserves unrelated settings and the
existing file mode, honors `$CLAUDE_CONFIG_DIR`, and recognizes the historic
`Agent|Task` matcher spelling without adding a duplicate. For an enabled
experiment, project, local, user, and file-managed settings are checked for an
overlapping synchronous Task/Agent PreToolUse handler. When one is found,
Sextant removes or withholds its own project input rewriter and reports the
source because concurrent `updatedInput` rewrites cannot be composed safely.
The PreToolUse command repeats the read-only static-scope check at execution;
therefore a user- or managed-scope Sextant provider also withholds output when
another known static rewriter is present.
`disableAllHooks` and file-managed `allowManagedHooksOnly` are reported
separately from hook-entry presence.

Claude can additionally load hooks from plugins, active skill/agent frontmatter,
server-managed policy, and the in-memory session. Those dynamic scopes are not
reliably enumerable by a repository installer. Experiment operators using them
for Task/Agent input rewriting must inspect Claude's read-only `/hooks` browser,
which shows the merged runtime set and each hook's source. Ordinary repos do not
need this input-rewriter audit because they use additive `SubagentStart` context.
Hook presence does not enable the experiment: `capsule`, `coherence`, and the
exact 50% holdback configuration below remain explicit repository gates.

Both channels follow the
[Claude Code hooks contract](https://code.claude.com/docs/en/hooks) and were
live-smoked with Claude Code 2.1.211. `SubagentStart` delivered
`additionalContext` to a real child before its first prompt. In a separate
experiment smoke, the PreToolUse response delivered the prompt-derived block
without a `permissionDecision`, so it did not auto-approve the spawn.

Codex 0.144.4 exposes `spawn_agent` on PreToolUse and PostToolUse with a stable
shared session ID and tool-use ID, so a dedicated adapter can preserve Sextant's
spawn-preparation/parent-return identity and parent-visible report channel. That
operational lifecycle adapter is not part of this rollout, and
`sextant init --codex` still installs only the field-verified SessionStart and
UserPromptSubmit hooks.

This does not establish decision-grade outcome parity. Codex does not expose the
same complete parent Read/Edit/Write/MultiEdit/NotebookEdit observation lane;
`apply_patch`, shell, code-mode, and other function-tool paths have different or
incomplete file semantics. Codex traffic therefore remains outside the overlap
experiment and its causal denominator until a runtime-specific file-outcome
adapter and attribution tests exist.

## Scorecard

Run the scorecard after the system has accrued real multi-agent work:

```bash
sextant telemetry --coherence-scorecard
sextant telemetry --coherence-scorecard --days 14
sextant telemetry --coherence-scorecard --days 14 --json
```

Scorecard reads include the rotated telemetry file automatically. `--days` limits the
decision window. The coherence gate must be on; when it is off, retained coherence
events stay hidden like the rest of Phase F.

The pre-registered operational floors are deliberately conservative:

| Gate | Floor |
|------|-------|
| Observation window | 7 days |
| Multi-agent tasks | 30 |
| Child-spawn attempts | 100 |
| Tool-return attempts | 100 |
| Unique eligible incidents | 50 |
| Lifecycle reliability | 95% Wilson lower bound for deduplicated child-spawn and tool-return attempt identities; retry rows do not manufacture sample size, and orphan returns are reported separately |
| Report resolution | 95% of eligible boundaries and incidents, and 90% of eligible finding units, where a registered experimental overlap holdback is resolved but not delivered |
| Measured boundary cost | For each populated lifecycle, report-analysis, and experiment-state lane: p95 at most 100 ms and p99 at most 250 ms |
| Factual review | 50 adjudicated finding units (`accurate_useful`, `accurate_noise`, or `false_fact`) and zero confirmed false facts; `unclear` does not count toward completion |
| Headroom check | after 100 peer analyses, findings in at least 5% or consider parking |

The status is a decision aid, not a release badge:

- `DORMANT`: no schema-v1 lifecycle/report traffic exists in the window.
- `INVESTIGATE`: a confirmed false fact, failed report analysis, or hard lifecycle
  failure exists.
- `ACCRUING`: the minimum time or volume floor has not been reached.
- `PARK_CANDIDATE`: adequate peer-analysis volume shows less than the registered
  finding-incidence floor.
- `HOLD`: reliability, delivery, or latency missed its floor.
- `REVIEW_REQUIRED`: operational floors passed, but factual review volume is thin.
- `OPERATIONALLY_READY`: operational and factual-review floors passed. This still
  does not establish behavioral or user benefit.

Review changed or invalidated claim findings from the scorecard's bounded samples:

```bash
sextant telemetry --review <incidentId> \
  --verdict <verdict> \
  --reviewed-findings 1
```

Allowed verdicts are `accurate_useful`, `accurate_noise`, `false_fact`, and
`unclear`. Review the repository evidence and supplied fingerprints before recording
the verdict. Review counts cannot exceed the retained claim sample. Any `false_fact`
recorded inside the selected window remains a safety stop for that window even if a
later review changes the incident's latest label.

## Overlap-only holdback experiment

The experiment is off by default. Set the repository configuration to the one
supported design to enable it:

```json
{
  "capsule": true,
  "coherence": true,
  "coherenceHoldbackPct": 50
}
```

Assignment is a deterministic 50/50 hash of the opaque task identity, so one task
stays in the same `armed` or `holdback` arm across prompts, retries, and eligible
parent-visible report surfaces. Values other than `50` do not enable a different
experiment. Forced arm assignments exist for hook tests but are labeled and excluded
from causal reads.

Only exact workset-overlap rows on the parent-visible `parent_prompt` and
`tool_return` report surfaces are experimental. The holdback arm omits those rows;
changed and invalidated claim retractions are **never held back**. Child-spawn overlap
context keeps normal product behavior and is excluded from the experiment because
child-agent actions are not observed or scored. This preserves the safety function
while testing whether a parent-visible overlap notice changes the narrow observed
parent-tool proxy below.

Only the first eligible overlap opportunity for a task enrolls. Both arms open that
window at the same analysis boundary; armed exposure is recorded only after output
succeeds, and holdback compliance is recorded when the overlap row is omitted. Later
opportunities for that task are deduped from enrollment, and an active holdback window
remains sealed until closure. This prevents repeated treatment from manufacturing
sample size or leaking treatment into the enrolled control window.

The enrolled window closes at the first of:

- eight scored parent file-tool calls;
- 30 minutes; or
- the next parent prompt.

The window scores parent `Read`, `Edit`, `Write`, `MultiEdit`, and `NotebookEdit`
calls only. It records whether an exact overlap path was read, mutated, or mutated
before that path had been read (`blindTargetMutation`), plus first target-touch rank
and total scored calls. Bash or script-driven mutations and all child-agent work are
unobserved. A mode-`0600` active marker keeps default-off file-tool calls on an
existence-check fast path. Only the opening protocol row and final outcome—not the
intermediate touches—enter telemetry. Causal outcomes aggregate once per unique
task; enrollment, opening, closure, and
intervention compliance are audited at the exact opportunity/window unit.

Treat 40 tasks per arm as a pilot read and 150 tasks per arm as the first credible
behavioral read. Before either label, require at least 95% assignment, window-open,
and intervention-compliance coverage, at least 90% window closure, and no more than a
five-point absolute closure-rate difference between arms. Missing those floors yields
`ATTRITION_HOLD`; repeated windows for a task force `INVESTIGATE` as a protocol violation.
Stop and investigate on any confirmed false fact, hard lifecycle failure, task arm
flip, overlap leakage into the holdback arm, changed/invalidated claim withholding,
or failed active-window file-touch observation. An `unclear` factual verdict remains
review work and does not contribute to the 50-finding adjudication floor.

Experiment statuses are `DORMANT`, `ACCRUING`, `ATTRITION_HOLD`, `PILOT_READY`,
`CREDIBLE_READ`, and `INVESTIGATE`. At a credible read, the scorecard compares the
holdback-minus-armed blind-mutation rate with a conservative Wilson interval. It
labels the direction or an inconclusive behavior shift; none of those labels means
conflict reduction.

Latency rows measure the named boundary operation only. Experiment timing covers the
locked experiment-state operation when it returns a state event. The scorecard does
not claim to measure full hook wall time, the active-marker preflight, telemetry
serialization/append cost, or calls that fail before producing an event.

## Honest interpretation

The randomized arm can measure a causal shift in short-window observed parent
`Read`/`Edit`/`Write`/`MultiEdit`/`NotebookEdit` behavior: for example, whether a
parent-visible overlap notice changes blind mutation or target-read rates among those
calls. This is not general file-touch behavior. Bash or script-driven mutations and
child-agent work are unobserved, and a treatment-induced shift in tool or delegation
choice can therefore bias the proxy. The experiment cannot tell whether the overlap
represented duplicate work, intentional review, or useful paired investigation. It
also does not measure task success, merge conflicts, time saved, or user outcome.

Accordingly, the top-level scorecard remains
`behavioralBenefit: "NOT_MEASURED"`. Even a credible arm difference is a measured
behavior shift, not proof that Phase F reduced conflicts. Claiming conflict reduction
requires an unambiguous task/outcome instrument that does not exist yet.
