"use strict";

// `sextant telemetry` -- audit surface for the freshness gate dataset.
//
// Reads .planning/intel/telemetry.jsonl (and optionally .old) and prints
// the aggregates that matter for the future Option-5 adaptive sync/async
// decision: stale rate, stale-reason breakdown, scan duration percentiles
// split by trigger, async-rescan success rate.
//
// Without this surface, the dataset exists but nobody looks at it -- and
// "telemetry-driven later" stays hand-waving.  The default invocation is
// a one-shot summary; --json emits the same data machine-readable, --tail
// dumps the last N raw events for ad-hoc inspection.

const fs = require("fs");
const path = require("path");

const { hasFlag, flag } = require("../lib/cli");
const telemetry = require("../lib/telemetry");

function readAllEvents(rootAbs, includeOld) {
  const events = [];
  // .old first so chronological order is preserved when concatenated.
  if (includeOld) {
    const oldPath = telemetry.telemetryOldPath(rootAbs);
    if (fs.existsSync(oldPath)) {
      const raw = fs.readFileSync(oldPath, "utf8");
      for (const line of raw.split("\n")) {
        if (!line) continue;
        try { events.push(JSON.parse(line)); } catch {}
      }
    }
  }
  for (const e of telemetry.readEvents(rootAbs)) events.push(e);
  return events;
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  // Linear interpolation between adjacent ranks.  We don't need fancy
  // estimators here -- the sample is small and the audit is human-read.
  const rank = (sortedAsc.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  const frac = rank - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

function fmtMs(v) {
  if (v == null) return "n/a";
  if (v < 1000) return `${Math.round(v)}ms`;
  return `${(v / 1000).toFixed(2)}s`;
}

function fmtPct(num, denom) {
  if (!denom) return "n/a";
  return `${((num / denom) * 100).toFixed(1)}%`;
}

function summarize(events) {
  const byName = new Map();
  const staleByReason = new Map();
  const scansAll = [];
  const scansByTrigger = new Map();
  let scanSuccessCount = 0;
  let scanFailureCount = 0;
  let firstTs = null;
  let lastTs = null;

  for (const e of events) {
    const name = e.name || "(unknown)";
    byName.set(name, (byName.get(name) || 0) + 1);

    if (typeof e.ts === "number") {
      if (firstTs == null || e.ts < firstTs) firstTs = e.ts;
      if (lastTs == null || e.ts > lastTs) lastTs = e.ts;
    }

    if (name === "freshness.stale_hit" && e.reason) {
      staleByReason.set(e.reason, (staleByReason.get(e.reason) || 0) + 1);
    }

    if (name === "scan.completed" && typeof e.durationMs === "number") {
      scansAll.push(e.durationMs);
      const trigger = e.trigger || "(unknown)";
      if (!scansByTrigger.has(trigger)) scansByTrigger.set(trigger, []);
      scansByTrigger.get(trigger).push(e.durationMs);
      if (e.success) scanSuccessCount++;
      else scanFailureCount++;
    }
  }

  const freshHits = byName.get("freshness.fresh_hit") || 0;
  const staleHits = byName.get("freshness.stale_hit") || 0;
  const blackoutTurns = byName.get("freshness.blackout_turn") || 0;
  const totalReads = freshHits + staleHits;

  const scanStats = (durations) => {
    if (durations.length === 0) return null;
    const sorted = [...durations].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
      count: sorted.length,
      mean: sum / sorted.length,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: sorted[sorted.length - 1],
    };
  };

  return {
    eventCount: events.length,
    firstTs,
    lastTs,
    spanMs: firstTs != null && lastTs != null ? lastTs - firstTs : null,
    byName: Object.fromEntries(byName),
    freshness: {
      freshHits,
      staleHits,
      blackoutTurns,
      totalReads,
      staleRate: totalReads ? staleHits / totalReads : null,
      blackoutRate: totalReads ? blackoutTurns / totalReads : null,
      reasons: Object.fromEntries(staleByReason),
    },
    scans: {
      total: scansAll.length,
      successes: scanSuccessCount,
      failures: scanFailureCount,
      successRate: scansAll.length ? scanSuccessCount / scansAll.length : null,
      duration: scanStats(scansAll),
      byTrigger: Object.fromEntries(
        Array.from(scansByTrigger.entries()).map(([k, v]) => [k, scanStats(v)])
      ),
    },
  };
}

function printSummary(rootAbs, sum) {
  const lines = [];
  lines.push(`sextant telemetry — ${rootAbs}`);
  lines.push("─".repeat(60));
  if (sum.firstTs && sum.lastTs) {
    const span = sum.spanMs;
    const days = (span / (1000 * 60 * 60 * 24)).toFixed(1);
    lines.push(
      `  Window: ${new Date(sum.firstTs).toISOString()} → ${new Date(sum.lastTs).toISOString()}  (${days} days, ${sum.eventCount} events)`
    );
  } else {
    lines.push(`  No events recorded.`);
    return lines.join("\n");
  }

  lines.push("");
  lines.push("Freshness gate");
  const f = sum.freshness;
  lines.push(`  fresh_hit:      ${f.freshHits}`);
  lines.push(`  stale_hit:      ${f.staleHits}  (${fmtPct(f.staleHits, f.totalReads)} of ${f.totalReads} reads)`);
  lines.push(`  blackout_turn:  ${f.blackoutTurns}  (${fmtPct(f.blackoutTurns, f.totalReads)} of reads)`);
  if (Object.keys(f.reasons).length) {
    lines.push("  reasons (stale_hit):");
    for (const [r, c] of Object.entries(f.reasons).sort((a, b) => b[1] - a[1])) {
      lines.push(`    - ${r.padEnd(28)} ${c}  (${fmtPct(c, f.staleHits)})`);
    }
  }

  lines.push("");
  lines.push("Scans");
  const s = sum.scans;
  if (s.total === 0) {
    lines.push(`  No scan.completed events recorded yet.`);
  } else {
    lines.push(`  total: ${s.total}  (${s.successes} success, ${s.failures} failure, ${fmtPct(s.successes, s.total)} success rate)`);
    if (s.duration) {
      const d = s.duration;
      lines.push(`  duration: mean ${fmtMs(d.mean)}, p50 ${fmtMs(d.p50)}, p95 ${fmtMs(d.p95)}, p99 ${fmtMs(d.p99)}, max ${fmtMs(d.max)}`);
    }
    for (const [trigger, stats] of Object.entries(s.byTrigger)) {
      if (!stats) continue;
      lines.push(
        `  by trigger=${trigger}: n=${stats.count}, p50=${fmtMs(stats.p50)}, p95=${fmtMs(stats.p95)}, p99=${fmtMs(stats.p99)}`
      );
    }
  }

  lines.push("");
  lines.push("All event types");
  for (const [name, count] of Object.entries(sum.byName).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${name.padEnd(32)} ${count}`);
  }

  return lines.join("\n");
}

async function run(ctx) {
  const root = ctx.roots[0];
  const wantJson = hasFlag(process.argv, "--json");
  const includeOld = hasFlag(process.argv, "--include-old");
  const tailN = flag(process.argv, "--tail");

  if (tailN) {
    // Raw-event mode: print the last N events as JSON lines, no aggregation.
    // Useful for `jq` post-processing or eyeballing recent activity.
    const n = Math.max(1, parseInt(tailN, 10) || 50);
    const events = readAllEvents(root, includeOld);
    const slice = events.slice(-n);
    for (const e of slice) process.stdout.write(JSON.stringify(e) + "\n");
    return;
  }

  const events = readAllEvents(root, includeOld);
  const summary = summarize(events);

  if (wantJson) {
    process.stdout.write(JSON.stringify({ root, ...summary }, null, 2) + "\n");
    return;
  }

  process.stdout.write(printSummary(root, summary) + "\n");
}

module.exports = { run, summarize, percentile };
