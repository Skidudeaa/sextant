# 041 — Hibernation results review

Date: 2026-08-26
Decision: hibernate; do not describe the current experiment as proof of benefit or harm

## Executive ruling

Sextant's post-fix experiment is inconclusive. The pooled result that initially
looked directionally negative does not survive repo stratification, did not reach
its predeclared reporting floor, and is materially contaminated by sessions that
received both arms. It cannot support “Sextant failed” or “Sextant hurts agents.”

Hibernation is still the correct allocation decision. Residual blackout,
empty-result frequency, broad ambient integration, measurement complexity, and
the cost of repairing the experiment exceed the evidence-backed value of another
development cycle. This is an opportunity-cost ruling, not a scientific
falsification.

## Reproduction boundary

The post-fix read was:

```bash
node bin/intel.js telemetry \
  --roots-file /root/.claude/sextant-fleet-roots \
  --include-old \
  --since 2026-08-08T20:00:00Z
```

The comparison window used the same roots and ended exactly at that boundary:

```bash
node bin/intel.js telemetry \
  --roots-file /root/.claude/sextant-fleet-roots \
  --include-old \
  --since 2026-07-30T12:00:00Z \
  --until 2026-08-08T20:00:00Z
```

The six configured roots were Sextant, jan25, somaNotes, glasshud, defGen2, and
open-interpreter-fork. Post-fix telemetry contained 8,273 events through
2026-08-25; somaNotes supplied 7,827 (94.6%). This is principally a somaNotes
result, not a representative fleet result.

## What improved

| Measure | Pre-fix window | Post-fix window | Change |
|---|---:|---:|---:|
| Freshness stale reads | 39.6% | 27.6% | −12.0 points |
| Freshness blackouts | 38.6% | 27.6% | −11.0 points |
| Retrieval-lane stale turns | 43.5% | 28.0% | −15.5 points |
| `head_changed` stale events | 153 | 30 | substantially reduced |

The August 8 freshness work had real effect. It did not make staleness rare:
`status_changed` still caused 189 of 220 post-fix stale reads. Calling the stale
problem “fixed” would overstate the result; calling the work ineffective would
discard a measurable improvement.

## What did not improve descriptively

| Measure | Pre-fix window | Post-fix window |
|---|---:|---:|
| Retrieve-classified turns | 200 | 225 |
| Empty fallback | 24.0% (48/200) | 40.9% (92/225) |
| Scored-turn hit rate | 8.1% (6/74) | 6.8% (5/74) |
| Open precision | 2.5% | 0.8% |
| `export_token` scoped open rate | 6.9% (32/464) | 3.7% (12/323) |
| `exported_symbol` scoped open rate | 0/17 | 0/43 |

These are non-randomized before/after comparisons across changing workloads.
They establish that the hoped-for improvement was not visible; they do not prove
the August fixes caused a regression. The three live Census queries in
`docs/039-handoff.md` remain credible query-level evidence that the ranking defect
was corrected, but that local repair did not produce a measurable fleet outcome.

## Why the pooled arm result is not decision-grade

The pooled post-fix output was:

| Arm | Hit turns | Scored turns | Hit rate |
|---|---:|---:|---:|
| Armed | 3 | 51 | 5.9% |
| Holdback | 2 | 23 | 8.7% |

That −2.8-point direction is not robust.

### Repo stratification reverses the main cohort

| Repo | Armed | Holdback | Direction |
|---|---:|---:|---|
| somaNotes | 3/48 (6.25%) | 1/19 (5.26%) | armed +0.99 points |
| defGen2 | 0/2 | 1/4 (25%) | holdback, based on one hit |
| jan25 | 0/1 | 0/0 | no contrast |

The pooled negative is driven by one defGen2 holdback hit among six total scored
turns, while the only meaningful cohort slightly favors armed retrieval. The
arm-composition guard accepted the pool because total-variation distance was
0.135, below its 0.5 refusal threshold; that threshold does not protect against
small-sample directional reversal.

### The control was contaminated

Assignment was randomized per retrieval turn, not per session. Thirteen of 66
sessions drew both arms. Those sessions contributed 30 of 74 scored turns:

| Mixed-arm sessions | Armed | Holdback |
|---|---:|---:|
| Scored turns | 16 | 14 |
| Hit turns | 1 | 1 |
| File opens | 396 | 371 |

Thus 14 of 23 holdback turns occurred in a session that also received armed
context. Prior retrieval blocks remain in conversational context, so these are
not clean injection-off observations. Excluding every mixed-arm session leaves
35 armed turns and only nine holdback turns—still directionally negative, but far
too sparse to interpret.

### The floor was not power

The report required 30 turns per arm before printing a benefit claim. Holdback
reached only 23. More importantly, the report itself states that at 30 per arm
only effects around 33 percentage points or larger are resolvable. The plausible
effect here is single-digit points. Reaching the floor would not have made the
experiment adequately powered.

### The outcome is narrower than “agent benefit”

`turnHitRate` includes only retrieval turns followed by at least one scored file
operation. Turns with no file operation emit no outcome event. If retrieval
changes whether file work occurs, conditioning on file work is post-treatment
selection.

The persisted surfaced set is overwritten at the next retrieval injection, not
at every user prompt. File operations after intervening non-retrieval prompts can
therefore remain attributed to the prior retrieval window. The metric measures
“opened a surfaced file during the attribution window,” not correctness, time
saved, reduced hallucination, task completion, or user value.

The human report also prints “no injection-OFF arm yet” whenever the volume gate
is unmet, even when holdback observations exist. That wording is wrong. It is a
reporting defect, not a change to the underlying counts.

## How to interpret the earlier 2.52× result

The offline trajectory harness found surfaced files were opened about 2.52 times
the permutation-null rate. That is evidence that Sextant often identified files
agents subsequently used. It is not evidence that Sextant caused those opens:
canonical files can be both easy for Sextant to rank and files the agent would
have opened anyway. The inconclusive holdback does not erase the correlation,
and the correlation does not rescue the causal claim.

## MCP reach verdict

Post-fix MCP telemetry recorded 1,055 calls over 370 tool-list loads:

- Codex: 1,052 calls / 271 loads (3.88 calls per load)
- Kimi: 3 calls / 4 loads
- Claude Code: 0 calls / 95 loads

Sextant had real pull-channel use in Codex, especially `sextant_search`; the tool
surface was not universally dead. Reach remains client-specific, and invocation
volume is not an outcome measure. This is a salvage signal: if work resumes, a
narrow Codex-first search tool deserves consideration before the full ambient
orientation system.

## Decision and preserved value

Hibernate because:

1. the experiment cannot close the causal question without redesign and much
   more volume;
2. residual stale/empty rates remain too high for an ambient trust surface;
3. the broad hook, watcher, telemetry, statusline, cron, MCP, and multi-client
   perimeter costs more attention than the observed signal currently earns; and
4. repairing measurement solely to justify stopping is poor allocation.

Preserve:

- the freshness/silent-absence model;
- the trajectory and holdback measurement lessons, including the failure modes;
- the graph/search implementation and Codex usage evidence;
- exact telemetry and reproducibility artifacts; and
- the rule that a future version begins with a new falsifiable thesis, not the
  old TODO queue.

If Sextant wakes again, do not restore the whole system by default. Start with
one disposable repo and one client. The strongest contrarian restart is a narrow
Codex-native search surface; the strongest technology salvage is extracting the
freshness gate and evaluation discipline into another product.
