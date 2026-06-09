---
title: Benefit proof — sextant measured on real agent behavior (not a fixture proxy)
date: 2026-06-06
updated: 2026-06-09 (suffix matcher v2 — basename false positives removed; corpus 74→110 sessions)
status: verified
method: offline trajectory replay over real Claude Code sessions + 6-agent adversarial reproduction (v1 anchor) + identical-corpus matcher A/B (v2 re-measurement)
companion: docs/ideas/009-yield-synthesis.md, lib/trajectory.js, commands/eval-trajectory.js
---

# Benefit Proof

> The question every sextant metric dodged until now: **does it actually help the agent?**
> MRR / nDCG / graphLiftNDCG are offline fixture proxies — they prove *no-regression* on a
> synthetic corpus, never *benefit* on real behavior. This is the first measurement of sextant
> against what real Claude Code agents actually did.

## TL;DR — the verified benefit statement

> **On 110 real Claude Code sessions across 9 repos (5,628 file-opens), files sextant surfaces for
> a query are opened ~2.5× more often than a matched chance baseline of plausible same-repo surfaced
> sets (5.6% actual vs 2.2% permutation-null = 2.52× lift), and when a surfaced file is opened it
> lands early (median first-touch rank 2). The static summary has a higher raw open-rate (14.6%)
> but a far smaller lift (1.38×) — most of its apparent usefulness is the recent-changes
> correlation trap.**

This number is **correlational, not yet causal** (see Caveats). The injection-OFF holdback arm —
shipped 2026-06-06, enabled at 20% on this repo — is the rigorous causal upgrade; it just needs
sessions to accumulate (as of 2026-06-09: 94 armed scored opens, 0 holdback yet).

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

## The numbers (anchor v2: 110-session corpus @ 2026-06-09, suffix matcher, K=200 perms, seed 12345)

| Signal | Raw open-rate | Permutation-null | **Lift** | opened/surfaced |
|--------|--------------|------------------|----------|-----------------|
| **Query-aware retrieval** | 5.64% | 2.24% | **2.52×** | 110/1951 |
| Static summary | 14.56% | 10.57% | **1.38×** | 1304/8955 |

- **Lift, not raw coverage, is the headline.** Raw coverage alone is uninterpretable (the agent
  opens central files regardless). The permutation null asks: *do the files we surface for a query
  get opened more than random plausible same-repo files would?* Retrieval: **2.5×**. That is the
  signal.
- **The static summary is the correlation trap, quantified.** It *looks* more useful (14.6% raw)
  but its lift is only 1.38× — because its "recent changes" rows list the files already being
  worked on, which the agent opens anyway (10.6% chance base rate). The **static/retrieval lift
  ratio is 0.55×**: query-relevance carries ~1.8× more genuine signal than recency.

### Re-measurement (2026-06-09): the matcher fix made the proof *stronger*

The v1 anchor (2026-06-06: 74 sessions, **1.98×** retrieval / 1.34× static) used basename-fallback
matching, which counted `config/config.js` as an open of a surfaced `lib/config.js`. The 6-agent
verification had flagged this as the matcher's only deviation — "a benign *over*count … which, if
anything, *inflates* static lift — i.e. works against the correlation-trap claim." The suffix
matcher (v2, commit `3ff86b7`) removed it; an A/B on the **identical 110-session corpus** isolates
the matcher effect from corpus growth:

| Matcher (same corpus, same seed/K) | Retrieval | Static |
|-----------------------------------|-----------|--------|
| v1 basename (false positives in) | 6.10% vs 2.73% = 2.24× | 18.53% vs 13.99% = 1.32× |
| v2 suffix (false positives out) | 5.64% vs 2.24% = **2.52×** | 14.56% vs 10.57% = 1.38× |

False matches inflated the *null* more than the *actual* (random plausible sets collide on
basenames more often than genuinely-surfaced sets get truly opened), so removing them raised
retrieval lift — and cut static's raw rate from 18.5% to 14.6%, confirming a chunk of static's
apparent usefulness was literally name collisions. Exactly as the verification predicted.

### Orientation latency — when retrieval hits, it lands early
- First-touch hit-rate: **9.9%** of injections have a surfaced file opened within the next 8 opens.
- **Median first-touch rank: 2** — when the agent opens a surfaced file, it's typically its 2nd
  open after the injection (opened-first 4.5%). Unchanged across matcher versions and corpus growth.
