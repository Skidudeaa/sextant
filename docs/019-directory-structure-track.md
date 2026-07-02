# 019 — Directory/subsystem mapping: the gap, why it exists, and the recon to run

Date: 2026-07-02. Status: **USER WANTS TO PURSUE — queued for a future session.**
Captured from a design conversation on main @ a93c613; nothing built yet.

## The observation

Sextant uses subdirectories everywhere as *heuristic signals* but nowhere as a
*first-class mapping unit*:

- **Signals today**: vendored-subtree exclusion (`lib/project-scope.js`), test-path
  penalties (`/Tests/`, `XCT*/`), `isEntryPoint()`'s fixtures/examples rejection,
  the ignore floor, and the path-match lane's `dir-segment` tier — which docs/013
  measured as one of the STRONGEST retrieval signals (22.9% open rate).
- **Absent**: the graph schema is file-granular (no directory rollups in
  `files`/`imports`/`cochange_pairs`); the summary has no structure section (an
  agent in a 2,000-file monorepo gets six hotspot *files* but no
  "`packages/api` + `packages/web` + `services/worker`" skeleton); no subproject
  awareness (a monorepo's per-package manifests/commands/entry points blend into
  one flat root view).

## Why the gap exists (from the conversation)

1. **The inverse question was never asked.** `project-scope.js` deliberately
   rejected "subdir has its own manifest" as an *exclusion* signal (false-positives
   on polyglot monorepos — its own comment at line ~54). Nobody asked the inverse:
   "is this subtree a *nameable part* of the project worth surfacing?" Same signal,
   opposite use, much lower risk — a false positive in a MAP is a mislabeled
   section, not a wrongly-deleted subtree.
2. **Streetlight effect.** Every metric (MRR, open-rate, lift) scores FILE
   retrieval; no metric rewards "the agent understood the layout," so
   directory-level orientation never had a number pulling it forward.
3. **Summary-budget conservatism.** The 2,200-char cap is sacred and every section
   earned its slot — but that argues about what to CUT, not whether the capability
   should exist.

**Not blocked by design philosophy**: a directory map is factual (file counts,
cross-directory import flows, per-dir churn from the co-change tables shipped in
016) — no semantics, no LLM, cheap aggregation over existing tables.

## Candidate value (sketch, unvalidated)

- **Summary "Structure" section**: top-level skeleton with per-dir file counts and
  the dominant import-flow direction (e.g. `commands/ → lib/ → (sql.js)`), possibly
  per-package manifests in monorepos.
- **Blast-radius rollup**: "27 files import it" → "used by `commands/` (9),
  `test/` (14), `mcp/` (2)" — more digestible at the same byte cost.
- **Dir-level graph queries**: `sextant explain lib/` (aggregate fan-in/out,
  hotspots within, co-change coupling to sibling dirs).
- **Monorepo per-package health**: resolution/staleness per package instead of one
  blended number.

## Recon-first (per spec ≠ plan) — run BEFORE designing

1. **Skeleton-quality probe**: generate a candidate Structure section for real
   repos (sextant, somaNotes, jan25, defGen2 + a true monorepo if available) and
   judge: does it describe the codebase a human would recognize? What's the byte
   cost inside the 2,200 cap, and which existing section (if any) yields bytes?
2. **Flow-signal probe**: compute cross-directory import flows from the existing
   `imports` table — is there a dominant, meaningful direction on real repos, or is
   it mush?
3. **Subproject-detection probe**: on real monorepos, how accurate is
   "depth≤2 subdir with its own manifest = package" for MAPPING (not exclusion)?
   Quantify the polyglot false-positive rate that scared off the exclusion use.
4. **Benefit hypothesis**: which failure class does this serve? Likely candidates:
   wrong-starting-file in large repos (agent greps the wrong package) and
   blast-radius digestibility. Decide the metric BEFORE building (trajectory
   first-touch rank on large repos? blast-radius note open-rates?).

Kill criteria to pre-register at recon time: if the skeleton reads as arbitrary on
≥half the probe repos, or costs >~300 bytes without displacing a weaker section,
the summary-section form dies (the dir-rollup-in-blast-radius form may survive
independently — evaluate separately).

## Queue position

Sits alongside `docs/018` (subagent orientation, planned) and docs/017 lever #1
(blast-radius open-attribution, small). User has explicitly said they want to
pursue THIS track in a future session; sequence against the other two at session
start.
