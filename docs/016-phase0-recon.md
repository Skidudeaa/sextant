# 016 — Phase 0 recon: blast-radius / self-tuning / subagent orientation

Date: 2026-07-01. Four recon spikes run before committing to any build, each with a
pre-registered kill criterion (spec ≠ plan: ground first, build second). Artifacts
(scripts + raw outputs) live under `docs/recon/016-phase0/`. All spikes were read-only;
working tree verified clean afterward.

## Scoreboard

| Spike | Question | Verdict |
|---|---|---|
| R1 | Can a PostToolUse hook inject context after an edit? | **VERIFIED — channel exists** (JSON `additionalContext`, field-tested) |
| R2 | Is git co-change a strong enough blast-radius signal? | **PASS-WITH-FILTERS** (filter + hub dampener are v1 requirements) |
| R3 | Can telemetry-learned per-source priors improve ranking? | **FAIL — killed.** Fallback: reporting-only `sextant tune` |
| R4 | Do hooks reach Task/workflow subagents? | **NO-CHANNEL** (0/200 transcripts + live probe). Fallback: MCP-tools + AGENTS.md-style conventions |

Net: **Sprint 1 = blast-radius lane** (both load-bearing assumptions verified).
Self-tuning demoted to a half-day reporting command. Subagent orientation re-scoped
to an active-pull design (no passive channel exists).

## R1 — PostToolUse injection channel (docs + field experiment)

- Plain stdout from a PostToolUse hook goes to the **debug log only** — not context, not
  transcript. **The caveat in CLAUDE.md ("a PostToolUse hook's stdout can reach the
  transcript/context") is wrong** and must be corrected. The out-of-band property of
  `commands/hook-posttooluse.js` is therefore even safer than documented.
- The real channel: exit 0 with
  `{"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "..."}}`.
  Cap 10,000 chars (additionalContext + systemMessage + stdout combined); overflow spills
  to a file. Phrase as factual statements, not imperatives (prompt-injection defenses
  flag command-like hook output).
- **Field-verified 2026-07-01 on Claude Code 2.1.198** (headless `claude -p`, scratch repo
  in `docs/recon/016-phase0/r1-live/`): the JSON marker was injected as a
  `<system-reminder>` immediately after the Read tool call; the plain-stdout marker
  (negative control) was invisible. Same INJECTED-marker methodology as the Codex
  verification in CLAUDE.md.
- Mid-session edits to the `hooks` section of settings.json: **unconfirmed** whether they
  take effect without restart; treat hooks as snapshotted at session start.

## R2 — co-change mining (sextant, somaNotes, jan25, defGen2)

Miner: `docs/recon/016-phase0/r2-cochange/cochange.js` (`computeCoChange()`, stdlib-only;
parses `git log --name-only --no-merges`, excludes >20-file commits — only 2–5% of
commits everywhere, so no silent history loss). Raw outputs per repo in `out/`.

- **Raw signal fails the kill criterion**: top-50 pairs are 40–86% junk
  (CHANGELOG/todos/docs/`.planning/`), worst on somaNotes where the workflow logs every
  commit to CHANGELOG.md (`CHANGELOG.md ↔ todos.md` count=356).
- **One cheap filter rescues it completely**: drop pairs where either file is not an
  indexable source file. Post-filter junk ≈ 0% on every repo; remaining pairs are real
  (somaNotes census UI cluster JS↔template↔CSS; jan25/defGen2 god-file hubs surfaced
  immediately).
- **Additive value confirmed on sextant itself**: 11/30 (37%) of filtered source pairs
  have **no import edge** — hub-orchestrated siblings that always move together but never
  import each other (`lib/graph.js ↔ lib/summary.js`, `lib/graph-retrieve.js ↔
  lib/merge-results.js`, `lib/config.js ↔ lib/intel.js`…). This is blast-radius
  information the import graph structurally cannot provide, so the lane is not redundant.
- **v1 ship requirements (promoted from follow-ups by the data)**:
  1. source-file filter — reuse `isIndexable()`/ignore-glob machinery, not a new regex list;
  2. hub dampener — god files (`feb8.py`, `allTogether3.py`) co-change with everything;
     apply the same fan-in-suppression pattern used for import-graph scoring.

## R3 — self-tuning priors: FAIL (killed)

Scripts + data: `docs/recon/016-phase0/r3-priors/` (`session_instances.json` freezes the
trajectory-derived instance rows — important, see corpus-churn finding). Method: volume
audit of live telemetry (19 wired repos) + trajectory corpus, Wilson intervals per
source, temporal-split and leave-one-turn-out reranking simulation with min-n=30 gate
and multipliers clipped to [0.7, 1.3].

Why it died — structural, not statistical noise:

1. **The mechanism has no lever.** 88% of multi-file injection blocks (168/190) are
   single-source; a per-source multiplier cannot reorder a homogeneous block. Only 5
   mixed-source blocks in the whole corpus have an observed open.
2. **Dead tie on every actable case.** Gated simulation: MRR 0.4733 before = 0.4733
   after, delta 0.0000, on all 5 available cases (and zero eligible cases landed in
   either temporal-split test half). An ungated variant "improves" 3/5 — by treating
   0/19 and 0/6 observed rates as truth (Wilson CIs [0–17%] / [0–39%]); that is
   overfitting, not evidence.
3. **Half the source vocabulary can't earn a prior**: `exported_symbol` 19 samples ever,
   `reexport_chain` 6, in the entire corpus. No forecastable date to reach n≥30 at
   current injection rates.
4. **The training-set premise is broken**: `~/.claude/projects` is a **rolling window,
   not append-only** — 72 sessions today vs the 110 behind docs/010's anchor (3 weeks
   ago). A learned prior's training data churns out from under it.

