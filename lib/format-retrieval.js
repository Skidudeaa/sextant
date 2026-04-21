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
 * @param {{ files: Array<{path: string, graphSignal: string|null, matchedTerms: string[], zoektHit: object|null, fanIn: number, fusedScore: number}> }} mergedResults
 * @param {{ maxChars?: number }} [opts]
 * @returns {string} Markdown string, or empty string if no results
 */
function formatRetrieval(mergedResults, opts = {}) {
  const maxChars = opts.maxChars || DEFAULT_MAX_CHARS;
  const files = (mergedResults && mergedResults.files) || [];

  if (files.length === 0) return "";

  const lines = ["### Relevant files"];

  for (const f of files) {
    const line = formatFileLine(f);
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
 * Format a single file entry as a markdown list item.
 */
function formatFileLine(f) {
  const pathStr = f.path;
  const parts = [];

  // Graph signal description
  if (f.graphSignal === "exported_symbol") {
    const terms = (f.matchedTerms || []).join(", ");
    parts.push(terms ? `exports ${terms}` : "export match");
  } else if (f.graphSignal === "reexport_chain") {
    const terms = (f.matchedTerms || []).join(", ");
    parts.push(terms ? `re-exports ${terms}` : "re-export chain");
  } else if (f.graphSignal === "path_match") {
    const terms = (f.matchedTerms || []).join(", ");
    parts.push(terms ? `path match: ${terms}` : "path match");
  }

  // Zoekt hit with line reference
  if (f.zoektHit && f.zoektHit.lineNumber) {
    const lineRef = f.zoektHit.line
      ? f.zoektHit.line.trim().slice(0, 60)
      : null;
    if (lineRef) {
      parts.push(`L${f.zoektHit.lineNumber}: ${lineRef}`);
    }
  }

  // Fan-in (only if meaningful)
  if (f.fanIn > 0) {
    parts.push(`fan-in: ${f.fanIn}`);
  }

  const detail = parts.length > 0 ? ` \u2014 ${parts.join(", ")}` : "";
  return `- \`${pathStr}\`${detail}`;
}

module.exports = { formatRetrieval };
