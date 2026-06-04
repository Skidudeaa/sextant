const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const intel = require("../lib/intel");
const { deriveSessionKey } = require("../lib/session");
const { stripUnsafeXmlTags, renderStatusLine, readStdinJson, applyFreshnessGate } = require("../lib/cli");
const { shouldRetrieve, hasIdentifierShape } = require("../lib/classifier");
const { mergeResults } = require("../lib/merge-results");
const { formatRetrieval } = require("../lib/format-retrieval");
const { recordEvent } = require("../lib/telemetry");

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

  // WHY 8 KB tail cap: this hook runs on every UserPromptSubmit inside the
  // ~200ms budget. A runaway paste (whole file, log dump) would blow
  // classification + retrieval latency. Keep the TAIL — the user's actual
  // ask/instruction is almost always at the end of a long paste, not the top.
  const rawPrompt = data.prompt || data.message || "";
  const MAX_PROMPT_BYTES = 8192;
  const prompt =
    rawPrompt.length > MAX_PROMPT_BYTES ? rawPrompt.slice(-MAX_PROMPT_BYTES) : rawPrompt;

  // 1. Classify
  let classification;
  try {
    classification = shouldRetrieve(prompt);
  } catch {
    // Classifier failed — fall back to static summary.  No telemetry here:
    // the classifier threw, so there's no classification decision to record;
    // this is the degraded path, distinct from a deliberate retrieve:false.
    await injectStaticSummary(root, data);
    return;
  }

  // TELEMETRY (T1.3): record the classifier decision for BOTH branches —
  // this is the denominator that makes classifier fire-rate and empty-
  // injection rate measurable. Emitted exactly once per classified prompt,
  // before either branch diverges, so it covers retrieve:true and
  // retrieve:false symmetrically. recordEvent never throws (lib/telemetry.js
  // swallows all I/O errors), so it's safe on the hook hot path.  We
  // deliberately do NOT emit any freshness/stale signal here — that lane is
  // owned by the freshness gate (T1.2).
  recordEvent(root, "retrieval.classified", {
    retrieve: classification.retrieve === true,
    confidence: typeof classification.confidence === "number" ? classification.confidence : 0,
    termCount: Array.isArray(classification.terms) ? classification.terms.length : 0,
  });

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

  // FRESHNESS GATE (T1.2): run checkFreshness CONCURRENTLY with graph+zoekt so
  // it adds no latency — it only reads graph.db meta (cached) + git rev-parse +
  // git status, the same signals applyFreshnessGate uses on the static-summary
  // path.  Resolve defensively: the hook must NEVER throw, so any rejection
  // degrades to fresh (the un-gated v1 behavior).
  const freshnessPromise = require("../lib/freshness").checkFreshness(root);

  await Promise.all([graphPromise, zoektPromise]);

  let freshness = { fresh: true };
  try {
    freshness = await freshnessPromise;
  } catch {
    // checkFreshness rejected — treat as fresh, never block the hook.
  }

  // WHY contentStale (not bare stale) keys the suppressive path: only a CONTENT
  // change (HEAD moved via commit/checkout/rebase, or git-status moved via an
  // edit) can relocate or delete files and invalidate the graph's stored paths.
  // scanner_version_changed / schema_version_changed mean the CODE moved on, not
  // the files — the graph's paths are still valid, and gating on them would tax
  // every routine sextant upgrade, re-introducing the cried-wolf alarm the
  // freshness redesign deliberately deleted ("freshness != age").
  //
  // WHY gate on freshness.contentChanged (NOT on the `reason` value): `reason` is
  // single-valued and version mismatches win the ordering FIRST. So when a sextant
  // upgrade (scanner_version bump) coincides with a checkout that moved/deleted
  // files, reason="scanner_version_changed" MASKS the real content move — the old
  // reason-list check (reason in {head_changed, status_changed}) computed
  // contentStale=FALSE that turn and leaked phantom graph paths until the next
  // turn self-healed. checkFreshness now exposes contentChanged, computed from the
  // HEAD/status delta INDEPENDENT of which reason fired, so a coincident
  // version+content turn is correctly content-stale. A PURE version bump still has
  // contentChanged=false → no suppression (the cried-wolf guard is preserved).
  const stale = freshness.fresh === false;
  const contentStale = stale && freshness.contentChanged === true;

  if (stale) {
    // Mirror the static-summary path: record the stale read and trigger the
    // single-flight async rescan so a code prompt also refreshes the index.
    // Both recordEvent and enqueueRescan are defined to never throw, but guard
    // anyway — the hook must never throw on the hot path.
    try {
      // contentChanged is included for observability so the audit can split
      // "version bump that ALSO moved files" (the masking case T1.2 closes)
      // from a pure version bump. telemetry.js aggregation keys on `reason`
      // only and ignores extra fields, so this is additive.
      recordEvent(root, "retrieval.stale_hit", {
        reason: freshness.reason,
        contentChanged: freshness.contentChanged === true,
      });
    } catch {}
    try {
      require("../lib/freshness").enqueueRescan(root);
    } catch {}
  }

  // 4. Merge — pass contentStale so the merge strips structural authority
  // (graph boost, fusion bonus, def floor) and lets live text dominate.
  let merged;
  try {
    merged = mergeResults(graphResults, zoektHits, {
      queryTerms: classification.terms,
      stale: contentStale,
    });
  } catch {
    merged = { files: [] };
  }

  // CONTENT-STALE PHANTOM DROP (T1.2): a graph-only file (graphSignal != null,
  // zoektHit == null) that no longer exists on disk is a post-checkout phantom
  // — the graph remembers a path the repo no longer has.  Drop it so we never
  // assert a structure that points at a moved/deleted file.  A file with a live
  // zoektHit was just found by text search → it exists → keep it.  We only do
  // this on contentStale because that's the only signal that files can have
  // moved; on fresh/version-stale the graph paths are trustworthy.  If this
  // empties merged.files, the empty-output branch below correctly falls through
  // to empty_fallback + static summary.
  if (contentStale && merged && Array.isArray(merged.files)) {
    merged.files = merged.files.filter((entry) => {
      if (!entry || entry.graphSignal == null || entry.zoektHit != null) return true;
      // WHY repo-relative join: merge entries store the path form graph-retrieve
      // emits, which is repo-relative (e.g. "lib/graph.js"), never absolute.
      // Guard anyway so an unexpected absolute path isn't double-joined into a
      // bogus location and wrongly dropped.
      const rel = String(entry.path || "");
      if (!rel || path.isAbsolute(rel)) return true;
      try {
        return fs.existsSync(path.join(root, rel));
      } catch {
        // existsSync shouldn't throw, but if it does, keep the file rather than
        // silently drop a possibly-valid result.
        return true;
      }
    });
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
    // No results from either source — fall back to static summary.
    // TELEMETRY (T1.3): this is the empty-injection numerator — a prompt the
    // classifier flagged for retrieval (retrieve:true) that yielded nothing,
    // so the static summary is shown instead. Pairing this count against the
    // retrieval.classified{retrieve:true} count gives the empty-injection rate
    // that surfaces NL-recall regressions (cf. the A4 gap).
    recordEvent(root, "retrieval.empty_fallback", {});
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

  // TELEMETRY (T1.3): a non-empty <codebase-retrieval> block is being
  // injected this turn (not a dedupe skip, not a static fallback). Record the
  // injection with its provenance.
  //
  // SOURCE-LABEL RULE: inspect the FINAL merged+ranked files. mergeResults
  // tags each result with `graphSignal` — a non-null hit-type string
  // (exported_symbol / swift_decl_type / reexport_chain / path_match) when the
  // file came from the graph lane, and null when it was zoekt/text-only. If
  // ANY injected file carries a non-null graphSignal, the graph lane
  // contributed to what we're showing → 'graph_merged'; otherwise every file
  // is a pure text hit → 'text_only'. This mirrors merge-results.js, where
  // graphSignal is the single provenance marker on a merged entry.
  const mergedFiles = (merged && Array.isArray(merged.files)) ? merged.files : [];
  const fromGraph = mergedFiles.some((f) => f && f.graphSignal != null);
  recordEvent(root, "retrieval.injected", {
    source: fromGraph ? "graph_merged" : "text_only",
    fileCount: mergedFiles.length,
  });

  // CONTENT-STALE MARKER (T1.2): on a content-stale turn with non-empty output,
  // prepend one honest line INSIDE the block so Claude knows the structural
  // ranking was suppressed and these are live text matches only.  We do NOT
  // prepend on fresh or version-only-stale turns (the cried-wolf guard — a
  // routine scanner/schema bump must stay invisible).  Prepended to the
  // already-stripped `safe` body so the marker text itself can't smuggle XML.
  const safe = stripUnsafeXmlTags(output);
  const STALE_MARKER =
    "⚠ index stale: repo changed since last scan — showing live text matches only, " +
    "structural ranking suppressed; rescan triggered.\n";
  const body = contentStale ? STALE_MARKER + safe : safe;
  process.stdout.write(`<codebase-retrieval>\n${body}\n</codebase-retrieval>`);
  await statusLinePromise;
}

module.exports = { run };
