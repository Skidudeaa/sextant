# 021 — Summary "Structure" section: design

Date: 2026-07-10, main @ ac208a5. Status: **BUILT 2026-07-10** (`lib/structure.js`
+ summary wiring; 15 unit + 3 integration tests; dogfooded on sextant, somaNotes,
vue-core — all three render the designed output; ship blockers all met).
Operational note from the build: a live OLD-code watcher overwrites the new
summary on its next flush — the Sprint-1 "restart watcher after upgrades" rule
applies to summary-shape changes too, not just schema changes. Evidence base:
`docs/020-dirmap-recon.md` (all four 019 probes passed; design notes D1–D5
inherited from there and treated as requirements below). This doc designs form
(a) of the dir-mapping track — the summary Structure section — and sketches the
sequencing for forms (b)–(d). Build should follow this doc (plan-adherence rule:
this is canonical during execution).

## Goal

An agent reading the `<codebase-intelligence>` block in a broad repo currently
gets six hotspot *files* and no layout. The Structure section gives it the
directory skeleton — per-dir file counts, dominant type, and the dominant
source→source import flows — so the wrong-directory-start failure class
(39.4% of scored real sessions; 59% on 33-top-dir somaNotes, 0% on 1-top-dir
glasshud) has a factual map to orient against. Factual aggregation only: file
counts, import edges, manifests. No semantics, no LLM.

## What it looks like (real probe output, not mockups)

Normal repo (sextant, 305B as probed; target ≤320B after tightening):

```
### Structure
- `test/` — 51 files (js)
- `lib/` — 35 files (js)
- `commands/` — 19 files (js)
- `fixtures/` — 11 files (ts)
- `docs/` — 8 files (js)
- `scripts/` — 5 files (js)
- …+2 more dirs
- Flow: commands/ → lib/; test/ → lib/
```

Monorepo (vue-core; probed 538B at one-row-per-package — v1 compresses expanded
parents to one row, target ≤420B):

```
### Structure
- `packages/` (12 pkgs): runtime-core 113, compiler-core 52, compiler-sfc 50, vue 41 …+8
- `packages-private/` (5 pkgs): dts-test 21, sfc-playground 8 …+3
- `scripts/` — 5 files (ts)
- Flow: runtime-core → reactivity; compiler-sfc → compiler-core
```

## Decisions

### D-data: compute at summary time, NO schema change

The probe aggregated 1,403 files + 2,586 edges in-memory in well under 100ms.
`writeSummaryMarkdown` runs at scan/flush time (debounced), not hook time, so
the budget is generous. No `dir_*` rollup tables, no SCHEMA_VERSION bump, no
migration. A new `lib/structure.js` exports:

