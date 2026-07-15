# 029 — Structural Delta + Closure (Phase D of the context-coherence arc)

Date: 2026-07-15. Branch `feat/region-outcome-substrate` (stacked on A/B/C).
Plan: `~/.claude/plans/prepare-for-integration-into-playful-rain.md` (roadmap row D).

## Why

Two things: (1) after an edit, answer "what did this change in the repository's OBSERVABLE
STRUCTURE?" — not a textual diff (git has that), the graph-level delta (exports/imports
appeared/vanished); (2) a **factual closure report** — agents stop when code "looks done";
sextant should report what HAS and HAS NOT been substantiated, never "safe to merge."

## Design

**Structural delta engine** (`lib/structural-delta.js:computeStructuralDelta`): diff a file's
CURRENT extraction (re-extract the post-edit content) against the graph's STORED extraction.
**The graph is the pre-image** — at PostToolUse time the watcher hasn't re-indexed the just-
edited file, so `graph.queryExports/queryImports` still return its pre-edit structure. If the
watcher was fast and re-indexed, old==new → empty delta → safe (never asserts a change that
didn't happen). Reuses `lib/extractor.js` (no new extraction). Returns
`{exportsAdded, exportsRemoved, importsAdded, importsRemoved, changed}`.

**Recorded on edit** (`hook-posttooluse.js` Lane 3, capsule-gated): on a mutating tool, compute
the delta against the graph pre-image, emit `structure.delta` telemetry, and append a record to
the capsule's `touchedRegions` (the Phase-B/D seam). Loads the graph via the mtime-cached
`loadDb` (the blast-radius lane already loads it). Out-of-band, never throws. Uses POST-edit
content (`tool_response.content` → disk), never `originalFile` (that would show a reversed delta).

**Evidence closure** (`lib/closure.js:buildClosure` → `renderClosure`;
`sextant closure [--session <k>] [--json]`; MCP `sextant_closure`): assembles a factual report
from the capsule + claim ledger + touchedRegions + the session's OBSERVED-file set (the
blast-radius `touched` state):
- **Changed files (structure)** — from `touchedRegions` (exports/imports ±).
- **Context consistency** — `claims.diffClaims` re-checks the served claims NOW (Phase C):
  unchanged / re-derived / invalidated.
- **Directly-connected witnesses** (capsule witnesses) — observed (∩ touched) vs NOT observed.
- **Affected surfaces** (primary + high-fan-in hazards) — inspected vs NOT inspected.
- **Unknowns** — what sextant can't verify (capsule unknowns).
- Ends: *"states the evidence that EXISTS and the connected surfaces NOT observed. It does not
  assert the change is correct, complete, or safe to merge."* (degrade, don't guess.)

**Gating**: structural-delta rides capsule mode (default-off; `capsuleEnabled` now shared in
`lib/capsule.js` so B/C/D turn on together). The closure command/tool are read-only and always
available (honest "no capsule" when none). Telemetry: `structure.delta`; `sextant telemetry`
renders it in the Claim-ledger + structural-delta section. MCP is now **9 tools**.

## Verified

Unit 1003/1003 (+`test/closure.test.js`: structural diff vs a real temp graph pre-image;
closure report witnesses observed/not, consumers, "never safe to merge"). Self-eval stable
(21/21, MRR 0.900 / nDCG 0.920; graphLift +0.014, up from +0.012 as the repo grew — not a
scoring change). Live: TBD in the session (edit adding an import → `structure.delta` +
`sextant closure` shows the change).

## Next

- Phase E — Anti-sprawl controller (detect new-source-file creation → surface existing-region
  matches; the user's original churn/script-proliferation complaint). Treatment/control arm.
- Phase F — graduate `servedClaims` to a shared cross-agent store for multi-agent invalidation.
