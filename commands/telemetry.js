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

  // T1.3 retrieval-pipeline counters.  classifiedTotal is the denominator for
  // fire-rate; classifiedRetrieve is the denominator for empty-injection rate.
  let classifiedTotal = 0;
  let classifiedRetrieve = 0;
  let injectedTotal = 0;
  const injectedBySource = new Map();
  let emptyFallback = 0;

  // T1.2 retrieval freshness-gate counters.  retrievalStaleHits is the
  // retrieval lane's own stale count (distinct from freshness.stale_hit, which
  // is the static-summary path); the reason breakdown distinguishes the
  // suppressive content reasons (head_changed / status_changed) from the
  // benign version bumps (scanner_version_changed / schema_version_changed).
  let retrievalStaleHits = 0;
  const retrievalStaleByReason = new Map();

  // 009 #1 outcome substrate.  path_hit = the agent opened/edited a file
  // retrieval surfaced (attributed by the signal that surfaced it); path_miss =
  // it opened a file we did NOT surface (after an injection).  openPrecision =
  // hits / (hits + misses).  HONEST FRAMING: this is precision-flavored and
  // baseline-pending — there is no injection-OFF counterfactual yet, so it is a
  // wired-loop signal, not a proven-benefit number.
  let pathHits = 0;
  let pathMisses = 0;
  const pathHitsBySource = new Map();
  // HOLDBACK ARM (009 #1 follow-up): split hits/misses by arm so open-precision
  // gains a counterfactual. armed = the <codebase-retrieval> block was shown;
  // holdback = it was withheld (the agent oriented WITHOUT our injection). The
  // armed−holdback open-precision DELTA is the actual benefit number — until
  // holdback events exist, openPrecision stays correlational (baseline pending).
  const pathHitsByArm = new Map();
  const pathMissesByArm = new Map();

  // Blast-radius lane (docs/016 Sprint 1): action-time injections after an
  // edit.  Counts emissions and the surfaced-path volume split by signal so a
  // future open-attribution pass has its denominator shape ready.
  let brInjected = 0;
  let brDependents = 0;
  let brCochange = 0;

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

    if (name === "retrieval.classified") {
      classifiedTotal++;
      if (e.retrieve === true) classifiedRetrieve++;
    }

    if (name === "retrieval.injected") {
      injectedTotal++;
      const source = e.source || "(unknown)";
      injectedBySource.set(source, (injectedBySource.get(source) || 0) + 1);
    }

    if (name === "retrieval.empty_fallback") {
      emptyFallback++;
    }

    if (name === "retrieval.stale_hit") {
      retrievalStaleHits++;
      const reason = e.reason || "(unknown)";
      retrievalStaleByReason.set(reason, (retrievalStaleByReason.get(reason) || 0) + 1);
    }

    if (name === "retrieval.path_hit") {
      pathHits++;
      const source = e.source || "(unknown)";
      pathHitsBySource.set(source, (pathHitsBySource.get(source) || 0) + 1);
      const arm = e.arm || "armed"; // legacy events w/o arm were effectively armed
      pathHitsByArm.set(arm, (pathHitsByArm.get(arm) || 0) + 1);
    }

    if (name === "retrieval.path_miss") {
      pathMisses++;
      const arm = e.arm || "armed";
      pathMissesByArm.set(arm, (pathMissesByArm.get(arm) || 0) + 1);
    }

    if (name === "blastradius.injected") {
      brInjected++;
      brDependents += typeof e.dependents === "number" ? e.dependents : 0;
      brCochange += typeof e.cochange === "number" ? e.cochange : 0;
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
    // T1.3 retrieval pipeline: the denominator that lets later retrieval
    // changes prove they worked.  fireRate = classified-as-retrieve / total
    // classified prompts; emptyInjectionRate = empty-fallbacks / classified-
    // as-retrieve (a rising rate flags an NL-recall regression like A4);
    // injectedBySource = graph_merged vs text_only provenance breakdown.
    retrieval: {
      classifiedTotal,
      classifiedRetrieve,
      fireRate: classifiedTotal ? classifiedRetrieve / classifiedTotal : null,
      injected: injectedTotal,
      emptyFallback,
      emptyInjectionRate: classifiedRetrieve ? emptyFallback / classifiedRetrieve : null,
      injectedBySource: Object.fromEntries(injectedBySource),
      // T1.2 freshness gate on the retrieval lane: staleHits is the count of
      // retrieve-classified turns where the gate fired; staleRate normalizes it
      // against retrieve-classified prompts (a rising rate flags churn the
      // watcher isn't keeping up with); staleReasons splits content reasons
      // (head_changed / status_changed → structure suppressed) from version
      // bumps (scanner/schema_version_changed → rescan only, output unchanged).
      staleHits: retrievalStaleHits,
      staleRate: classifiedRetrieve ? retrievalStaleHits / classifiedRetrieve : null,
      staleReasons: Object.fromEntries(retrievalStaleByReason),
      // 009 #1 outcome substrate: did the agent open/edit what we surfaced?
      // openPrecision is precision-flavored + baseline-pending UNLESS holdback
      // events exist — then openPrecisionByArm + benefitDelta make it causal.
      pathHits,
      pathMisses,
      openPrecision: pathHits + pathMisses ? pathHits / (pathHits + pathMisses) : null,
      pathHitsBySource: Object.fromEntries(pathHitsBySource),
      // HOLDBACK ARM split. benefitDelta = armed openPrecision − holdback
      // openPrecision: the causal lift the injection buys. null until BOTH arms
      // have data (a holdback-disabled install only ever has the armed arm).
      openPrecisionByArm: armPrecision(pathHitsByArm, pathMissesByArm),
      benefitDelta: benefitDelta(pathHitsByArm, pathMissesByArm),
      // Raw per-arm scored-open counts so a consumer (e.g. the holdback-benefit
      // cron) can gate on VOLUME, not just read a rate that's unstable at low n.
      armCounts: armCounts(pathHitsByArm, pathMissesByArm),
    },
    // Blast-radius lane (docs/016 Sprint 1): post-edit additionalContext
    // injections.  dependentsSurfaced/cochangeSurfaced are path VOLUMES (how
    // many files the notes named), the future denominator for open-attribution.
    blastradius: {
      injected: brInjected,
      dependentsSurfaced: brDependents,
      cochangeSurfaced: brCochange,
    },
  };
}

