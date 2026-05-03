const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const intel = require("../lib/intel");
const { deriveSessionKey } = require("../lib/session");
const { stripUnsafeXmlTags, renderStatusLine, readStdinJson, applyFreshnessGate } = require("../lib/cli");
const { shouldRetrieve, hasIdentifierShape } = require("../lib/classifier");
const { mergeResults } = require("../lib/merge-results");
const { formatRetrieval } = require("../lib/format-retrieval");

// ARCHITECTURE: Query-aware UserPromptSubmit hook.
//
// Flow:
//   1. Classify the prompt — should we search or just inject static summary?
//   2. If search: graph retrieval (exports, re-exports, paths) + Zoekt HTTP
//   3. Merge, format, dedupe, inject as <codebase-retrieval>
//   4. If no results or classifier says skip: fall back to static summary
//
// CRITICAL CONSTRAINTS:
//   - Must NEVER throw (all errors caught and degraded gracefully)
//   - Total latency < 200ms (benchmarked: 35-70ms for graph+zoekt)
//   - stdout → Claude context, stderr → nowhere visible
//   - If classifier says skip, preserve existing static summary behavior
//
// LATENCY NOTE: intel.health() takes ~140ms (it calls init → loadDb → summary.health).
// We run it concurrently with the retrieval pipeline so it doesn't add to total latency.
// The status line (stderr) is purely diagnostic — nobody sees it — so it's fine if
// it resolves after the retrieval output is already written to stdout.

