# 031 — Multi-agent coherence (Phase F of the context-coherence arc)

Date: 2026-07-15. Branch `feat/region-outcome-substrate` (stacked on Phases A–E,
docs/025–030).

## Why

Phase C made the facts served to one session addressable, but stored them only in
that session's mutable Task Capsule. Phase F graduates that seam into a bounded,
per-agent observation layer: record the repository fingerprint and visible context
actually delivered to a parent or prepared by the hook for a child spawn; re-check
each recorded claim against the current repository; and surface factual overlap
between the recorded, visible file worksets.

This is **visibility and invalidation only**. It does not assign files, establish
ownership, identify an editor, lock a region, coordinate writers, or declare a
conflict. Running subagents still have no push channel. A changed fact can reach the
parent or a newly spawning child only at an existing hook boundary.

## Contract

### Explicit default-off gate

Phase F has its own gate in addition to Task Capsule mode:

- `SEXTANT_COHERENCE=1` or `.codebase-intel.json` `coherence: true` enables it.
- `SEXTANT_COHERENCE=0` / `false` forces it off.
- Task Capsule mode must also be enabled; coherence never turns capsules on by
  itself.

This separation is load-bearing. Repositories already dogfooding `capsule: true`
must not silently gain cross-agent injection behavior. This branch enables both
flags on sextant itself for dogfooding; that is not evidence for making either flag
default-on.

### Agent identity

`lib/coherence.js` derives opaque local keys for filenames and report labels:

- parent key = hash of the **raw** session identity;
- child key = hash of `(parent key, top-level tool_use_id)`.

The raw identity is hashed before filename sanitization, so values such as
`session/a` and `session_a` cannot collapse into one agent. There is deliberately no
prompt-based, timestamp-based, or sequential fallback for a missing child tool id:
identical parallel prompts are valid, so guessing would manufacture attribution.
The proven Lane-A orientation still runs when Phase F declines to record a child.

The snapshot retains the top-level tool-use id as join metadata, but does not render
it in reports. These keys identify recorded observation boundaries only. They are
not user identity, process identity, authorship, or proof that a particular child
changed a file.

The mutable Task Capsule still uses one stable task id per runtime session in v1.
Filesystem-safe session keys now append a hash of the raw id whenever sanitization
or truncation would lose information, while already-safe short keys remain byte-for-
byte compatible. This prevents filename/task collisions; it does not infer semantic
task boundaries inside one long runtime session. Sequential unrelated work in that
session may therefore share a Phase-F task group for up to the retention window.

### Immutable boundary snapshots

Each successful parent delivery or child-spawn preparation writes a new JSON
generation under:

`.planning/intel/.agent-capsule.<agentKey>.<createdAt>.<nonce>.json`

The snapshot contains:

- schema version, task id, agent key, optional parent key and spawn tool-use id;
- `parent|child` kind, agent type, and observed boundary state;
- creation time, monotonic generation, and repository fingerprint;
- bounded intent, the visible overlap-bearing workset, recorded claims, and the
  complete rewritten-block hash.

Values are JSON-detached at construction. Writes use a unique nonce plus
temporary-file rename, so concurrent boundaries create separate immutable generations
instead of contending on a last-writer-wins registry. State changes such as
`spawn_prepared` → `tool_returned` are new generations, not mutation in place. The
explicit generation number orders lifecycle observations that land in the same wall-
clock millisecond; snapshots are never future-dated to force ordering.

Reads accept only validated schema/file-identity pairs, ignore malformed and older-
than-24-hour generations, retain the newest generation per agent, and hard-cap each
report at 64 agents. An exact-key lifecycle lookup separately considers up to the 64
newest generations for that one requested agent, so the reporting cap alone cannot
hide a known spawn from its retry/return join. Workset output is deterministic and
bounded to 50 listed overlap items and 64 overlap pairs; the uncapped totals remain
in the result. Every publication also removes expired generations and the oldest
files above a 2,048-generation storage cap; TTL is not merely a read filter. The cap
protects each live agent's newest generation before history while distinct agents fit;
above 2,048 distinct retained agents, the newest agents win and older exact joins can
be evicted.