- Reading: retrieval's *hits* steer well; its *precision* is the headroom (surfaces ~4 files, agent
  opens <1 — low coverage = precision opportunity, not "broken").

### Per-source — which surfacing signal earns opens (retrieval)
| Source | Coverage |
|--------|----------|
| `text_only` (live zoekt excerpt) | 9.4% (43/459) |
| `path_match` | 4.7% (60/1268) |
| `exported_symbol` | 3.3% (7/214) |
| `reexport_chain` | 0.0% (n=6, tiny) |
| `swift_decl_other` | 0.0% (n=4, tiny) |

Attribution is preserved per-signal (the 009 #1 correction), so future signal work is measurable
individually rather than collapsing to one aggregate.

### Robustness (re-derived on anchor v2)
- Per-repo retrieval lift is **positive in every multi-session repo**: somaNotes 2.80×, jan25
  2.63×, defGen2 2.37×, open-interpreter-fork 2.14×, sextant 1.98×. (Single-/few-session repos
  dictum/tradingDesk/jan25-CCbeast can't form a real null, correctly.)
- **Not a one-repo artifact**: dropping the largest repo (somaNotes) → 2.37×; dropping the two
  largest (somaNotes + jan25) → 2.20×. The v2 floor across all cuts is **1.98×** — notably
  stronger than v1, whose drop-two cut fell to 1.39×.
- Size-matched null (guards a set-cardinality bias): 2.38× — the lift is not a size artifact.

## How it was verified (6 independent reproductions + adversarial reconciliation)

> Scope note: the 6-agent verification below was run against the **v1 anchor** (74 sessions,
> basename matcher). The v2 re-measurement reuses the verified harness with one change — the
> suffix matcher — whose effect is isolated by the identical-corpus A/B above, and which removes
> the exact deviation the verification itself flagged. The v2 numbers have not had a fresh
> 6-agent pass.

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
  Until that accumulates, lead with "2.52× over a plausible-file baseline," never "2.52× benefit."
- **Lift point estimate is 1.98×–2.80×** across robustness cuts on anchor v2 (per-repo, drop-largest,
  size-matched); **2.52×** is the canonical seed/K. The all-cuts floor is ~2× — it never approaches 1.0×.
- **Coverage is precision-flavored.** A miss includes surfaced files the agent simply didn't need
  that turn. Low absolute coverage = precision headroom, not "retrieval is wrong."
- **Static raw rate: publish 14.6%** (v2 matcher; the v1 19.3% included basename false matches).
  Static lift is estimator-dependent; the cross-estimator invariant is the *direction* — static has
  the higher raw rate but the lower lift (ratio ≈ 0.55× of retrieval on v2; 0.68× on v1).
- The live `sextant eval-trajectory` number drifts slightly from this anchor as new sessions land
  (this repo self-dogfoods the hook). The **110-session corpus @ 2026-06-09** is the citable anchor;
  the v1 74-session anchor (1.98×) is preserved in the re-measurement section for history.

## What this unlocks

The 009 ladder's entire eval-invisible orientation family (schema anchors, Makefile commands,
public-API outline, co-change, blast-radius) "moves no scoreboard number by construction." It can
now be measured: ship the signal, watch its per-source coverage in `sextant eval-trajectory`, and —
once the holdback arm is enabled on a dogfooding repo — its causal delta. The benefit-proof brake
is now an accelerator.

## Next steps

1. ~~Enable the holdback arm on a dogfooding repo~~ **Done** (`SEXTANT_HOLDBACK_PCT=20` on this
   repo since 2026-06-06). Accruing: 94 armed scored opens, 0 holdback as of 2026-06-09; the
   `check-holdback-benefit.sh` cron announces when both arms reach 30.
2. **Precision work** — the open-rate says retrieval surfaces ~4 files for <1 open. Tightening the
   surfaced set (fewer, higher-confidence files) is the highest-leverage retrieval improvement, and
   now has a metric to optimize against.
3. **`exported_symbol` underperforms `text_only` on opens (3.3% vs 9.4%, v2)** — worth investigating
   whether export-graph injections surface defs the agent doesn't need, or a ranking issue. (v1
   reported 4.3% vs 14%; part of that was basename false-matches — the honest gap is ~2.8×.)