Pre-registered fallback stands: a **reporting-only `sextant tune`** command surfacing
per-source Wilson intervals + coverage so drift is human-auditable. Revisit live tuning
only if (a) thin sources exceed ~30 samples in a stable window, or (b) corpus retention
becomes append-only (e.g. sextant snapshots trajectory instances itself, as
`session_instances.json` does here).

### Incidental findings (act on regardless)

- **Holdback arm is dormant**: 1 `retrieval.holdback` event and 0 holdback-arm hits in
  3 weeks at `SEXTANT_HOLDBACK_PCT=20` on one repo. `benefitDelta` will never mature at
  this rate — either widen enablement (more repos / higher pct) or explicitly declare
  the causal arm dormant when citing it.
- **`retrieval.path_miss` carries no `source` field** — live telemetry structurally
  cannot compute per-source open denominators; trajectory replay is the only instrument
  that can. (A miss has no surfaced source to attribute; this is inherent, worth a note
  in CLAUDE.md's telemetry docs.)
- **Lift drift**: eval-trajectory today reports 1.76× on 72 sessions vs the canonical
  2.52×/110 (docs/010 anticipated drift; cite with the date attached).
- Live per-source hits ever recorded: `path_match` 255, `text_only` 44,
  `exported_symbol` 10, `swift_decl_type`/`reexport_chain` 0.

## R4 — subagent orientation: NO-CHANNEL

Two independent instruments agree:

- **Live probe** (subagent spawned in this wired repo, introspecting its own context):
  no `<codebase-intelligence>`, no `<codebase-retrieval>`, no hook results. It DID have
  the checked-in CLAUDE.md contents and the memory index.
- **Exhaustive transcript audit** (`docs/recon/016-phase0/r4-subagents/`): all 200
  subagent/workflow transcripts under `~/.claude/projects/**/subagents/**` (58 Task
  subagents + 136 workflow agents + 6 journals, 6 projects) contain **zero**
  `hook_success`/`hook_cancelled` attachment records — the record type that carries hook
  injections in main sessions (13/13 positive controls show 7–317 hookEvents each).
  4 string matches were all inherited/quoted text (Read-tool output of sextant's own
  source or AGENTS.md prose), not live injections. Task subagents and workflow agents
  behave identically; all hook types equally absent.
- Note: official docs *claim* SessionStart fires for subagents (with `agent_id`/
  `agent_type` fields). The field evidence says otherwise for this environment —
  docs-vs-field conflicts resolve in favor of the field.

**Re-scope**: subagent orientation cannot be a passive injection feature today. The
viable surfaces are what a subagent actively reads or calls: (a) the MCP tools —
already registered per-project and available to subagents; (b) CLAUDE.md/AGENTS.md-style
convention text inherited at spawn; (c) the parent agent embedding orientation into the
Task prompt. Design work, if pursued, is "make sextant trivially pullable" (e.g. a
compact `sextant_orient` MCP tool tuned for a subagent's first call), not a hook.

## Sprint 1 scope (blast-radius lane)

1. Co-change extraction at scan time: promote `computeCoChange()` into `lib/`, persist
   pairs to a graph.db table; source-filter via `isIndexable()` + hub dampener in v1.
2. PostToolUse emitter: after Edit/Write to a file with fan-in or co-change partners
   above threshold, emit the `additionalContext` JSON envelope with a ≤~300-char factual
   note (dependents not yet touched this session — from the existing
   `.last_injected_paths` / posttooluse session tracking — plus top co-change partners).
   Silent when nothing to say. Preserve the existing out-of-band scoring behavior.
3. Telemetry: tag emissions (`blastradius.injected` etc.) so the same open-rate
   instruments measure the new lane from day one.
4. Fix the wrong PostToolUse-stdout caveat in CLAUDE.md.
5. Half-day: reporting-only `sextant tune` (R3 fallback).

Gates: full suite green, self-eval byte-identical, a fail-pre/pass-post test on the new
lane, and a live INJECTED-marker verification in a real session before calling it
shipped (code-in-place ≠ behavior-verified).