There is no code-coordination lock. A per-agent lifecycle integrity lock serializes
only spawn/retry/tombstone/return state transitions for one snapshot stream; it does
not reserve code or serialize agent work. If spawn registration or terminal
suppression cannot acquire that lock within its bounded wait, an immutable tokenized
contention marker poisons every older preparation for that exact identity. Exact
joins and reports then withhold it until the marker and older snapshots expire. A
return-only lock failure does not create poison because it introduces neither a new
identity nor new output. A separate short-lived integrity lock serializes only the
mutable Task Capsule's evidence merge so prompt refresh and PostToolUse append cannot
erase each other. These locks carry no ownership or scheduling meaning.

## Delivery channels

### Parent prompt — `commands/hook-refresh.js`

On an armed, non-deduped capsule retrieval that reaches the output boundary, the hook
records a parent `served` snapshot. Holdback, dedupe, stale-text-only, and failed-
output paths do not publish new served claims. The snapshot filters its role/region
workset to the file rows that survived the renderer's byte cap; hidden compiled rows
cannot create overlap.

At every later UserPromptSubmit—including conversational/static-summary and holdback
fallbacks—the hook can re-check same-session-task snapshots. If another recorded agent has a
changed/invalidated claim or any recorded pair has workset overlap, it prepends a
facts-only `<sextant-agent-coherence>` block. The block participates in the dedupe
hash, so a new retraction cannot be deduped behind an unchanged retrieval body.

### Child spawn — `commands/hook-pretask.js`

The already field-verified PreToolUse `Agent|Task` channel still appends the compact
Lane-A orientation block. When coherence is enabled and top-level `tool_use_id` is
present, Phase F additionally:

1. records the rendered task-file list as a neutral, path-only context workset (the
   compact block does not expose Task Capsule roles or regions);
2. mints claims only for facts included in that prepared block;
3. records a `spawn_prepared` child snapshot linked to the parent;
4. optionally appends overlap/invalidations involving the candidate child.

`spawn_prepared` means only that PreToolUse successfully built, validated, and
persisted the preparation before its stdout attempt. The snapshot alone does not prove
that the rewrite crossed stdout, that the Agent/Task tool accepted it, that the child
started, or that the child read the block. A final post-registration fingerprint fence
terminally hides a newly persisted preparation when publication is withheld. The later matching
PostToolUse boundary advances the observation to `tool_returned` without inventing a
child lifecycle state.

The combined orientation plus coherence payload remains under the existing 1100-byte
spawn budget. Reports drop whole factual lines rather than truncate facts. The exact
scan fingerprint freshness validated is checked again immediately before publication
for every Lane-A rewrite, even when Phase F is off; if it moved, the whole rewrite is
withheld rather than returning stale structural claims. The parent retrieval path has
the same publication fence. Its bounded fingerprint hashes dirty-file content, so a
second edit to an already-dirty path is visible; path count and bytes are capped and
over-budget state fails closed. Snapshot-write failure falls back to the proven
orientation-only behavior; serialization failure returns the original tool call
unchanged. Neither publishes a usable ghost Phase-F record.

A repeated tool id with the same complete rewritten payload is a retry. Reuse with a
different complete-payload hash is identity ambiguity; Phase F is skipped and only
the proven Lane-A block is returned. Spawn and return transitions share the same
per-agent integrity lock. Divergent reuse publishes an empty terminal tombstone when
it serializes; if registration times out, immutable contention poison suppresses the
older preparation instead. A concurrent return consults both and cannot revive the
rejected identity.

### Parent-side tool return — `commands/hook-posttooluse.js`

The dogfood PostToolUse matcher includes `Agent|Task` as a separate matcher from the
existing file-tool hook. A matching return tool id uses the exact child-key lookup,
records a new `tool_returned` generation, re-checks same-session-task snapshots, and
may send the factual report to the parent through the existing `additionalContext`
channel.

`tool_returned` means only that the parent-side tool call returned. It is not a child
lifecycle claim and does not attribute intervening repository edits to that child.

### On-demand status — existing MCP tool

`sextant_task_status` remains the single task-status tool. When both gates are on, it
also reports the number of recorded agent boundaries, workset-overlap pairs, and
bounded coherence detail. Gate-off status and closure responses expose no retained
Phase-F data. Phase F adds no assignment or coordination tool.

## What the report means

For every newest live agent snapshot in the session-scoped task group,
`analyzeCoherence` reuses Phase C's `diffClaims` against the repository **now**. It
reports:

