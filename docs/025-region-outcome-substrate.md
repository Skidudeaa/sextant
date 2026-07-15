# 025 — Region outcome substrate (Phase A of the context-coherence arc)

Date: 2026-07-15. Phase A of the "context-coherence kernel" plan
(`~/.claude/plans/prepare-for-integration-into-playful-rain.md`). Measurement-first,
additive, default-safe — no ranking change, `npm run test:eval` byte-identical
(MRR 0.900 / nDCG 0.920 / graphLift +0.012, 21/21). Built to answer ONE question
cheaply before committing to the region-aware direction: **when retrieval points at
a region, does the agent act on THAT region, or open the right file and edit a
different one (reclaimable within-file navigation)?**

## What shipped

The retrieval → injection → open-attribution loop was strictly path-granular at
every layer. Phase A threads a **region breadcrumb** through it and adds region-level
attribution, live and offline, without changing what Claude sees or how files rank.

- **`lib/regions.js`** (new) — thin, pure, reuses `scope-finder.js`. Line→region
  identity (`path#name`) for JS/TS/Python; `deriveEditedLines` (structuredPatch
  newStart, else string-locate `old_string`); `scoreEditedRegion` = hit iff the
  surfaced line is inside the edited region OR the surfaced symbol === the edited
  region's name; hit=false is the "right file, wrong region" headroom signal.
- **`scope-finder.js`** — added `findEnclosingScopeInContent(content, ext, lines,
  {allowSpawn})`: content-based (no disk re-read) + gates the python3-spawning path
  off hot callers.
- **A.2 `hook-refresh.js:buildInjectedPaths`** — stops discarding the breadcrumb we
  already compute: persists `{path, source, line?, symbol?}` (`line` = Swift decl
  start or matched zoekt line; `symbol` only for symbol-bearing signals — a
  path_match term is a filename token, not a code symbol). Zero hot-path cost.
- **A.3 `hook-posttooluse.js`** — on a mutation of a surfaced file, resolves the
  edited region (in-process langs only live) and emits `retrieval.region_hit` /
  `retrieval.region_miss {source, tool, arm, regionKind}` beside the existing path
  events. Silent degrade when unresolvable; never throws.
- **A.4 `lib/trajectory.js:analyzeRegions`** — self-contained offline pass
  (file-level lift numbers stay byte-identical). Correlates each Edit `tool_use`
  → its `toolUseResult` (`structuredPatch` + post-edit `content`, falling back to
  `originalFile`), and scores region-hit/miss over history. Surfaced from
  `sextant eval-trajectory` as a REGION SUBSTRATE section.
- **A.5 `commands/telemetry.js`** — region-precision + headroom + per-arm split in
  `sextant telemetry`.
- Tests: `test/regions.test.js` (16), plus `analyzeRegions` /
  `parseRetrievalBlock` line+symbol locks in `test/trajectory.test.js` and a live
  `region_hit` end-to-end + `readInjectedRegion` / `buildInjectedPaths` breadcrumb
  locks in `test/hook-posttooluse.test.js`. Unit 971/971.

## The empirical finding (kill-criterion read)

The offline retrospective over the local corpus is **underpowered, and the reason IS
the finding**: the compounding sparsity is the point the whole arc exists to change.

| Gate | Count | Note |
|---|---|---|
| Surfaced file-rows (corpus) | 1480 | across 347 retrieval blocks |
| …carrying a **line** breadcrumb | 58 (3.9%) | only zoekt-excerpt + swift-decl rows |
| Correlated edits (id→result) | 592 | correlation works |
| …with post-edit content/originalFile | ~50 direct + originalFile fallback | ~90% omit `content` |
| **Region-scoreable edits of surfaced files** | **2** | after excluding path_match name-noise |

Two scored edits is no basis for a decision. **The kill criterion cannot be
evaluated offline** — not from a bug (the instrument is verified on synthetic
records), but because **sextant historically surfaces FILES, not regions**: 96% of
rows carry no line, and the transcript rarely preserves post-edit content. The
measurement substrate's first output is a diagnosis of the very gap the vision
targets.

## Verdict — neither kill nor proceed; a prerequisite surfaced

- **Do NOT kill the region direction** — the offline arm is starved, not negative.
- **Do NOT declare proceed** — there is no powered signal yet.
- **Prerequisite discovered:** region-outcome measurement can only become powered
  once sextant *surfaces regions* on more than 4% of rows. That is Phase B (Task
  Capsule) — surfacing role-based regions isn't just "monetizing headroom," it is a
  **precondition for measuring whether the headroom exists.** The live lane (A.3)
  is now the go-forward instrument; it will accumulate region events as B increases
  region surfacing.

## Next

1. Let the live `retrieval.region_hit/miss` accrue on dogfood repos (watch
   `sextant telemetry` → Region substrate). Re-read at ≥30 scored.
2. Phase B: make the injected block carry a region per primary file (raise the 3.9%
   line-coverage), which both improves orientation AND powers this measurement.
3. Retained-to-final-diff survival is the next refinement to `analyzeRegions`
   (current metric is the IMMEDIATE in-region edit rate — labelled as such).
