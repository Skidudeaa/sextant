"use strict";

// Decision-grade telemetry helpers for Phase F.  These functions deliberately
// know nothing about hook holdback or delivery policy: they only turn a
// coherence observation into stable, flat facts that can be joined later.

const crypto = require("crypto");

const METRICS_SCHEMA_VERSION = 1;
const DEFAULT_SAMPLE_ITEMS = 8;
const DEFAULT_SAMPLE_CHARS = 800;
const MAX_TEXT_CHARS = 240;

function text(value, max = MAX_TEXT_CHARS) {
  return String(value == null ? "" : value)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function nonNegativeInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

// JSON.stringify preserves insertion order, which is not enough for an
// incident identifier assembled by different surfaces.  Sort every object key;
// callers sort set-like arrays before passing them here.
function stableCanonicalize(value) {
  if (value == null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableCanonicalize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableCanonicalize(value[key])}`).join(",")}}`;
  }
  return "null";
}

function digest(namespace, value, length = 24) {
  return crypto
    .createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(String(value))
    .digest("hex")
    .slice(0, length);
}

// Raw runtime task ids can contain user text or provider-specific identifiers.
// They are useful as a join key, but must never enter telemetry verbatim.
function opaqueTaskKey(taskId) {
  if (taskId == null || String(taskId).length === 0) return null;
  return `ctask_${digest("sextant.coherence.task.v1", String(taskId))}`;
}

function resolvedTaskKey(taskId, suppliedKey) {
  const supplied = text(suppliedKey, 96);
  if (/^ctask_[a-f0-9]{24}$/.test(supplied)) return supplied;
  // A caller that accidentally passes a raw id through the taskKey option must
  // still not put it on disk. Treat any non-empty, non-opaque value as raw.
  if (supplied) return opaqueTaskKey(supplied);
  return opaqueTaskKey(taskId);
}

