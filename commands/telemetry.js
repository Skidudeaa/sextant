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

// Minimum scored opens PER ARM before the human-readable summary renders
// benefitDelta as a causal claim. Mirrors check-holdback-benefit.sh's
// SEXTANT_HOLDBACK_MIN default and `sextant tune`'s n>=30 prior-eligibility
// floor. Below this the summary prints a DORMANT line with the raw counts.
const HOLDBACK_MIN_SCORED = 30;

// Minimum scored TURNS per arm before the turn-level benefit delta renders as a
// citable claim (docs/033 Tier 1 #3). The turn is the unit the holdback arm
// actually randomizes at (decideArm runs once per injection), so it is the unit
// the delta must be computed and gated at. HOLDBACK_MIN_SCORED gates the older
// per-OPEN delta, whose samples are ~10x correlated within a turn and therefore
// overstate the effective n.
const HOLDBACK_MIN_TURNS = 30;

// Phase-F decision floors. These are intentionally conservative operational
// gates, not proof of behavioral benefit. The scorecard cannot graduate while
// factual review is thin or a confirmed false fact exists.
const COHERENCE_THRESHOLDS = Object.freeze({
  minDays: 7,
  minMultiAgentTasks: 30,
  minSpawnAttempts: 100,
  minReturnAttempts: 100,
  minEligibleIncidents: 50,
  minReviewedFindings: 50,
  minLifecycleWilsonLower: 0.95,
  minBoundaryResolutionRate: 0.95,
  minIncidentResolutionRate: 0.95,
  minFindingResolutionRate: 0.90,
  maxP95Ms: 100,
  maxP99Ms: 250,
  minPeerAnalysesForHeadroom: 100,
  minFindingIncidence: 0.05,
});

const COHERENCE_FEEDBACK_VERDICTS = new Set([
  "accurate_useful",
  "accurate_noise",
  "false_fact",
  "unclear",
]);
const COHERENCE_ADJUDICATED_VERDICTS = new Set([
  "accurate_useful",
  "accurate_noise",
  "false_fact",
]);

function readAllEvents(rootAbs, includeOld) {
  const events = [];
  // .old first so chronological order is preserved when concatenated.
  if (includeOld) {
    const oldPath = telemetry.telemetryOldPath(rootAbs);
    try {
      const raw = fs.readFileSync(oldPath, "utf8");
      for (const line of raw.split("\n")) {
        if (!line) continue;
        try { events.push(JSON.parse(line)); } catch {}
      }
    } catch {}
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

// Render the armed-vs-holdback contrast at the TURN level (docs/033 Tier 1 #3).
// Same gating discipline as the per-open delta — the raw value always lives in
// --json; only the human-readable causal CLAIM waits for volume — but the floor
// counts TURNS, the unit decideArm actually randomizes at.
function renderTurnArms(lines, r) {
  const counts = r.turnCountsByArm || {};
  const armedTurns = (counts.armed || {}).turns || 0;
  const holdbackTurns = (counts.holdback || {}).turns || 0;
  // A holdback-DISABLED install has nothing to contrast — stay silent. But an
  // install whose holdback arm HAS run and simply has no turn-stamped holdback
  // turns yet must render a zero state (docs/033 Tier 3). Returning here left
  // the live repo showing only the per-OPEN accrual line ("holdback n=17 ...
  // need >=30"), which reads as "over half way" while the canonical unit sat at
  // 0 of 30 — ~20x further out at ~28 opens/turn. Suppressing the correct-unit
  // line while printing the wrong-unit one is the failure mode docs/033 exists
  // to kill.
  const armExists =
    holdbackTurns > 0 || ((r.armCounts || {}).holdback || {}).scored > 0;
  if (!armExists) return;
  const rates = r.turnHitRateByArm || {};
  lines.push("  by arm (injection-OFF holdback), at the randomization unit:");
  for (const arm of ["armed", "holdback"]) {
    // Render a zero row rather than skipping: "holdback 0/0 turns" is the
    // honest accrual state, and it is exactly the row a reader needs to see.
    const c = counts[arm] || { hitTurns: 0, turns: 0 };
    const rate = rates[arm] == null ? "n/a" : `${(rates[arm] * 100).toFixed(1)}%`;
    lines.push(`    - ${arm.padEnd(10)} turn hit-rate ${rate}  (${c.hitTurns}/${c.turns} turns)`);
  }
  const atVolume =
    r.turnBenefitDelta != null &&
    armedTurns >= HOLDBACK_MIN_TURNS &&
    holdbackTurns >= HOLDBACK_MIN_TURNS;
  if (atVolume) {
    lines.push(
      `  TURN BENEFIT DELTA (armed − holdback): ${(r.turnBenefitDelta * 100).toFixed(1)} pts` +
      `  — the causal lift, measured per turn`
    );
  } else {
    lines.push(
      `  turn benefit delta: DORMANT (accruing) — holdback ${holdbackTurns} turns, ` +
      `armed ${armedTurns} turns; need >=${HOLDBACK_MIN_TURNS} per arm before the delta is citable.`
    );
  }
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
  let retrievalDeduped = 0;

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

  // TURN-LEVEL OUTCOME (docs/033 Tier 1 #1). openPrecision divides by every file
  // touched after an injection — an unbounded denominator driven by session
  // shape, not retrieval quality (it fell 34.4% -> 1.6% while opens/turn rose
  // 3.4 -> 28.4; see docs/033 §1). The turn-level rate asks the bounded question
  // instead: of the turns where we surfaced something, in how many did the agent
  // open at least one surfaced file?
  //
  // Keyed by the injected-set `ts` the PostToolUse hook stamps as `turn`. Events
  // predating that stamp carry no turn and are counted as turnUnscored — never
  // folded into a bucket, so the covered fraction stays visible.
  const turns = new Map(); // turn -> { arm, opens, hits, firstHitRank }
  let turnUnscoredOpens = 0;
  const noteTurn = (e, isHit) => {
    const turn = e.turn;
    if (!Number.isFinite(turn)) {
      turnUnscoredOpens++;
      return;
    }
    let t = turns.get(turn);
    if (!t) {
      t = { arm: e.arm || "armed", opens: 0, hits: 0, firstHitRank: null };
      turns.set(turn, t);
    }
    t.opens++;
    if (isHit) {
      t.hits++;
      // Rank = position of this open among the turn's scored opens, in append
      // order. Reconstructed here so the hook needs no per-turn counter state.
      if (t.firstHitRank == null) t.firstHitRank = t.opens;
    }
  };

  // REGION LANE (docs/025 Phase A): sharper than path_hit — on a mutation of a
  // surfaced file, did the edit land in the REGION we pointed at (region_hit) or
  // a DIFFERENT region of the right file (region_miss = reclaimable within-file
  // navigation, the Phase-A headroom signal)?  region-precision = hits/(hits+
  // misses); the miss rate and the armed−holdback gap are what the kill
  // criterion reads.  In-process langs only live; python/swift score offline in
  // eval-trajectory.
  let regionHits = 0;
  let regionMisses = 0;
  const regionHitsBySource = new Map();
  const regionHitsByArm = new Map();
  const regionMissesByArm = new Map();

  // CLAIM LEDGER (docs/028 Phase C): claims served + context-deltas emitted
  // (a delta RETRACTS a fact that moved/vanished since we served it).
  let claimsServed = 0;
  let contextDeltas = 0;
  let deltaChanged = 0;
  let deltaInvalidated = 0;
  // STRUCTURAL DELTA (docs/029 Phase D): edits that changed observable structure.
  let structuralDeltas = 0;
  // ANTI-SPRAWL (docs/030 Phase E): new-file nudges surfacing existing matches.
  let sprawlNudges = 0;
  // MULTI-AGENT COHERENCE (docs/031 Phase F): immutable parent-delivered and
  // child-prepared boundary records plus
  // bounded reports delivered at parent prompt/spawn/tool-return boundaries.
  let coherenceAgentsRegistered = 0;
  let coherenceAgentReturns = 0;
  let coherenceReportsEligible = 0;
  let coherenceReportsDelivered = 0;
  let coherenceOverlapPairs = 0;
  let coherenceChanged = 0;
  let coherenceInvalidated = 0;
  let coherenceSkipped = 0;
  const coherenceSkippedByReason = new Map();

  // Blast-radius lane (docs/016 Sprint 1): action-time injections after an
  // edit.  Counts emissions and the surfaced-path volume split by signal.
  let brInjected = 0;
  let brDependents = 0;
  let brCochange = 0;
  // Blast-radius open-attribution (docs/017 lever #1): did the agent go look
  // at a file a note named?  Session-cumulative and precision-flavored (see
  // hook-posttooluse lane 1b); no arm split — the lane has no holdback.
  let brPathHits = 0;
  let brPathMisses = 0;
  let brRollupNotes = 0;
  const brHitsBySource = new Map();

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

    // A turn that retrieved the same thing as the previous turn: the block was
    // suppressed as a duplicate, so it is NOT an injection, but it is still an
    // armed turn. Counting it keeps the funnel closed — without it, armed turns
    // silently left the denominator while holdback turns never could.
    if (name === "retrieval.deduped") {
      retrievalDeduped++;
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
      noteTurn(e, true);
    }

    if (name === "retrieval.path_miss") {
      pathMisses++;
      const arm = e.arm || "armed";
      pathMissesByArm.set(arm, (pathMissesByArm.get(arm) || 0) + 1);
      noteTurn(e, false);
    }

    if (name === "retrieval.region_hit") {
      regionHits++;
      const source = e.source || "(unknown)";
      regionHitsBySource.set(source, (regionHitsBySource.get(source) || 0) + 1);
      const arm = e.arm || "armed";
      regionHitsByArm.set(arm, (regionHitsByArm.get(arm) || 0) + 1);
    }

    if (name === "retrieval.region_miss") {
      regionMisses++;
      const arm = e.arm || "armed";
      regionMissesByArm.set(arm, (regionMissesByArm.get(arm) || 0) + 1);
    }

    if (name === "claim.served") {
      claimsServed += typeof e.n === "number" ? e.n : 0;
    }
    if (name === "contextdelta.emitted") {
      contextDeltas++;
      deltaChanged += typeof e.changed === "number" ? e.changed : 0;
      deltaInvalidated += typeof e.invalidated === "number" ? e.invalidated : 0;
    }
    if (name === "structure.delta") structuralDeltas++;
    if (name === "sprawl.nudge") sprawlNudges++;
    if (name === "coherence.agent_registered") coherenceAgentsRegistered++;
    if (name === "coherence.agent_returned") coherenceAgentReturns++;
    if (name === "coherence.report_eligible") coherenceReportsEligible++;
    if (name === "coherence.delta_delivered") {
      coherenceReportsDelivered++;
      coherenceOverlapPairs += typeof e.overlaps === "number" ? e.overlaps : 0;
      coherenceChanged += typeof e.changed === "number" ? e.changed : 0;
      coherenceInvalidated += typeof e.invalidated === "number" ? e.invalidated : 0;
    }
    if (name === "coherence.skipped") {
      coherenceSkipped++;
      const reason = e.reason || "(unknown)";
      coherenceSkippedByReason.set(reason, (coherenceSkippedByReason.get(reason) || 0) + 1);
    }

    if (name === "blastradius.injected") {
      brInjected++;
      brDependents += typeof e.dependents === "number" ? e.dependents : 0;
      brCochange += typeof e.cochange === "number" ? e.cochange : 0;
      if (e.rollup === true) brRollupNotes++; // docs/021 form b: dir-rollup tail
    }

    if (name === "blastradius.path_hit") {
      brPathHits++;
      const source = e.source || "(unknown)";
      brHitsBySource.set(source, (brHitsBySource.get(source) || 0) + 1);
    }

    if (name === "blastradius.path_miss") {
      brPathMisses++;
    }
  }

  const freshHits = byName.get("freshness.fresh_hit") || 0;
  const staleHits = byName.get("freshness.stale_hit") || 0;
  const blackoutTurns = byName.get("freshness.blackout_turn") || 0;
  const totalReads = freshHits + staleHits;
  // Option-5 sync-rescan arm.  A RESCUE is a stale read that got a fresh body
  // instead of a blackout — counted from stale_hit{rescanState:"sync"}, which
  // only records after the post-scan recheck passed (an ok sync_rescan whose
  // recheck stayed stale is an attempt, not a rescue).
  let syncAttempts = 0;
  let syncRescues = 0;
  for (const e of events) {
    if (e.name === "freshness.sync_rescan") syncAttempts += 1;
    else if (e.name === "freshness.stale_hit" && e.rescanState === "sync") syncRescues += 1;
  }

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
      syncAttempts,
      syncRescues,
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
      deduped: retrievalDeduped,
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
      // TURN-LEVEL (docs/033 Tier 1): the session-shape-independent read of the
      // same substrate. Lead with this; openPrecision above is the secondary,
      // session-shape-SENSITIVE view kept for continuity with prior reports.
      ...summarizeTurns(turns),
      turnUnscoredOpens,
      // HOLDBACK ARM split. benefitDelta = armed openPrecision − holdback
      // openPrecision: the causal lift the injection buys. null until BOTH arms
      // have data (a holdback-disabled install only ever has the armed arm).
      openPrecisionByArm: armPrecision(pathHitsByArm, pathMissesByArm),
      benefitDelta: benefitDelta(pathHitsByArm, pathMissesByArm),
      // Raw per-arm scored-open counts so a consumer (e.g. the holdback-benefit
      // cron) can gate on VOLUME, not just read a rate that's unstable at low n.
      armCounts: armCounts(pathHitsByArm, pathMissesByArm),
      // REGION LANE (docs/025 Phase A): region-level open attribution. regionMiss
      // = right file, wrong region — the reclaimable-navigation headroom the
      // Phase-A kill criterion reads. regionPrecision null until an edit of a
      // surfaced in-process-language file is scored.
      regionHits,
      regionMisses,
      regionPrecision: regionHits + regionMisses ? regionHits / (regionHits + regionMisses) : null,
      regionHitsBySource: Object.fromEntries(regionHitsBySource),
      regionPrecisionByArm: armPrecision(regionHitsByArm, regionMissesByArm),
      regionBenefitDelta: benefitDelta(regionHitsByArm, regionMissesByArm),
      regionArmCounts: armCounts(regionHitsByArm, regionMissesByArm),
    },
    // Blast-radius lane (docs/016 Sprint 1): post-edit additionalContext
    // injections.  dependentsSurfaced/cochangeSurfaced are path VOLUMES (how
    // many files the notes named) — the open-attribution denominator.
    // pathHits/pathMisses (docs/017 lever #1) mirror the retrieval outcome
    // substrate: openPrecision = hits / scored file-touches after >=1 note
    // this session.  Precision-flavored + correlational (no holdback arm on
    // this lane); per-source split answers WHICH signal earns its opens
    // (dependent vs cochange).
    blastradius: {
      injected: brInjected,
      dependentsSurfaced: brDependents,
      cochangeSurfaced: brCochange,
      rollupNotes: brRollupNotes,
      pathHits: brPathHits,
      pathMisses: brPathMisses,
      openPrecision: brPathHits + brPathMisses ? brPathHits / (brPathHits + brPathMisses) : null,
      pathHitsBySource: Object.fromEntries(brHitsBySource),
    },
    // CLAIM LEDGER (docs/028 Phase C): claims served + context-deltas that
    // retracted stale facts mid-session (cache coherence for agent context).
    claimLedger: {
      claimsServed,
      contextDeltas,
      deltaChanged,
      deltaInvalidated,
      structuralDeltas,
      sprawlNudges,
    },
    multiAgentCoherence: {
      agentsRegistered: coherenceAgentsRegistered,
      agentReturns: coherenceAgentReturns,
      reportsEligible: coherenceReportsEligible,
      reportsDelivered: coherenceReportsDelivered,
      overlapPairsDelivered: coherenceOverlapPairs,
      claimsChangedDelivered: coherenceChanged,
      claimsInvalidatedDelivered: coherenceInvalidated,
      skipped: coherenceSkipped,
      skippedByReason: Object.fromEntries(coherenceSkippedByReason),
      scorecard: coherenceScorecard(events),
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

// TURN-LEVEL OUTCOME SUMMARY (docs/033 Tier 1 #1 and #3).
//
// turnHitRate = turns with >=1 surfaced-file open / turns scored. Bounded in
// [0,1] and independent of how many files the agent touched per turn, so it is
// comparable week over week in a way openPrecision is not.
//
// medianFirstTouchRank = median position of the first hit among a turn's scored
// opens (hit turns only). Low rank = we surfaced it before the agent wandered.
//
// turnBenefitDelta = armed turnHitRate − holdback turnHitRate. This is the
// armed-vs-holdback contrast computed at the unit the arm is RANDOMIZED at; the
// per-open delta treats ~10x correlated within-turn opens as independent.
function summarizeTurns(turns) {
  const byArm = new Map(); // arm -> { turns, hitTurns }
  let scored = 0;
  let hitTurns = 0;
  const ranks = [];
  for (const t of turns.values()) {
    scored++;
    let a = byArm.get(t.arm);
    if (!a) {
      a = { turns: 0, hitTurns: 0 };
      byArm.set(t.arm, a);
    }
    a.turns++;
    if (t.hits > 0) {
      hitTurns++;
      a.hitTurns++;
      if (t.firstHitRank != null) ranks.push(t.firstHitRank);
    }
  }
  ranks.sort((a, b) => a - b);
  const rateByArm = {};
  const countsByArm = {};
  for (const [arm, a] of byArm) {
    rateByArm[arm] = a.turns ? a.hitTurns / a.turns : null;
    countsByArm[arm] = { turns: a.turns, hitTurns: a.hitTurns };
  }
  const delta =
    typeof rateByArm.armed === "number" && typeof rateByArm.holdback === "number"
      ? +(rateByArm.armed - rateByArm.holdback).toFixed(4)
      : null;
  return {
    turnsScored: scored,
    turnsWithHit: hitTurns,
    turnHitRate: scored ? hitTurns / scored : null,
    medianFirstTouchRank: ranks.length ? ranks[Math.floor((ranks.length - 1) / 2)] : null,
    turnHitRateByArm: rateByArm,
    turnCountsByArm: countsByArm,
    turnBenefitDelta: delta,
  };
}

function finiteCount(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function ratio(num, denom) {
  return denom > 0 ? num / denom : null;
}

// Wilson lower confidence bound for a binomial success rate. The scorecard
// gates on the lower bound, never the optimistic point estimate.
function wilsonLowerBound(successes, attempts, z = 1.96) {
  if (!Number.isFinite(attempts) || attempts <= 0) return null;
  const n = attempts;
  const p = Math.max(0, Math.min(1, successes / n));
  const z2 = z * z;
  const center = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, (center - spread) / (1 + z2 / n));
}

function wilsonInterval(successes, attempts, z = 1.96) {
  if (!Number.isFinite(attempts) || attempts <= 0) return null;
  const n = attempts;
  const p = Math.max(0, Math.min(1, successes / n));
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const radius =
    z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n) / denominator;
  return {
    lower: Math.max(0, center - radius),
    upper: Math.min(1, center + radius),
  };
}

function countBy(items, keyFn) {
  const out = {};
  for (const item of items) {
    const key = keyFn(item) || "(unknown)";
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function findingCounts(event, prefix) {
  const overlapKey = prefix === "eligible"
    ? (event.eligibleOverlaps ?? event.overlapPairs)
    : prefix === "deduped"
      ? event.dedupedOverlapPairs
      : (event.deliveredOverlaps ?? event.deliveredOverlapPairs);
  const changedKey = prefix === "eligible"
    ? (event.eligibleChanged ?? event.changed)
    : prefix === "deduped"
      ? event.dedupedChanged
      : event.deliveredChanged;
  const invalidatedKey = prefix === "eligible"
    ? (event.eligibleInvalidated ?? event.invalidated)
    : prefix === "deduped"
      ? event.dedupedInvalidated
      : event.deliveredInvalidated;
  return {
    overlaps: finiteCount(overlapKey),
    changed: finiteCount(changedKey),
    invalidated: finiteCount(invalidatedKey),
  };
}

function findingTotal(counts) {
  return counts.overlaps + counts.changed + counts.invalidated;
}

function claimSampleCount(event) {
  const raw = event && (
    typeof event.findingSample === "string" ? event.findingSample : event.sample
  );
  if (typeof raw !== "string" || raw.length > 2000) return 0;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item) =>
          item && (item.kind === "changed" || item.kind === "invalidated")
        ).length
      : 0;
  } catch {
    return 0;
  }
}

