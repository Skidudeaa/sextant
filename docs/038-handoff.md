# 038 — Session handoff: three on-thesis features + interim fleet reads

Date: 2026-08-07. Branch `main` @ `394beaa` — **committed, NOT pushed** (will push with this handoff).

## What this session did

### Research sweep (wide and far)

Researched five horizons directly (subagent swarm hit a quota wall on web search, so the web work was done via `r.jina.ai` + primary sources): agentic context tooling landscape (Serena, Aider, Cursor, etc.), MCP code-intelligence servers, research frontier (repo-level retrieval, trajectory mining), indexing/graph tech (SCIP, tree-sitter, embeddings), and measurement/agent analytics (METR slowdown RCT, OTel GenAI). Filtered through sextant's own `STRATEGY.md` + `DESIGN_PHILOSOPHY.md` + rejected-approaches log.

Key finding: **the METR slowdown RCT** (July 2025 — AI made experienced devs 19% slower; benchmarks overstate, self-reports are delusional) validates sextant's measurement culture as the product, not just the process. The field has a measurement vacuum; sextant *is* the honest number nobody else produces. Serena's LSP-backed symbol tools optimize the layer agents are already decent at; the broken layer (tests, docs, code quality) is where sextant's honesty-first, measure-everything lane is differentiated.

### Interim fleet reads (037 open items, all resolved)

1. **Kimi wiring CONFIRMED live.** 398 `client:"kimi"` hook-lane rows in somaNotes telemetry, 63 in defGen2. Kimi restarted on 08-05+; the race condition is moot.
2. **MCP tool-surface interim read.** Codex sustains at 13.82 calls/load (608 calls); Kimi 0.38/load (8 calls — no longer dark but small); claude-code 0.11/load. Leaning keep the 9-tool surface for the ~08-20 verdict.
3. **Kimi Grep-vs-sextant ratio re-measured.** 994:2 baseline → 917:8 post-wiring (~4× better, still hook-dominated). Wire-log count (8) cross-validates exactly with MCP telemetry's `kimi-code` count (8).
4. **Benefit-delta era read.** Still DORMANT — 16 holdback / 44 armed turns (need ≥30/arm). Re-check ~08-20.
5. **Per-repo AGENTS.md committed.** somaNotes `eb9d37b`, defGen2 `ad48cf6` (scoped to AGENTS.md only; both repos have unrelated WIP untouched).
6. **docs/037 handoff + todos committed** (`3a4bd0b`).
7. **Deleted 2 merged local branches** (`feat/033-metric-instruments`, `feat/region-outcome-substrate`).

### Classifier conf-0.4 mission (docs/014) — verified ALREADY FIXED

The handoff predates the 07-30 prose gate (commit `6d1cf70`), which moved strict mode to `score >= 2` and made the conf-0.4 borderline band `retrieve:false`. The example "proceed the way you have laid out please" now correctly returns `retrieve:false`. No code change needed.

### Three features shipped

| commit | feature | what |
|---|---|---|
| `33cd9f3` | Loud staleness [009 #5] | `.content_stale` sentinel at both injection sites; statusline dot → red on content-stale blackouts. Gated strictly on `contentChanged` (never version bumps). |
| `859afe6` | Schema anchors [009 #2] | `### Schema` block via `schemaFilesFromGlob` for `*.prisma`/`*.graphql`/`*.gql`/`*.proto`/`openapi.*`/`schema.sql`. Placed above Recent-changes (clamp-safe). |
| `394beaa` | Rejected-approaches memory [docs/003] | `rejections` table (SCHEMA_VERSION 4→5), `sextant reject` CLI, staleness auto-detection, retrieval-lane injection. MCP tools deferred. |

Test state: 1399/1399 unit, 21/21 self-eval, 45/45 freshness — all green.

## Open — resume here

1. **Push to origin.** This session's commits (`3a4bd0b`, `33cd9f3`, `859afe6`, `394beaa`) + the per-repo commits are local. Push `main` so the MacBook sync picks them up.
2. **Holdback benefit delta — re-check ~08-20.** Run:
   ```
   node bin/intel.js telemetry --roots-file ~/.claude/sextant-fleet-roots --include-old --since 2026-07-30T12:00:00Z
   ```
   Look for `benefit delta:` — currently `DORMANT (accruing)` at 16/44 turns. When both arms cross 30, it becomes the first causal number. The daily cron (`scripts/check-holdback-benefit.sh`) logs to `~/sextant-benefit.log` but reads the all-time delta — quote the WINDOWED one, not the cron's.
3. **MCP tool-surface verdict — ~08-20.** One-command read (same telemetry command above, read the MCP section). Decision rule in `todos.md`: keep the 9-tool surface unless Codex sustains zero AND Kimi stays dark. Current lean: keep (Codex redeems the rent).
4. **Start recording rejections.** The feature is opt-in. Run `sextant reject "description" --files X --why "reason"` on repos where the agent re-proposes abandoned approaches. The first qualitative check: does the agent stop re-proposing after the rejection is in the retrieval lane?
5. **Run `sextant scan --force` on dogfooding repos** to trigger the SCHEMA_VERSION 4→5 self-heal (one-time version-only rescan, fast repos do it in-hook).

## How to know when the benefit delta is ready

Run the era-windowed telemetry command above. The line currently reads:
```
benefit delta: DORMANT (accruing) — holdback N turns, armed M turns; need >=30 per arm
```
When both arms cross 30, it switches to:
```
BENEFIT DELTA (armed − holdback): +X.X pts — the causal open-rate lift the injection buys
```
That number is the thing nobody else in the field can produce — benchmarks overstate (METR), self-reports are delusional (METR), and no other context tool publishes a holdback-arm causal delta on real agent behavior.

## Landmines for whoever resumes

- **SCHEMA_VERSION bump 4→5.** Existing repos self-heal on next scan via the versionOnly sync-rescue bypass. The first hook fire after pull will take ~1-2s on fast repos (in-hook rescan) or trigger one background rescan on slow repos. No action needed, but expect a one-time latency blip.
- **Rejections are opt-in.** No rejections exist until someone runs `sextant reject`. The retrieval-lane injection is a no-op until then.
- **Schema block only appears on repos with schema files.** somaNotes has none; a Prisma/GraphQL/proto repo will show it.
- **The holdback delta quotes the WINDOWED read** (`--since 2026-07-30T12:00:00Z`), NOT the cron banner's all-time number. The all-time delta is contaminated by pre-gate junk injections.
