"use strict";

// EVIDENCE CLOSURE (docs/029 Phase D).
//
// Agents stop when code "looks done." Sextant should not pronounce a change
// correct — it should report what HAS and HAS NOT been substantiated. This
// assembles a factual closure report from the capsule (Phase B), the claim
// ledger (Phase C), the structural deltas recorded on edit (Phase D
// touchedRegions), and the session's observed-file set (the blast-radius touched
// state). It states evidence + gaps only: never "safe to merge / tests covered /
// change is correct" — those would be unsupported claims (degrade, don't guess).

const fs = require("fs");
const path = require("path");
const capsuleLib = require("./capsule");
const claimsLib = require("./claims");

// The session's OBSERVED set: files the agent read/edited (blast-radius `touched`).
function readTouchedSet(root, sessionId) {
  try {
    const p = path.join(root, ".planning", "intel", `.blastradius.${sessionId}`);
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    return new Set(Array.isArray(parsed.touched) ? parsed.touched : []);
  } catch {
    return new Set();
  }
}

// Hazard notes render as "path high fan-in (N)" — recover the path.
function hazardPath(note) {
  const m = /^(\S+)\s+high fan-in/.exec(String(note || ""));
  return m ? m[1] : null;
}

function buildClosure(root, opts = {}) {
  const capsule = opts.sessionKey
    ? capsuleLib.readCapsule(root, opts.sessionKey)
    : capsuleLib.readLatestCapsule(root);
  if (!capsule) return { none: true };

  const ws = capsule.workset || {};
  const touched = readTouchedSet(root, capsule.sessionId);

  // Structural changes recorded during the task (Phase D touchedRegions).
  const tr = Array.isArray(capsule.touchedRegions) ? capsule.touchedRegions : [];
  let exAdd = 0, exRem = 0, imAdd = 0, imRem = 0;
  const changedFiles = [];
  for (const t of tr) {
    const ea = t.exportsAdded || [], er = t.exportsRemoved || [], ia = t.importsAdded || [], ir = t.importsRemoved || [];
    exAdd += ea.length; exRem += er.length; imAdd += ia.length; imRem += ir.length;
    changedFiles.push({ path: t.path, exportsAdded: ea, exportsRemoved: er, importsAdded: ia, importsRemoved: ir });
  }

  // Context consistency (Phase C): re-check the served claims NOW.
  let claimDiff = { unchanged: [], changed: [], invalidated: [] };
  try {
    claimDiff = claimsLib.diffClaims(root, capsule.servedClaims || []);
  } catch {}

  // Directly-connected witnesses observed vs not.
  const witnesses = (ws.witnesses || []).map((w) => w.path).filter(Boolean);
  const witnessesObserved = witnesses.filter((w) => touched.has(w));
  const witnessesUnobserved = witnesses.filter((w) => !touched.has(w));

  // Affected surfaces = primary + high-fan-in hazard files; inspected vs not.
  const primary = (ws.primary || []).map((p) => p.path).filter(Boolean);
  const hazards = (ws.hazards || []).map(hazardPath).filter(Boolean);
  const consumers = [...new Set([...primary, ...hazards])];
  const consumersInspected = consumers.filter((c) => touched.has(c));
  const consumersNotInspected = consumers.filter((c) => !touched.has(c));

  const fr = capsuleLib.capsuleFreshness(root, capsule);

  return {
    taskId: capsule.taskId,
    intent: (capsule.intent && capsule.intent.text) || "",
    repo: capsule.repo || {},
    fingerprintCurrent: fr.fresh,
    fingerprintReason: fr.reason,
    changedFiles,
    structural: { exportsAdded: exAdd, exportsRemoved: exRem, importsAdded: imAdd, importsRemoved: imRem },
    claims: { unchanged: claimDiff.unchanged.length, changed: claimDiff.changed.length, invalidated: claimDiff.invalidated.length },
    witnessesObserved,
    witnessesUnobserved,
    consumersInspected,
    consumersNotInspected,
    unknowns: ws.unknowns || [],
    touchedCount: touched.size,
  };
}

function renderClosure(r) {
  if (r.none) {
    return "No task capsule found for this repo (capsule mode off, or no retrieval turn yet). Enable `capsule: true` and run a code prompt first.";
  }
  const L = [];
  L.push(`TASK CLOSURE REPORT — ${r.taskId}`);
  L.push(`Intent: ${r.intent || "(none declared)"}`);
  L.push(
    `Repository: ${(r.repo.branch) || "?"} @ ${String(r.repo.head || "").slice(0, 7)} — ` +
    `fingerprint ${r.fingerprintCurrent ? "current" : "MOVED (" + r.fingerprintReason + ")"}`
  );
  L.push("");
  L.push(`Changed files (observable structure): ${r.changedFiles.length}`);
  for (const f of r.changedFiles.slice(0, 20)) {
    const parts = [];
    if (f.exportsAdded.length) parts.push(`+exports ${f.exportsAdded.join(", ")}`);
    if (f.exportsRemoved.length) parts.push(`-exports ${f.exportsRemoved.join(", ")}`);
    if (f.importsAdded.length) parts.push(`+imports ${f.importsAdded.join(", ")}`);
    if (f.importsRemoved.length) parts.push(`-imports ${f.importsRemoved.join(", ")}`);
    L.push(`  ${f.path}: ${parts.join("; ") || "changed"}`);
  }
  L.push(
    `Structural totals: +${r.structural.exportsAdded}/-${r.structural.exportsRemoved} exports, ` +
    `+${r.structural.importsAdded}/-${r.structural.importsRemoved} imports`
  );
  L.push("");
  L.push(
    `Context consistency (served facts): ${r.claims.unchanged} unchanged, ` +
    `${r.claims.changed} re-derived, ${r.claims.invalidated} invalidated since served`
  );
  L.push("");
  const witTotal = r.witnessesObserved.length + r.witnessesUnobserved.length;
  L.push(`Directly-connected witnesses (tests/fixtures): ${witTotal}`);
  if (r.witnessesObserved.length) L.push(`  observed (read/edited): ${r.witnessesObserved.join(", ")}`);
  if (r.witnessesUnobserved.length) L.push(`  NOT observed: ${r.witnessesUnobserved.join(", ")}`);
  L.push("Affected surfaces (primary + high-fan-in):");
  if (r.consumersInspected.length) L.push(`  inspected: ${r.consumersInspected.join(", ")}`);
  if (r.consumersNotInspected.length) L.push(`  NOT inspected: ${r.consumersNotInspected.join(", ")}`);
  if (r.unknowns.length) {
    L.push("Unknowns (sextant cannot verify):");
    for (const u of r.unknowns) L.push(`  - ${u}`);
  }
  L.push("");
  L.push(
    "This report states the evidence that EXISTS and the connected surfaces NOT observed. " +
    "It does not assert the change is correct, complete, or safe to merge."
  );
  return L.join("\n");
}

module.exports = { buildClosure, renderClosure, readTouchedSet };
