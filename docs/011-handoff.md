---
title: Session handoff — after the benefit-proof shipment (trajectory + holdback)
date: 2026-06-06
status: handoff
branch_state: main @ 5d1d709 (merged + pushed; feature branch deleted)
supersedes: docs/009-handoff.md
companion: docs/010-benefit-proof.md, docs/ideas/009-yield-synthesis.md, todos.md, CLAUDE.md §15
---

# Handoff — Next Session

> Read order: this file → `docs/010-benefit-proof.md` (the verified result) →
> `CLAUDE.md` §15 + the Telemetry section. `todos.md` top section is the live
> tracker; `docs/ideas/009-yield-synthesis.md` is the canonical ladder.

## TL;DR

The benefit-proof campaign's headline is **done and proven**: sextant's query-aware
retrieval has **1.98× open-rate lift** over a permutation null on 74 real sessions
(adversarially verified by a 6-agent reproduction). Both instruments shipped:
- **`sextant eval-trajectory`** (offline replay) — proof you can run today.
- **Injection-OFF holdback arm** — the causal upgrade, **enabled at 20%** on this repo.

**✅ Merged to `main` @ `5d1d709`** (fast-forward; feature branch deleted) — so the
holdback arm + `eval-trajectory` are now durable on the npm-linked checkout and the
20% dogfood accrues permanently. The benefit baseline is now just a waiting game.

## State (verified this session)

- Branch `feat/benefit-proof-trajectory-holdback`, pushed to origin. Commits:
  `6857673` (trajectory + holdback) · `bcf2241` (enable 20%) · `392c270` (armCounts +
  cron) · plus the doc-cleanup commit this session.
- Gates: unit **763/763** (clean runs; one spawn test flakes under full-suite
  concurrency with the live session's own hooks — passes in isolation + on re-run),
  self-eval 21/21 (MRR 0.900 / nDCG 0.920 / graphLift +0.012), retrieve() path
  byte-identical (git-confirmed off-path), integration 5/5.
- Holdback is live at `SEXTANT_HOLDBACK_PCT=20` in this repo's `.claude/settings.json`
  (loads at session start). A local cron (`scripts/check-holdback-benefit.sh`, daily
  16:00 UTC) logs to `~/sextant-benefit.log` when `benefitDelta` is ready.

### What shipped (file map)

| File | What |
|------|------|
| `lib/trajectory.js` (new) | offline replay core — `parseRetrievalBlock`/`extractEvents`/`analyzeSession`/`computeLift`/`buildReport` (pure, unit-tested) |
| `commands/eval-trajectory.js` (new) | `sextant eval-trajectory` — lift report + caveats |
| `commands/hook-refresh.js` | `decideArm` + holdback branch (withhold block, persist `arm:holdback`, fire `retrieval.holdback`, static fallback) |
| `commands/hook-posttooluse.js` | reads `arm`, stamps it on `path_hit`/`path_miss`; `readInjectedRaw`/`buildInjectedMap`/`readInjectedArm` exported |
| `commands/telemetry.js` | `openPrecisionByArm` + `benefitDelta` + `armCounts`; conditional caveat |
| `scripts/check-holdback-benefit.sh` (new) | local cron: READY when holdback ≥30 scored + `benefitDelta` non-null |
| `docs/010-benefit-proof.md` (new) | the verified report |

## THE NEXT MOVE — the cheap manifest-seam wins (now provable)

The unlock is merged and the dogfood is accruing on its own (`sextant telemetry` /
`~/sextant-benefit.log` will show the first armed−holdback `benefitDelta` after a few
sessions — no action needed to make that happen). So the active work is the 009 ladder's
cheap manifest-seam wins, each now measurable in `eval-trajectory`'s per-source coverage:
start with **Public-API outline (#6, XS)**, then schema anchors (#2), Makefile (#7),
resolution-by-kind (#4). See the ladder below.

**Highest-leverage lever from the benefit data:** retrieval **precision**.
`exported_symbol` injections earn opens at only 4.3% vs `text_only` 14% (`eval-trajectory`
per-source); sextant surfaces ~4 files, the agent opens <1. Tightening the surfaced set
(fewer, higher-confidence files) is the biggest retrieval improvement available, and now
has a real metric to optimize against.

## The 009 ladder — now PROVABLE (was the whole point of the unlock)

Every eval-invisible orientation signal can now be measured (`eval-trajectory`
per-source coverage today; holdback `benefitDelta` once it accrues). In recommended
order (009 §sequencing), the cheap manifest-seam wins:
1. **Public-API outline (#6, XS)** — `graph.queryExports` exists (`graph.js:428`); one
   call site in `writeSummaryMarkdown`. FAIL-pre anchors on the HOTSPOT block
   (`bin/intel.js` has zero exports).
2. **Schema/contract anchors (#2, S)** — NEW fast-glob pass (exts not in `isIndexable`);
   place ABOVE Recent-changes (clamp guard).
3. **Makefile → Commands block (#7, S)** — dual-source merge contract with package.json scripts.
4. **Resolution-by-kind (#4, S)** — new `GROUP BY imports.kind`; needs a new fixture
   with an unhonored tsconfig-paths import.

Then: co-change lane (#3), swift_relations pathfinder (#8) → symbol-blast-radius (#11).

**Newly actionable from the benefit data:** `exported_symbol` injections earn opens at
only 4.3% vs `text_only` 14% (`sextant eval-trajectory` per-source). Retrieval
**precision** (surfaces ~4 files, agent opens <1) is now the highest-leverage lever,
with a metric to optimize against.

## Landmines / gotchas carried forward

- **Holdback now lives on `main`** (merged) — durable on the npm-linked checkout. (Pre-merge
  it only ran on the feature branch; that risk is closed.)
- **`eval-trajectory` corpus is a rolling ~14-day window** — a crontab entry
  (`find ~/.claude/projects … -mtime +14 -delete`) prunes old transcripts nightly. The
  1.98× is the *frozen 74-session anchor*; the live command recomputes over recent
  sessions and drifts slightly (and this repo self-dogfoods, so its own sessions enter
  the corpus).
- **Telemetry is local-only** (`.planning/intel/*` gitignored). No remote/cloud routine
  can read `benefitDelta` — that's why the check is a local cron, not a `/schedule`.
- **self-eval cross-003 sits 0.01 past its per-case floor (−0.06)** — corpus drift from
  adding the harness's own source files (a #2/#3 swap of two valid `extractImports`
  defs), not a scoring change. Surfaced, not masked. If it bugs you, it's accepted-debt
  fodder, not a bug to chase.
- **Benefit framing is correlational until `benefitDelta` accrues.** `eval-trajectory`'s
  caveat block and `docs/010` say so; keep it that way on every surface.

## Open question for Amo

After merge, is 20% the right standing holdback fraction, or dial down once a stable
`benefitDelta` exists (you only need the counterfactual sampled, not maintained forever)?