// Arm names in deterministic (sorted) order regardless of which arm's events
// appear first in the log — keeps the --json key order stable across windows.
function armNames(hitsByArm, missesByArm) {
  return [...new Set([...hitsByArm.keys(), ...missesByArm.keys()])].sort();
}

// Per-arm scored-open counts: { armed: {hits, misses, scored}, holdback: {...} }.
function armCounts(hitsByArm, missesByArm) {
  const out = {};
  for (const arm of armNames(hitsByArm, missesByArm)) {
    const hits = hitsByArm.get(arm) || 0;
    const misses = missesByArm.get(arm) || 0;
    out[arm] = { hits, misses, scored: hits + misses };
  }
  return out;
}

// openPrecision per arm: { armed: 0.x|null, holdback: 0.x|null }.
function armPrecision(hitsByArm, missesByArm) {
  const out = {};
  for (const arm of armNames(hitsByArm, missesByArm)) {
    const h = hitsByArm.get(arm) || 0;
    const m = missesByArm.get(arm) || 0;
    out[arm] = h + m ? h / (h + m) : null;
  }
  return out;
}

// The benefit number: armed − holdback open-precision. null unless both arms
// have a defined precision (needs holdback turns, i.e. SEXTANT_HOLDBACK_PCT > 0).
function benefitDelta(hitsByArm, missesByArm) {
  const p = armPrecision(hitsByArm, missesByArm);
  if (typeof p.armed === "number" && typeof p.holdback === "number") {
    return +(p.armed - p.holdback).toFixed(4);
  }
  return null;
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
  lines.push("Retrieval pipeline");
  const r = sum.retrieval;
  if (r.classifiedTotal === 0) {
    lines.push(`  No retrieval.classified events recorded yet.`);
  } else {
    lines.push(
      `  classified:     ${r.classifiedTotal}  (${r.classifiedRetrieve} retrieve, fire-rate ${fmtPct(r.classifiedRetrieve, r.classifiedTotal)})`
    );
    lines.push(
      `  injected:       ${r.injected}`
    );
    lines.push(
      `  empty_fallback: ${r.emptyFallback}  (${fmtPct(r.emptyFallback, r.classifiedRetrieve)} of retrieve-classified)`
    );
    lines.push(
      `  stale_hit:      ${r.staleHits}  (${fmtPct(r.staleHits, r.classifiedRetrieve)} of retrieve-classified)`
    );
    if (Object.keys(r.staleReasons).length) {
      lines.push("  stale reasons (retrieval):");
      for (const [reason, c] of Object.entries(r.staleReasons).sort((a, b) => b[1] - a[1])) {
        lines.push(`    - ${reason.padEnd(28)} ${c}  (${fmtPct(c, r.staleHits)})`);
      }
    }
    if (Object.keys(r.injectedBySource).length) {
      lines.push("  injected source:");
      for (const [src, c] of Object.entries(r.injectedBySource).sort((a, b) => b[1] - a[1])) {
        lines.push(`    - ${src.padEnd(28)} ${c}  (${fmtPct(c, r.injected)})`);
      }
    }
  }

  // Blast-radius lane (docs/016): shown only once emissions exist, so a
  // pre-lane install's output is unchanged.
  if (sum.blastradius && sum.blastradius.injected > 0) {
    lines.push("");
    lines.push("Blast radius (post-edit injections)");
    const b = sum.blastradius;
    lines.push(`  injected:       ${b.injected}`);
    lines.push(
      `  surfaced paths: ${b.dependentsSurfaced} dependents, ${b.cochangeSurfaced} co-change partners`
    );
  }

  // 009 #1 outcome substrate — did the agent open what we surfaced?
  // WHY outside the classifiedTotal branch (VH-1): path_hit/path_miss out-volume
  // classified events, so a rotation can push the lone classified event into
  // .old and leave a current window that is all path events. Gating this on
  // classifiedTotal hid open-precision from the default audit EXACTLY when volume
  // was high. Render it whenever there are scored opens, independent of classified.
  if (r.pathHits + r.pathMisses > 0) {
    // WHY the full caveat (VH-2): "open-precision: 7%" invites a "retrieval is
    // 93% wrong" misread. It is NOT that — misses include opens of files we never
    // surfaced (precision-flavored, not coverage), AND there is no injection-OFF
    // counterfactual yet. Both halves must travel to the surface that's read.
    lines.push("");
    lines.push("Outcome substrate (did the agent open what we surfaced?)");
    lines.push(
      `  open-precision: ${fmtPct(r.pathHits, r.pathHits + r.pathMisses)}  ` +
      `(${r.pathHits} hit / ${r.pathHits + r.pathMisses} scored opens)`
    );
    // The "baseline pending" half of the caveat is only honest UNTIL a holdback
    // arm provides the counterfactual; once benefitDelta exists, drop it and keep
    // only the precision-flavored half (still load-bearing — VH-2).
    if (r.benefitDelta == null) {
      lines.push(
        `  caveat: baseline pending (no injection-OFF arm yet) AND precision-flavored — ` +
        `misses include opens of files we never surfaced, NOT coverage; a low % is not "retrieval is wrong."`
      );
    } else {
      lines.push(
        `  caveat: precision-flavored — misses include opens of files we never surfaced, ` +
        `NOT coverage; a low % is not "retrieval is wrong." (counterfactual present → see BENEFIT DELTA)`
      );
    }
    if (Object.keys(r.pathHitsBySource).length) {
      lines.push("  path_hit by source:");
      for (const [src, c] of Object.entries(r.pathHitsBySource).sort((a, b) => b[1] - a[1])) {
        lines.push(`    - ${src.padEnd(28)} ${c}  (${fmtPct(c, r.pathHits)})`);
      }
    }
    // HOLDBACK ARM split (009 #1 follow-up): only meaningful once a holdback arm
    // has run (SEXTANT_HOLDBACK_PCT > 0). The armed−holdback delta is the causal
    // benefit number; until then only the armed arm has data and benefitDelta is null.
    const arms = r.openPrecisionByArm || {};
    const armKeys = Object.keys(arms);
    if (armKeys.length > 1 || (armKeys.length === 1 && armKeys[0] !== "armed")) {
      lines.push("  by arm (injection-OFF holdback):");
      for (const arm of ["armed", "holdback"]) {
        if (arms[arm] == null && !(arm in arms)) continue;
        lines.push(`    - ${arm.padEnd(10)} open-precision ${arms[arm] == null ? "n/a" : (arms[arm] * 100).toFixed(1) + "%"}`);
      }
      if (r.benefitDelta != null) {
        lines.push(
          `  BENEFIT DELTA (armed − holdback): ${(r.benefitDelta * 100).toFixed(1)} pts` +
          ` — the causal open-rate lift the injection buys (counterfactual present).`
        );
      }
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

module.exports = { run, summarize, percentile, printSummary };
