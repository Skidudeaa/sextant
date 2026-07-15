"use strict";

// CLAIM LEDGER (docs/028 Phase C — the architectural inflection).
//
// Every structural fact sextant injects becomes an addressable CLAIM: a typed
// assertion (subject, predicate, provenance) stamped with the file fingerprint
// it was compiled against. On the NEXT hook event we re-check each claim we
// served this session against the current file on disk and, when one moved or
// vanished, emit a <sextant-context-delta> that RETRACTS the stale fact and
// (for a symbol) reports its new span. That is cache coherence for agent context:
// the agent holds a cached subset of repo claims, and sextant invalidates them
// when the source changes.
//
// v1 scope: single-session coherence, served claims embedded in the per-session
// capsule (lib/capsule.js servedClaims). Cross-session / multi-agent served_claims
// (a shared store) is the Phase F graduation — deltas here land only at the next
// eligible hook (no push channel), per the recon constraint. Facts only; never
// throws.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const regionsLib = require("./regions");

// Provenance taxonomy (the epistemic firewall, vision §13): a claim's authority
// is TYPED, never conflated. direct = AST/graph-derived definition; heuristic =
// filename inference; live_text = a zoekt/text match, not a structural assertion.
function provenanceOf(source) {
  switch (source) {
    case "exported_symbol":
    case "swift_decl_type":
    case "swift_decl_other":
    case "reexport_chain":
      return "direct";
    case "path_match":
      return "heuristic";
    default:
      return "live_text"; // text_only / unknown
  }
}

function hashFile(rootAbs, relPath) {
  try {
    return crypto
      .createHash("sha1")
      .update(fs.readFileSync(path.join(rootAbs, relPath)))
      .digest("hex")
      .slice(0, 16);
  } catch {
    return ""; // unreadable / removed
  }
}

function claimId(row) {
  return "c_" + crypto
    .createHash("sha1")
    .update(`${row.path}|${row.symbol || ""}|${row.line || ""}`)
    .digest("hex")
    .slice(0, 10);
}

// Mint claims from the rows actually SERVED to the agent (the persisted injected
// set / capsule files: {path, source, line?, symbol?, region?}). Each claim
// carries the source file's content hash at serve time — the invalidation anchor.
function mintClaims(rootAbs, rows, opts = {}) {
  const nowMs = typeof opts.nowMs === "number" ? opts.nowMs : Date.now();
  const claims = [];
  for (const r of rows || []) {
    if (!r || typeof r.path !== "string") continue;
    claims.push({
      id: claimId(r),
      subject: {
        path: r.path,
        symbol: r.symbol || null,
        region: r.region || null,
        line: typeof r.line === "number" ? r.line : null,
      },
      predicate: r.symbol ? "defines" : r.region ? "region_at" : "relevant",
      provenance: provenanceOf(r.source),
      fileHash: hashFile(rootAbs, r.path),
      servedAt: nowMs,
    });
  }
  return claims;
}

// Locate a symbol's DEFINITION region in the current file (used to re-derive a
// moved span). Heuristic def-form match (JS/TS/Python) → line → scope-finder
// region. null when the symbol has no locatable definition (removed/renamed).
function locateSymbolRegion(rootAbs, relPath, symbol) {
  if (!symbol) return null;
  let content;
  try {
    content = fs.readFileSync(path.join(rootAbs, relPath), "utf8");
  } catch {
    return null;
  }
  const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const defForms = [
    // `function foo` / `class foo` / `const foo =` / `def foo(` (+ export/async prefixes)
    new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function\\*?\\s+|class\\s+|const\\s+|let\\s+|var\\s+|def\\s+)${esc}\\b`),
    // `foo = function` / `foo: (` (assigned/arrow/method)
    new RegExp(`^\\s*${esc}\\s*[:=]\\s*(?:async\\s+)?(?:function|\\(|[A-Za-z_$])`),
  ];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (defForms.some((re) => re.test(lines[i]))) {
      const region = regionsLib.resolveRegionInContent(relPath, content, i + 1, { allowSpawn: false });
      if (region) return region;
      // Line matched but scope-finder couldn't resolve (unsupported lang): the
      // symbol still EXISTS, so report the def line as a minimal span.
      return { name: symbol, kind: "def", startLine: i + 1, endLine: i + 1 };
    }
  }
  return null;
}

function spanStr(region, line) {
  if (region && Number.isFinite(region.startLine)) {
    return Number.isFinite(region.endLine) && region.endLine !== region.startLine
      ? `L${region.startLine}–${region.endLine}`
      : `L${region.startLine}`;
  }
  return Number.isFinite(line) ? `L${line}` : "?";
}

// Re-check prior served claims against the current repo. Returns
// { unchanged, changed, invalidated }. A claim whose source file is byte-identical
// to serve time is unchanged (cheap hash gate); a changed file triggers re-
// derivation — a moved symbol span → changed(from→to), a vanished symbol → invalidated.
function diffClaims(rootAbs, priorClaims) {
  const out = { unchanged: [], changed: [], invalidated: [] };
  for (const c of priorClaims || []) {
    if (!c || !c.subject || typeof c.subject.path !== "string") continue;
    const curHash = hashFile(rootAbs, c.subject.path);
    if (curHash === "") {
      out.invalidated.push({ claim: c, reason: "file_removed" });
      continue;
    }
    if (curHash === c.fileHash) {
      out.unchanged.push(c);
      continue;
    }
    // File changed since served → re-derive.
    if (c.subject.symbol) {
      const loc = locateSymbolRegion(rootAbs, c.subject.path, c.subject.symbol);
      if (!loc) {
        out.invalidated.push({ claim: c, reason: "symbol_removed" });
        continue;
      }
      const from = spanStr(c.subject.region, c.subject.line);
      const to = spanStr(loc, loc.startLine);
      if (from !== to) out.changed.push({ claim: c, from, to });
      else out.unchanged.push(c); // bytes moved elsewhere in the file; span held
    } else {
      // No symbol anchor — the honest signal is "this file changed, re-check".
      out.changed.push({ claim: c, from: "as served", to: "file changed" });
    }
  }
  return out;
}

// Render the inner text of a <sextant-context-delta> (facts only, no imperatives
// — the orient/subagent discipline). Returns "" when there's nothing to retract.
function renderContextDelta(diff) {
  if (!diff || (!diff.changed.length && !diff.invalidated.length)) return "";
  const lines = ["Since this task was last oriented, sextant re-checked the facts it gave you:"];
  if (diff.invalidated.length) {
    lines.push("INVALIDATED (no longer holds):");
    for (const x of diff.invalidated.slice(0, 10)) {
      const s = x.claim.subject;
      if (x.reason === "symbol_removed") {
        lines.push(`- ${s.path}: ${s.symbol} — definition no longer found (file changed)`);
      } else {
        lines.push(`- ${s.path} — file removed since served`);
      }
    }
  }
  if (diff.changed.length) {
    lines.push("CHANGED (re-derived):");
    for (const x of diff.changed.slice(0, 10)) {
      const s = x.claim.subject;
      if (s.symbol) lines.push(`- ${s.path}: ${s.symbol} span ${x.from} → ${x.to}`);
      else lines.push(`- ${s.path} — changed since served`);
    }
  }
  return lines.join("\n");
}

module.exports = {
  provenanceOf,
  hashFile,
  claimId,
  mintClaims,
  locateSymbolRegion,
  diffClaims,
  renderContextDelta,
};
