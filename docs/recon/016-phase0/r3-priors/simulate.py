#!/usr/bin/env python3
"""R3 task 3+4+5: Wilson intervals, temporal-split prior computation, and
offline reranking simulation (MRR before/after) on the trajectory corpus.

Reads session_instances.json (produced by extract_instances.js): one row per
session, each with firstTs and a list of instances {source, path, rank,
blockSize, injIdx, opened}.
"""
import json, math
from collections import defaultdict

DATA_PATH = "/tmp/claude-0/-root-sextant/99a8659d-2d38-447b-a637-0ec57e5a5886/scratchpad/r3/session_instances.json"

def wilson(x, n, z=1.96):
    if n == 0:
        return (None, None, None)
    phat = x / n
    denom = 1 + z**2 / n
    center = (phat + z**2 / (2 * n)) / denom
    margin = z * math.sqrt(phat * (1 - phat) / n + z**2 / (4 * n**2)) / denom
    return (phat, max(0, center - margin), min(1, center + margin))

def load():
    sessions = json.load(open(DATA_PATH))
    sessions = [s for s in sessions if s.get("firstTs")]
    sessions.sort(key=lambda s: s["firstTs"])
    return sessions

def source_stats(sessions):
    src = defaultdict(lambda: [0, 0])  # source -> [opened, total]
    for s in sessions:
        for i in s["instances"]:
            src[i["source"]][1] += 1
            if i["opened"]:
                src[i["source"]][0] += 1
    return src

def group_injections(sessions):
    """Return list of injection turns: each is list of instance dicts sharing
    the same (session, injIdx)."""
    turns = []
    for s in sessions:
        by_inj = defaultdict(list)
        for i in s["instances"]:
            by_inj[i["injIdx"]].append(i)
        for injIdx, insts in by_inj.items():
            turns.append(insts)
    return turns

def compute_priors(sessions, clip_lo=0.7, clip_hi=1.3, min_n=30):
    stats = source_stats(sessions)
    rates = {}
    for src, (opened, n) in stats.items():
        rates[src] = (opened / n) if n else None
    eligible = {k: v for k, v in rates.items() if v is not None and stats[k][1] >= min_n}
    if not eligible:
        return {}, stats
    mean_rate = sum(v * stats[k][1] for k, v in eligible.items()) / sum(stats[k][1] for k in eligible)
    priors = {}
    for k in stats:
        n = stats[k][1]
        if n < min_n or mean_rate == 0:
            priors[k] = 1.0  # insufficient data -> neutral multiplier
            continue
        raw_mult = rates[k] / mean_rate
        priors[k] = max(clip_lo, min(clip_hi, raw_mult))
    return priors, stats

def rerank_turn(turn, priors):
    """turn: list of instance dicts with rank/blockSize/source/opened.
    Base score proxy = blockSize - rank + 1 (rank 1 = highest score).
    New score = base * prior_multiplier(source)."""
    block_size = turn[0]["blockSize"]
    scored = []
    for i in turn:
        base = block_size - i["rank"] + 1
        mult = priors.get(i["source"], 1.0)
        scored.append({**i, "base": base, "new_score": base * mult})
    orig_order = sorted(scored, key=lambda x: x["rank"])
    new_order = sorted(scored, key=lambda x: (-x["new_score"], x["rank"]))
    return orig_order, new_order

def mrr_of_first_opened(order):
    for idx, i in enumerate(order):
        if i["opened"]:
            return 1.0 / (idx + 1)
    return 0.0

def simulate(train_sessions, test_sessions, label):
    priors, stats = compute_priors(train_sessions)
    turns = group_injections(test_sessions)
    turns_multi = [t for t in turns if len(t) > 1]
    turns_with_hit = [t for t in turns_multi if any(i["opened"] for i in t)]

    mrr_before = []
    mrr_after = []
    moved_up = 0
    moved_down = 0
    unchanged = 0
    for t in turns_with_hit:
        orig, new = rerank_turn(t, priors)
        mb = mrr_of_first_opened(orig)
        ma = mrr_of_first_opened(new)
        mrr_before.append(mb)
        mrr_after.append(ma)
        if ma > mb:
            moved_up += 1
        elif ma < mb:
            moved_down += 1
        else:
            unchanged += 1

    print(f"\n--- {label} ---")
    print(f"  train sessions: {len(train_sessions)}, test sessions: {len(test_sessions)}")
    print(f"  priors (min_n=30 gate): { {k: round(v,3) for k,v in priors.items()} }")
    print(f"  train per-source stats (opened/total): { {k: tuple(v) for k,v in stats.items()} }")
    print(f"  test turns (multi-file): {len(turns_multi)}, with >=1 opened hit: {len(turns_with_hit)}")
    if mrr_before:
        mb_mean = sum(mrr_before) / len(mrr_before)
        ma_mean = sum(mrr_after) / len(mrr_after)
        print(f"  mean MRR(first opened): before={mb_mean:.4f}  after={ma_mean:.4f}  delta={ma_mean-mb_mean:+.4f}")
        print(f"  turns: moved_up={moved_up}  moved_down={moved_down}  unchanged={unchanged}")
    else:
        print("  no scoreable turns (no multi-file injection with an opened hit)")
    return priors, stats

sessions = load()
n = len(sessions)
mid = n // 2
early, late = sessions[:mid], sessions[mid:]

print(f"Total sessions with retrieval injections + timestamps: {n}")
print(f"Split: early={len(early)} ({early[0]['firstTs'] if early else '?'} .. {early[-1]['firstTs'] if early else '?'})")
print(f"       late={len(late)} ({late[0]['firstTs'] if late else '?'} .. {late[-1]['firstTs'] if late else '?'})")

def iso(ts):
    return ts if ts else "?"
print(f"early window: {iso(early[0]['firstTs'])} .. {iso(early[-1]['firstTs'])}")
print(f"late  window: {iso(late[0]['firstTs'])} .. {iso(late[-1]['firstTs'])}")

# forward split: train on early, evaluate on late (the natural "prior learned from history" case)
priors_fwd, stats_fwd = simulate(early, late, "FORWARD split (train=early, test=late)")

# reverse split: train on late, evaluate on early (flap-check)
priors_rev, stats_rev = simulate(late, early, "REVERSE split (train=late, test=early)")

# stability check: do forward and reverse priors agree in direction/magnitude?
print("\n--- PRIOR STABILITY (forward vs reverse split) ---")
all_src = set(priors_fwd) | set(priors_rev)
for src in sorted(all_src):
    pf = priors_fwd.get(src)
    pr = priors_rev.get(src)
    print(f"  {src:20s} forward={pf}  reverse={pr}  {'FLAP' if pf and pr and abs(pf-pr) > 0.15 else ''}")

# full-corpus Wilson intervals (task 3, restated here from full data for the report)
print("\n--- FULL-CORPUS WILSON 95% INTERVALS ---")
stats_all = source_stats(sessions)
for src, (opened, tot) in sorted(stats_all.items(), key=lambda kv: -kv[1][1]):
    phat, lo, hi = wilson(opened, tot)
    flag = "eligible (n>=30)" if tot >= 30 else "TOO THIN (n<30)"
    print(f"  {src:20s} {opened:4d}/{tot:4d}  rate={phat*100:5.2f}%  CI=[{lo*100:5.2f}%,{hi*100:5.2f}%]  {flag}")

# static baseline for comparison
