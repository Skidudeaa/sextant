# 024 — Session handoff (2026-07-12): efficacy review + open-queue execution

Session span: main `079176f` → `025d4c9` (4 feature/fix commits). Suite at
handoff: **unit 948/948**, integration scripts green, CLI self-eval
byte-identical (21/21, MRR 0.900, nDCG 0.920).

## The efficacy review that drove this session (data as of 2026-07-12)

- **Structure section (021 form a)**: probe4 re-run on the 22 post-2026-07-10
  transcripts (6 scorable): wrong-dir-start 33.3% overall vs 39.4% baseline;
  **somaNotes 40% vs 59% baseline**, first-touch p90 2 vs 4. Right direction
  on the pre-registered metric, n=6 — NOT citable yet.
- **Blast-radius per-source**: 19 notes, open-precision 6.1%; **all 7 hits are
  dependents; co-change 0/24 opened**. If that holds at ~50 notes, the
  co-change half of the note is cost without benefit.
- **Holdback arm**: 73 days at 20%-on-one-repo accrued exactly **1** holdback
  turn — telemetry was rendering an n=1 delta as "the causal lift".
- **Freshness**: 29.9% of reads were blackout turns while scans ran p50 1.1s /
  p95 1.7s at 100% success (122 scans) — the Option-5 dataset answered its
  own question.
- 2.52× offline-replay lift (2026-06-09, 110 sessions) remains the only
  citable benefit number.

## What shipped (chronological)

1. **`1903e13` fix(telemetry)** — BENEFIT DELTA rendering gated on ≥30 scored
   opens PER ARM (prints `DORMANT (accruing)` with raw counts below that);
   per-arm rows carry n=. JSON semantics unchanged (the cron volume-gates
   itself). Holdback widened: `SEXTANT_HOLDBACK_PCT` 20→30 on sextant, newly
   30 on somaNotes + glasshud.
2. **`6861d9a` feat(doctor)** — watcher code-version stamp (017 lever #4):
   `lib/utils.js:codeVersionStamp()` (pkg version + git short-HEAD) baked
   into every heartbeat; doctor flags a live watcher whose stamp mismatches
   the code on disk (or predates stamping) with the restart command. The
   old-code-watcher-clobbers-new-summary landmine is now loud.
3. **`3413292` feat(freshness)** — **Option-5 adaptive sync rescan**. On a
   stale read, when the repo's own recorded history says scans are fast
   (≥5 successful durations, p95 ≤ 2.5s), `applyFreshnessGate` runs ONE scan
   synchronously (same single-flight marker; child killed at 3×p95 clamped
   3–8s), re-verifies, and injects the FRESH body instead of the blackout.
   Rescues record `stale_hit{rescanState:"sync"}` + `sync_rescan{ok}` and NO
   `blackout_turn`. Kill switches: `SEXTANT_SYNC_RESCAN=0`, `=1` forces,
   `.codebase-intel.json syncRescan:false`; 10-min failure cooldown.
   Verified live: stale → 2.5s sync scan → fresh body, no blackout.
4. **`025d4c9` feat(subagents)** — **orientation Lanes A+B** (docs/018+022).
   Lane A: `sextant hook pretask` (PreToolUse, matcher `Task|Agent`) appends
   a facts-only `<codebase-intelligence>` block to the spawning Task's prompt
   via `updatedInput`. Lane B: `sextant_orient` MCP tool, same builder
   (`lib/orient.js`). All pre-registered ship blockers enforced +
   test-locked (never-modify-on-doubt, 1100-byte cap, content-stale silent
   absence, no double-inject, refused-root no-state). Verified live.

## Landmines / constraints carried forward

- **Lane A is dogfood-wired only** (sextant, somaNotes, glasshud settings) —
  deliberately NOT in `sextant init`. The R-A residual stands: verify how
  `updatedInput` renders in the INTERACTIVE permission dialog before wiring
  wider. The hook emits `permissionDecision:"allow"` (field-verified
  pattern), which auto-approves the spawn it modifies.
- The sync-rescan arm adds ~1–2s to stale-turn hook latency BY DESIGN. If a
  repo's scans get slower, the stats gate closes on its own (p95 recomputed
  per read from telemetry); a timed-out child triggers the 10-min cooldown.
- Watcher restarts after upgrades are now DETECTABLE (`sextant doctor`), not
  yet automatic.
- CJS `module.exports.X` is not captured as a named export — orient's
  task-relevant line leans on path/export/decl lanes that exist; keep fixture
  expectations honest (hit this in test design).

## Measurement queue (dates matter)

1. **~2026-07-24 — probe4 re-run** on post-2026-07-10 sessions vs the 39.4%/59%
   baseline (docs/020). Today's 6-session read (33.3%/40%) is directional only.
   Method: mirror post-ship transcripts to a temp projects dir (script has no
   date filter), `node docs/recon/019-dirmap/probe4-benefit.js --projects <dir>`.
2. **At ~50 blast-radius notes — per-source re-read** (`sextant telemetry`):
   if co-change is still ~0 opens, consider dropping/demoting the co-change
   half of the note (016 evidence said the signal exists; behavior isn't
   confirming agents USE it).
3. **Holdback benefitDelta**: now 30% on three repos; the cron
   (`check-holdback-benefit.sh`) fires a READY block at ≥30 scored per arm.
   Until then the telemetry line says DORMANT — do not cite a delta.
4. **Sync-rescan watch**: `sextant telemetry` → "sync rescues: N of M" +
   scan percentiles now split out `trigger=freshness_gate_sync`. Expect
   blackout share (29.9% at ship) to fall on active repos; investigate if
   sync attempts fail repeatedly (cooldown events).
5. **Subagent orientation uptake**: `pretask.injected` counts by
   `subagentType`; success = oriented subagents appear in
   `eval-trajectory --include-subagents` with their own lift row (R-D
   baseline: 0/~205). Needs real multi-agent sessions on dogfood repos.

## Open queue after this session

1. Interactive permission-dialog spot check for Lane A → then `sextant init`
   integration (+ Codex parity question for `--codex` installs).
2. Dir-mapping form (d) per-package health — still blocked on a dogfooded
   monorepo.
3. Background debt unchanged: classifier conf-0.4 arc (docs/014), two Vapor
   eval failures, cosmetic `lib/trajectory` resolution miss.