function maxFindingCounts(current, candidate) {
  if (!candidate) {
    return current
      ? { ...current }
      : { overlaps: 0, changed: 0, invalidated: 0 };
  }
  if (!current) return { ...candidate };
  return {
    overlaps: Math.max(current.overlaps, candidate.overlaps),
    changed: Math.max(current.changed, candidate.changed),
    invalidated: Math.max(current.invalidated, candidate.invalidated),
  };
}

function findingCoverage(eligible, delivered, heldback) {
  const shown = delivered || { overlaps: 0, changed: 0, invalidated: 0 };
  const withheld = heldback || { overlaps: 0, changed: 0, invalidated: 0 };
  const deliveredCount =
    Math.min(eligible.overlaps, shown.overlaps) +
    Math.min(eligible.changed, shown.changed) +
    Math.min(eligible.invalidated, shown.invalidated);
  const heldbackOverlap = Math.min(
    Math.max(0, eligible.overlaps - shown.overlaps),
    withheld.overlaps
  );
  return {
    delivered: deliveredCount,
    heldback: heldbackOverlap,
    resolved: deliveredCount + heldbackOverlap,
    eligible: findingTotal(eligible),
  };
}

function addTaskAgent(taskAgents, taskKey, agentKey) {
  if (!taskKey) return;
  if (!taskAgents.has(taskKey)) taskAgents.set(taskKey, new Set());
  if (agentKey) taskAgents.get(taskKey).add(agentKey);
}

function eventDurationStats(items) {
  const durations = items
    .map((event) => event && event.durationMs)
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  return durations.length ? {
    count: durations.length,
    p50: percentile(durations, 0.50),
    p95: percentile(durations, 0.95),
    p99: percentile(durations, 0.99),
    max: durations[durations.length - 1],
  } : null;
}

function lifecycleAttemptUnits(items) {
  const units = new Map();
  items.forEach((event, index) => {
    // A child agent is the stable spawn/return identity. Include taskKey when
    // available so an upstream identity collision cannot merge separate work.
    // Identity-less failures remain separate attempts because there is no
    // defensible join key with which to collapse them.
    const stable = event && event.agentKey
      ? `${event.taskKey || "(unknown-task)"}\0${event.agentKey}`
      : `anonymous\0${index}`;
    if (!units.has(stable)) units.set(stable, []);
    units.get(stable).push({ event, index });
  });
  return [...units.values()].map((rows) => {
    rows.sort((left, right) => {
      const leftTs = Number.isFinite(left.event.ts) ? left.event.ts : Number.POSITIVE_INFINITY;
      const rightTs = Number.isFinite(right.event.ts) ? right.event.ts : Number.POSITIVE_INFINITY;
      return leftTs - rightTs || left.index - right.index;
    });
    const successful = rows.filter(({ event }) =>
      event.outcome === "written" || event.outcome === "retry"
    );
    // A later integrity-safe terminal state is not a successful retry. In
    // particular, written -> ambiguous/withheld/moved means the identity can no
    // longer be trusted at the boundary and must remain visible. Plain failed
    // rows may recover via an explicit retry; raw failures are still counted by
    // the separate sticky hard-failure stop below.
    const terminal = rows.filter(({ event }) =>
      ["ambiguous", "withheld", "moved"].includes(event.outcome)
    );
    const selected = (terminal.length ? terminal : (successful.length ? successful : rows)).at(-1).event;
    return {
      ...selected,
      outcome: terminal.length
        ? selected.outcome
        : successful.length
        ? (successful.some(({ event }) => event.outcome === "written") ? "written" : "retry")
        : selected.outcome,
      rowCount: rows.length,
    };
  });
}

