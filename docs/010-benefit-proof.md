---
title: Benefit proof — sextant measured on real agent behavior (not a fixture proxy)
date: 2026-06-06
status: verified
method: offline trajectory replay over 74 real Claude Code sessions + 6-agent adversarial reproduction
companion: docs/ideas/009-yield-synthesis.md, lib/trajectory.js, commands/eval-trajectory.js
---

# Benefit Proof

> The question every sextant metric dodged until now: **does it actually help the agent?**
> MRR / nDCG / graphLiftNDCG are offline fixture proxies — they prove *no-regression* on a
> synthetic corpus, never *benefit* on real behavior. This is the first measurement of sextant
> against what real Claude Code agents actually did.

## TL;DR — the verified benefit statement

> **On 74 real Claude Code sessions across 7 repos (4,216 file-opens), files sextant surfaces for
> a query are opened ~2× more often than a matched chance baseline of plausible same-repo surfaced
> sets (6.8% actual vs 3.4% permutation-null = 1.98× lift), and when a surfaced file is opened it
> lands early (median first-touch rank 2). The static summary has a higher raw open-rate (19.3%)
> but a far smaller lift (1.34×) — most of its apparent usefulness is the recent-changes
> correlation trap.**

This number is **correlational, not yet causal** (see Caveats). The injection-OFF holdback arm —
**shipped this session** — is the rigorous causal upgrade; it just needs sessions to accumulate.

## How to see it yourself

```bash
sextant eval-trajectory            # human report over ~/.claude/projects
sextant eval-trajectory --json     # machine-readable
sextant eval-trajectory --size-matched   # null-fairness robustness variant
```

## The two instruments

| Instrument | What it answers | When it pays out | Status |
|------------|-----------------|------------------|--------|
| **`sextant eval-trajectory`** (offline replay, `lib/trajectory.js`) | Did the agent open what we surfaced, on history that *already exists*? | **Today** — a real number from months of real sessions | ✅ shipped |
| **Injection-OFF holdback arm** (`hook-refresh.js` + telemetry) | Causal: armed-vs-holdback open-rate delta | After sessions accumulate (opt-in via `SEXTANT_HOLDBACK_PCT`) | ✅ shipped (default-off) |

Offline replay is the *before-merge* proof; the holdback arm is the *in-field* causal proof. Together
they answer the user's question: **is-delivering** (measured on real history) + **could-deliver**
(clean causal instrument going forward).

## The numbers (frozen anchor: 74-session manifest, K=200 perms, seed 12345)

| Signal | Raw open-rate | Permutation-null | **Lift** | opened/surfaced |
|--------|--------------|------------------|----------|-----------------|
| **Query-aware retrieval** | 6.81% | 3.44% | **1.98×** | 101/1484 |
| Static summary | 19.31% | 14.42% | **1.34×** | 1274/6596 |

- **Lift, not raw coverage, is the headline.** Raw coverage alone is uninterpretable (the agent
  opens central files regardless). The permutation null asks: *do the files we surface for a query
  get opened more than random plausible same-repo files would?* Retrieval: **2×**. That is the
  signal.
- **The static summary is the correlation trap, quantified.** It *looks* more useful (19.3% raw)
  but its lift is only 1.34× — because its "recent changes" rows list the files already being
  worked on, which the agent opens anyway (14.4% chance base rate). The **static/retrieval lift
  ratio is 0.68×**: query-relevance carries ~1.5× more genuine signal than recency.

### Orientation latency — when retrieval hits, it lands early
- First-touch hit-rate: **11%** of injections have a surfaced file opened within the next 8 opens.
- **Median first-touch rank: 2** — when the agent opens a surfaced file, it's typically its 2nd
  open after the injection (opened-first 5.3%).
- Reading: retrieval's *hits* steer well; its *precision* is the headroom (surfaces ~4 files, agent
  opens <1 — low coverage = precision opportunity, not "broken").

### Per-source — which surfacing signal earns opens (retrieval)
| Source | Coverage |
|--------|----------|
| `text_only` (live zoekt excerpt) | 14.0% |
| `path_match` | 5.5% |
| `exported_symbol` | 4.3% |
| `reexport_chain` | 0.0% (n=6, tiny) |