- `computeStructure(db, rootAbs, opts)` → `{ rows, expandedParents, flows, hiddenDirCount }`
- `renderStructureSection(structure, { maxBytes })` → string (or null when the
  section shouldn't render — see omission rule)

`lib/summary.js` calls it where Module types is built today (line ~526). The
recon scripts (`docs/recon/019-dirmap/common.js`, `probe1-skeleton.js`) are the
reference implementation for the queries; production code re-implements in
`lib/` (recon stays frozen as evidence).

### D-rows: top-level dirs, capped, dominant type

- Dirs from the `files` table at depth 1; root-level files (`.`) are counted in
  `hiddenDirCount` framing but never get a row (D2 rationale — root files are
  clutter, not structure).
- Sort by file count desc; show ≤7 rows + `…+N more dirs`.
- Row form: `- \`lib/\` — 35 files (js)` (dominant type from `files.type`;
  fixes the probe's "1 files" grammar: singular "file").

### D-expand (monorepo): junk-filtered manifest expansion, compressed row (D1)

A top-level dir expands when it contains ≥3 direct subdirs that each carry a
manifest AND pass the mapping guard triplet (D4): not junk-hint
(`fixtures|examples|tests|vendor|…` — the probe-3 regex), not nested-git, and
≥1 indexed file in the graph. Expanded parents render as ONE compressed row
(`\`packages/\` (12 pkgs): runtime-core 113, … …+8`) — top 4 packages by file
count, byte-capped. Manifest detection is a depth≤2 `readdir` walk at summary
time (sub-ms; same walk the probes used). FP evidence: 0/32 across 9 repos.

### D-flow: source→source directed flows only (D2, D3)

From resolved internal imports (`to_path IS NOT NULL AND is_external=0`),
dir→dir at the same granularity as the rows. A pair qualifies when asymmetry
≥0.6 (probe 2: 69–100% of cross-dir mass qualifies on real repos). Render top
≤3 by mass as `- Flow: a/ → b/; c/ → d/`, with three exclusions:
- no `.` endpoint (jan25's only mush was root-file pairs),
- no flow SOURCED from a test-ish dir (`tests?/`, `__tests__/`, `spec/` — the
  highest-mass pairs everywhere, zero architecture),
- both endpoints must be shown rows (no dangling references).
Inside expanded parents, flows are BETWEEN packages (probe 2 vue-core mode),
rendered with the parent prefix stripped.

### D-displace: Structure replaces Module types (D5), with a fallback

- The `### Module types (top)` section is REMOVED from the summary when
  Structure renders — per-dir dominant types + counts strictly subsume it
  (89–95B reclaimed; net Structure cost ~210–260B).
- **Omission rule**: when the repo has <2 non-root dirs with indexed files
  (glasshud: 1 top dir), Structure says nothing useful → render Module types
  instead (the subsumption argument fails exactly there). One section or the
  other, never both, never neither (on a non-empty graph).
- `health()` / `sextant doctor` / the health JSON keep their `topTypes` field —
  only the summary section is displaced.

### D-budget: hard internal byte cap + clamp interaction

`renderStructureSection` enforces its own cap (default 320B; 420B when a parent
expanded) by dropping rows, then the flow line, before ever exceeding it. The
summary's global 2200 clamp truncates from the END, so section order is clamp
priority; Structure inherits Module types' mid-order slot (after Required env,
before Dependency hotspots). Consequence on cap-bound repos (somaNotes is at
2228 today): the tail sections (Recent changes, entry points, Public API tail)
absorb the net +~150–250B. Accepted for v1 and explicitly on the post-ship
metrics watchlist — if static-block open-rates dip on cap-bound repos, the
reorder decision reopens with data.

### D-fresh: no new gating needed

Structure is graph-derived; the freshness gate already suppresses the entire
graph-derived body on content-stale turns (`buildStaleBody` builds the minimal
body from scratch). Structure simply isn't in the stale body. No
self-caused-drift consideration (summary is prompt-time, not action-time).

## Test plan (build phase)

- Unit (`test/structure.test.js`): row aggregation + cap; expansion fires on a
  3-manifest fixture parent and NOT on a junk-hint parent (D1 — the exact
  fixtures/ false-expansion the probe hit); guard triplet (nested-git and
  0-indexed-file subdirs never count toward expansion); flow exclusions (`.`,
  test-sourced, non-shown endpoints); omission rule (<2 non-root dirs →
  Module types fallback); singular "file" grammar; byte caps.
- Summary integration: Structure present + Module types absent on the sextant
  self-graph; both swap on a single-dir fixture; total ≤2200.
- Gates: `npm run test:eval` + Vapor diff byte-identical (no scoring change —
  any diff is a bug); unit suite green.
- The section must render identically from CLI `sextant summary` and the
  SessionStart/refresh hooks (it's the same summary.md — assert no per-surface
  divergence).

## Ship blockers vs acceptable debt (pre-registered)

Ship blockers:
- D1 junk filter on expansion (probed failure, not hypothetical).
- Internal byte cap enforced; Module-types displacement complete (never both).
- Flow exclusions D2/D3 in place.
- Omission rule for narrow repos (a 1-dir repo must not get a useless section).
- Post-ship baseline: probe4 re-run recorded BEFORE enabling anywhere beyond
  sextant itself (the 2026-07-09 baseline in docs/020 is the pre-ship anchor).

Acceptable debt v1:
- Expansion depth stops at 2 (no `packages/*/src` sublevels).
- No per-package health/resolution split (form d — needs a dogfooded monorepo).
- No dir-level `sextant explain lib/` (form c — separate small feature; the
  aggregation in `lib/structure.js` should be exported with it in mind).
- Blast-radius dir rollups (form b) ship separately: replace the note's
  `(+N more)` with a dir rollup when N ≥ 4 (`"used by commands/ (9), test/ (14)"`),
  measured by the now-live `blastradius.path_hit` open-attribution before/after.
- Flow line on repos where nothing passes the exclusions: simply absent (no
  fallback to weaker pairs).

## Measurement (pre-registered in docs/020, restated)

Primary: wrong-dir-start rate + dir-level first-touch rank on broad repos
(≥10 top-level dirs) via `docs/recon/019-dirmap/probe4-benefit.js` re-run on
post-ship sessions vs the 2026-07-09 baseline (39.4% overall / 59% somaNotes,
first-touch p90=4; 33 scored sessions — rolling-window caveat, always cite
dated). Secondary: blast-radius rollup open-rates via `blastradius.path_hit`
once form (b) ships. Honest expectation: modest — agents already recover by
open ~4; the claim is cheaper orientation, not a new capability.

## Build sequencing

1. `lib/structure.js` + unit tests (pure, no wiring).
2. Wire into `lib/summary.js` (displacement + omission rule) + integration test.
3. Gates + dogfood on sextant/somaNotes; eyeball real summaries.
4. Baseline probe4 re-run stamp → CHANGELOG + docs/020 addendum.
Forms (b)/(c) as separate small follow-ups; (d) waits for a real monorepo.
