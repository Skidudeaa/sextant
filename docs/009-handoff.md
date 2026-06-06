---
title: Session handoff — after 009 #1 (outcome-telemetry substrate v1)
date: 2026-06-06
status: superseded
superseded_by: docs/011-handoff.md
branch_state: main @ 8255023 (pushed, clean, == origin/main)
companion: docs/ideas/009-yield-synthesis.md, todos.md, CLAUDE.md
---

> **⚠ SUPERSEDED by [docs/011-handoff.md](011-handoff.md).** The "THE NEXT MOVE"
> below (the injection-OFF holdback arm) is **DONE** — shipped with the offline
> trajectory harness on `feat/benefit-proof-trajectory-holdback`. Retrieval's
> benefit is now proven (1.98× open-rate lift; see `docs/010-benefit-proof.md`).
> This file is kept for history; read 011 for current state.

# Handoff — Next Session

> Read order: this file → `docs/ideas/009-yield-synthesis.md` (the ranked menu) →
> `CLAUDE.md` component 14 + the Telemetry section. `todos.md` top section is the
> live tracker. The 009 doc is canonical for *why*; this file is *where you are
> and what to do next, with the landmines surfaced*.

## TL;DR

The benefit-proof loop (009 #1) is **shipped and pushed** to `main` (`8255023`).
sextant now records whether the agent opens/edits the files retrieval surfaced
(`retrieval.path_hit{source}` / `path_miss` → `sextant telemetry` open-precision).
It is explicitly **v1 = "loop wired, baseline pending"** — the number is
correlational until the **injection-OFF holdback arm** lands. That arm is the
single most important next move; everything else on the 009 ladder is now
*provable* because this denominator exists.

## State (verified this session)

- `main @ 8255023`, clean, == `origin/main`. Two commits pushed: `ff2c4ab` (009
  blueprint + backlog re-rank) and `8255023` (the substrate).
- Gates green: **unit 742/742**, self-eval **byte-identical** 0.908/0.923
  (stash-compared — the feature is off the CLI `retrieve()` path), **5/5**
  integration scripts.
- The substrate is **self-dogfooding**: this repo's `.claude/settings.json` now
  carries the PostToolUse hook (committed). It's already scoring this repo's own
  sessions. `sextant telemetry` will read `open-precision: n/a` until a
  query-aware injection is followed by file-opens in the same session.

### What shipped (file map)

| File | What |
|------|------|
| `commands/hook-posttooluse.js` (new) | PostToolUse hook. `classifyOpen`/`toRepoRel`/`readInjectedSet` are exported + unit-tested. Never throws, **no stdout**. |
| `commands/hook-refresh.js` | Persists `.last_injected_paths.retrieval.<sessionKey>` = `{ts,stale,paths:[{path,source}]}` on real injection. `buildInjectedPaths()` exported. |
| `lib/format-retrieval.js` | `formatRetrievalDetailed() → {text, files}` (the *rendered* prefix). `formatRetrieval()` delegates (byte-identical). |
| `lib/intel.js` | 3rd hook self-wired in `ensureClaudeSettingsUnlocked`; `ensureHookCommand(arr,cmd,matcher="*")`. |
| `commands/telemetry.js` | `openPrecision` + `pathHitsBySource` aggregation; `printSummary` exported; "Outcome substrate" section. |
| `commands/init.js`, `bin/intel.js` | reporting + dispatch (`hook posttooluse`). |

## THE NEXT MOVE — injection-OFF holdback arm (009 #1 follow-up)

**Why:** without a counterfactual, open-precision can't separate "we steered the
agent" from "the agent would have opened the canonical file anyway." This is the
load-bearing reason v1 is *not* a benefit number. **Do not cite open-precision as
evidence of benefit until this exists.**

**Mechanism (proposed — confirm with Amo before building):**
1. In `commands/hook-refresh.js`, at the code-relevant branch, decide per-turn
   whether this is an **armed** (inject normally) or **holdback** (suppress the
   `<codebase-retrieval>` injection) turn, by a configurable fraction
   (e.g. `SEXTANT_HOLDBACK_PCT`, default 0 = off so it never degrades a normal
   install).
2. On a holdback turn: still run retrieval and still **write the injected-set
   file tagged `arm:"holdback"`** (with the paths it *would* have surfaced), but
   do NOT emit the block. On an armed turn: tag `arm:"armed"` and inject as today.
3. `hook-posttooluse.js`: include the set's `arm` on the emitted event
   (`retrieval.path_hit{source, arm}` / `path_miss{arm}`).
4. `commands/telemetry.js`: split open-precision by `arm` → the
   armed-vs-holdback delta IS the benefit signal.

**Landmines for the holdback arm:**
- **Determinism for tests vs randomness in prod.** Scripts can't use
  `Math.random()` in the workflow harness, but the hook is plain Node — random is
  fine there. For *tests*, gate the decision on something injectable (env var /
  explicit flag in the stdin payload) so a test can force armed vs holdback.
- **Holdback must NOT suppress the static-summary fallback** — only the
  query-aware `<codebase-retrieval>` block. The agent still needs *some*
  orientation; suppressing everything changes behavior too much and conflates the
  experiment with "no sextant at all."
- **Freshness interaction:** a content-stale turn already strips structure. Decide
  whether holdback stacks with stale (probably: skip holdback accounting on
  stale turns — the arm is about the *graph-authority* contribution, which is
  already suppressed when stale).
- **Honesty:** keep the `arm` semantics out of anything Claude sees. It's
  out-of-band telemetry only.

**Offline complement (009 #12, optional, can run in parallel):** a
`sextant eval-trajectory` over `~/.claude/projects/**/*.jsonl` reporting
**orientation latency / first-touch precision** (did the agent open the injected
file *first* vs after N exploratory reads). NOTE the review's correction:
**hallucinated-path rate is degenerate (~0 in real sessions** — the agent
Globs/LS before Reading); lead with orientation-latency, keep hallucinated-path
as a tripwire only. (009 #12 in the doc.)

## The 009 ladder after the holdback arm (now provable)

In recommended order (009 §"Recommended sequencing"):
1. **Schema/contract anchors (#2, S)** — NEW fast-glob pass (exts not in
   `isIndexable`); place ABOVE Recent-changes (clamp guard). Migration anchors are
   a *separate* readdir op, not the same pass.
2. **Makefile Commands block (#7, S)** — specify the dual-source merge contract
   (polyglot repos have both package.json scripts AND a Makefile).
3. **Public-API outline (#6, XS)** — `graph.queryExports` (`graph.js:428`) exists;
   FAIL-pre anchors on the HOTSPOT block (`bin/intel.js` has zero exports).
4. **Resolution-by-kind (#4, S)** — new `GROUP BY imports.kind`; needs a NEW
   fixture with an unhonored tsconfig-paths import (no existing fixture is multi-kind).
5. **Co-change lane (#3, M)** — **NO SCHEMA_VERSION bump if live-computed**
   (`getRecentGitFiles` is render-time/git-only, `summary.js:283`); the hard half
   is MIN_SUPPORT + mega-commit cap + frozen-range fixture, not pair recovery.
6. **swift_relations consumer (#8, S)** — cheap MCP pathfinder; `findRelationsByTarget`
   (`graph.js:908`) has zero callers. Validates the relation-altitude pattern
   BEFORE the heavy symbol-blast-radius (#11). No-benefit-here = kill the trilogy.
7. **Symbol-level blast radius (#11, L)** — JS names are NEVER parsed today
   (`js_ast_imports.js` reads only `node.source.value`); they must be ADDED, not
   un-discarded. SCHEMA_VERSION bump.

## Landmines / gotchas carried forward

- **SPM-1 is fixed but understand it:** `toRepoRel` now `realpathSync`-collapses
  both root and the opened path (symlinked checkouts / macOS `/tmp→/private/tmp`
  otherwise false-MISS every open). The writer stores graph-relpaths under the
  (realpath-collapsed-on-Linux) scan root; the read-side realpath aligns them.
  Regression test exists. If you touch path handling, keep both sides resolved.
- **open-precision framing is load-bearing.** Both halves of the caveat
  (baseline-pending AND precision-flavored/misses-include-unrelated-opens) must
  stay on every surface that shows the number (`telemetry.js` stdout + CLAUDE.md).
  VH-2 was a real finding; don't let a future edit drop a half.
- **path_miss fires on every in-repo file-open after an injection** (scoped to the
  session's most-recent set). That's intentional but makes the raw denominator
  precision-flavored, not coverage. The holdback arm + a possible future
  "coverage" metric (which injected paths got opened ≥once) are the upgrades.
- **`.claude/settings.json` is git-tracked here** and self-wires on every prompt
  via `intel.init`. If you add/rename a hook, the merge is idempotent + anti-clobber
  (locked by `test/init.test.js`), but the repo's own settings will change on next
  run — commit it as dogfooding or `git checkout` it deliberately.
- **Self-eval ≠ the feature's proof.** The substrate is off the CLI `retrieve()`
  path, so self-eval/Vapor are byte-identical by construction. Its proof is the
  telemetry denominator (and, soon, the holdback delta) — never a graphLiftNDCG claim.

## Acceptable debt (reviewed, NOT fixed — deliberate)

- **SPM-3 (LOW):** the pid/ppid `deriveSessionKey` fallback diverges writer↔reader
  if a harness omits `session_id`. Real Claude Code always sends `session_id`
  (confirmed against `~/.claude/hooks/gsd-context-monitor.js`), so this only bites
  exotic harnesses. Fix only if it shows up.
- **SPM-4 (LOW):** both hooks use `process.cwd()`, ignoring the payload `cwd` that
  the project's own PostToolUse hook prefers. Consistent with the other two hooks;
  leave unless a multi-root case appears.
- **CS-1 (LOW, pre-existing):** `readStdinJson`'s 3s timeout bounds promise
  resolution but not process lifetime if the runner holds stdin open (~40ms in the
  normal close case). Shared trait of all hooks; one-line stdin-detach fix if ever
  needed.

## How to verify you haven't regressed

```bash
npm test                      # unit 742/742 + 5 integration + self-eval 21/21
npm run test:eval             # self-eval must stay byte-identical (off the CLI path)
node --test test/hook-posttooluse.test.js test/init.test.js   # the substrate locks
sextant telemetry             # open-precision section (n/a until real opens scored)
```

For the holdback arm specifically: add a test that forces armed vs holdback via an
injectable flag and asserts `path_hit{arm:"armed"}` vs the holdback path emits a
set tagged `holdback` with NO `<codebase-retrieval>` block on stdout.

## Open question for Amo (decide before building the holdback arm)

What holdback fraction, and is it acceptable to occasionally withhold retrieval
from real sessions to earn the baseline? (Default-off via env var means zero
impact until deliberately enabled on a dogfooding repo — recommended.)
