# 017 — Sprint 1 metrics snapshot + consolidated findings for the three "next level" ideas

Date: 2026-07-02, main @ b39ea43 (blast-radius sprint merged + pushed). This doc is the
post-ship metrics run plus the durable record of where all three ideas from the
2026-07-01 ideation landed. Recon evidence: `docs/016-phase0-recon.md`; ship record:
CHANGELOG 2026-07-01 entry.

## Metrics snapshot (all gates, post-ship)

| Metric | Value | vs anchor | Verdict |
|---|---|---|---|
| Self-eval (21 cases) | 21/21, MRR 0.900, nDCG 0.920, lift +0.012 | byte-identical | PASS |
| Python fixture (7 cases) | 7/7 | unchanged | PASS |
| Vapor CLI (committed fixture) | MRR 0.8111, nDCG 0.7997, Δ +0.0000 | byte-identical | PASS |
| Vapor hook | MRR 0.7550, nDCG 0.7406, Δ +0.0000 | byte-identical | PASS |
| Unit suite | 846/846 | +34 tests over pre-sprint | PASS |
| Trajectory lift (retrieval) | **1.93×** (7.45% vs 3.86% null), 71 sessions / 11 repos | 2.52× anchor was 110 sessions | drift = corpus rotation, expected |
| Trajectory lift (static) | 1.15× (13.93% raw — the recency-correlation trap) | 1.38× anchor | same pattern |

`sextant tune` (reporting-only): path_match 8.3% [6.3%, 10.9%] n=555; text_only 6.7%
[4.5%, 9.8%] n=358; exported_symbol 0/20 and reexport_chain 0/6 remain
prior-ineligible. Post-docs/012 the exported_symbol lane fires rarely (20 lifetime
surfacings) — the gate is doing its job; the open-rate question stays unanswerable
until volume exists.

### Blast-radius lane (new — day-zero numbers)

- **Emissions**: 3 (`blastradius.injected`), 9 dependent paths surfaced, 0 co-change
  partners (all three predate sextant's own co-change rescan — partners now populate).
- **Lane coverage on sextant's graph** (would an edit speak?): 127 indexed files,
  83 co-change pairs (101 commits mined, 4 bulk excluded). 28 files clear the
  fan-in≥3 floor, 39 have a partner at conf≥0.4, **51/127 (40%) carry at least one
  signal** — i.e. an edit to a random sextant file has a ~40% chance of a note on
  first touch, 0% on repeat touches (once-per-session dedupe).
- **Open-attribution**: NOT yet measured — the emitted-path state carries
  `{path, source: dependent|cochange}` but no scorer reads it. This is the lane's
  009-#1-style follow-up (see Next levers).

### Holdback arm — first benefitDelta data (caveat heavily)

`sextant telemetry` now prints: armed open-precision 17.4%, holdback 0.0%,
**benefitDelta +17.4 pts**. The holdback arm has only a handful of scored opens
(single holdback turn), so this is the instrument WORKING, not a stable number.
R3's finding stands: at 20% on one repo the arm accrues ~1 turn per 3 weeks. Decide:
widen (`SEXTANT_HOLDBACK_PCT` on more repos / higher pct) or declare dormant when
citing.

### Housekeeping flag

Indexing now covers `docs/recon/016-phase0/` scripts (127 files, was 120); one
absolute-path `require("/root/sextant/lib/trajectory")` in a recon script shows as
the sole resolution miss (249/250). Cosmetic. If it bothers: `.codebase-intel.json`
ignore for `docs/recon/**`, or make the recon requires relative.

## The three ideas — final dispositions

### 1. Blast-radius / action-time orientation — SHIPPED (b39ea43)

The bet: the costliest orientation failure ("missed blast radius") happens at EDIT
time, and sextant only spoke at prompt time. Now `hook posttooluse` lane 2 emits one
factual note after a mutating tool call — untouched dependents + co-change partners —
via the `additionalContext` envelope (plain PostToolUse stdout provably reaches
nothing; the old CLAUDE.md caveat was false).

Durable findings:
- **Co-change is real signal once filtered**: raw top-50 pairs are 40–86% junk;
  post-filter ~0%, and 37% of sextant's own source pairs have no import edge.
- **The self-caused-drift trap**: the agent's own edit content-stales the tree at
  exactly emit time; without a live watcher the lane never speaks. Fixed via
  dirty-path→content-hash map (`scanned_status_files`) + `isSelfCausedStatusDrift`.
  Found ONLY by the headless fresh-repo gate — dev-session dogfooding masked it
  completely (the watcher kept re-stamping state). Fresh-install headless E2E is
  now the lane's canonical verification.
- Adversarial review: 1 MEDIUM (content re-drift on already-dirty file — closed with
  hashes), 4 LOWs (all closed). Independent reproduction 5/5, re-verified post-hardening.

### 2. Self-tuning retrieval — KILLED with evidence; `sextant tune` is the residue

R3's kill was structural, not statistical: 88% of injection blocks are single-source
(a per-source multiplier cannot reorder them), the gated simulation was an exact tie
on all 5 actable cases, half the source vocabulary has ≤20 lifetime samples, and
`~/.claude/projects` is a rolling window so learned priors train on churning data.
Revisit conditions (printed by `tune` itself): thin sources reach n≥30 in a stable
window, or corpus retention becomes append-only. Today's run: unchanged, no revisit.

### 3. Subagent orientation — NO passive channel; re-scoped to active-pull

R4 (0/200 transcripts + live probe): no hook type fires for Task or workflow
subagents; official docs claiming otherwise lose to field evidence. Subagents DO get
CLAUDE.md and (per `.mcp.json` registration) can call the sextant MCP tools — but
nothing pushes orientation at them. Research + plan for the active-pull design:
`docs/018-subagent-orientation-plan.md`.

## Next levers, ranked

1. **Blast-radius open-attribution** (small): a PostToolUse-side scorer matching
   subsequent opens against the emitted `{path, source}` sets → `blastradius.path_hit`
   → per-signal open rates in `telemetry`/`tune`. Mirrors 009 #1; substrate already
   persisted.
2. **Subagent orientation v1** (medium): per docs/018.
3. **Holdback-arm decision** (tiny but a decision): widen or declare dormant.
4. Watcher-restart ergonomics after upgrades (old-code watcher persists over new
   tables until restarted): a version stamp in the heartbeat + doctor/statusline
   action would make the operational footgun loud.
