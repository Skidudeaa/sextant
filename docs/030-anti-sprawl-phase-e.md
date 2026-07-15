# 030 — Anti-sprawl controller (Phase E of the context-coherence arc)

Date: 2026-07-15. Branch `feat/region-outcome-substrate` (stacked on A/B/C/D).
Plan: `~/.claude/plans/prepare-for-integration-into-playful-rain.md` (roadmap row E).

## Why

The user's ORIGINAL complaint: coding agents proliferate scripts/files instead of extending
what exists. When an agent creates a NEW source file, sextant surfaces the existing files whose
names/symbols already match — making "add a parallel implementation" a visible choice, not a
silent default. Non-blocking, once-per-path, factual.

## Design

**Trigger** (`hook-posttooluse.js`, inside the blast-radius emitter): a new file has no
dependents/co-change, so it already falls through the blast-radius composer — exactly the slot
the sprawl note fills. On a mutating tool where the path is a NEW, non-test, indexable source
file (`anti-sprawl.js:isNewSourceFile` = indexable AND `graph.getFileMeta == null`; new TEST
files aren't sprawl, so they're excluded), compute existing matches and emit.

**Matches** (`findExistingMatches`): tokens from the new file's stem (camelCase-split, ≥3-char)
plus its exported symbols (`extractExports` on the just-written content) → `graphRetrieve` →
top-3 existing files, excluding self and tests. Emitted as a factual `additionalContext` note
(`composeSprawlNote`): "New file added: X. Existing indexed files with matching names or
symbols: … If one already covers this, extending it avoids a parallel implementation."

**Measured two ways (the KILL criterion):**
- **"nudges ignored?" — live.** The surfaced matches are recorded in the blast-radius `emitted`
  state with `source: "sprawl_match"`, so the existing open-attribution lane scores whether the
  agent opened a suggestion → `blastradius.path_hit {source: "sprawl_match"}`. If suggestions are
  never opened, the nudge is ignored (a KILL signal).
- **"reduction in abandoned files?" — offline baseline.** `analyzeSprawlHistory` +
  `sextant sprawl [--json] [--within N]` mine git for source files added then deleted within N
  commits — the create-then-abandon rate the nudge aims to reduce.

**Gating**: capsule-gated (default-off; a new file emits nothing either way when off, so default
behavior is unchanged). Freshness handled like blast-radius (a new file self-causes drift; the
MATCHES are existing graph files, valid unless foreign drift — the same
`isSelfCausedStatusDrift` exception). Never throws. Telemetry: `sprawl.nudge {path, matchCount}`;
`sextant telemetry` renders it in the context-coherence section.

## Verified

Unit 1009/1009 (+`test/anti-sprawl.test.js`: stemTokens, new-file detection, match-finding
excluding self/tests, note text, and a temp-git create-then-abandon baseline). Self-eval 21/21
(MRR 0.908 / nDCG 0.923 — up from 0.900/0.920 as the repo grew across A–E; no scoring change).
**Verified live in-session**: writing `commands/sprawl.js` and `test/anti-sprawl.test.js`
triggered the nudge, surfacing the matching existing files.

## Finding (KILL-criterion baseline)

On the sextant repo itself: **125 source files added, 2 abandoned within 10 commits (1.6%)**.
Sextant is a disciplined repo — little sprawl to reclaim HERE, so the nudge's headroom is on
higher-churn repos (the user's original complaint). The instrument is what matters; the nudge's
benefit must be measured where sprawl is actually high.

## Next

- Phase F shipped default-off immutable per-agent serve snapshots, cross-agent claim
  invalidation, and factual workset-overlap visibility; see
  `docs/031-multi-agent-coherence-phase-f.md`.
- Phase G remains parked. Stable region ABI markers require live Phase-A/B region outcomes and
  Phase-F field evidence that exact-region invalidation/overlap materially helps.