function lifecycleIdentity(event) {
  return event && event.agentKey
    ? `${event.taskKey || "(unknown-task)"}\0${event.agentKey}`
    : null;
}

// The experiment registers exact opportunity/window units for protocol
// accounting, then estimates the behavioral outcome once per task from that
// task's first registered opportunity. Keeping those two units separate stops
// repeated windows from manufacturing either apparent sample size or closure.
function coherenceExperimentScorecard(events) {
  const schemaOne = (event) => event && (event.schema === 1 || event.schemaVersion === 1);
  const relevantRows = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) =>
      schemaOne(event) &&
      (String(event.name || "").startsWith("coherence.experiment.") ||
        String(event.name || "").startsWith("coherence.overlap.") ||
        (event.name === "coherence.report" && ["delivery", "holdback"].includes(event.stage)))
    );
  const relevant = relevantRows.map(({ event }) => event);
  const forcedTaskKeys = new Set(
    relevant.filter((event) => event.assignmentMode === "forced")
      .map((event) => event.taskKey)
      .filter(Boolean)
  );
  const randomized = (event) =>
    event && event.assignmentMode === "randomized" && !forcedTaskKeys.has(event.taskKey);
  const armOf = (event) => event && (event.arm || event.experimentArm);
  const exactKey = (event) => {
    const arm = armOf(event);
    return event && event.opportunityId && event.taskKey && (arm === "armed" || arm === "holdback")
      ? `${arm}\0${event.taskKey}\0${event.opportunityId}`
      : null;
  };
  const taskArmKey = (event) => {
    const arm = armOf(event);
    return event && event.taskKey && (arm === "armed" || arm === "holdback")
      ? `${arm}\0${event.taskKey}`
      : null;
  };
  const ordered = (rows) => [...rows].sort((left, right) => {
    const leftTs = Number.isFinite(left.event.ts) ? left.event.ts : Number.POSITIVE_INFINITY;
    const rightTs = Number.isFinite(right.event.ts) ? right.event.ts : Number.POSITIVE_INFINITY;
    return leftTs - rightTs || left.index - right.index;
  });
  const uniqueBy = (rows, keyFn) => {
    const out = new Map();
    for (const row of ordered(rows)) {
      const key = keyFn(row.event);
      if (key && !out.has(key)) out.set(key, row);
    }
    return out;
  };
  const taskArms = new Map();
  const rememberArm = (event) => {
    if (!randomized(event) || !event.taskKey) return;
    const arm = armOf(event);
    if (arm !== "armed" && arm !== "holdback") return;
    if (!taskArms.has(event.taskKey)) taskArms.set(event.taskKey, new Set());
    taskArms.get(event.taskKey).add(arm);
  };
  for (const event of relevant) rememberArm(event);

  const assignments = relevant.filter(
    (event) => event.name === "coherence.experiment.assigned"
  );
  const opportunities = relevant.filter(
    (event) => event.name === "coherence.overlap.opportunity"
  );
  const exposed = relevant.filter((event) => event.name === "coherence.overlap.exposed");
  const withheld = relevant.filter((event) => event.name === "coherence.overlap.withheld");
  const opened = relevant.filter(
    (event) => event.name === "coherence.experiment.window_opened"
  );
  const closed = relevant.filter(
    (event) => event.name === "coherence.experiment.window_closed"
  );
  const observationFailures = relevant.filter(
    (event) => event.name === "coherence.experiment.observation_failed"
  );

  const causalNames = new Set([
    "coherence.experiment.assigned",
    "coherence.overlap.opportunity",
    "coherence.overlap.exposed",
    "coherence.overlap.withheld",
    "coherence.experiment.window_opened",
    "coherence.experiment.window_closed",
  ]);
  const missingAssignmentModeEvents = relevant.filter(
    (event) => causalNames.has(event.name) && event.assignmentMode == null
  ).length;
  const rowsNamed = (name) => relevantRows.filter(({ event }) => event.name === name);
  const randomizedOpportunityRows = rowsNamed("coherence.overlap.opportunity")
    .filter(({ event }) => randomized(event));
  const registeredByKey = uniqueBy(randomizedOpportunityRows, exactKey);
  const randomizedOpportunities = [...registeredByKey.values()].map(({ event }) => event);
  const randomizedOpenRows = rowsNamed("coherence.experiment.window_opened")
    .filter(({ event }) => randomized(event));
  const randomizedCloseRows = rowsNamed("coherence.experiment.window_closed")
    .filter(({ event }) => randomized(event));
  const randomizedExposedRows = rowsNamed("coherence.overlap.exposed")
    .filter(({ event }) => randomized(event));
  const randomizedWithheldRows = rowsNamed("coherence.overlap.withheld")
    .filter(({ event }) => randomized(event));
  const openedByKey = uniqueBy(randomizedOpenRows, exactKey);
  const closedByKey = uniqueBy(randomizedCloseRows, exactKey);
  const exposedByKey = uniqueBy(randomizedExposedRows, exactKey);
  const withheldByKey = uniqueBy(randomizedWithheldRows, exactKey);

  const registrationCountByTask = new Map();
  const firstRegisteredByTask = new Map();
  for (const row of ordered([...registeredByKey.values()])) {
    const key = taskArmKey(row.event);
    if (!key) continue;
    registrationCountByTask.set(key, (registrationCountByTask.get(key) || 0) + 1);
    if (!firstRegisteredByTask.has(key)) firstRegisteredByTask.set(key, row);
  }
  const tasksWithMultipleOpportunities = [...registrationCountByTask.values()]
    .filter((count) => count > 1).length;
  const protocolDuplicateOpportunityUnits = [...registrationCountByTask.values()]
    .reduce((total, count) => total + Math.max(0, count - 1), 0);
  const randomizedAssignmentRows = rowsNamed("coherence.experiment.assigned")
    .filter(({ event }) => randomized(event));
  const uniqueAssignments = uniqueBy(randomizedAssignmentRows, taskArmKey);

  const opportunityTasks = {
    armed: new Set(),
    holdback: new Set(),
  };
  for (const event of randomizedOpportunities) {
    if (event.taskKey && opportunityTasks[event.arm]) opportunityTasks[event.arm].add(event.taskKey);
  }

  const tasks = new Map();
  for (const [taskKey, registration] of firstRegisteredByTask) {
    const close = closedByKey.get(exactKey(registration.event));
    if (!close) continue;
    const event = close.event;
    tasks.set(taskKey, {
      taskKey: event.taskKey,
      arm: armOf(event),
      opportunityId: event.opportunityId,
      targetRead: event.targetRead === true,
      targetMutation: event.targetMutation === true,
      blindTargetMutation: event.blindTargetMutation === true,
      firstTargetRank: Number.isInteger(event.firstTargetRank) && event.firstTargetRank > 0
        ? event.firstTargetRank
        : null,
      totalTouches: finiteCount(event.totalTouches),
    });
  }

  const arms = {};
  for (const arm of ["armed", "holdback"]) {
    const taskSet = (items) => new Set(items
      .filter((event) => randomized(event) && event.arm === arm && event.taskKey)
      .map((event) => event.taskKey));
    const assignedTasks = taskSet(assignments);
    const eligibleTasks = opportunityTasks[arm];
    const registeredKeys = new Set(randomizedOpportunities
      .filter((event) => armOf(event) === arm)
      .map(exactKey)
      .filter(Boolean));
    const openedKeys = new Set([...openedByKey.keys()].filter((key) => registeredKeys.has(key)));
    const closedKeys = new Set([...closedByKey.keys()].filter((key) => registeredKeys.has(key)));
    const compliantSource = arm === "armed" ? exposedByKey : withheldByKey;
    const compliantKeys = new Set([...compliantSource.keys()].filter((key) => registeredKeys.has(key)));
    const openedTasks = taskSet([...openedByKey.values()].map(({ event }) => event));
    const closedTasks = taskSet([...closedByKey.values()].map(({ event }) => event));
    const compliantTasks = taskSet([...compliantSource.values()].map(({ event }) => event));
    const intersection = (left, right) => [...left].filter((item) => right.has(item)).length;
    const rows = [...tasks.values()].filter((row) => row.arm === arm);
    const blind = rows.filter((row) => row.blindTargetMutation).length;
    const reads = rows.filter((row) => row.targetRead).length;
    const mutations = rows.filter((row) => row.targetMutation).length;
    const readBeforeMutation = rows.filter(
      (row) => row.targetMutation && !row.blindTargetMutation
    ).length;
    const ranked = rows.filter((row) => row.firstTargetRank != null);
    arms[arm] = {
      tasks: rows.length,
      assignedTasks: assignedTasks.size,
      opportunityTasks: eligibleTasks.size,
      openedTasks: intersection(openedTasks, eligibleTasks),
      closedTasks: intersection(closedTasks, eligibleTasks),
      compliantTasks: intersection(compliantTasks, eligibleTasks),
      registeredOpportunities: registeredKeys.size,
      openedWindows: openedKeys.size,
      closedWindows: closedKeys.size,
      compliantWindows: compliantKeys.size,
      assignmentCoverage: ratio(intersection(assignedTasks, eligibleTasks), eligibleTasks.size),
      assignmentToOpportunityRate: ratio(
        intersection(assignedTasks, eligibleTasks),
        assignedTasks.size
      ),
      windowOpenRate: ratio(openedKeys.size, registeredKeys.size),
      windowClosureRate: ratio(closedKeys.size, registeredKeys.size),
      openedWindowClosureRate: ratio(closedKeys.size, openedKeys.size),
      complianceRate: ratio(compliantKeys.size, registeredKeys.size),
      windows: closedKeys.size,
      blindTargetMutations: blind,
      blindTargetMutationRate: ratio(blind, rows.length),
      targetReads: reads,
      targetReadRate: ratio(reads, rows.length),
      targetMutations: mutations,
      targetMutationRate: ratio(mutations, rows.length),
      readBeforeMutationRate: ratio(readBeforeMutation, mutations),
      meanFirstTargetRank: ranked.length
        ? ranked.reduce((total, row) => total + row.firstTargetRank, 0) / ranked.length
        : null,
      meanTouches: rows.length
        ? rows.reduce((total, row) => total + row.totalTouches, 0) / rows.length
        : null,
      blindMutationWilson95: wilsonInterval(blind, rows.length),
    };
  }

  const armedInterval = arms.armed.blindMutationWilson95;
  const holdbackInterval = arms.holdback.blindMutationWilson95;
  const blindMutationDelta =
    arms.armed.blindTargetMutationRate != null &&
    arms.holdback.blindTargetMutationRate != null
      ? arms.holdback.blindTargetMutationRate - arms.armed.blindTargetMutationRate
      : null;
  const blindMutationDeltaInterval = armedInterval && holdbackInterval ? {
    lower: holdbackInterval.lower - armedInterval.upper,
    upper: holdbackInterval.upper - armedInterval.lower,
  } : null;

  const armFlips = [...taskArms.values()].filter((armsForTask) => armsForTask.size > 1).length;
  const controlLeaks = exposed.filter(
    (event) => randomized(event) && event.arm === "holdback"
  ).length +
    relevant.filter((event) =>
      event.name === "coherence.report" && event.stage === "delivery" &&
      event.experimentArm === "holdback" && !forcedTaskKeys.has(event.taskKey) &&
      taskArms.has(event.taskKey) && finiteCount(event.deliveredOverlapPairs) > 0
    ).length;
  const claimHoldbacks = relevant.filter((event) =>
    event.name === "coherence.report" && event.stage === "holdback" &&
    (finiteCount(event.heldbackChanged) > 0 || finiteCount(event.heldbackInvalidated) > 0)
  ).length;

  const pilotPerArm = 40;
  const crediblePerArm = 150;
  const minAssignmentCoverage = 0.95;
  const minOpenCoverage = 0.95;
  const minClosureCoverage = 0.90;
  const maxClosureRateDifference = 0.05;
  const minCompliance = 0.95;
  const attritionFailures = [];
  const attritionPilotReached = ["armed", "holdback"].every((arm) =>
    Math.max(arms[arm].assignedTasks, arms[arm].opportunityTasks) >= pilotPerArm
  );
  if (attritionPilotReached) {
    for (const arm of ["armed", "holdback"]) {
      const row = arms[arm];
      if (row.assignmentCoverage == null || row.assignmentCoverage < minAssignmentCoverage) {
        attritionFailures.push(`${arm} assignment coverage below ${minAssignmentCoverage}`);
      }
      if (
        row.assignmentToOpportunityRate == null ||
        row.assignmentToOpportunityRate < minAssignmentCoverage
      ) {
        attritionFailures.push(`${arm} assignment-to-opportunity coverage below ${minAssignmentCoverage}`);
      }
      if (row.windowOpenRate == null || row.windowOpenRate < minOpenCoverage) {
        attritionFailures.push(`${arm} window-open coverage below ${minOpenCoverage}`);
      }
      if (row.windowClosureRate == null || row.windowClosureRate < minClosureCoverage) {
        attritionFailures.push(`${arm} window-closure coverage below ${minClosureCoverage}`);
      }
      if (row.complianceRate == null || row.complianceRate < minCompliance) {
        attritionFailures.push(`${arm} intervention compliance below ${minCompliance}`);
      }
    }
    if (
      Math.abs(arms.armed.windowClosureRate - arms.holdback.windowClosureRate) >
      maxClosureRateDifference
    ) {
      attritionFailures.push("differential window closure exceeds 0.05");
    }
  }
  let status = "DORMANT";
  let interpretation = "NOT_ENOUGH_DATA";
  if (
    armFlips || controlLeaks || claimHoldbacks || tasksWithMultipleOpportunities ||
    observationFailures.length > 0
  ) {
    status = "INVESTIGATE";
    interpretation = "EXPERIMENT_INTEGRITY_FAILURE";
  } else if (attritionFailures.length > 0) {
    status = "ATTRITION_HOLD";
    interpretation = "EXPERIMENT_ATTRITION_FAILURE";
  } else if (
    arms.armed.opportunityTasks > 0 || arms.holdback.opportunityTasks > 0
  ) {
    status = arms.armed.tasks >= crediblePerArm && arms.holdback.tasks >= crediblePerArm
      ? "CREDIBLE_READ"
      : arms.armed.tasks >= pilotPerArm && arms.holdback.tasks >= pilotPerArm
        ? "PILOT_READY"
        : "ACCRUING";
    if (status === "CREDIBLE_READ" && blindMutationDeltaInterval) {
      if (blindMutationDeltaInterval.lower > 0) {
        interpretation = "ARMED_REDUCES_BLIND_TARGET_MUTATION";
      } else if (blindMutationDeltaInterval.upper < 0) {
        interpretation = "ARMED_INCREASES_BLIND_TARGET_MUTATION";
      } else {
        interpretation = "INCONCLUSIVE_BEHAVIOR_SHIFT";
      }
    }
  }

  const registeredKeys = new Set(registeredByKey.keys());
  const registeredOpenedKeys = new Set([...openedByKey.keys()].filter((key) => registeredKeys.has(key)));
  const registeredClosedKeys = new Set([...closedByKey.keys()].filter((key) => registeredKeys.has(key)));
  const registeredExposedKeys = new Set([...exposedByKey.keys()].filter((key) => registeredKeys.has(key)));
  const registeredWithheldKeys = new Set([...withheldByKey.keys()].filter((key) => registeredKeys.has(key)));
  const validRowCount = (rows, keyFn) => rows.filter(({ event }) => keyFn(event)).length;
  const validAssignmentRows = validRowCount(randomizedAssignmentRows, taskArmKey);
  const validOpportunityRows = validRowCount(randomizedOpportunityRows, exactKey);
  const validOpenRows = validRowCount(randomizedOpenRows, exactKey);
  const validCloseRows = validRowCount(randomizedCloseRows, exactKey);
  const forcedTasksExcluded = forcedTaskKeys.size;
  return {
    schema: 1,
    name: "overlap-holdback-v1",
    status,
    interpretation,
    unit: "unique task",
    outcomeUnit: "first registered opportunity per unique task",
    protocolUnit: "exact registered opportunity/window",
    pilotTasksPerArm: pilotPerArm,
    credibleTasksPerArm: crediblePerArm,
    attritionThresholds: {
      minAssignmentCoverage,
      minOpenCoverage,
      minClosureCoverage,
      maxClosureRateDifference,
      minCompliance,
    },
    attritionFailures,
    forcedTasksExcluded,
    missingAssignmentModeEvents,
    opportunities: registeredKeys.size,
    exposed: registeredExposedKeys.size,
    withheld: registeredWithheldKeys.size,
    windowsOpened: registeredOpenedKeys.size,
    windowsClosed: registeredClosedKeys.size,
    windowsOpenOrUnobserved: [...registeredOpenedKeys]
      .filter((key) => !registeredClosedKeys.has(key)).length,
    protocol: {
      duplicateAssignmentRecords: validAssignmentRows - uniqueAssignments.size,
      duplicateOpportunityRecords: validOpportunityRows - registeredByKey.size,
      duplicateOpenRecords: validOpenRows - openedByKey.size,
      duplicateCloseRecords: validCloseRows - closedByKey.size,
      malformedAssignmentRecords: randomizedAssignmentRows.length - validAssignmentRows,
      malformedOpportunityRecords: randomizedOpportunityRows.length - validOpportunityRows,
      malformedOpenRecords: randomizedOpenRows.length - validOpenRows,
      malformedCloseRecords: randomizedCloseRows.length - validCloseRows,
      tasksWithMultipleOpportunities,
      duplicateOpportunityUnits: protocolDuplicateOpportunityUnits,
      orphanOpenWindows: [...openedByKey.keys()].filter((key) => !registeredKeys.has(key)).length,
      orphanClosedWindows: [...closedByKey.keys()].filter((key) => !registeredKeys.has(key)).length,
      orphanComplianceEvents: [...new Set([...exposedByKey.keys(), ...withheldByKey.keys()])]
        .filter((key) => !registeredKeys.has(key)).length,
    },
    armFlips,
    controlLeaks,
    claimHoldbacks,
    observationFailures: observationFailures.length,
    observationFailureReasons: countBy(
      observationFailures.filter((event) => event.reason),
      (event) => event.reason
    ),
    arms,
    blindTargetMutationDeltaHoldbackMinusArmed: blindMutationDelta,
    blindTargetMutationDeltaWilson95: blindMutationDeltaInterval,
    outcomeBoundary:
      "Uses each randomized task's first registered opportunity to measure observed parent Read/Edit/Write/MultiEdit/NotebookEdit behavior; Bash/script mutations, child-agent work, conflicts, task success, and user value are not measured.",
  };
}