function tryReadFile(p) {
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Inject the static summary.md if it has changed since last injection.
 * Routed through applyFreshnessGate so stale-state graph.db data never
 * reaches Claude as structural claims; on stale, the function returns a
 * minimal body and triggers an async rescan in the background.
 *
 * Async because applyFreshnessGate calls graph.loadDb() (cached, but the
 * call is async).  All three callers in this file already run inside the
 * async run() flow.
 */
async function injectStaticSummary(root, data) {
  const summaryPath = path.join(root, ".planning", "intel", "summary.md");

  if (!fs.existsSync(summaryPath)) return;

  const rawSummary = tryReadFile(summaryPath);
  if (!rawSummary) return;

  // WHY: applyFreshnessGate inspects HEAD + git status hash + scanner /
  // schema versions.  If any have moved since the last persist, it
  // discards rawSummary and returns a minimal body with only safe fields
  // (root, git head, signals, recent commits, "rescan requested|pending"
  // marker).  See lib/cli.js for the full contract.
  const summary = await applyFreshnessGate(rawSummary, root);

  const sessionKey = deriveSessionKey(data);
  const cachePath = path.join(
    root,
    ".planning",
    "intel",
    // WHY: Separate cache namespace from retrieval path to prevent alternating
    // code/non-code prompts from invalidating each other's dedupe hash.
    `.last_injected_hash.summary.${sessionKey}`
  );

  const h = crypto.createHash("sha256").update(summary).digest("hex");
  const last = tryReadFile(cachePath);

  if (last === h) return;

  try {
    fs.writeFileSync(cachePath, h);
  } catch {}

  const safe = stripUnsafeXmlTags(summary);
  process.stdout.write(
    `<codebase-intelligence>\n(refreshed: ${new Date().toISOString()})\n${safe}\n</codebase-intelligence>`
  );
}

/**
 * Write status line to stderr (diagnostic only — nobody sees it).
 * Runs concurrently with the main pipeline to avoid blocking.
 */
async function writeStatusLine(root) {
  try {
    const health = await intel.health(root);
    process.stderr.write(renderStatusLine(health, false, root) + "\n");
  } catch {
    // Non-critical — don't block the hook
  }
}

async function run() {
  const root = process.cwd();
  const data = await readStdinJson();

  // WHY: Kicked off concurrently (not awaited here) so intel.health's ~140ms
  // doesn't serialize with the main pipeline. We await it at the end of run()
  // so the process doesn't exit before settings.json writes land — earlier
  // versions fired-and-forgot, and because ensureClaudeSettingsUnlocked wrote
  // .claude/settings.json without tmp+rename, a hook that returned fast could
  // truncate the file. Settings writes are now atomic AND conditional, so this
  // is belt-and-suspenders — keep the await anyway so any disk work the
  // status-line path triggers is fully flushed before Node exits.
  const statusLinePromise = writeStatusLine(root);

  const rawPrompt = data.prompt || data.message || "";

  // WHY: cap prompt length before classification + retrieval. Classifier
  // tokenization and downstream rg/zoekt queries scan the whole string;
  // a runaway prompt (paste of a giant log, etc.) would stretch latency
  // well past the hook budget. 8 KB is more than any real coding
  // question; trim from the start so the most recent text wins.
  const MAX_PROMPT_CHARS = 8192;
  const prompt = rawPrompt.length > MAX_PROMPT_CHARS
    ? rawPrompt.slice(rawPrompt.length - MAX_PROMPT_CHARS)
    : rawPrompt;

  // 1. Classify
  let classification;
  try {
    classification = shouldRetrieve(prompt);
  } catch {
    // Classifier failed — fall back to static summary
    await injectStaticSummary(root, data);
    return;
  }

  if (!classification.retrieve) {
    // Non-code prompt — inject static summary if changed
    await injectStaticSummary(root, data);
    await statusLinePromise;
    return;
  }

  // 2. Graph retrieval + 3. Zoekt retrieval (parallel)
  let graphResults = { files: [], warnings: [] };
  let zoektHits = [];

  // WHY: Run graph and zoekt in parallel since they're independent.
  // Graph uses graph.loadDb() directly (not intel.init()) because init()
  // does migration, settings sync, mkdir, etc. that the hook doesn't need.
  // loadDb() just reads the SQLite file — 51ms cold, 0ms warm. This saves
  // ~90ms compared to going through intel.init() on cold start.
  // Zoekt just reads daemon.json and does an HTTP request.
  const graphPromise = (async () => {
    try {
      const db = await require("../lib/graph").loadDb(root);
      if (db) {
        graphResults = require("../lib/graph-retrieve").graphRetrieve(
          db,
          classification.terms
        );
      }
    } catch {
      // Graph failed — graphResults stays empty
    }
  })();

  // WHY: Zoekt's default syntax treats space-separated tokens as a conjunction
  // at the document level.  For a query like "extractImports function", it
  // returns only files that contain BOTH terms — which is usually a single
  // hub file (e.g. intel.js, which has dozens of `function` keywords AND
  // imports extractImports once) and excludes the actual definition files
  // (extractor.js, extractors/javascript.js) whose only `function` occurrence
  // is the def line itself.  Filter to identifier-shaped terms for the zoekt
  // query when any exist — those are the signal; plain words like "function"
  // are grammatical filler that drown the real symbols.  Graph retrieval
  // still uses all terms (cheap, covers the "concept" case).
  const identifierTerms = classification.terms.filter(hasIdentifierShape);
  const zoektQuery = (identifierTerms.length > 0 ? identifierTerms : classification.terms).join(" ");

  const zoektPromise = (async () => {
    try {
      const zoektResult = await require("../lib/zoekt").searchFast(
        root,
        zoektQuery
      );
      zoektHits = (zoektResult && zoektResult.hits) || [];
    } catch {
      // Zoekt not available — zoektHits stays empty
    }
  })();

  await Promise.all([graphPromise, zoektPromise]);

  // 4. Merge
  let merged;
  try {
    merged = mergeResults(graphResults, zoektHits, { queryTerms: classification.terms });
  } catch {
    merged = { files: [] };
  }

  // 5. Format
  const maxChars = classification.confidence >= 0.7 ? 1000 : 600;
  let output = "";
  try {
    output = formatRetrieval(merged, { maxChars });
  } catch {
    output = "";
  }

  if (!output || !output.trim()) {
    // No results from either source — fall back to static summary
    await injectStaticSummary(root, data);
    await statusLinePromise;
    return;
  }

  // 6. Dedupe and inject
  const sessionKey = deriveSessionKey(data);
  const cachePath = path.join(
    root,
    ".planning",
    "intel",
    // WHY: Separate cache namespace from static summary path (see injectStaticSummary).
    `.last_injected_hash.retrieval.${sessionKey}`
  );

  const h = crypto.createHash("sha256").update(output).digest("hex");
  const last = tryReadFile(cachePath);

  if (last === h) {
    await statusLinePromise;
    return;
  }

  try {
    fs.writeFileSync(cachePath, h);
  } catch {}

  // WHY: User-visible signal that retrieval actually fired with results.
  // Written only on real injection (not on dedupe, not on static-summary
  // fallback) so the statusline can distinguish "retrieval matched N files"
  // from "no code-relevant prompt" or "no results".  Two-line plaintext
  // so the bash statusline can read it without jq.
  try {
    const fileCount = (merged && Array.isArray(merged.files)) ? merged.files.length : 0;
    const markerPath = path.join(root, ".planning", "intel", ".last_retrieval");
    fs.writeFileSync(markerPath, `${fileCount}\n${Math.floor(Date.now() / 1000)}\n`);
  } catch {}

  const safe = stripUnsafeXmlTags(output);
  process.stdout.write(`<codebase-retrieval>\n${safe}\n</codebase-retrieval>`);
  await statusLinePromise;
}

module.exports = { run };
