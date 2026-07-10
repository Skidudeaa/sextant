# 023 — Session handoff (2026-07-09/10)

Session span: main `c10e2c1` → `c18687f`, all merged to main and pushed.
Suite at handoff: **unit 886/886**, integration scripts green, CLI self-eval
byte-identical (21/21, MRR 0.900, nDCG 0.920). Watchers on sextant and
somaNotes restarted on current code.

## What shipped (8 commits, chronological)

1. **`c10e2c1` docs(020)** — dir-mapping recon: all four docs/019 probes ran
   against 5–9 real repos (incl. a vuejs/core clone). Neither kill criterion
   fired. Baseline: wrong-dir-start 39.4% (59% on 33-top-dir somaNotes, 0% on
   1-top-dir glasshud), first-touch p90=4. Scripts: `docs/recon/019-dirmap/`.
2. **`ac208a5` feat(blastradius)** — open-attribution scorer (017 lever #1
   CLOSED): lane 1b scores every file-touch against the union of the
   session's note-surfaced `{path, source}` sets → `blastradius.path_hit
   {source}` / `path_miss`; score-before-emit; telemetry renders blast-radius
   open-precision + per-source split. Verified live in its own dev session.
3. **`b64270e` docs(021)** — Structure-section design (D1–D5, byte budget,
   clamp policy, pre-registered metrics).
4. **`cc70ede` feat(summary)** — Structure section BUILT per 021:
   `lib/structure.js` + summary wiring; DISPLACES Module types (omission
   fallback on <2 non-root dirs); dogfooded on sextant/somaNotes/vue-core;
   live in the SessionStart injection.
5. **`7f622c5` feat(blastradius)** — dir rollups (021 form b): remainder ≥4
   → `(+28 more: test/ 19, lib/ 5, …)`; surfaced set unchanged;
   `blastradius.injected` stamped `rollup` for the open-rate split.
6. **`9e87175` feat(explain)** — dir-level explain (021 form c): new
   `sextant explain <file|dir/>` CLI + MCP `sextant_explain` dir mode, both
   over `lib/structure.js:explainDir`. Live: `explain lib/` → 172 inbound /
   0 outbound.
7. **`099aada` fix(cochange)** — `--no-renames` + stderr drop on the mining
   `git log`: kills the `diff.renameLimit` warning spray on large repos
   (user-reported on somaNotes; verified zero post-fix).
8. **`c18687f` docs(022)** — subagent-orientation Phase 0 recon (018 track):
   R-A/R-B/R-C all PASS → **GO**. Harness: `docs/recon/018-subagents/`.

## The next build: subagent orientation Lane A (docs/018 + docs/022)

Recon verdicts that shape it (Claude Code 2.1.206, field-verified):
- `updatedInput` from a parent-session PreToolUse hook (matcher
  `Task|Agent`; tool_name arrives `"Agent"`) rewrites `tool_input.prompt`
  cleanly — marker reached general-purpose AND Explore subagents verbatim.
  `subagent_type` is in the payload → per-type targeting is free.
- **FACTS-ONLY framing is load-bearing**: Explore explicitly discounted a
  self-described injected instruction line as untrusted. The block must be
  the `<codebase-intelligence>` shape (root, health, hotspots, structure) —
  no imperatives, no "call sextant_search first".
- All agent types already get CLAUDE.md (docs claimed otherwise — falsified);
  none get hook injection. Lane A's pitch is fresh + staleness-gated +
  query-relevant, not "text at all".
- MCP tools are reachable from subagents (Lane B viable, uptake unknown).

Pre-registered ship blockers (018 §blockers + 022): never-modify-on-doubt
(the probe hook `docs/recon/018-subagents/pretask-hook.js` demonstrates the
exact pattern), byte cap (parallel fleets multiply cost), freshness gate at
spawn time (subagents can't see the statusline — silent absence is their only
protection), R-D baseline done (0/~205), **plus an interactive permission-
dialog spot check** (headless couldn't observe how `updatedInput` renders in
the dialog — verify in a default-mode interactive session before enabling
beyond dogfood repos).

## Landmines (do not relearn these)

- **Old-code watcher clobbers new summary shapes.** A live watcher running
  pre-upgrade code rewrites summary.md on its next flush (hit live: somaNotes
  showed Module types after a new-code scan until watcher restart). Restart
  watchers after upgrading summary/graph/watcher code. Hook-only changes are
  exempt (hooks spawn fresh per invocation). 017 lever #4 (version stamp in
  heartbeat + doctor action) would make this loud — now field-motivated.
- **Nested `claude -p --dangerously-skip-permissions` is classifier-denied**
  in auto mode. Probes don't need it: default permission mode worked; the
  hook's `permissionDecision: "allow"` covers the spawn itself.
- `intel.init` self-deploys sextant hooks into any repo a session runs in
  (the ra-probe scratch repo gained SessionStart/refresh/posttooluse entries
  mid-probe). Harmless here, but scratch-repo experiments should expect it.
- Trajectory/lift numbers ride a ROLLING transcript window — always cite with
  date + corpus size.

## Measurement queue (blocked on volume, not work)

- **Structure benefit**: re-run `docs/recon/019-dirmap/probe4-benefit.js` on
  post-2026-07-10 sessions vs the 2026-07-09 baseline in docs/020.
- **Blast-radius open-precision**: now instrumented end-to-end (per-source +
  rollup split); read `sextant telemetry` once real sessions accumulate.
- **benefitDelta / holdback decision** (017 lever #3, STILL OPEN): at 20% on
  one repo the holdback arm accrues ~1 turn per 3 weeks — widen
  `SEXTANT_HOLDBACK_PCT`/repos or declare it dormant when citing.

## Open queue, ranked

1. Subagent orientation Lane A build (above) — the biggest unserved surface.
2. Watcher-restart ergonomics (017 lever #4) — small, field-motivated twice.
3. Holdback-arm decision — tiny, but it gates citing benefitDelta.
4. Dir-mapping form (d) per-package health — deferred until a real monorepo
   is dogfooded.
5. Background debt unchanged: classifier conf-0.4 arc (docs/014), two
   accepted Vapor eval failures, cosmetic `lib/trajectory` resolution miss.