function coherenceScorecard(events) {
  const schemaOne = (event) => event && (event.schema === 1 || event.schemaVersion === 1);
  const incidentKey = (event) => event && (event.incidentId || event.reportId) || null;
  const lifecycle = events.filter(
    (event) => schemaOne(event) && event.name === "coherence.lifecycle"
  );
  const reports = events.filter(
    (event) => schemaOne(event) && event.name === "coherence.report"
  );
  const feedbackEvents = events.filter(
    (event) => schemaOne(event) && event.name === "coherence.feedback"
  );
  const experimentEvents = events.filter(
    (event) => schemaOne(event) &&
      (String(event.name || "").startsWith("coherence.experiment.") ||
        String(event.name || "").startsWith("coherence.overlap."))
  );
  const versioned = [...lifecycle, ...reports, ...feedbackEvents, ...experimentEvents];

  let firstTs = null;
  let lastTs = null;
  for (const event of versioned) {
    if (!Number.isFinite(event.ts)) continue;
    if (firstTs == null || event.ts < firstTs) firstTs = event.ts;
    if (lastTs == null || event.ts > lastTs) lastTs = event.ts;
  }
  const spanMs = firstTs != null && lastTs != null ? Math.max(0, lastTs - firstTs) : 0;
  const spanDays = spanMs / (24 * 60 * 60 * 1000);

  const taskAgents = new Map();
  const childSpawnEvents = lifecycle.filter((event) => event.stage === "child_spawn");
  const returnEvents = lifecycle.filter((event) => event.stage === "tool_return");
  const parentServeEvents = lifecycle.filter((event) => event.stage === "parent_serve");
  for (const event of lifecycle) addTaskAgent(taskAgents, event.taskKey, event.agentKey);

  const lifecycleSuccess = (event) => event.outcome === "written" || event.outcome === "retry";
  const spawnAttempts = lifecycleAttemptUnits(childSpawnEvents);
  const returnAttempts = lifecycleAttemptUnits(returnEvents);
  const spawnSuccesses = spawnAttempts.filter(lifecycleSuccess).length;
  const returnSuccesses = returnAttempts.filter(lifecycleSuccess).length;
  const uniqueChildrenPrepared = new Set(
    spawnAttempts.filter(lifecycleSuccess).map(lifecycleIdentity).filter(Boolean)
  );
  const uniqueChildrenReturned = new Set(
    returnAttempts.filter(lifecycleSuccess).map(lifecycleIdentity).filter(Boolean)
  );
  const observedReturnedChildren = new Set(
    [...uniqueChildrenReturned].filter((agentKey) => uniqueChildrenPrepared.has(agentKey))
  );
  const orphanReturnedChildren = new Set(
    [...uniqueChildrenReturned].filter((agentKey) => !uniqueChildrenPrepared.has(agentKey))
  );
  const lifecycleUnits = [
    ...lifecycle.filter((event) =>
      event.stage !== "child_spawn" && event.stage !== "tool_return"
    ),
    ...spawnAttempts,
    ...returnAttempts,
  ];

  const analyses = reports.filter((event) => event.stage === "analysis");
  const analysisFailures = analyses.filter((event) => event.outcome === "failed");
  const deliveries = reports.filter((event) => event.stage === "delivery");
  const holdbacks = reports.filter((event) => event.stage === "holdback");
  const dedupes = reports.filter((event) => event.stage === "dedupe");
  const suppressions = reports.filter((event) => event.stage === "suppression");
  const lifecycleDurationStats = eventDurationStats(lifecycle);
  const reportAnalysisDurationStats = eventDurationStats(analyses);
  const experimentDurationStats = eventDurationStats(experimentEvents);
  const measuredLatencyLanes = {
    lifecycle: lifecycleDurationStats,
    reportAnalysis: reportAnalysisDurationStats,
    experimentState: experimentDurationStats,
  };
  const latencyFailures = Object.entries(measuredLatencyLanes)
    .filter(([, stats]) => stats && (
      stats.p95 > COHERENCE_THRESHOLDS.maxP95Ms ||
      stats.p99 > COHERENCE_THRESHOLDS.maxP99Ms
    ))
    .map(([lane, stats]) =>
      `${lane} latency p95 ${Math.round(stats.p95)}ms / p99 ${Math.round(stats.p99)}ms exceeds ` +
      `${COHERENCE_THRESHOLDS.maxP95Ms}ms / ${COHERENCE_THRESHOLDS.maxP99Ms}ms`
    );
  const peerAnalyses = analyses.filter((event) => finiteCount(event.agents) >= 2);
  for (const event of peerAnalyses) {
    if (event.taskKey && !taskAgents.has(event.taskKey)) taskAgents.set(event.taskKey, new Set());
  }

  const eligibleByIncident = new Map();
  const deliveredByIncident = new Map();
  const dedupedByIncident = new Map();
  const heldbackByIncident = new Map();
  const incidentSamples = new Map();
  const incidentReviewableSamples = new Map();
  const eligibleBoundaryIds = new Set();
  const deliveredBoundaryIds = new Set();
  const heldbackBoundaryIds = new Set();
  const eligibleByBoundary = new Map();
  const deliveredByBoundary = new Map();
  const dedupedByBoundary = new Map();
  const heldbackByBoundary = new Map();
  let findingBearingAnalyses = 0;
  let claimsChecked = 0;
  let unverifiableClaims = 0;

  const surface = {};
  const ensureSurface = (name) => {
    const key = name || "(unknown)";
    if (!surface[key]) {
      surface[key] = {
        analyses: 0,
        eligibleBoundaries: 0,
        deliveredBoundaries: 0,
        eligibleIncidents: 0,
        deliveredIncidents: 0,
        resolvedIncidents: 0,
        incidentDeliveryRate: null,
        incidentResolutionRate: null,
        _eligible: new Map(),
        _delivered: new Map(),
        _deduped: new Map(),
        _heldback: new Map(),
      };
    }
    return surface[key];
  };

  for (const event of analyses) {
    const row = ensureSurface(event.surface);
    row.analyses++;
    claimsChecked += finiteCount(
      event.claimsChecked ??
      (finiteCount(event.unchanged) + finiteCount(event.changed) +
        finiteCount(event.invalidated) + finiteCount(event.unknown))
    );
    unverifiableClaims += finiteCount(event.unverifiable ?? event.unknown);
    const eligible = findingCounts(event, "eligible");
    if (findingTotal(eligible) === 0) continue;
    findingBearingAnalyses++;
    row.eligibleBoundaries++;
    if (event.boundaryId) {
      eligibleBoundaryIds.add(event.boundaryId);
      eligibleByBoundary.set(
        event.boundaryId,
        maxFindingCounts(eligibleByBoundary.get(event.boundaryId), eligible)
      );
    }
    const reportId = incidentKey(event);
    if (!reportId) continue;
    row._eligible.set(reportId, maxFindingCounts(row._eligible.get(reportId), eligible));
    eligibleByIncident.set(
      reportId,
      maxFindingCounts(eligibleByIncident.get(reportId), eligible)
    );
    const sample = typeof event.sample === "string" ? event.sample : event.findingSample;
    const reviewableSampleCount = claimSampleCount(event);
    const priorReviewableSampleCount = incidentReviewableSamples.get(reportId) || 0;
    if (
      reviewableSampleCount > priorReviewableSampleCount &&
      typeof sample === "string" && sample && sample !== "[]"
    ) {
      incidentSamples.set(reportId, sample.slice(0, 500));
    }
    incidentReviewableSamples.set(
      reportId,
      Math.max(priorReviewableSampleCount, reviewableSampleCount)
    );
  }

  for (const event of deliveries) {
    const row = ensureSurface(event.surface);
    const reportId = incidentKey(event);
    if (!reportId) continue;
    const delivered = findingCounts(event, "delivered");
    if (findingTotal(delivered) > 0) {
      row.deliveredBoundaries++;
      if (event.boundaryId) {
        deliveredBoundaryIds.add(event.boundaryId);
        deliveredByBoundary.set(
          event.boundaryId,
          maxFindingCounts(deliveredByBoundary.get(event.boundaryId), delivered)
        );
      }
      row._delivered.set(
        reportId,
        maxFindingCounts(row._delivered.get(reportId), delivered)
      );
    }
    deliveredByIncident.set(
      reportId,
      maxFindingCounts(deliveredByIncident.get(reportId), delivered)
    );
  }

  for (const event of holdbacks) {
    const row = ensureSurface(event.surface);
    const reportId = incidentKey(event);
    if (!reportId) continue;
    const heldback = {
      overlaps: finiteCount(event.heldbackOverlapPairs),
      changed: finiteCount(event.heldbackChanged),
      invalidated: finiteCount(event.heldbackInvalidated),
    };
    heldbackByIncident.set(
      reportId,
      maxFindingCounts(heldbackByIncident.get(reportId), heldback)
    );
    if (heldback.overlaps > 0) {
      if (event.boundaryId) {
        heldbackBoundaryIds.add(event.boundaryId);
        heldbackByBoundary.set(
          event.boundaryId,
          maxFindingCounts(heldbackByBoundary.get(event.boundaryId), heldback)
        );
      }
      row._heldback.set(
        reportId,
        maxFindingCounts(row._heldback.get(reportId), heldback)
      );
    }
  }

  for (const event of dedupes) {
    const row = ensureSurface(event.surface);
    const reportId = incidentKey(event);
    if (!reportId) continue;
    const deduped = findingCounts(event, "deduped");
    if (findingTotal(deduped) === 0) continue;
    dedupedByIncident.set(
      reportId,
      maxFindingCounts(dedupedByIncident.get(reportId), deduped)
    );
    row._deduped.set(
      reportId,
      maxFindingCounts(row._deduped.get(reportId), deduped)
    );
    if (event.boundaryId) {
      dedupedByBoundary.set(
        event.boundaryId,
        maxFindingCounts(dedupedByBoundary.get(event.boundaryId), deduped)
      );
    }
  }

  for (const row of Object.values(surface)) {
    row.eligibleIncidents = row._eligible.size;
    row.deliveredIncidents = 0;
    row.resolvedIncidents = 0;
    for (const [id, eligible] of row._eligible) {
      const rawCoverage = findingCoverage(eligible, row._delivered.get(id), null);
      const resolvedCoverage = findingCoverage(
        eligible,
        maxFindingCounts(row._delivered.get(id), row._deduped.get(id)),
        row._heldback.get(id)
      );
      if (rawCoverage.delivered > 0) row.deliveredIncidents++;
      if (resolvedCoverage.resolved === resolvedCoverage.eligible) row.resolvedIncidents++;
    }
    row.incidentDeliveryRate = ratio(row.deliveredIncidents, row.eligibleIncidents);
    row.incidentResolutionRate = ratio(row.resolvedIncidents, row.eligibleIncidents);
    delete row._eligible;
    delete row._delivered;
    delete row._deduped;
    delete row._heldback;
  }

  let eligibleFindings = 0;
  let deliveredFindings = 0;
  let resolvedFindings = 0;
  let dedupedFindings = 0;
  let intentionallyHeldbackFindings = 0;
  let deliveredIncidents = 0;
  let resolvedIncidents = 0;
  for (const [reportId, eligible] of eligibleByIncident) {
    eligibleFindings += findingTotal(eligible);
    const rawCoverage = findingCoverage(eligible, deliveredByIncident.get(reportId), null);
    const dedupeCoverage = findingCoverage(eligible, dedupedByIncident.get(reportId), null);
    const resolvedCoverage = findingCoverage(
      eligible,
      maxFindingCounts(deliveredByIncident.get(reportId), dedupedByIncident.get(reportId)),
      heldbackByIncident.get(reportId)
    );
    deliveredFindings += rawCoverage.delivered;
    dedupedFindings += dedupeCoverage.delivered;
    intentionallyHeldbackFindings += resolvedCoverage.heldback;
    resolvedFindings += resolvedCoverage.resolved;
    if (rawCoverage.delivered > 0) deliveredIncidents++;
    if (resolvedCoverage.resolved === resolvedCoverage.eligible) resolvedIncidents++;
  }

  let deliveredBoundaries = 0;
  let resolvedBoundaries = 0;
  for (const [boundaryId, eligible] of eligibleByBoundary) {
    const rawCoverage = findingCoverage(eligible, deliveredByBoundary.get(boundaryId), null);
    const resolvedCoverage = findingCoverage(
      eligible,
      maxFindingCounts(deliveredByBoundary.get(boundaryId), dedupedByBoundary.get(boundaryId)),
      heldbackByBoundary.get(boundaryId)
    );
    if (rawCoverage.delivered > 0) deliveredBoundaries++;
    if (resolvedCoverage.resolved === resolvedCoverage.eligible) resolvedBoundaries++;
  }

  const feedbackByIncident = new Map();
  for (const event of feedbackEvents) {
    const reportId = incidentKey(event);
    if (!reportId || !COHERENCE_FEEDBACK_VERDICTS.has(event.verdict)) continue;
    const previous = feedbackByIncident.get(reportId);
    if (!previous || finiteCount(event.ts) >= finiteCount(previous.ts)) {
      feedbackByIncident.set(reportId, event);
    }
  }
  const feedbackByVerdict = countBy([...feedbackByIncident.values()], (event) => event.verdict);
  // Safety findings are sticky within the selected telemetry window. A later
  // convenience review cannot silently erase a confirmed false fact; clearing
  // one requires an explicit adjudication mechanism, which v1 does not expose.
  const falseFactIncidents = new Set(
    feedbackEvents
      .filter((event) => event.verdict === "false_fact")
      .map((event) => incidentKey(event))
      .filter(Boolean)
  );
  const falseFacts = falseFactIncidents.size;
  const claimIncidents = [...eligibleByIncident.entries()]
    .filter(([, counts]) => counts.changed + counts.invalidated > 0)
    .map(([reportId]) => reportId);
  const reviewedClaimIncidents = claimIncidents.filter((reportId) => {
    const feedback = feedbackByIncident.get(reportId);
    return feedback && COHERENCE_ADJUDICATED_VERDICTS.has(feedback.verdict);
  });
  const reviewedFindings = reviewedClaimIncidents.reduce((total, reportId) => {
    const eligible = eligibleByIncident.get(reportId);
    const event = feedbackByIncident.get(reportId);
    const reviewable = Math.min(
      eligible.changed + eligible.invalidated,
      incidentReviewableSamples.get(reportId) || 0
    );
    return total + Math.min(reviewable, finiteCount(event.reviewedFindings));
  }, 0);
  const unreviewed = claimIncidents
    .filter((reportId) => {
      const feedback = feedbackByIncident.get(reportId);
      return !feedback || !COHERENCE_ADJUDICATED_VERDICTS.has(feedback.verdict);
    })
    .slice(0, 5)
    .map((reportId) => ({ reportId, sample: incidentSamples.get(reportId) || "" }));

  // Eventual retry success is appropriate for the reliability denominator, but
  // must not erase a hard failure that actually occurred inside the window.
  const hardFailureEvents = lifecycle.filter((event) => event.outcome === "failed");
  const safeWithholdEvents = lifecycleUnits.filter((event) =>
    ["ambiguous", "withheld", "moved", "missing"].includes(event.outcome)
  );
  const multiAgentTasks = [...taskAgents.entries()].filter(([, agents]) => agents.size >= 2).length +
    [...new Set(peerAnalyses.map((event) => event.taskKey).filter(Boolean))]
      .filter((taskKey) => !taskAgents.has(taskKey) || taskAgents.get(taskKey).size < 2).length;

  const incidentDeliveryRate = ratio(deliveredIncidents, eligibleByIncident.size);
  const findingDeliveryRate = ratio(deliveredFindings, eligibleFindings);
  const incidentResolutionRate = ratio(resolvedIncidents, eligibleByIncident.size);
  const findingResolutionRate = ratio(resolvedFindings, eligibleFindings);
  const boundaryDeliveryRate = ratio(deliveredBoundaries, eligibleByBoundary.size);
  const boundaryResolutionRate = ratio(resolvedBoundaries, eligibleByBoundary.size);
  const findingIncidence = ratio(findingBearingAnalyses, peerAnalyses.length);
  const spawnWilson = wilsonLowerBound(spawnSuccesses, spawnAttempts.length);
  const returnWilson = wilsonLowerBound(returnSuccesses, returnAttempts.length);

  const baseGaps = [];
  if (spanDays < COHERENCE_THRESHOLDS.minDays) {
    baseGaps.push(`window ${spanDays.toFixed(1)}d < ${COHERENCE_THRESHOLDS.minDays}d`);
  }
  if (multiAgentTasks < COHERENCE_THRESHOLDS.minMultiAgentTasks) {
    baseGaps.push(`multi-agent tasks ${multiAgentTasks} < ${COHERENCE_THRESHOLDS.minMultiAgentTasks}`);
  }
  if (spawnAttempts.length < COHERENCE_THRESHOLDS.minSpawnAttempts) {
    baseGaps.push(`spawn attempts ${spawnAttempts.length} < ${COHERENCE_THRESHOLDS.minSpawnAttempts}`);
  }
  if (returnAttempts.length < COHERENCE_THRESHOLDS.minReturnAttempts) {
    baseGaps.push(`return attempts ${returnAttempts.length} < ${COHERENCE_THRESHOLDS.minReturnAttempts}`);
  }
  const incidentGap = eligibleByIncident.size < COHERENCE_THRESHOLDS.minEligibleIncidents
    ? `eligible incidents ${eligibleByIncident.size} < ${COHERENCE_THRESHOLDS.minEligibleIncidents}`
    : null;
  const gaps = incidentGap ? [...baseGaps, incidentGap] : [...baseGaps];

  let status = "DORMANT";
  const reasons = [];
  if (versioned.length > 0) {
    if (falseFacts > 0) {
      status = "INVESTIGATE";
      reasons.push(`${falseFacts} confirmed false-fact review(s)`);
    } else if (analysisFailures.length > 0) {
      status = "INVESTIGATE";
      reasons.push(`${analysisFailures.length} report analysis failure(s)`);
    } else if (hardFailureEvents.length > 0) {
      status = "INVESTIGATE";
      reasons.push(`${hardFailureEvents.length} hard lifecycle failure(s)`);
    } else if (baseGaps.length > 0) {
      status = "ACCRUING";
      reasons.push(...baseGaps);
    } else if (
      spawnWilson == null || spawnWilson < COHERENCE_THRESHOLDS.minLifecycleWilsonLower ||
      returnWilson == null || returnWilson < COHERENCE_THRESHOLDS.minLifecycleWilsonLower ||
      latencyFailures.length > 0
    ) {
      status = "HOLD";
      reasons.push(
        ...(spawnWilson == null || spawnWilson < COHERENCE_THRESHOLDS.minLifecycleWilsonLower ||
          returnWilson == null || returnWilson < COHERENCE_THRESHOLDS.minLifecycleWilsonLower
          ? ["one or more lifecycle-reliability gates missed"]
          : []),
        ...latencyFailures
      );
    } else if (
      peerAnalyses.length >= COHERENCE_THRESHOLDS.minPeerAnalysesForHeadroom &&
      (findingIncidence == null || findingIncidence < COHERENCE_THRESHOLDS.minFindingIncidence)
    ) {
      status = "PARK_CANDIDATE";
      reasons.push("finding incidence is below the pre-registered headroom floor");
    } else if (incidentGap) {
      status = "ACCRUING";
      reasons.push(incidentGap);
    } else if (
      boundaryResolutionRate == null ||
      boundaryResolutionRate < COHERENCE_THRESHOLDS.minBoundaryResolutionRate ||
      incidentResolutionRate == null ||
      incidentResolutionRate < COHERENCE_THRESHOLDS.minIncidentResolutionRate ||
      findingResolutionRate == null ||
      findingResolutionRate < COHERENCE_THRESHOLDS.minFindingResolutionRate
    ) {
      status = "HOLD";
      reasons.push("one or more boundary, incident, or finding resolution gates missed");
    } else if (reviewedFindings < COHERENCE_THRESHOLDS.minReviewedFindings) {
      status = "REVIEW_REQUIRED";
      reasons.push(
        `adjudicated findings ${reviewedFindings} < ` +
        `${COHERENCE_THRESHOLDS.minReviewedFindings}`
      );
    } else {
      status = "OPERATIONALLY_READY";
      reasons.push("operational and factual-review gates passed");
    }
  } else {
    reasons.push("no schema-v1 coherence lifecycle/report events recorded");
  }

  const experiment = coherenceExperimentScorecard(events);
  if (experiment.status === "INVESTIGATE" && status !== "DORMANT") {
    status = "INVESTIGATE";
    reasons.unshift("overlap experiment integrity stop triggered");
  } else if (experiment.status === "ATTRITION_HOLD" && status !== "INVESTIGATE") {
    status = "HOLD";
    reasons.unshift("overlap experiment attrition/compliance gate missed");
  }

  return {
    schema: 1,
    status,
    reasons,
    behavioralBenefit: "NOT_MEASURED",
    behavioralBenefitReason:
      "The randomized overlap trial observes only parent Read/Edit/Write/MultiEdit/NotebookEdit behavior; Bash/script mutations, child work, conflicts, task success, and user value are not instrumented.",
    window: { firstTs, lastTs, spanMs, spanDays },
    thresholds: COHERENCE_THRESHOLDS,
    gaps: status === "PARK_CANDIDATE" ? baseGaps : gaps,
    lifecycle: {
      multiAgentTasks,
      parentServeAttempts: parentServeEvents.length,
      childSpawnAttempts: spawnAttempts.length,
      childSpawnRows: childSpawnEvents.length,
      childSpawnDuplicateRowsCollapsed: childSpawnEvents.length - spawnAttempts.length,
      childSpawnSuccesses: spawnSuccesses,
      childSpawnSuccessRate: ratio(spawnSuccesses, spawnAttempts.length),
      childSpawnWilsonLower95: spawnWilson,
      uniqueChildrenPrepared: uniqueChildrenPrepared.size,
      returnAttempts: returnAttempts.length,
      returnRows: returnEvents.length,
      returnDuplicateRowsCollapsed: returnEvents.length - returnAttempts.length,
      returnSuccesses,
      returnSuccessRate: ratio(returnSuccesses, returnAttempts.length),
      returnWilsonLower95: returnWilson,
      uniqueChildrenReturned: uniqueChildrenReturned.size,
      observedChildrenReturned: observedReturnedChildren.size,
      observedReturnRate: ratio(observedReturnedChildren.size, uniqueChildrenPrepared.size),
      orphanReturns: orphanReturnedChildren.size,
      outcomesByStage: {
        parent_serve: countBy(parentServeEvents, (event) => event.outcome),
        child_spawn: countBy(spawnAttempts, (event) => event.outcome),
        tool_return: countBy(returnAttempts, (event) => event.outcome),
      },
      reasons: countBy(lifecycleUnits.filter((event) => event.reason), (event) => event.reason),
      hardFailures: hardFailureEvents.length,
      safeWithholds: safeWithholdEvents.length,
      duration: lifecycleDurationStats,
    },
    reports: {
      analyses: analyses.length,
      analysisFailures: analysisFailures.length,
      analysisFailureReasons: countBy(
        analysisFailures.filter((event) => event.reason),
        (event) => event.reason
      ),
      peerAnalyses: peerAnalyses.length,
      findingBearingAnalyses,
      findingIncidence,
      eligibleBoundaries: eligibleBoundaryIds.size,
      deliveredBoundaries,
      dedupedBoundaries: dedupedByBoundary.size,
      heldbackBoundaries: heldbackBoundaryIds.size,
      resolvedBoundaries,
      boundaryDeliveryRate,
      boundaryResolutionRate,
      uniqueEligibleIncidents: eligibleByIncident.size,
      uniqueDeliveredIncidents: deliveredIncidents,
      incidentDeliveryRate,
      uniqueResolvedIncidents: resolvedIncidents,
      incidentResolutionRate,
      eligibleFindings,
      deliveredFindings,
      dedupedFindings,
      findingDeliveryRate,
      intentionallyHeldbackFindings,
      resolvedFindings,
      findingResolutionRate,
      claimsChecked,
      unverifiableClaims,
      unverifiableRate: ratio(unverifiableClaims, claimsChecked),
      bySurface: surface,
      analysisDuration: reportAnalysisDurationStats,
      suppressions: {
        count: suppressions.length,
        reasons: countBy(suppressions, (event) => event.reason),
      },
    },
    safetyReview: {
      feedbackIncidents: feedbackByIncident.size,
      reviewedIncidents: reviewedClaimIncidents.length,
      reviewedFindings,
      adjudicatedIncidents: reviewedClaimIncidents.length,
      adjudicatedFindings: reviewedFindings,
      unclearIncidents: finiteCount(feedbackByVerdict.unclear),
      verdicts: feedbackByVerdict,
      falseFacts,
      unreviewedClaimIncidents: Math.max(0, claimIncidents.length - reviewedClaimIncidents.length),
      nextUnreviewed: unreviewed,
    },
    experiment: {
      ...experiment,
      operationDuration: experimentDurationStats,
    },
    latency: {
      measurementBoundary:
        "durationMs covers instrumented Phase-F lifecycle handling, report analysis, and experiment state operations only; it excludes telemetry append and total hook runtime.",
      lanes: measuredLatencyLanes,
      failures: latencyFailures,
    },
  };
}

