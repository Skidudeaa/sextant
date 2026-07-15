# 028 — Claim Ledger (Phase C of the context-coherence arc)

Date: 2026-07-15. Branch `feat/region-outcome-substrate` (stacked on Phase A/B).
Plan: `~/.claude/plans/prepare-for-integration-into-playful-rain.md` (roadmap row C —
"the architectural inflection point").

## Why

Git tracks code state; sextant should track which repository FACTS each agent was given
and whether they're still valid. Phase C makes every injected structural fact an
addressable **claim**, and on the next hook event re-checks the claims served this session
against the current files — retracting the ones that moved or vanished via a
`<sextant-context-delta>`. That is cache coherence for agent context: the agent holds a
cached subset of repo claims; sextant invalidates them when the source changes.

## Design

**Claim** (`lib/claims.js`): a typed assertion minted from each served row —
`{ id, subject:{path, symbol, region, line}, predicate, provenance, fileHash, servedAt }`.
- **provenance** is the epistemic firewall (vision §13): `direct` (AST/graph def —
  exported_symbol/swift_decl/reexport), `heuristic` (path_match filename inference),
  `live_text` (a zoekt match, not a structural assertion). Authority is TYPED, never conflated.
- **fileHash** (sha1 of the source file at serve time) is the invalidation anchor.

**Storage (Phase-C baseline)**: served claims live in the per-session capsule
(`capsule.servedClaims`, the Phase-B seam). Phase F later graduated this baseline into immutable
per-agent serve snapshots with cross-agent invalidation and workset-overlap visibility; see
`docs/031-multi-agent-coherence-phase-f.md`. Delivery still occurs only at the next eligible
hook—there is no push channel, ownership, or locking.

**Invalidation + delta** (`lib/claims.js:diffClaims` → `renderContextDelta`, wired in
`hook-refresh.js`): on the next hook event, for each prior served claim, compare its source
file's hash to serve time.
- unchanged file → valid, no delta (cheap hash gate).
- changed file + symbol claim → re-locate the symbol's definition (`locateSymbolRegion`:
  def-form regex → scope-finder region). Moved span → **CHANGED** (`from → to`); symbol gone →
  **INVALIDATED** (`symbol_removed`). File removed → **INVALIDATED** (`file_removed`).
- changed file + symbol-less claim → **CHANGED** (coarse "file changed since served").

The delta is a facts-only `<sextant-context-delta>` block prepended to the retrieval block
(no imperatives — the orient/subagent discipline; its own XML strip). It is folded into the
dedupe hash so a retraction can't be deduped away.

**Runs on content-stale turns too.** The whole point is to fire when files changed — and a
changed tree is content-stale. The diff is disk-based (freshness-independent) and RETRACTS
facts rather than asserting new ones, so it's honest exactly when it matters. Claims are only
*minted* on a fresh capsule turn (the last good orientation stays the baseline through
intervening content-stale turns); the delta is *computed* whenever capsule mode is on.

**Gating**: rides on capsule mode (`SEXTANT_CAPSULE` / `.codebase-intel.json capsule:true`) —
default-off, so a normal install is byte-identical; the sextant repo has it enabled to dogfood.
Never throws.

**Telemetry**: `claim.served {n}`, `contextdelta.emitted {changed, invalidated}`; `sextant
telemetry` renders a Claim-ledger section.

## Verified

Unit 997/997 (+`test/claims.test.js`: mint, moved/removed-symbol/removed-file invalidation,
symbol re-location, delta rendering). Self-eval byte-identical. Live: a served claim whose
symbol was moved produced `CHANGED (re-derived): … span L1–3 → L3–5`; removed → INVALIDATED.

## Next

- Phase D shipped the Structural Delta + Closure seam; see `docs/029-structural-delta-closure-phase-d.md`.
- Phase F shipped default-off multi-agent visibility and invalidation; see
  `docs/031-multi-agent-coherence-phase-f.md`.
- Phase G remains parked pending live evidence that exact region identity is load-bearing.