function randomBoundaryId() {
  return `cboundary_${crypto.randomBytes(16).toString("hex")}`;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function claimSubject(item) {
  const claim = item && item.claim ? item.claim : item;
  const subject = claim && claim.subject && typeof claim.subject === "object"
    ? claim.subject
    : {};
  return {
    claimId: text(claim && claim.id, 96) || null,
    path: text(subject.path, MAX_TEXT_CHARS) || null,
    symbol: text(subject.symbol, 160) || null,
  };
}

function claimFinding(kind, agentKey, item) {
  const subject = claimSubject(item);
  return {
    kind,
    agentKey: text(agentKey, 96),
    claimId: subject.claimId,
    path: subject.path,
    symbol: subject.symbol,
    reason: text(item && item.reason, 96) || null,
    from: text(item && item.from, 160) || null,
    to: text(item && item.to, 160) || null,
    servedFileHash: text(item && item.claim && item.claim.fileHash, 96) || null,
    observedFileHash: text(item && item.observedFileHash, 96) || null,
    observedKind: text(item && item.observedKind, 32) || null,
  };
}

function canonicalPair(overlap) {
  const agents = [text(overlap && overlap.agentA, 96), text(overlap && overlap.agentB, 96)]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  if (agents.length !== 2 || agents[0] === agents[1]) return null;
  const paths = [...new Set(array(overlap.sharedPaths).map((item) => text(item)).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  const regions = [...new Set(array(overlap.sharedRegions).map((item) => text(item)).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  const sharedPathTotal = Math.max(nonNegativeInt(overlap.sharedPathTotal), paths.length);
  const sharedRegionTotal = Math.max(nonNegativeInt(overlap.sharedRegionTotal), regions.length);
  if (sharedPathTotal === 0 && sharedRegionTotal === 0) return null;
  return {
    kind: "overlap",
    agentA: agents[0],
    agentB: agents[1],
    sharedPaths: paths,
    sharedRegions: regions,
    sharedPathTotal,
    sharedRegionTotal,
  };
}

function crossAgentClaimGroups(result) {
  const current = text(result && result.currentAgentKey, 96);
  return array(result && result.agentClaims).filter((group) => {
    const agentKey = text(group && group.agentKey, 96);
    return agentKey && (!current || agentKey !== current);
  });
}

function uniqueSortedFindings(findings) {
  const byCanonical = new Map();
  for (const finding of findings) {
    const canonical = stableCanonicalize(finding);
    if (!byCanonical.has(canonical)) byCanonical.set(canonical, finding);
  }
  return [...byCanonical.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, finding]) => finding);
}

// Canonical report findings intentionally exclude the current agent's claims:
// its local claim ledger owns those.  Unchanged and unknown claims remain
// analysis denominators, not report incidents, because the Phase-F renderer
// does not deliver them as findings.
function canonicalReportFindings(result) {
  const findings = [];
  for (const group of crossAgentClaimGroups(result)) {
    for (const item of array(group.changed)) {
      findings.push(claimFinding("changed", group.agentKey, item));
    }
    for (const item of array(group.invalidated)) {
      findings.push(claimFinding("invalidated", group.agentKey, item));
    }
  }
  for (const overlap of array(result && result.overlaps)) {
    const pair = canonicalPair(overlap);
    if (pair) findings.push(pair);
  }
  return uniqueSortedFindings(findings);
}

// Content fingerprints are evidence for factual review, not incident identity.
// A semantic claim failure must keep the same incident id when an unrelated
// edit changes the current file hash. Keep the hashes in findingSample while
// projecting only stable claim meaning into the canonical id.
function incidentIdentityFinding(finding) {
  if (!finding || finding.kind === "overlap") return finding;
  return {
    kind: finding.kind,
    agentKey: finding.agentKey,
    claimId: finding.claimId,
    path: finding.path,
    symbol: finding.symbol,
    reason: finding.reason,
    from: finding.from,
    to: finding.to,
  };
}

function reportIncidentId(result, options = {}) {
  const findings = uniqueSortedFindings(
    canonicalReportFindings(result).map(incidentIdentityFinding)
  );
  if (findings.length === 0) return null;
  const taskKey = resolvedTaskKey(result && result.taskId, options.taskKey);
  const canonical = stableCanonicalize({ taskKey: taskKey || null, findings });
  return `cincident_${digest("sextant.coherence.incident.v1", canonical)}`;
}

function analysisCounts(result) {
  const groups = crossAgentClaimGroups(result);
  const hasGroups = Array.isArray(result && result.agentClaims);
  const fallbackTotals = result && result.totals && typeof result.totals === "object"
    ? result.totals
    : {};
  const sum = (field) => groups.reduce((total, group) => total + array(group[field]).length, 0);
  const overlaps = array(result && result.overlaps)
    .map(canonicalPair)
    .filter(Boolean);
  const agentKeys = new Set();
  for (const agent of array(result && result.agents)) {
    const key = text(agent && agent.agentKey, 96);
    if (key) agentKeys.add(key);
  }
  if (agentKeys.size === 0) {
    for (const group of array(result && result.agentClaims)) {
      const key = text(group && group.agentKey, 96);
      if (key) agentKeys.add(key);
    }
  }
  const current = text(result && result.currentAgentKey, 96);
  const overlapPairTotal = Math.max(
    nonNegativeInt(result && result.overlapPairTotal),
    overlaps.length
  );
  const changed = hasGroups ? sum("changed") : nonNegativeInt(fallbackTotals.changed);
  const invalidated = hasGroups ? sum("invalidated") : nonNegativeInt(fallbackTotals.invalidated);
  return {
    snapshots: nonNegativeInt(result && result.snapshotCount),
    agents: agentKeys.size,
    crossAgents: current && agentKeys.has(current) ? Math.max(0, agentKeys.size - 1) : agentKeys.size,
    unchanged: hasGroups ? sum("unchanged") : nonNegativeInt(fallbackTotals.unchanged),
    changed,
    invalidated,
    unknown: hasGroups ? sum("unknown") : nonNegativeInt(fallbackTotals.unknown),
    overlapPairs: overlapPairTotal,
    overlapPairsObserved: overlaps.length,
    sharedPaths: overlaps.reduce((total, item) => total + item.sharedPathTotal, 0),
    sharedRegions: overlaps.reduce((total, item) => total + item.sharedRegionTotal, 0),
    reportFindings: changed + invalidated + overlapPairTotal,
  };
}

function sampleProjection(finding) {
  if (finding.kind === "overlap") {
    return {
      kind: finding.kind,
      agentA: finding.agentA,
      agentB: finding.agentB,
      sharedPathTotal: finding.sharedPathTotal,
      sharedRegionTotal: finding.sharedRegionTotal,
      path: finding.sharedPaths[0] || null,
      region: finding.sharedRegions[0] || null,
    };
  }
  return {
    kind: finding.kind,
    agentKey: finding.agentKey,
    path: finding.path,
    symbol: finding.symbol,
    reason: finding.reason,
    from: finding.from,
    to: finding.to,
    servedFileHash: finding.servedFileHash,
    observedFileHash: finding.observedFileHash,
    observedKind: finding.observedKind,
  };
}

// `findingSample` is a JSON string rather than a nested array so the telemetry
// row remains flat.  Both item count and encoded length are hard bounds.
function boundedFactualSample(result, options = {}) {
  const maxItems = positiveInt(options.maxItems, DEFAULT_SAMPLE_ITEMS);
  const maxChars = positiveInt(options.maxChars, DEFAULT_SAMPLE_CHARS);
  const candidates = canonicalReportFindings(result)
    // Manual factual review concerns changed/invalidated claims. Preserve those
    // before overlap rows when the bounded sample cannot fit every finding.
    .sort((a, b) => Number(a.kind === "overlap") - Number(b.kind === "overlap"))
    .map(sampleProjection);
  const chosen = [];
  let encoded = "[]";
  for (const candidate of candidates) {
    if (chosen.length >= maxItems) break;
    const next = stableCanonicalize([...chosen, candidate]);
    if (next.length > maxChars) continue;
    chosen.push(candidate);
    encoded = next;
  }
  return {
    findingSample: encoded,
    findingSampleCount: chosen.length,
    findingSampleTruncated: chosen.length < candidates.length,
  };
}

function commonAnalysisPayload(result, options = {}) {
  const taskKey = resolvedTaskKey(result && result.taskId, options.taskKey);
  return {
    schemaVersion: METRICS_SCHEMA_VERSION,
    taskKey,
    incidentId: reportIncidentId(result, { taskKey }),
    boundaryId: text(options.boundaryId, 96) || null,
    surface: text(options.surface, 64) || null,
    ...analysisCounts(result),
    ...boundedFactualSample(result, options),
  };
}

function buildAnalysisPayload(result, options = {}) {
  return commonAnalysisPayload(result, options);
}

// Analysis itself is a decision-grade denominator. If a hook cannot produce a
// result, emit a flat zero-finding attempt so healthy traffic cannot hide the
// missing observation. Callers add stage/outcome/reason at the boundary.
function buildFailedAnalysisPayload(details = {}) {
  return {
    schemaVersion: METRICS_SCHEMA_VERSION,
    taskKey: resolvedTaskKey(details.taskId, details.taskKey),
    incidentId: null,
    boundaryId: text(details.boundaryId, 96) || randomBoundaryId(),
    surface: text(details.surface, 64) || null,
    snapshots: 0,
    agents: 0,
    crossAgents: 0,
    unchanged: 0,
    changed: 0,
    invalidated: 0,
    unknown: 0,
    overlapPairs: 0,
    overlapPairsObserved: 0,
    sharedPaths: 0,
    sharedRegions: 0,
    reportFindings: 0,
    findingSample: "[]",
    findingSampleCount: 0,
    findingSampleTruncated: false,
  };
}

function buildDeliveryPayload(result, delivered = {}, options = {}) {
  const eligible = analysisCounts(result);
  const deliveredChanged = nonNegativeInt(delivered.changed);
  const deliveredInvalidated = nonNegativeInt(delivered.invalidated);
  const deliveredUnknown = nonNegativeInt(delivered.unknown);
  const deliveredOverlapPairs = nonNegativeInt(delivered.overlapPairs);
  const deliveredFindings = deliveredChanged + deliveredInvalidated + deliveredOverlapPairs;
  return {
    ...commonAnalysisPayload(result, options),
    deliveredChanged,
    deliveredInvalidated,
    deliveredUnknown,
    deliveredOverlapPairs,
    deliveredFindings,
    deliveryComplete: deliveredFindings >= eligible.reportFindings,
  };
}

function buildLifecyclePayload(details = {}) {
  const boundaryId = text(details.boundaryId, 96) || randomBoundaryId();
  return {
    schemaVersion: METRICS_SCHEMA_VERSION,
    taskKey: opaqueTaskKey(details.taskId),
    boundaryId,
    agentKey: text(details.agentKey, 96) || null,
    parentAgentKey: text(details.parentAgentKey, 96) || null,
    stage: text(details.stage, 32) || null,
    kind: text(details.kind, 32) || null,
    state: text(details.state, 64) || null,
    outcome: text(details.outcome, 64) || null,
    reason: text(details.reason, 96) || null,
    generation: nonNegativeInt(details.generation),
    claims: nonNegativeInt(details.claims),
    worksetPaths: nonNegativeInt(details.worksetPaths),
    durationMs: nonNegativeInt(details.durationMs),
  };
}

module.exports = {
  METRICS_SCHEMA_VERSION,
  DEFAULT_SAMPLE_ITEMS,
  DEFAULT_SAMPLE_CHARS,
  stableCanonicalize,
  opaqueTaskKey,
  randomBoundaryId,
  canonicalReportFindings,
  reportIncidentId,
  analysisCounts,
  boundedFactualSample,
  buildAnalysisPayload,
  buildFailedAnalysisPayload,
  buildDeliveryPayload,
  buildLifecyclePayload,
};