function fmtRate(value) {
  return typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "n/a";
}

function printCoherenceScorecard(rootAbs, card) {
  const lines = [];
  lines.push(`sextant coherence scorecard — ${rootAbs}`);
  lines.push("─".repeat(60));
  lines.push(`  status: ${card.status}`);
  for (const reason of card.reasons || []) lines.push(`  - ${reason}`);
  lines.push("");
  lines.push(
    `  Behavioral benefit: ${card.behavioralBenefit} — ${card.behavioralBenefitReason}`
  );

  if (card.status === "DORMANT") {
    lines.push("");
    lines.push("  No decision-grade Phase-F events exist in this window.");
    lines.push("  This is not a negative result; the measurement lane has not observed traffic.");
    return lines.join("\n");
  }

  const windowDays = card.window && Number.isFinite(card.window.spanDays)
    ? card.window.spanDays.toFixed(1)
    : "0.0";
  lines.push("");
  lines.push(`Observation window: ${windowDays} days`);

  const lifecycle = card.lifecycle;
  lines.push("");
  lines.push("Lifecycle reliability (unique identities remain separately counted)");
  lines.push(`  multi-agent tasks: ${lifecycle.multiAgentTasks}`);
  lines.push(
    `  child spawn: ${lifecycle.childSpawnSuccesses}/${lifecycle.childSpawnAttempts} successful ` +
    `(rate ${fmtRate(lifecycle.childSpawnSuccessRate)}, Wilson lower ${fmtRate(lifecycle.childSpawnWilsonLower95)})`
  );
  lines.push(
    `  tool return join: ${lifecycle.returnSuccesses}/${lifecycle.returnAttempts} successful ` +
    `(rate ${fmtRate(lifecycle.returnSuccessRate)}, Wilson lower ${fmtRate(lifecycle.returnWilsonLower95)})`
  );
  lines.push(
    `  unique children: ${lifecycle.uniqueChildrenPrepared} prepared, ` +
    `${lifecycle.observedChildrenReturned} observed returned ` +
    `(right-censored rate ${fmtRate(lifecycle.observedReturnRate)}); ` +
    `orphan returns: ${lifecycle.orphanReturns}`
  );
  if (lifecycle.childSpawnDuplicateRowsCollapsed || lifecycle.returnDuplicateRowsCollapsed) {
    lines.push(
      `  retry/duplicate rows collapsed by stable child identity: spawn ` +
      `${lifecycle.childSpawnDuplicateRowsCollapsed}, return ` +
      `${lifecycle.returnDuplicateRowsCollapsed}`
    );
  }
  lines.push(
    `  hard failures: ${lifecycle.hardFailures}; safe withholds/ambiguities/missing joins: ${lifecycle.safeWithholds}`
  );
  if (lifecycle.duration) {
    lines.push(
      `  instrumented lifecycle segment: p50 ${fmtMs(lifecycle.duration.p50)}, ` +
      `p95 ${fmtMs(lifecycle.duration.p95)}, p99 ${fmtMs(lifecycle.duration.p99)}, ` +
      `max ${fmtMs(lifecycle.duration.max)}`
    );
  }
  const reasonEntries = Object.entries(lifecycle.reasons || {});
  if (reasonEntries.length) {
    lines.push("  exact reasons:");
    for (const [reason, count] of reasonEntries.sort((a, b) => b[1] - a[1])) {
      lines.push(`    - ${reason}: ${count}`);
    }
  }

  const reports = card.reports;
  lines.push("");
  lines.push("Report signal and delivery (deduped by canonical incident ID)");
  if (reports.analysisFailures > 0) {
    lines.push(`  failed analysis attempts: ${reports.analysisFailures}`);
    for (const [reason, count] of Object.entries(reports.analysisFailureReasons || {})) {
      lines.push(`    - ${reason}: ${count}`);
    }
  }
  lines.push(
    `  analyses with peers: ${reports.peerAnalyses}; finding-bearing: ${reports.findingBearingAnalyses} ` +
    `(${fmtRate(reports.findingIncidence)})`
  );
  lines.push(
    `  output boundaries delivered: ${reports.deliveredBoundaries}/${reports.eligibleBoundaries} ` +
    `(${fmtRate(reports.boundaryDeliveryRate)}); resolved: ` +
    `${reports.resolvedBoundaries}/${reports.eligibleBoundaries} ` +
    `(${fmtRate(reports.boundaryResolutionRate)})`
  );
  lines.push(
    `  unique incidents delivered: ${reports.uniqueDeliveredIncidents}/${reports.uniqueEligibleIncidents} ` +
    `(${fmtRate(reports.incidentDeliveryRate)})`
  );
  lines.push(
    `  finding units delivered: ${reports.deliveredFindings}/${reports.eligibleFindings} ` +
    `(${fmtRate(reports.findingDeliveryRate)})`
  );
  lines.push(
    `  findings resolved (delivered or intentional overlap holdback): ` +
    `${reports.resolvedFindings}/${reports.eligibleFindings} ` +
    `(${fmtRate(reports.findingResolutionRate)}); deduped: ${reports.dedupedFindings}; ` +
    `held back: ${reports.intentionallyHeldbackFindings}`
  );
  lines.push(
    `  incidents resolved: ${reports.uniqueResolvedIncidents}/${reports.uniqueEligibleIncidents} ` +
    `(${fmtRate(reports.incidentResolutionRate)})`
  );
  lines.push(
    `  claims checked: ${reports.claimsChecked}; unverifiable: ${reports.unverifiableClaims} ` +
    `(${fmtRate(reports.unverifiableRate)}; never rendered as a factual retraction)`
  );
  if (reports.analysisDuration) {
    lines.push(
      `  instrumented report-analysis segment: p50 ${fmtMs(reports.analysisDuration.p50)}, ` +
      `p95 ${fmtMs(reports.analysisDuration.p95)}, ` +
      `p99 ${fmtMs(reports.analysisDuration.p99)}`
    );
  }
  for (const [surface, row] of Object.entries(reports.bySurface || {})) {
    lines.push(
      `  surface=${surface}: ${row.deliveredIncidents}/${row.eligibleIncidents} incidents delivered, ` +
      `${row.resolvedIncidents}/${row.eligibleIncidents} resolved, ${row.analyses} analyses`
    );
  }
  if (reports.suppressions && reports.suppressions.count > 0) {
    lines.push(`  unresolved publication suppressions: ${reports.suppressions.count}`);
    for (const [reason, count] of Object.entries(reports.suppressions.reasons || {})) {
      lines.push(`    - ${reason}: ${count}`);
    }
  }

  const review = card.safetyReview;
  lines.push("");
  lines.push("Factual safety review");
  lines.push(
    `  adjudicated: ${review.reviewedFindings} finding units across ${review.reviewedIncidents} incident(s); ` +
    `confirmed false facts: ${review.falseFacts}`
  );
  for (const item of review.nextUnreviewed || []) {
    lines.push(`  unreviewed ${item.reportId}${item.sample ? ` — ${item.sample}` : ""}`);
    lines.push(
      `    record: sextant telemetry --review ${item.reportId} ` +
      `--verdict <verdict> --reviewed-findings 1`
    );
  }

  const experiment = card.experiment;
  if (experiment) {
    lines.push("");
    lines.push("Randomized overlap-only behavior trial (unique-task outcome; exact-window protocol)");
    lines.push(
      `  status: ${experiment.status}; interpretation: ${experiment.interpretation}`
    );
    lines.push(
      `  opportunities: ${experiment.opportunities}; exposed: ${experiment.exposed}; ` +
      `withheld: ${experiment.withheld}; closed windows: ${experiment.windowsClosed}; ` +
      `forced tasks excluded: ${experiment.forcedTasksExcluded}`
    );
    for (const arm of ["armed", "holdback"]) {
      const row = experiment.arms && experiment.arms[arm];
      if (!row) continue;
      lines.push(
        `  ${arm}: assigned ${row.assignedTasks}, opportunities ${row.opportunityTasks}, ` +
        `opened ${row.openedTasks}, closed ${row.closedTasks}, compliant ${row.compliantTasks}`
      );
      lines.push(
        `    exact windows: registered ${row.registeredOpportunities}, opened ` +
        `${row.openedWindows}, closed ${row.closedWindows}, compliant ${row.compliantWindows}`
      );
      lines.push(
        `    coverage: assignment ${fmtRate(row.assignmentCoverage)}, open ` +
        `${fmtRate(row.windowOpenRate)}, closure ${fmtRate(row.windowClosureRate)}, ` +
        `compliance ${fmtRate(row.complianceRate)}`
      );
      lines.push(
        `    outcome: ${row.tasks} task(s), blind target mutation ${row.blindTargetMutations}/` +
        `${row.tasks} (${fmtRate(row.blindTargetMutationRate)}), target read ` +
        `${fmtRate(row.targetReadRate)}, read-before-mutation ${fmtRate(row.readBeforeMutationRate)}`
      );
    }
    const delta = experiment.blindTargetMutationDeltaHoldbackMinusArmed;
    const interval = experiment.blindTargetMutationDeltaWilson95;
    lines.push(
      `  holdback−armed blind-mutation delta: ` +
      `${typeof delta === "number" ? fmtRate(delta) : "n/a"}` +
      `${interval ? ` (conservative 95% interval ${fmtRate(interval.lower)} to ${fmtRate(interval.upper)})` : ""}`
    );
    lines.push(
      `  integrity stops: arm flips ${experiment.armFlips}, control leaks ${experiment.controlLeaks}, ` +
      `claim holdbacks ${experiment.claimHoldbacks}, observation failures ` +
      `${experiment.observationFailures}`
    );
    for (const [reason, count] of Object.entries(experiment.observationFailureReasons || {})) {
      lines.push(`    - observation ${reason}: ${count}`);
    }
    if (experiment.protocol) {
      lines.push(
        `  protocol duplicates: ${experiment.protocol.duplicateOpportunityUnits} extra opportunity ` +
        `unit(s) across ${experiment.protocol.tasksWithMultipleOpportunities} task(s); ` +
        `orphan opens ${experiment.protocol.orphanOpenWindows}, ` +
        `orphan closes ${experiment.protocol.orphanClosedWindows}`
      );
    }
    if (experiment.missingAssignmentModeEvents) {
      lines.push(
        `  excluded causal rows missing assignmentMode: ${experiment.missingAssignmentModeEvents}`
      );
    }
    for (const failure of experiment.attritionFailures || []) {
      lines.push(`  attrition: ${failure}`);
    }
    if (experiment.operationDuration) {
      lines.push(
        `  instrumented experiment-state operation: p50 ${fmtMs(experiment.operationDuration.p50)}, ` +
        `p95 ${fmtMs(experiment.operationDuration.p95)}, ` +
        `p99 ${fmtMs(experiment.operationDuration.p99)}`
      );
    }
    lines.push(`  ${experiment.outcomeBoundary}`);
  }

  if (card.latency && card.latency.measurementBoundary) {
    lines.push("");
    lines.push(`Latency measurement boundary: ${card.latency.measurementBoundary}`);
  }

  if (card.gaps && card.gaps.length) {
    lines.push("");
    lines.push("Accrual gaps");
    for (const gap of card.gaps) lines.push(`  - ${gap}`);
  }
  return lines.join("\n");
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
  if (f.syncAttempts > 0) {
    lines.push(
      `  sync rescues:   ${f.syncRescues} of ${f.syncAttempts} sync-rescan attempts ` +
      `(stale reads converted to fresh injections in-hook)`
    );
  }
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
    if (r.deduped) {
      lines.push(
        `  deduped:        ${r.deduped}  (armed turns whose block repeated the previous one — ` +
        `counted so the arm denominator stays unbiased)`
      );
    }
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

  // Blast-radius lane (docs/016): shown only once lane events exist, so a
  // pre-lane install's output is unchanged.  Gated on emissions OR scored
  // opens (the VH-1 lesson: rotation can strand path events in a window whose
  // injected events moved to .old — never hide the number exactly when volume
  // is high).
  const bScored = sum.blastradius
    ? sum.blastradius.pathHits + sum.blastradius.pathMisses
    : 0;
  if (sum.blastradius && (sum.blastradius.injected > 0 || bScored > 0)) {
    lines.push("");
    lines.push("Blast radius (post-edit injections)");
    const b = sum.blastradius;
    lines.push(
      `  injected:       ${b.injected}${b.rollupNotes > 0 ? `  (${b.rollupNotes} with dir rollup)` : ""}`
    );
    lines.push(
      `  surfaced paths: ${b.dependentsSurfaced} dependents, ${b.cochangeSurfaced} co-change partners`
    );
    // Open-attribution (docs/017 lever #1).  Same VH-2 discipline as the
    // retrieval substrate: the caveat travels with the number.
    if (bScored > 0) {
      lines.push(
        `  open-precision: ${fmtPct(b.pathHits, bScored)}  (${b.pathHits} hit / ${bScored} scored file-touches after a note)`
      );
      lines.push(
        `  caveat: correlational (no holdback on this lane) + session-cumulative precision — ` +
        `misses include touches of files no note ever named; a low % is not "the notes are wrong."`
      );
      if (Object.keys(b.pathHitsBySource).length) {
        lines.push("  path_hit by source:");
        for (const [src, c] of Object.entries(b.pathHitsBySource).sort((a2, b2) => b2[1] - a2[1])) {
          lines.push(`    - ${src.padEnd(28)} ${c}  (${fmtPct(c, b.pathHits)})`);
        }
      }
    }
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
    // LEAD WITH THE TURN-LEVEL RATE (docs/033 Tier 1 #1). open-precision below
    // divides by every file touched after an injection, so it tracks session
    // shape more than retrieval quality — it fell 34.4% -> 1.6% while opens/turn
    // rose 3.4 -> 28.4 with the surfaced-set size flat. The turn rate is bounded
    // and comparable across windows; it is the number to trend.
    if (r.turnsScored > 0) {
      lines.push(
        `  turn hit-rate: ${fmtPct(r.turnsWithHit, r.turnsScored)}  ` +
        `(${r.turnsWithHit} of ${r.turnsScored} injection turns had >=1 surfaced file opened)`
      );
      if (r.medianFirstTouchRank != null) {
        lines.push(
          `  median first-touch rank: ${r.medianFirstTouchRank}  ` +
          `(position of the first hit among that turn's scored opens)`
        );
      }
      renderTurnArms(lines, r);
    }
    if (r.turnUnscoredOpens > 0) {
      lines.push(
        `  turn-unscored opens: ${r.turnUnscoredOpens}  ` +
        `(recorded before the turn stamp shipped — excluded from the turn rate, not folded in)`
      );
    }
    lines.push(
      `  open-precision: ${fmtPct(r.pathHits, r.pathHits + r.pathMisses)}  ` +
      `(${r.pathHits} hit / ${r.pathHits + r.pathMisses} scored opens)` +
      `  [session-shape sensitive — see turn hit-rate above]`
    );
    // The "baseline pending" half of the caveat is only honest UNTIL a holdback
    // arm provides the counterfactual; once benefitDelta exists AT VOLUME, drop
    // it and keep only the precision-flavored half (still load-bearing — VH-2).
    // Volume gate mirrors check-holdback-benefit.sh's SEXTANT_HOLDBACK_MIN:
    // benefitDelta computes from the first scored open per arm, but a precision
    // at n=1 is noise — rendering it as "the causal lift" misleads (73 days of
    // 20%-on-one-repo accrued exactly 1 holdback turn). JSON keeps the raw
    // value; only the human-readable claim is gated.
    const counts = r.armCounts || {};
    const armedScored = (counts.armed || {}).scored || 0;
    const holdbackScored = (counts.holdback || {}).scored || 0;
    // ALSO gate on the RANDOMIZATION unit (docs/033 Tier 3). docs/033 §4 named
    // the analysis-unit mismatch a defect — "benefitDelta would become citable
    // while remaining statistically wrong" — and Tier 1 #3 added the correct
    // turn-level metric but left this per-OPEN claim able to graduate on its
    // own. With ~28 opens/turn it clears an opens floor of 30 after ONE
    // randomized turn per arm, so the shipped surface could print a DORMANT
    // turn line and an ALL-CAPS causal per-open claim two lines apart. The
    // per-open figure stays (it is a real descriptive number) but it may not
    // call itself causal until the unit the arm was actually randomized at
    // clears its own floor.
    const turnCounts = r.turnCountsByArm || {};
    const armedTurnsForDelta = (turnCounts.armed || {}).turns || 0;
    const holdbackTurnsForDelta = (turnCounts.holdback || {}).turns || 0;
    const deltaAtVolume =
      r.benefitDelta != null &&
      armedScored >= HOLDBACK_MIN_SCORED &&
      holdbackScored >= HOLDBACK_MIN_SCORED &&
      armedTurnsForDelta >= HOLDBACK_MIN_TURNS &&
      holdbackTurnsForDelta >= HOLDBACK_MIN_TURNS;
    if (!deltaAtVolume) {
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
        const n = (counts[arm] || {}).scored || 0;
        lines.push(
          `    - ${arm.padEnd(10)} open-precision ${arms[arm] == null ? "n/a" : (arms[arm] * 100).toFixed(1) + "%"}` +
          `  (n=${n} scored)`
        );
      }
      if (deltaAtVolume) {
        lines.push(
          `  BENEFIT DELTA (armed − holdback): ${(r.benefitDelta * 100).toFixed(1)} pts` +
          ` — the causal open-rate lift the injection buys (counterfactual present).`
        );
      } else if (r.benefitDelta != null) {
        lines.push(
          `  benefit delta: DORMANT (accruing) — holdback n=${holdbackScored}, armed n=${armedScored} scored ` +
          `(${holdbackTurnsForDelta}/${armedTurnsForDelta} turns); need >=${HOLDBACK_MIN_SCORED} opens ` +
          `AND >=${HOLDBACK_MIN_TURNS} turns per arm — turns are the randomization unit.`
        );
      }
    }
  }

  // REGION LANE (docs/025 Phase A) — did the EDIT land in the region we surfaced?
  // region_miss = right file, wrong region: the reclaimable within-file
  // navigation the Phase-A kill criterion measures. Rendered only when an edit of
  // a surfaced in-process-language file was actually scored.
  if (r.regionHits + r.regionMisses > 0) {
    const scored = r.regionHits + r.regionMisses;
    lines.push("");
    lines.push("Region substrate (did the edit land in the region we surfaced?)");
    lines.push(
      `  region-precision: ${fmtPct(r.regionHits, scored)}  ` +
      `(${r.regionHits} in-region / ${scored} scored edits of surfaced files)`
    );
    lines.push(
      `  headroom: ${fmtPct(r.regionMisses, scored)} region_miss — right file, DIFFERENT region ` +
      `(reclaimable within-file navigation). JS/TS only live; python/swift score in eval-trajectory.`
    );
    if (Object.keys(r.regionHitsBySource).length) {
      lines.push("  region_hit by source:");
      for (const [src, c] of Object.entries(r.regionHitsBySource).sort((a, b) => b[1] - a[1])) {
        lines.push(`    - ${src.padEnd(28)} ${c}  (${fmtPct(c, r.regionHits)})`);
      }
    }
    const rArms = r.regionPrecisionByArm || {};
    const rArmKeys = Object.keys(rArms);
    if (rArmKeys.length > 1 || (rArmKeys.length === 1 && rArmKeys[0] !== "armed")) {
      const rCounts = r.regionArmCounts || {};
      lines.push("  by arm (injection-OFF holdback):");
      for (const arm of ["armed", "holdback"]) {
        if (rArms[arm] == null && !(arm in rArms)) continue;
        const n = (rCounts[arm] || {}).scored || 0;
        lines.push(
          `    - ${arm.padEnd(10)} region-precision ${rArms[arm] == null ? "n/a" : (rArms[arm] * 100).toFixed(1) + "%"}` +
          `  (n=${n} scored)`
        );
      }
    }
  }

  // CLAIM LEDGER (docs/028 Phase C) — cache coherence for agent context.
  const cl = sum.claimLedger;
  if (cl && (cl.claimsServed > 0 || cl.contextDeltas > 0 || cl.structuralDeltas > 0 || cl.sprawlNudges > 0)) {
    lines.push("");
    lines.push("Context coherence (claim ledger / structural delta / anti-sprawl)");
    lines.push(`  claims served: ${cl.claimsServed}`);
    lines.push(
      `  context-deltas emitted: ${cl.contextDeltas}  ` +
      `(${cl.deltaChanged} facts re-derived, ${cl.deltaInvalidated} invalidated)`
    );
    lines.push(`  structural deltas (edits that changed exports/imports): ${cl.structuralDeltas}`);
    lines.push(
      `  anti-sprawl nudges (new file → existing matches surfaced): ${cl.sprawlNudges}` +
      `  — did the agent open a suggestion? see blastradius path_hit source=sprawl_match`
    );
  }

  const ma = sum.multiAgentCoherence;
  if (ma && (ma.agentsRegistered > 0 || ma.reportsEligible > 0 || ma.reportsDelivered > 0 || ma.skipped > 0)) {
    lines.push("");
    lines.push("Multi-agent coherence (recorded observation only)");
    lines.push(
      `  recorded capsule generations: ${ma.agentsRegistered}; parent-side tool returns: ${ma.agentReturns}`
    );
    lines.push(
      `  reports: ${ma.reportsDelivered}/${ma.reportsEligible} delivered; ` +
      `${ma.overlapPairsDelivered} recorded workset-overlap pair(s)`
    );
    lines.push(
      `  cross-agent claim changes delivered: ${ma.claimsChangedDelivered} changed, ` +
      `${ma.claimsInvalidatedDelivered} invalidated; skipped: ${ma.skipped}`
    );
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
  const wantCoherenceScorecard = hasFlag(process.argv, "--coherence-scorecard");
  const reviewId = flag(process.argv, "--review");
  const includeOld = hasFlag(process.argv, "--include-old") || wantCoherenceScorecard || !!reviewId;
  const tailN = flag(process.argv, "--tail");
  const daysRaw = flag(process.argv, "--days");
  let days = null;
  if (daysRaw != null) {
    days = Number(daysRaw);
    if (!Number.isFinite(days) || days <= 0 || days > 3650) {
      throw new Error("--days must be greater than 0 and at most 3650");
    }
  }
  let exposeCoherence = false;
  try {
    exposeCoherence = require("../lib/coherence").coherenceEnabled(root);
  } catch {}
  const visibleEvents = (events) => exposeCoherence
    ? events
    : events.filter((event) => !String(event && event.name || "").startsWith("coherence."));

  const applyWindow = (events) => {
    if (days == null) return events;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return events.filter((event) => Number.isFinite(event && event.ts) && event.ts >= cutoff);
  };

  const allVisible = visibleEvents(readAllEvents(root, includeOld));

  if (reviewId) {
    if (!exposeCoherence) throw new Error("coherence review is unavailable while the gate is off");
    const verdict = flag(process.argv, "--verdict");
    if (!COHERENCE_FEEDBACK_VERDICTS.has(verdict)) {
      throw new Error(
        "--verdict must be accurate_useful, accurate_noise, false_fact, or unclear"
      );
    }
    const reviewedFindings = Number(flag(process.argv, "--reviewed-findings"));
    if (!Number.isInteger(reviewedFindings) || reviewedFindings <= 0 || reviewedFindings > 1000) {
      throw new Error("--reviewed-findings must be an integer between 1 and 1000");
    }
    const incidentRows = allVisible.filter((event) =>
      event && event.name === "coherence.report" && event.stage === "analysis" &&
      (event.incidentId === reviewId || event.reportId === reviewId)
    );
    if (incidentRows.length === 0) throw new Error(`unknown coherence incident: ${reviewId}`);
    const reviewableClaimFindings = Math.max(...incidentRows.map((event) =>
      Math.min(
        finiteCount(event.changed) + finiteCount(event.invalidated),
        claimSampleCount(event)
      )
    ));
    if (reviewedFindings > reviewableClaimFindings) {
      throw new Error(
        `--reviewed-findings exceeds the ${reviewableClaimFindings} changed/invalidated ` +
        `claim finding(s) in ${reviewId}`
      );
    }
    const incident = incidentRows.find((event) => event.taskKey) || incidentRows[0];
    telemetry.recordEvent(root, "coherence.feedback", {
      schemaVersion: 1,
      incidentId: reviewId,
      taskKey: incident.taskKey || null,
      verdict,
      reviewedFindings,
    });
    process.stdout.write(
      `recorded coherence review ${reviewId}: ${verdict} (${reviewedFindings} finding(s))\n`
    );
    return;
  }

  if (tailN) {
    // Raw-event mode: print the last N events as JSON lines, no aggregation.
    // Useful for `jq` post-processing or eyeballing recent activity.
    const n = Math.max(1, parseInt(tailN, 10) || 50);
    const events = applyWindow(allVisible);
    const slice = events.slice(-n);
    for (const e of slice) process.stdout.write(JSON.stringify(e) + "\n");
    return;
  }

  const events = applyWindow(allVisible);
  const summary = summarize(events);

  if (wantCoherenceScorecard) {
    const scorecard = summary.multiAgentCoherence.scorecard;
    if (wantJson) {
      process.stdout.write(JSON.stringify({ root, days, ...scorecard }, null, 2) + "\n");
    } else {
      process.stdout.write(printCoherenceScorecard(root, scorecard) + "\n");
    }
    return;
  }

  if (wantJson) {
    process.stdout.write(JSON.stringify({ root, ...summary }, null, 2) + "\n");
    return;
  }

  process.stdout.write(printSummary(root, summary) + "\n");
}

module.exports = {
  run,
  summarize,
  percentile,
  printSummary,
  coherenceScorecard,
  printCoherenceScorecard,
  wilsonLowerBound,
  wilsonInterval,
  coherenceExperimentScorecard,
  COHERENCE_THRESHOLDS,
};
