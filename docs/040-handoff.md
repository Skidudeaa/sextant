# 040 — Session handoff: the stale problem + periphery freeze

Date: 2026-08-08. Branch `main` — committed and **pushed** this session (`8037e3b` + this doc).

## Direction ruling (read this first — it governs future sessions)

The owner opened with waning enthusiasm ("the deeper i dig the more flawed it appears"). The assessment against live fleet telemetry validated it: 45.0% of reads stale / 44.4% blackout, turn hit-rate 10.5%, the holdback delta directionally NEGATIVE (armed 9.1% vs holdback 15.6%, CI spans zero), MCP reach client-bimodal, and the coherence arc structurally starved. Owner agreed to:

1. **Periphery FROZEN** — no further coherence/capsule/claims/instrument work. The instruments are honest now; stop building them. Do not start new measurement surfaces.
2. **Fix the stale problem first** (44% dark beats every ranking refinement as a lever) — done this session, see below.
3. **Decision gate ~2026-08-20**: with BOTH the 039 ranking fix and this stale fix live, re-read turn hit-rate, holdback delta, and stale rate over the post-08-08 window. If armed still doesn't beat holdback, the core hypothesis has had its fair test — wind down, salvaging the freshness-gate model and eval discipline. Read commands:
   - `sextant telemetry --roots-file ~/.claude/sextant-fleet-roots --since 2026-08-08T20:00:00Z`
   - qualitative re-run of the 039 somaNotes census queries (039 §Open #4)

## What shipped (`8037e3b`, feat(freshness))

Diagnosis: three compounding ratchets made staleness the steady state on active repos. The only recovery was a full spawned rescan (forced: p50 ~22s, p95 154s on somaNotes) that had to complete inside a quiet window; on a churny repo those windows are rarer than the invalidations.

| ratchet | fix | file |
|---|---|---|
| Git ops (commit/add/checkout) touch only `.git/` — invisible to the watcher — and the reconcile hard-required HEAD equality, so every commit invalidated the anchor (`head_changed` = 44.8% of fleet stale_hits) | Second chokidar watcher on git-dir `HEAD`/`index`/`packed-refs`/`refs/` → new `intel.notifyRepoStateChanged`; reconcile accepts HEAD moves by unioning `git diff --name-only --no-renames old new` into candidates (`freshness.diffNameOnly`). Untrusted diff → invalidation as before; all fences (400-path cap, control-path, out-of-scope, evidence, before/after tree) unchanged | `watch.js`, `lib/intel.js`, `lib/freshness.js` |
| New/deleted file set a sticky full-scan flag → stale until a bulk scan landed quietly | `repairMembershipUnlocked` — bounded re-resolution of direct dependents + unresolved-edge holders + specifier-stem shadow candidates (`filesWithUnresolvedImports`, `filesImportingSpecifierLike`; 200-importer cap). Refused repair (cap/error/symlink-replacement `notFile`) preserves old invalidation. Watcher `unlink` now flows through `updateFile` (was ignored) | `lib/intel.js`, `lib/graph.js`, `watch.js` |
| Recovery rescans always `--force` (re-extract everything; 22s vs 12s non-force on somaNotes) | `enqueueRescan`/`syncRescan` take `forceReindex`; all four gate call sites force ONLY on version reasons. Safe because checkFreshness reports version reasons FIRST in the single-valued reason race, so `head_changed`/`status_changed` imply matching version stamps | `lib/freshness.js`, `lib/cli.js`, `commands/hook-refresh.js` |

**Verification:** `test/freshness-reconcile.test.js` (6 cases, mutation-checked — dropping the head-diff union dies on the checkout test's graph-content assertion, i.e. the false-fresh hazard; no-op'ing the repair dies on the resolution-flip assertions; the symlink refusal is locked by the pre-existing `intel-scan.test.js` case, which caught it during development). Full suite 1410/1410; self-eval 21/21, lift unchanged (scoring untouched). **Live:** commit → fresh in ~1s on this repo, both directions (commit forward, reset back), zero spawned rescans.

## Deploy state

- Pushed to `Skidudeaa/sextant` main. Global `sextant` on this box is a symlink to `/root/sextant` — code is live.
- **Watchers restarted on new code + anchors re-established** (one non-force rescan each): sextant, somaNotes, jan25, defGen2 — all verified fresh.
- glasshud + open-interpreter-fork watchers dead ~4 days (inactive repos). SessionStart auto-starts new-code watchers on their next session; left alone.
- **MacBook**: owner pulls from remote. Per repo there: `sextant watch-stop && sextant watch-start`, then `sextant rescan --allow-concurrent` once.

## Gotchas for the next session

- **Ratcheted anchors do not self-heal.** An anchor invalidated by OLD code has `statusHash=""` → `canReconcile` false forever → the new incremental machinery cannot re-anchor it. ONE `sextant rescan --allow-concurrent` re-establishes it; after that the new machinery maintains it. If a repo reads permanently stale post-upgrade, this is why — do not diagnose the reconcile as broken.
- A running watcher is the old code until restarted; until then behavior is exactly pre-fix (the reconcile extension helps on any flush, but git ops still go unseen).
- The `shouldSyncRescan` p95 history now mixes forced and non-force durations; the trimmed last-50 window adapts on its own. Deliberately NOT filtered by force-mode — don't add machinery (periphery freeze).
- Membership repair refuses (and correctly stays stale) on: >200 affected importers, any resolver error, and not-a-regular-file replacements (symlink semantics differ between the incremental lane and fast-glob).

## Open — resume here

1. **Watch the stale rate collapse (or not).** `freshness.stale_hit` reasons `head_changed`/`status_changed` should drop sharply on watcher-live repos in the post-08-08 window. If they don't, read which reason survives — it names the uncovered path. This is the cheap early read before the 08-20 gate.
2. **The 08-20 decision gate** (§Direction ruling above). This is the session's real deliverable: a falsifiable test of the whole project.
3. Carried from 039 (all still open, all allowed under the freeze since they're core-lane): eval corpus gap for scattered-token export-injection queries (039 §Open #1 — highest-value follow-up); doc-penalty-vs-plan-docs question (039 #2); BM25 recalibration only as a gated project (039 #3, do NOT flip `UseBM25Scoring`).
4. NOT allowed under the freeze: anything in the coherence/capsule/claims arc, new telemetry surfaces, new instruments. The freeze holds until the 08-20 gate rules.
