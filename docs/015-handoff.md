---
title: Session handoff — Codex integration shipped + verified, #6 public-API outline; next lever unchanged (classifier conf-0.4)
date: 2026-06-22
status: handoff
branch_state: main @ 4af0471 (everything merged + pushed; clean tree)
supersedes: docs/014-handoff.md
companion: docs/014-handoff.md (the classifier conf-0.4 dig — still the next lever), todos.md
---

# Handoff — Next Session

> Read order: this file → `docs/014-handoff.md` (the classifier conf-0.4 mission is unchanged
> and still un-started — its evidence/landmines/candidate-fixes are all still live) →
> `CLAUDE.md`. `todos.md` top section is the live tracker.

## TL;DR

This session was **not** retrieval-precision work — it was triggered by a real-world report
("many misses and failures" while using **Codex** in the glasshud repo). Root cause: **sextant
was completely dark under Codex.** `sextant init` only wires Claude Code surfaces
(`.claude/settings.json` hooks + `.mcp.json`); Codex reads neither, so the agent oriented blind.

Shipped + pushed (main @ `4af0471`):
1. **`sextant init --codex`** — wires the three surfaces Codex DOES read: `.codex/hooks.json`
   (auto-injection), `AGENTS.md` (orientation), global `~/.codex/config.toml [mcp_servers.sextant]`
   (on-demand MCP). Merge-not-clobber, idempotent. `commands/init.js`, 10 tests.
2. **Hook-stdout ingestion VERIFIED live** (Codex CLI 0.141.0) — not just "emits blocks." A
   `codex exec` logged `hook: SessionStart` + `hook: UserPromptSubmit` and the tool-forbidden model
   answered `INJECTED` (it saw the `<codebase-intelligence>` block). Dirty tree → freshness gate
   served the blackout body → model reported "unavailable" instead of hallucinating = silent-absence
   working end-to-end through Codex. **This closes the long-standing "does Codex ingest hook stdout?"
   question — yes.**
3. **009 #6 public-API outline** — `### Public API (hotspots)` block in the summary listing the
   exported symbols of the highest-fan-in files. `summary.js`, 3 tests.

The retrieval-precision arc remains mined out (012/013 shipped). **The next dev lever is still
the classifier's conf-0.4 conversational firing — see `docs/014`, fully intact.**

## Codex integration — gotchas a future session WILL hit

- **Codex requires persisted hook trust.** A freshly-written `.codex/hooks.json` is **silently
  skipped** until the user trusts it. A Codex *restart* prompts for trust; trust state persists to
  `~/.codex/config.toml [hooks.state."<repo>/.codex/hooks.json:session_start:0:0"]`. For automation,
  `codex exec --dangerously-bypass-hook-trust`.
- **`codex exec` hangs on a non-TTY stdin** — invoke with `< /dev/null` or it waits forever
  ("Reading additional input from stdin..."). Cost me two timed-out probes.
- Codex's `[mcp_servers]` is GLOBAL (one entry covers all repos; the MCP server resolves the repo
  from `process.cwd()`). The hooks + AGENTS.md are per-repo.
- Codex maps the Claude-style `{hooks:{SessionStart|UserPromptSubmit:[...]}}` JSON onto its internal
  `session_start`/`user_prompt_submit` events. **PostToolUse is intentionally omitted** from
  `init --codex` — unverified under Codex; an unknown event could break hook parsing. (Consequence:
  no outcome-substrate `path_hit`/`path_miss` from Codex sessions yet — a future verify-then-add.)

## USER ACTION outstanding (not code — can't be done for them)

`sextant init --codex` was run across 8 repos this session, but Codex only trusts a repo's hooks
after a **restart in that repo**. Still needing a restart+trust: `jan25`, `manus-api-mcp`,
`amoSportsCenter`, `sinter`, `somaNotes`, `open-interpreter-fork`. (glasshud trusted; sextant itself
deliberately not wired.) Until then those repos get the MCP tools but NOT auto-injection.

## Next lever (unchanged from 014) — classifier conf-0.4

Everything in `docs/014` is still true and un-started. The one-line version: the classifier fires
`retrieve:true` at confidence 0.4 on conversational prompts (`"proceed the way you have laid out"`
→ terms `proceed/laid/out` hit every lane). The mission is instance-level diagnosis → measured fix
or measured no-ship. **KEY landmine (refutes the naive fix):** aligned path matches on conf-0.4
turns run **6.2%** (ABOVE lane average) — blanket conf-0.4 suppression is already refuted by data.
Front-runner candidate: borderline requires ≥1 code-shaped term (`utils.isCodeShapedTerm` exists).
Full evidence table + candidate shapes (a/b/c/d) + the py-nl-001 minRecall landmine are in `docs/014`.

After that, the cheap manifest-seam tier (now one shorter): **#7 Makefile→Commands**, **#2 schema
anchors**, **#4 resolution-by-kind**; then the bigger **#3 co-change lane** (composite 45, new
fact-class). Per-item gates in `docs/ideas/009`.

## Landmines / constraints (carried forward, still live)

- `test/classifier.test.js` regression-locks exact dogfooding phrasings — any classifier change must
  keep those + self-eval scope cases green.
- `py-nl-001` (python hook eval) has `minRecall` gates that NEED NL prompts to keep firing — a
  stricter classifier that kills NL-scatter queries regresses the A4 recall work. Check explicitly.
- Classifier budget <1ms, pure heuristics, no LLM calls.
- **Known pre-existing eval failures** (do not re-discover): hook self-eval `multi-003`, python
  hook-eval `py-flag-001` — both reproduce at clean baseline. CLI self-eval + Vapor diff are the
  hard gates.
- Telemetry rotates at 1 MiB → use `--include-old` when reading rates.

## Standing instruments (all passive)

- `sextant eval-trajectory` per-source: watch exported_symbol drift toward ~15% and path_match
  toward ~5.4% as post-ship sessions accrue; #6's open-rate payoff will also show here.
- Holdback arm at 20% on this repo; daily cron logs to `~/sextant-benefit.log`.
- `bash scripts/check-holdback-benefit.sh` to check manually.

## This session's ledger (all pushed, main @ 4af0471)

`1f96979` feat: `sextant init --codex` · `9def3ec` fix: stray `.codex` file actionable error
(found dogfooding across repos) · `aad4039` docs: Codex ingestion VERIFIED · `4af0471` feat:
009 #6 public-API outline. Unit suite 809/809; `npm test` exit 0 end-to-end.
