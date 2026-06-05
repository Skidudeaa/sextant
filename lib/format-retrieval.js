"use strict";

// ARCHITECTURE: Formats merged retrieval results as compact markdown for injection
// into Claude's context via the UserPromptSubmit hook stdout.
// WHY: The output must be small (~500-1000 chars) because it's injected on every
// code-relevant prompt. Verbose output wastes context budget. Each line carries
// the most useful signal: file path, why it matched, and fan-in as a proxy for
// structural importance.

const DEFAULT_MAX_CHARS = 1000;

// WHY: The tool reminder is a nudge — even if the proactive results don't
// answer the question fully, Claude sees a pointer to the sextant MCP tools
// for deeper queries. Naming the actual MCP tool (`sextant_search`) rather
// than a non-existent CLI verb (`sextant search` was a ghost reference — the
// real CLI command is `sextant retrieve`) makes the hint actionable.
const TOOL_REMINDER = "\nUse the `sextant_search` MCP tool for deeper code search.";

/**
 * Format merged retrieval results as compact markdown for hook injection.
 *
 * @param {{ files: Array<{path: string, graphSignal: string|null, matchedTerms: string[], zoektHit: object|null, fanIn: number, fusedScore: number, parentName?: string|null, startLine?: number|null}> }} mergedResults
 * @param {{ maxChars?: number, textOnly?: boolean }} [opts]
 *   textOnly: content-stale turn — suppress every graph-derived label (exports /
 *   defines / re-exports / path-match) AND fan-in so the lines carry only LIVE
 *   text evidence (the zoekt excerpt). The caller (hook-refresh) sets this when
 *   it has prepended the STALE marker, so the block can't claim structure under
 *   a header that disclaims it. (T1.2 honesty leak fix.)
 * @returns {string} Markdown string, or empty string if no results
 */
function formatRetrieval(mergedResults, opts = {}) {
  const maxChars = opts.maxChars || DEFAULT_MAX_CHARS;
  const textOnly = opts.textOnly === true;
  const files = (mergedResults && mergedResults.files) || [];

  if (files.length === 0) return "";

  const lines = ["### Relevant files"];

  for (const f of files) {
    const line = formatFileLine(f, { textOnly });
    // WHY: Check total length BEFORE adding the line + tool reminder to avoid
    // exceeding maxChars. The +1 accounts for the newline between lines.
    const projected = lines.join("\n").length + 1 + line.length + TOOL_REMINDER.length;
    if (projected > maxChars && lines.length > 1) break;
    lines.push(line);
  }

  // WHY: Build the body WITHOUT the reminder, clamp it, THEN append the reminder
  // exactly once. The old pattern pushed TOOL_REMINDER into lines, then re-appended
  // it on safety clamp — producing a duplicate.
  const body = lines.join("\n");
  const clamped = body.length > maxChars ? body.slice(0, maxChars) : body;
  return clamped + TOOL_REMINDER;
}

/**
 * Render the graph-derived match reason for a Swift declaration hit.
 * `defines` for an authoritative type def (struct/class/protocol/enum/actor/
 * typealias \u2192 graphSignal swift_decl_type); `declares` for a member/extension
 * (swift_decl_other). WHY this exists: the graph's flagship Swift win \u2014 injecting
 * the canonical decl file (e.g. URI.swift) to rank 1 over its own consumer/test
 * files \u2014 previously reached Claude as a *labelless path*, indistinguishable from
 * an incidental filename hit. The strongest signal arrived unexplained.
 *
 * Enrichment (when graph-retrieve threaded the decl's enclosing type + line):
 * `(in <parentName>)` and `L<startLine>` point the agent at the declaration
 * itself, not just the file.
 */
function swiftDeclLabel(verb, f) {
  const terms = (f.matchedTerms || []).join(", ");
  let label = terms ? `${verb} ${terms}` : verb;
  if (f.parentName) label += ` (in ${f.parentName})`;
  if (typeof f.startLine === "number" && f.startLine > 0) label += ` L${f.startLine}`;
  return label;
}

/**
 * Format a single file entry as a markdown list item.
 *
 * @param {object} f - merged result entry
 * @param {{ textOnly?: boolean }} [opts] - textOnly suppresses all graph-derived
 *   provenance (labels + fan-in), leaving only the live zoekt excerpt. See
 *   formatRetrieval's textOnly doc \u2014 the content-stale honesty contract.
 */
function formatFileLine(f, opts = {}) {
  const textOnly = opts && opts.textOnly === true;
  const pathStr = f.path;
  const parts = [];

  // Graph signal description \u2014 a STRUCTURAL claim, so suppressed entirely on a
  // content-stale (textOnly) turn: the prepended STALE marker tells Claude the
  // structural ranking was suppressed, and these labels would contradict it.
  if (!textOnly) {
    if (f.graphSignal === "exported_symbol") {
      const terms = (f.matchedTerms || []).join(", ");
      parts.push(terms ? `exports ${terms}` : "export match");
    } else if (f.graphSignal === "swift_decl_type") {
      parts.push(swiftDeclLabel("defines", f));
    } else if (f.graphSignal === "swift_decl_other") {
      parts.push(swiftDeclLabel("declares", f));
    } else if (f.graphSignal === "reexport_chain") {
      const terms = (f.matchedTerms || []).join(", ");
      parts.push(terms ? `re-exports ${terms}` : "re-export chain");
    } else if (f.graphSignal === "path_match") {
      const terms = (f.matchedTerms || []).join(", ");
      parts.push(terms ? `path match: ${terms}` : "path match");
    }
  }

  // Zoekt hit with line reference \u2014 LIVE text evidence, recomputed every turn,
  // so it survives the textOnly gate (this IS the "live text matches only" set).
  if (f.zoektHit && f.zoektHit.lineNumber) {
    const lineRef = f.zoektHit.line
      ? f.zoektHit.line.trim().slice(0, 60)
      : null;
    if (lineRef) {
      parts.push(`L${f.zoektHit.lineNumber}: ${lineRef}`);
    }
  }

  // Fan-in (graph-derived structural proxy) \u2014 suppressed on a textOnly turn.
  if (!textOnly && f.fanIn > 0) {
    parts.push(`fan-in: ${f.fanIn}`);
  }

  const detail = parts.length > 0 ? ` \u2014 ${parts.join(", ")}` : "";
  return `- \`${pathStr}\`${detail}`;
}

module.exports = { formatRetrieval };