- claims delivered to a parent, or prepared for a child spawn, that no longer hold;
- claims whose definition/span was re-derived or became unavailable;
- exact shared file paths across the visible parent role rows and neutral child
  context paths;
- exact shared region identities only where both visible worksets carried one.

The renderer says “recorded worksets share …” and distinguishes a claim “served” from
one “prepared for recorded spawn.” It does not say that agents conflict, that one
owns the path, that one edited it, or that work must stop. Overlap may be intentional
review or paired investigation.

## Correctness repairs included in this phase

Phase F exposed several pre-existing single-agent correctness gaps. The current
implementation repairs them rather than building cross-agent behavior on false facts:

- **Boundary wording matches evidence.** Parent capsules/claims publish only on the
  armed, non-deduped output path. Holdback and dedupe cannot create unseen parent
  claims. Child records say `spawn_prepared`, never “ran” or “received.” Aggregate
  status surfaces count recorded boundaries, not “serves.”
- **Task evidence survives prompts.** Recompiling a capsule carries forward its
  original creation time, status, and Phase-D `touchedRegions` instead of erasing
  task-long edit evidence; the newly served claim baseline still replaces the old
  one. The final merge happens under a capsule-integrity lock so a PostToolUse append
  between staging and publication is retained.
- **Claim absence is conservative.** Claims retain their concrete source signal.
  Swift declarations, TypeScript interfaces/types/enums, CommonJS named exports,
  Python defs/classes, and JS/TS declarations gain explicit re-derivation paths.
  Losing a span degrades to `CHANGED (span unavailable)` unless an authoritative
  extractor or literal absence supports `INVALIDATED`; it is no longer treated as
  proof of symbol removal. Claim mint/diff reads use descriptor-stable, bounded,
  one-snapshot-per-path captures; oversized or moving files surface as
  `claims.unverifiable` in closure instead of being guessed away.
- **Per-agent isolation.** Equal claim ids in different snapshots remain separate
  observations with their own serve-time file hashes.
- **Identity and TOCTOU safety.** Raw runtime ids are collision-safe both in hashed
  agent keys and lossy filesystem session keys; missing or reused spawn ids are not
  guessed; complete rewritten payloads are retry-hashed; and the exact validated
  scan fingerprint is re-checked immediately before parent/child structural context
  is published. Dirty-path fingerprints use NUL-safe Git paths plus bounded content
  hashes, including already-dirty edits; unverifiable volume fails closed.
- **Graph and summary publication are generation-bound.** Every graph persist rotates
  an opaque generation token; `summary.md` publishes an atomic manifest binding its
  exact raw bytes to that generation and the scan anchors. SessionStart, refresh,
  inject, and summary surfaces recheck the binding plus the live repo immediately
  before structural output, so an H0 summary cannot validate against an H1 graph.
  Rendering uses one immutable capture of every repository-live summary input. The
  graph cache keys persisted bytes by descriptor-stable full file identity, and a
  persist caches the binding captured beside the exported bytes—not later mutations
  to the live sql.js handle.
- **Recorded overlap is visible overlap.** Parent snapshots filter to rendered role
  rows; child snapshots contain only the rendered path list, with no hidden role or
  region derivation.
- **Lifecycle joins survive report caps.** Retry and parent-side return joins use an
  exact agent-key lookup instead of the newest-64-agent reporting view. Explicit
  generations order same-millisecond lifecycle writes without future timestamps.
- **Lock contention cannot revive an old preparation.** If spawn registration or
  terminal suppression cannot acquire the lifecycle lock, an immutable contention
  marker poisons that exact identity; exact joins and reports fail closed rather than
  falling through to an older `spawn_prepared` generation.
- **Opt-out is complete.** MCP task status, closure, and telemetry omit retained
  Phase-F state whenever the independent coherence gate is off.
- **Telemetry counts delivered facts.** Eligible counters retain full analysis
  totals; delivered counters come from the bounded renderer and count only whole
  finding lines that actually fit and cross an output boundary.
- **Legacy default-off dedupe is byte-compatible.** With no Phase-C/F prefix, the
  static-summary hash remains the original summary hash rather than hashing an extra
  separator.
- **Immutable storage is bounded.** Publication prunes expired generations and the
  oldest files above the 2,048-generation hard cap.
