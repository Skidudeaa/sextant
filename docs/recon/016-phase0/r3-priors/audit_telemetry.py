#!/usr/bin/env python3
"""R3 task 1: volume audit of live telemetry.jsonl across all wired repos."""
import json, glob, os, sys
from collections import defaultdict, Counter

FILES = sorted(glob.glob("/root/*/.planning/intel/telemetry.jsonl")) + \
        ["/root/.planning/intel/telemetry.jsonl", "/root/.claude/.planning/intel/telemetry.jsonl"]

def repo_of(path):
    # /root/<repo>/.planning/intel/telemetry.jsonl
    parts = path.split("/")
    return parts[2] if len(parts) > 2 else path

report = {}
totals_by_name = Counter()
totals_hit_by_source = Counter()
totals_hit_by_arm = Counter()
totals_miss_by_arm = Counter()

for f in FILES:
    if not os.path.exists(f):
        continue
    repo = repo_of(f)
    events = []
    with open(f) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except Exception:
                continue
    if not events:
        continue
    names = Counter(e.get("name") for e in events)
    tss = [e.get("ts") for e in events if e.get("ts")]
    hit_by_source = Counter()
    hit_by_arm = Counter()
    miss_by_arm = Counter()
    for e in events:
        if e.get("name") == "retrieval.path_hit":
            hit_by_source[e.get("source", "?")] += 1
            hit_by_arm[e.get("arm", "?")] += 1
        elif e.get("name") == "retrieval.path_miss":
            miss_by_arm[e.get("arm", "?")] += 1

    for k, v in names.items():
        totals_by_name[k] += v
    for k, v in hit_by_source.items():
        totals_hit_by_source[k] += v
    for k, v in hit_by_arm.items():
        totals_hit_by_arm[k] += v
    for k, v in miss_by_arm.items():
        totals_miss_by_arm[k] += v

    report[repo] = {
        "file": f,
        "total_events": len(events),
        "names": dict(names.most_common()),
        "path_hit_by_source": dict(hit_by_source.most_common()),
        "path_hit_by_arm": dict(hit_by_arm.most_common()),
        "path_miss_by_arm": dict(miss_by_arm.most_common()),
        "first_ts": min(tss) if tss else None,
        "last_ts": max(tss) if tss else None,
    }

print("=== PER-REPO TELEMETRY VOLUME ===")
for repo, r in sorted(report.items(), key=lambda kv: -kv[1]["total_events"]):
    import datetime
    first = datetime.datetime.utcfromtimestamp(r["first_ts"]/1000).isoformat() if r["first_ts"] else "?"
    last = datetime.datetime.utcfromtimestamp(r["last_ts"]/1000).isoformat() if r["last_ts"] else "?"
    print(f"\n-- {repo} ({r['total_events']} events, window {first} .. {last}) --")
    print("  names:", r["names"])
    if r["path_hit_by_source"]:
        print("  path_hit by source:", r["path_hit_by_source"])
    if r["path_hit_by_arm"]:
        print("  path_hit by arm:", r["path_hit_by_arm"])
    if r["path_miss_by_arm"]:
        print("  path_miss by arm:", r["path_miss_by_arm"])

print("\n=== TOTALS ACROSS ALL REPOS ===")
print("event names:", dict(totals_by_name.most_common()))
print("path_hit by source:", dict(totals_hit_by_source.most_common()))
print("path_hit by arm:", dict(totals_hit_by_arm.most_common()))
print("path_miss by arm:", dict(totals_miss_by_arm.most_common()))

with open("/tmp/claude-0/-root-sextant/99a8659d-2d38-447b-a637-0ec57e5a5886/scratchpad/r3/telemetry_report.json", "w") as out:
    json.dump({
        "per_repo": report,
        "totals_by_name": dict(totals_by_name),
        "totals_hit_by_source": dict(totals_hit_by_source),
        "totals_hit_by_arm": dict(totals_hit_by_arm),
        "totals_miss_by_arm": dict(totals_miss_by_arm),
    }, out, indent=2)
