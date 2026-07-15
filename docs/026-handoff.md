# 026 — Session handoff: region outcome substrate (Phase A) shipped

Date: 2026-07-15. Branch `feat/region-outcome-substrate` @ `7ecfea1` — **committed,
NOT pushed, NOT merged.** Main is unchanged at the 2026-07-12 snapshot (`bdd7f72`).

## What this session did

Took the user's "context-coherence kernel" vision (re-found sextant as a
repository-to-agent synchronization protocol — claim ledger, task capsules,
structural deltas, evidence closure) through plan mode and shipped **Phase A**: the
region outcome substrate. Plan doc (canonical, read it before continuing):
`~/.claude/plans/prepare-for-integration-into-playful-rain.md` — Phase A detailed +
A–G roadmap, with the two user decisions baked in (Phase A deep + roadmap; edit-region
/ retained as the primary signal).

Full finding write-up: `docs/025-region-outcome-substrate.md`.

## State: what's built (all in the one commit)

Measurement-first, additive, default-safe. No ranking change; self-eval byte-identical
(MRR 0.900 / nDCG 0.920 / graphLift +0.012, 21/21). Unit **971/971**.

- **`lib/regions.js`** (new) — line→region identity (`path#name`) via `scope-finder`;
  `deriveEditedLines` (structuredPatch newStart → else string-locate old_string);
  `scoreEditedRegion(line, symbol, regions)` = hit iff surfaced line inside edited
  region OR surfaced symbol === region name; hit=false = "right file, wrong region"
  (the headroom signal). Never throws.
- **`scope-finder.js`** — `findEnclosingScopeInContent(content, ext, lines,
  {allowSpawn})`; `allowSpawn:false` gates the python3 child off hot callers.
- **`hook-refresh.js:buildInjectedPaths`** — persists `{path, source, line?, symbol?}`
  (symbol ONLY for symbol-bearing signals; path_match term excluded). Zero hot-path cost.
- **`hook-posttooluse.js`** — Lane 1r: on a mutation of a surfaced file, emit
  `retrieval.region_hit`/`region_miss {source, tool, arm, regionKind}` (in-process langs
  live; content from `tool_response.content` → `originalFile` → disk). Silent degrade;
  path events unchanged. `readInjectedRegion` exported for tests.
- **`trajectory.js:analyzeRegions`** — self-contained offline pass; correlates Edit
  `tool_use.id` → `toolUseResult.{structuredPatch, content|originalFile}`; report
  `regions{scored, inRegion, wrongRegion, precisionPct, wrongRegionPct,
  medianNavBeforeEdit, bySource}`. `parseRetrievalBlock` now also captures `line`+`symbol`.
- **`telemetry.js` / `eval-trajectory.js`** — region-precision + headroom + per-arm split.
- **Tests** — `test/regions.test.js` (16); `analyzeRegions` + block line/symbol locks in
  `test/trajectory.test.js`; live `region_hit` e2e + `readInjectedRegion`/breadcrumb locks
  in `test/hook-posttooluse.test.js`.

## The finding (why this matters for what's next)

**The Phase-A kill criterion is NOT evaluable offline — and the reason is the diagnosis.**
Corpus gates: 1480 surfaced rows → only **58 (3.9%) carry a line**; 592 correlated edits →
~90% omit post-edit content → **n=2 scored edits**. The instrument is verified; the corpus
is starved because **sextant surfaces files, not regions**. Verdict: neither kill nor proceed
— **region surfacing (Phase B Task Capsule) is a PREREQUISITE for measuring the headroom, not
just monetizing it.** The live `retrieval.region_hit/miss` lane is the go-forward instrument.

## Gotchas / landmines

- **Offline metric = IMMEDIATE in-region edit rate**, NOT retained-to-final-diff survival
  (labelled as such everywhere). Retained-survival is the next `analyzeRegions` refinement.
- **Live region lane depends on `tool_response` on the hook stdin** — field-verified in the
  transcript (`toolUseResult`), but the live-hook field name (`tool_response` vs
  `toolUseResult`) is handled defensively (both tried) and degrades to disk-read then to no
  event. Not yet observed firing in a real live session; the e2e test drives it synthetically.
- **Branch not pushed/merged.** Restart watchers on the dogfood repos AFTER any
  merge+upgrade (old-code flush clobbers new state — the recurring landmine).

## Constraints carried forward (do not re-litigate — all recon-verified)

- Self-tuning / context-selection-as-optimization is DEAD (016 R3); the vision's §7 is that
  grave in new clothes → parked, not built.
- Running subagents have NO push channel — deltas land only at the next hook/spawn event.
- PostToolUse `additionalContext` IS a real injection channel (016 R1).

## Next steps (in order)

1. **Decide: push + open PR / merge, or keep iterating on the branch.** (User's call.)
2. **Phase B — Task Capsule**: role-based workset (primary/support/witness/hazard/unknown)
   that surfaces a region per primary file — raises the 3.9% line-coverage AND powers the
   Phase-A measurement. A/B the role-block vs today's flat list using the region metrics.
   Grounded on `lib/orient.js` + `format-retrieval.js` + `.last_injected_paths.*`.
3. Let live `retrieval.region_hit/miss` accrue on dogfood repos; re-read `sextant telemetry`
   → "Region substrate" at ≥30 scored.
4. Then Phase C — Claim Ledger (the architectural inflection: "drift must be loud" at the
   fact level; prior art = `swift_declarations` span model + `scanned_status_files` map).