- **Retractions are not code-prompt-only.** Phase-C context deltas can travel with
  conversational/static-summary and holdback fallbacks, when the next prompt is the
  only delivery opportunity.
- **Closure totals are net per path.** `lib/closure.js` aggregates duplicate per-edit
  structural records into unique changed files, counts repeated same-direction facts
  once, and cancels explicit inverse observations. It does not infer cancellation
  merely because a later graph-relative record omits a fact.
- **Rescan recovery is a real full reconciliation.** Freshness-triggered recovery uses
  `rescan --allow-concurrent --force`, prunes deleted rows, reindexes clean importers
  when resolver membership/control inputs move, and refuses to manifest a graph from
  a repository generation that changed during extraction or watcher reconciliation.

All paths retain the established never-throw / never-modify-on-doubt discipline and
strip unsafe XML from repository-derived report text.

## Telemetry

The append-only telemetry stream gains:

- `coherence.agent_registered { kind, state, claims, agentType? }`
- `coherence.agent_returned { agentType, claims }`
- `coherence.report_eligible { agents?, overlaps, changed, invalidated }`
- `coherence.delta_delivered { agents?, overlaps, changed, invalidated, surface? }`
- `coherence.skipped { reason }`

Current skip reasons include missing/reused spawn identity, a moved fingerprint, a
return without an id, and a return without a matching spawn snapshot. `sextant
telemetry` summarizes recorded capsule generations, parent-side returns, eligible vs
delivered reports, overlap-pair volume, delivered changed/invalidated claims, and
skips. These are volume and delivery counters—not evidence that duplicate work or
conflicts fell.

## Verification status

Final verification on 2026-07-15, after the contention-poison and immutable
export-binding audit fixes:

```text
npm run test:unit
1114 tests, 272 suites, 1114 passed, 0 failed

npm run test:integration
6 integration scripts passed

npm run test:eval
21/21 cases passed; MRR 0.904; nDCG 0.921;
graph lift P@k +0.018, nDCG +0.015; per-case floor passed

npm ls --depth=0
dependency tree clean

git diff --check
clean
```

The final adversarial review also reran the graph/static/intel/freshness/summary
matrix (100/100 across 33 suites) and the hook/coherence/holdback/telemetry matrix
(114/114 across 24 suites), with syntax checks clean and no remaining actionable
finding. Coverage includes default-off gating, collision-safe/no-fallback identity,
concurrent immutable generations, contention poison, TTL/schema/cap behavior,
per-agent claim isolation, deterministic bounded overlap, factual non-attributing
rendering, spawn and return hook paths, conversational-prompt invalidation,
descriptor-stable claim snapshots, conservative claim re-derivation across supported
languages/forms, capsule evidence carry-forward, net closure aggregation, graph and
summary publication races, full-rescan reconciliation, telemetry, and MCP task status.

The existing PreToolUse rewrite and PostToolUse `additionalContext` mechanisms were
field-verified before Phase F (docs/022 and docs/016), but this exact end-to-end
multi-agent snapshot flow has not yet accumulated live child/parent efficacy evidence.

## Honest efficacy limits and the Phase G gate

Phase F currently proves that sextant can record and re-check bounded observation
snapshots without inventing ownership or attribution. It does **not** yet prove that
the reports:

- reduce duplicate edits, conflicts, wandering, or stale-fact use;
- reach a still-running child (there is no such push channel);
- identify which agent changed a file;
- distinguish harmful overlap from intentional review;
- distinguish unrelated sequential work inside one long runtime session;
- justify locking, cancellation, reassignment, or automatic conflict resolution.

The branch's dogfood telemetry must first establish non-trivial eligible volume,
delivery reliability, skip reasons, and a zero-false-retraction safety record. A
treatment/holdback outcome measure would still be required before claiming behavioral
benefit or enabling coherence by default. Until then, this is a measurement-capable
visibility substrate, not a coordination system.

**Phase G remains parked.** Stable source-level region ABI markers are a user-facing
convention and the most speculative tail of the roadmap. Phase F's ability to compare
region ids does not prove that region identity is load-bearing. Proceed only after
live Phase-A/B region outcomes and Phase-F field evidence show that exact-region
invalidation/overlap materially helps; otherwise record the negative/underpowered
result and stop the arc here.
