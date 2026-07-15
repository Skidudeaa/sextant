"use strict";

// TASK CAPSULE renderer (docs/027 Phase B).
//
// Renders the role-based workset (lib/workset.js) into the injected block, and
// returns { text, files } mirroring formatRetrievalDetailed so the Phase-A
// outcome substrate (persisted {path, source, line?, symbol?}) keeps working
// unchanged. Rows are included greedily by KEEP-priority under the char cap
// (unknowns dropped first, primary last), so the persisted set never claims a
// row the cap truncated out — the same invariant formatRetrievalDetailed holds.

const TOOL_REMINDER = "\nUse the `sextant_search` MCP tool for deeper code search.";
const DEFAULT_MAX_CHARS = 1000;

// Section display order (readability) and keep-priority (drop order under cap).
// Lower keepPriority = kept first. Drop order: unknowns → support → witnesses →
// hazards → primary(last).
const SECTIONS = [
  { key: "primary", header: "PRIMARY", keep: 0, isFile: true },
  { key: "hazards", header: "HAZARDS", keep: 1, isFile: false },
  { key: "witnesses", header: "WITNESSES", keep: 2, isFile: true },
  { key: "support", header: "SUPPORT", keep: 3, isFile: true },
  { key: "unknowns", header: "UNKNOWNS", keep: 4, isFile: false },
];

function fileRow(entry) {
  const parts = [];
  if (entry.region && entry.region.name) {
    const r = entry.region;
    const span = Number.isFinite(r.startLine) && Number.isFinite(r.endLine) ? ` (L${r.startLine}–${r.endLine})` : "";
    parts.push(`${r.kind || "region"} ${r.name}${span}`);
  } else if (entry.symbol) {
    parts.push(`defines ${entry.symbol}`);
  } else if (Number.isFinite(entry.line)) {
    parts.push(`L${entry.line}`);
  }
  if (Number.isFinite(entry.fanIn) && entry.fanIn > 0) parts.push(`fan-in: ${entry.fanIn}`);
  const detail = parts.length ? ` — ${parts.join(", ")}` : "";
  return `- \`${entry.path}\`${detail}`;
}

// Flatten a persisted injected-set entry from a workset file entry (already in
// {path, source, line?, symbol?} shape — no re-derivation needed).
function toInjected(entry) {
  const out = { path: entry.path, source: entry.source || "text_only" };
  if (Number.isFinite(entry.line)) out.line = entry.line;
  if (entry.symbol) out.symbol = entry.symbol;
  return out;
}

// Render the capsule. Returns { text, files } — files = the included FILE
// entries (primary+witnesses+support) in persisted-set shape.
function formatCapsule(capsule, opts = {}) {
  const maxChars = opts.maxChars || DEFAULT_MAX_CHARS;
  const ws = (capsule && capsule.workset) || {};

  // Build every candidate row tagged with its section + keep-priority.
  const rows = [];
  for (const sec of SECTIONS) {
    const items = Array.isArray(ws[sec.key]) ? ws[sec.key] : [];
    for (const it of items) {
      if (sec.isFile) {
        if (!it || typeof it.path !== "string") continue;
        rows.push({ sec, text: fileRow(it), entry: it });
      } else {
        if (typeof it !== "string" || !it) continue;
        rows.push({ sec, text: `- ${it}`, entry: null });
      }
    }
  }
  if (!rows.length) return { text: "", files: [] };

  // Greedy include by keep-priority, then original order within a section.
  rows.forEach((r, i) => (r._i = i));
  const byKeep = rows.slice().sort((a, b) => (a.sec.keep - b.sec.keep) || (a._i - b._i));
  const included = new Set();
  const usedSections = new Set();
  const HEADER = "### Task capsule";
  let used = HEADER.length + TOOL_REMINDER.length;
  for (const r of byKeep) {
    const headerCost = usedSections.has(r.sec.key) ? 0 : r.sec.header.length + 1;
    const projected = used + 1 + r.text.length + headerCost;
    if (projected > maxChars && included.size > 0) continue;
    included.add(r._i);
    usedSections.add(r.sec.key);
    used = projected;
  }

  // Render in DISPLAY order, only included rows, headers only for used sections.
  const lines = [HEADER];
  const files = [];
  for (const sec of SECTIONS) {
    const secRows = rows.filter((r) => r.sec.key === sec.key && included.has(r._i));
    if (!secRows.length) continue;
    lines.push(sec.header);
    for (const r of secRows) {
      lines.push(r.text);
      if (sec.isFile && r.entry) files.push(toInjected(r.entry));
    }
  }
  return { text: lines.join("\n") + TOOL_REMINDER, files };
}

module.exports = { formatCapsule, fileRow, DEFAULT_MAX_CHARS };