Attribution is preserved per-signal (the 009 #1 correction), so future signal work is measurable
individually rather than collapsing to one aggregate.

### Robustness
- Per-repo retrieval lift is **positive in every multi-session repo**: jan25 3.74×, somaNotes
  2.14×, open-interpreter-fork 1.91×, sextant 1.47×, defGen2 1.40×. (Single-session repos
  dictum/tradingDesk are ~1.0× — a pool of <2 can't form a real null, correctly.)
- **Not a one-repo artifact**: dropping the largest repo (somaNotes) → 1.90×; dropping the two
  largest (somaNotes + jan25) → 1.39×. Never collapses to 1.0×.
- Size-matched null (guards a set-cardinality bias): 1.96× — the lift is not a size artifact.

## How it was verified (6 independent reproductions + adversarial reconciliation)

A dynamic workflow dispatched **6 skeptics**, each rebuilding the measurement *from scratch* with
its own parser (no reuse of `lib/trajectory.js`) and attacking one validity threat; a synthesis
lead then reconciled — and **reproduced the two refuting verdicts**, overturning both:

- **Retrieval ~2× lift — CONFIRMED** by 3 independent parsers (actual 6.44%/6.81%/~6.9%; lift
  1.97×–2.43× depending on null construction; all ≫ 1.0×).
- **Median first-touch rank 2 — CONFIRMED exact** (independent hit-rate 13.65% — the 11% claim is
  conservative).
- **Matcher does not undercount — CONFIRMED**: 0 false negatives, 100% recall. The only deviation
  is a benign *over*count on static (basename collisions) which, if anything, *inflates* static
  lift — i.e. works against the correlation-trap claim, so it can't be hiding it.
- **Population clean — CONFIRMED**: 74/74 unique sessions, **0 subagent/workflow transcripts**
  (those inherit injected context but aren't real orientation — excluding them is correct, not
  cherry-picking), top session ≤4.6% of opens.
- **"Null-fairness refuted" — itself REFUTED.** A skeptic built a "fairer" null drawing from the
  repo's *already-opened* files and found it lower than the canonical null. Reproduced: that null
  returns **8.69% (above actual, lift 0.79×)** because already-opened files have guaranteed nonzero
  open-probability — it is **upward-biased by construction**. The canonical same-repo-other-session
  null (a plausible set the agent did *not* get for this query) is the fair one. Conclusion stands.
- **"Static-correlation refuted" — metric mismatch, not a contradiction.** That skeptic used a
  session-windowed estimator with a different null and got static 3.68× / retrieval 15.66×. On the
  canonical permutation null, static/retrieval lift ratio is **0.68× ≈ the claimed 0.65×**. Both
  estimators agree on direction: static higher raw rate, lower lift = correlation trap.

## Caveats (load-bearing — travel with every citation)

- **Correlational, not causal.** The permutation null controls for "plausible repo files" but
  *not* for "the agent would have opened the canonical file regardless of injection." The
  **injection-OFF holdback arm** (shipped, default-off) is the rigorous upgrade: it withholds the
  retrieval block on a configurable fraction of turns, tags those turns `holdback`, and
  `sextant telemetry` then reports the **armed − holdback open-precision delta** = the causal lift.
  Until that accumulates, lead with "1.98× over a plausible-file baseline," never "1.98× benefit."
- **Lift point estimate is 1.76×–2.43×** depending on null construction and which large repo is
  included; **1.98×** is the canonical seed/K. It does not drop below ~1.4× under any robustness cut.
- **Coverage is precision-flavored.** A miss includes surfaced files the agent simply didn't need
  that turn. Low absolute coverage = precision headroom, not "retrieval is wrong."
- **Static raw rate: publish 19.3%, not 18.5%** (older-population rounding). Static lift 1.34× is
  estimator-dependent; the cross-estimator invariant is the *ratio* (static ≈ 0.68× of retrieval).
- The live `sextant eval-trajectory` number drifts slightly from this frozen anchor as new sessions
  land (this repo self-dogfoods the hook). The **74-session frozen manifest** is the citable anchor.

## What this unlocks

The 009 ladder's entire eval-invisible orientation family (schema anchors, Makefile commands,
public-API outline, co-change, blast-radius) "moves no scoreboard number by construction." It can
now be measured: ship the signal, watch its per-source coverage in `sextant eval-trajectory`, and —
once the holdback arm is enabled on a dogfooding repo — its causal delta. The benefit-proof brake
is now an accelerator.

## Next steps

1. **Enable the holdback arm on a dogfooding repo** (`SEXTANT_HOLDBACK_PCT=20` in its
   `.claude/settings.json`) to start earning the causal baseline. Decision deferred to Amo (it
   occasionally withholds retrieval mid-session to earn the counterfactual; default-off until then).
2. **Precision work** — the open-rate says retrieval surfaces ~4 files for <1 open. Tightening the
   surfaced set (fewer, higher-confidence files) is the highest-leverage retrieval improvement, and
   now has a metric to optimize against.
3. **`exported_symbol` underperforms `text_only` on opens (4.3% vs 14%)** — worth investigating
   whether export-graph injections surface defs the agent doesn't need, or a ranking issue.
