const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const intel = require("../lib/intel");
const { deriveSessionKey, rawSessionIdentity } = require("../lib/session");
const {
  stripUnsafeXmlTags,
  renderStatusLine,
  readStdinJson,
  applyBoundFreshnessGateDetailed,
  boundSummaryStillValid,
} = require("../lib/cli");
const { shouldRetrieve, hasIdentifierShape } = require("../lib/classifier");
const { mergeResults } = require("../lib/merge-results");
const { formatRetrievalDetailed } = require("../lib/format-retrieval");
const { recordEvent } = require("../lib/telemetry");

// OUTCOME SUBSTRATE (009 #1): build the {path, source} set persisted per session
// so a later PostToolUse hook can score whether the agent opened/edited what
// retrieval surfaced. source = the signal that SURFACED the file (graphSignal:
// exported_symbol / swift_decl_type / reexport_chain / path_match, or text_only
// for a zoekt/text-only hit) so opens are attributable PER SIGNAL — a single
// un-attributable aggregate was the explicit 009 correction. We record the
// RETRIEVAL reason (why it entered the set), independent of the content-stale
// display strip (that strip governs what Claude SEES; this governs what we
// SURFACED). Exported for unit testing the attribution without a live hook run.
function buildInjectedPaths(includedFiles) {
  const out = [];
  for (const f of includedFiles || []) {
    if (!f || typeof f.path !== "string") continue;
    const entry = { path: f.path, source: f.graphSignal || "text_only" };
    // REGION SUBSTRATE (docs/025 Phase A): carry the positional breadcrumb we
    // ALREADY computed (shown to Claude as `L<n>` / `defines X L<n>`) so the
    // PostToolUse hook can score region-level opens without re-resolving at
    // injection time — hot-path cost stays exactly zero. `line` = the Swift decl
    // start OR the matched zoekt line; `symbol` = the matched term / enclosing
    // type. Purely additive: path-keyed consumers ignore both keys.
    const line =
      typeof f.startLine === "number" && f.startLine > 0
        ? f.startLine
        : f.zoektHit && typeof f.zoektHit.lineNumber === "number" && f.zoektHit.lineNumber > 0
          ? f.zoektHit.lineNumber
          : null;
    if (line != null) entry.line = line;
    // symbol carried only for symbol-BEARING signals (export/decl/re-export) —
    // a path_match's term is a filename token, not a code symbol, so it must not
    // region-match by name (mirrors trajectory.detailSymbol's path_match exclusion).
    const SYMBOL_SOURCES = new Set([
      "exported_symbol",
      "swift_decl_type",
      "swift_decl_other",
      "reexport_chain",
    ]);
    if (SYMBOL_SOURCES.has(f.graphSignal)) {
      const symbol = (Array.isArray(f.matchedTerms) && f.matchedTerms[0]) || f.parentName || null;
      if (symbol) entry.symbol = symbol;
    }
    out.push(entry);
  }
  return out;
}

// HOLDBACK ARM (009 #1 follow-up — the counterfactual that turns open-precision
// from a correlation into a benefit number). On a "holdback" turn we still RUN
// retrieval and still PERSIST the set we would have surfaced (tagged arm:holdback),
// but we do NOT emit the <codebase-retrieval> block — so the PostToolUse hook
// scores the agent's opens WITHOUT our injection. armed-vs-holdback open-rate IS
// the benefit signal (`sextant telemetry`).
//
// DEFAULT-OFF: SEXTANT_HOLDBACK_PCT unset/0 → always "armed" → byte-identical to
// pre-holdback behavior, so a normal install is never degraded. You opt in by
// setting the env var on a dogfooding repo to earn the baseline.
//
// DETERMINISM FOR TESTS: SEXTANT_HOLDBACK_FORCE=armed|holdback (or the stdin
// payload field _holdbackForce) hard-pins the decision so a test can exercise
// either branch without relying on Math.random. The hook is plain Node, so
// Math.random in prod is fine (it would break only the workflow-script harness).
//
// STALE INTERACTION: holdback governs the GRAPH-AUTHORITY contribution, which a
// content-stale turn already suppresses (textOnly + STALE marker). So we never
// hold back on a content-stale turn — that would conflate "we withheld" with
// "the index was stale"; such turns are always armed.
function decideArm(data, contentStale, env = process.env) {
  if (contentStale) return "armed";
  const force =
    (env && env.SEXTANT_HOLDBACK_FORCE) ||
    (data && typeof data._holdbackForce === "string" ? data._holdbackForce : "");
  if (force === "armed" || force === "holdback") return force;
  const pct = parseInt((env && env.SEXTANT_HOLDBACK_PCT) || "0", 10);
  // pct > 100 is a misconfig (e.g. a typo'd "150"), not "always holdback" —
  // fall back to the default-off contract rather than silently locking the
  // install into 100% holdback. pct === 100 stays valid (deliberate always-on).
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return "armed"; // default-off
  return Math.random() * 100 < pct ? "holdback" : "armed";
}

function persistInjectedSet(injPathsFile, payload) {
  try {
    fs.writeFileSync(injPathsFile, JSON.stringify(payload));
  } catch {}
}

// TASK CAPSULE gate (docs/027 Phase B). DEFAULT-OFF: unset → flat block,
// byte-identical to pre-capsule behavior. Canonical impl lives in lib/capsule.js
// (shared with hook-posttooluse so B/C/D turn on together); re-exported here for
// the existing test and call sites.
const { capsuleEnabled } = require("../lib/capsule");

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

// Compare the exact HEAD/status anchors observed by checkFreshness with the
// live repository immediately before publishing graph-derived context.
function sameValidatedRepo(validated, current) {
  if (!validated || !current) return false;
  return (
    (validated.head ?? "") === (current.head ?? "") &&
    (validated.statusHash ?? "") === (current.statusHash ?? "")
  );
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
async function injectStaticSummary(root, data, contextPrefix = "") {
  const summaryPath = path.join(root, ".planning", "intel", "summary.md");
  let summary = "";
  let structuralValidation = null;
  const rawSummary = fs.existsSync(summaryPath) ? tryReadFile(summaryPath) : "";
  // The bound gate also regenerates a missing/corrupt summary manifest from a
  // fresh graph (never by blessing existing bytes). On stale/no-graph state it
  // returns only the graph-free minimal body and schedules the normal rescan.
  const gated = await applyBoundFreshnessGateDetailed(rawSummary || "", root);
  structuralValidation = gated.validation;
  summary = gated.body;
  // A claim retraction is independently useful and safe even when no static
  // summary exists. It may therefore be the entire hook output.
  if (!summary && !contextPrefix) return false;

  const sessionKey = deriveSessionKey(data);
  const cachePath = path.join(
    root,
    ".planning",
    "intel",
    // WHY: Separate cache namespace from retrieval path to prevent alternating
    // code/non-code prompts from invalidating each other's dedupe hash.
    `.last_injected_hash.summary.${sessionKey}`
  );

  const h = crypto
    .createHash("sha256")
    // Preserve the legacy/default-off hash exactly when there is no delta.
    // Existing sessions should not receive a one-time duplicate summary merely
    // because Phase F code was installed but remains disabled.
    .update(contextPrefix ? contextPrefix + "\0" + summary : summary)
    .digest("hex");
  const last = tryReadFile(cachePath);

  if (last === h) return false;

  const summaryBlock = summary
    ? `<codebase-intelligence>\n(refreshed: ${new Date().toISOString()})\n${stripUnsafeXmlTags(summary)}\n</codebase-intelligence>`
    : "";
  if (structuralValidation && !(await boundSummaryStillValid(root, structuralValidation))) {
    recordEvent(root, "freshness.summary_withheld", { reason: "publication_moved" });
    return false;
  }
  // Emit before committing the dedupe marker. If stdout fails, the next prompt
  // must still be eligible to deliver the summary/retraction rather than see a
  // ghost hash for context that never crossed the output boundary.
  process.stdout.write(contextPrefix + summaryBlock);
  try {
    fs.writeFileSync(cachePath, h);
  } catch {}
  return true;
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

  // WHY: hooks adopt cwd — a session running in $HOME / a non-project dir
  // must not grow sextant state here (see lib/root-guard.js). Silent exit:
  // SessionStart already told the model intelligence is OFF for this session,
  // and a per-prompt repeat would be pure noise.
  {
    const { checkRoot } = require("../lib/root-guard");
    if (!checkRoot(root, { requireMarker: true }).ok) process.exit(0);
  }

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

  const sessionKey = deriveSessionKey(data);
  const capsuleOn = capsuleEnabled(root);
  let contextDelta = "";
  let contextDeltaMeta = null;

  // CLAIM LEDGER (Phase C): re-check the PRIOR served baseline at the start of
  // every UserPromptSubmit, not only code-classified prompts. Retractions are
  // disk-based historical facts, so they remain honest on content-stale turns
  // and may be delivered with the static-summary/holdback fallback too.
  if (capsuleOn) {
    try {
      const prior = require("../lib/capsule").readCapsule(root, sessionKey);
      if (prior && Array.isArray(prior.servedClaims) && prior.servedClaims.length) {
        const diff = require("../lib/claims").diffClaims(root, prior.servedClaims);
        contextDelta = require("../lib/claims").renderContextDelta(diff);
        if (contextDelta) {
          contextDeltaMeta = {
            changed: diff.changed.length,
            invalidated: diff.invalidated.length,
          };
        }
      }
    } catch {
      contextDelta = "";
      contextDeltaMeta = null;
    }
  }
  let contextPrefix = contextDelta
    ? `<sextant-context-delta>\n${stripUnsafeXmlTags(contextDelta)}\n</sextant-context-delta>\n`
    : "";

  // PHASE F: compare immutable per-agent boundary snapshots for this task. The
  // report describes only recorded workset overlap and claims that no longer
  // hold; it never attributes an edit, declares a conflict, or coordinates a
  // writer. Running children have no push channel, so this lands at the next
  // parent UserPromptSubmit (this hook) or spawn/join surface.
  let coherenceMeta = null;
  let coherenceTaskId = null;
  let parentKey = null;
  try {
    const coherence = require("../lib/coherence");
    if (coherence.coherenceEnabled(root)) {
      const cap = require("../lib/capsule").readCapsule(root, sessionKey);
      coherenceTaskId = cap && cap.taskId
        ? cap.taskId
        : "task_" + require("../lib/capsule").shortHash(sessionKey);
      parentKey = coherence.parentAgentKey(rawSessionIdentity(data));
      const result = coherence.analyzeCoherence(root, {
        taskId: coherenceTaskId,
        currentAgentKey: parentKey,
      });
      if (coherence.hasFindings(result)) {
        const crossGroups = (result.agentClaims || []).filter(
          (g) => !parentKey || g.agentKey !== parentKey
        );
        recordEvent(root, "coherence.report_eligible", {
          agents: result.snapshotCount,
          overlaps: result.overlapPairTotal,
          changed: crossGroups.reduce((n, g) => n + (g.changed || []).length, 0),
          invalidated: crossGroups.reduce((n, g) => n + (g.invalidated || []).length, 0),
          surface: "parent_prompt",
        });
        const rendered = coherence.renderCoherenceDetailed(result, { maxChars: 800 });
        const text = rendered.text;
        if (text) {
          coherenceMeta = {
            delivered: {
              agents: result.snapshotCount,
              overlaps: rendered.delivered.overlapPairs,
              changed: rendered.delivered.changed,
              invalidated: rendered.delivered.invalidated,
              surface: "parent_prompt",
            },
          };
          contextPrefix +=
            `<sextant-agent-coherence>\n${stripUnsafeXmlTags(text)}\n` +
            `</sextant-agent-coherence>\n`;
        }
      }
    }
  } catch {
    coherenceMeta = null;
  }

  const recordCoherenceDelivered = () => {
    if (coherenceMeta) recordEvent(root, "coherence.delta_delivered", coherenceMeta.delivered);
  };
  const recordContextDeltaDelivered = () => {
    if (contextDeltaMeta) recordEvent(root, "contextdelta.emitted", contextDeltaMeta);
  };
  const recordPrefixDelivered = () => {
    recordContextDeltaDelivered();
    recordCoherenceDelivered();
  };

  // 1. Classify
  let classification;
  try {
    classification = shouldRetrieve(prompt);
  } catch {
    // Classifier failed — fall back to static summary.  No telemetry here:
    // the classifier threw, so there's no classification decision to record;
    // this is the degraded path, distinct from a deliberate retrieve:false.
    if (await injectStaticSummary(root, data, contextPrefix)) recordPrefixDelivered();
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
    if (await injectStaticSummary(root, data, contextPrefix)) recordPrefixDelivered();
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
          classification.terms,
          // docs/013 move 1: on a borderline turn (classifier barely fired)
          // a mid-word path guess is 1.4% noise — drop it.  Confident turns
          // keep loose matches: that's where the typo rescues live.
          { borderline: classification.confidence <= 0.4 }
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
  // WHY textOnly on contentStale (T1.2 honesty leak fix): a content-stale turn
  // prepends the STALE marker ("structural ranking suppressed; live text matches
  // only") — but the formatter would otherwise still render graph-derived
  // provenance ("exports X", "defines X", "fan-in: N") on each surviving line,
  // directly contradicting the marker under the exact header that disclaims
  // structure. textOnly strips every graph label + fan-in, leaving only the live
  // zoekt excerpt, so the block is honest about what it is. Fresh/version-only
  // turns are unaffected (contentStale=false → byte-identical output).
  const maxChars = classification.confidence >= 0.7 ? 1000 : 600;
  // TASK CAPSULE (docs/027 Phase B): default-off role-based, region-surfaced
  // block. On → replaces the flat list AND persists the durable capsule. A
  // content-stale turn NEVER renders a capsule (structural claims withheld —
  // same silent-absence rule as every lane); it takes the flat textOnly path.
  const useCapsule = capsuleOn && !contentStale;
  let output = "";
  // injectedPaths = the {path,source,line?,symbol?}[] to persist for the Phase-A
  // outcome substrate. In flat mode it's derived from the RENDERED subset (so the
  // persisted set can't claim a file the cap truncated out); in capsule mode the
  // renderer already returns entries in that shape.
  let injectedPaths = [];
  // A freshly compiled capsule is only a CANDIDATE until the block survives
  // holdback + dedupe and is actually written to stdout. Publishing it sooner
  // falsely records unseen rows as served claims (and used to erase Phase-D
  // touchedRegions on every new prompt).
  let capsuleToPersist = null;
  let parentSnapshotToPersist = null;
  try {
    if (useCapsule) {
      const { compileWorkset } = require("../lib/workset");
      const { buildCapsule, readCapsule, carryForwardCapsule } = require("../lib/capsule");
      const { formatCapsule } = require("../lib/format-capsule");
      const claimsLib = require("../lib/claims");

      const workset = compileWorkset((merged && merged.files) || [], { root });
      const priorCapsule = readCapsule(root, sessionKey);
      let capsule = buildCapsule({ root, sessionKey, taskText: prompt, workset });
      // The workset came from the graph state checkFreshness validated. Do not
      // stamp a later live fingerprint onto older facts if the tree moves
      // between retrieval and capsule construction.
      if (freshness.validatedRepo) {
        capsule.repo = {
          ...capsule.repo,
          head: freshness.validatedRepo.head ?? null,
          statusHash: freshness.validatedRepo.statusHash ?? null,
        };
      }
      const detailed = formatCapsule(capsule, { maxChars });
      output = detailed.text;
      injectedPaths = detailed.files;
      // Mint claims from the rows ACTUALLY served (what Claude saw) into the
      // capsule so the NEXT turn can re-check them (the served_claims ledger).
      // Only on a FRESH capsule turn — the last good orientation stays the
      // baseline through intervening content-stale turns (whose textOnly block
      // carries no structural claims worth minting).
      try {
        capsule.servedClaims = claimsLib.mintClaims(root, injectedPaths, { nowMs: Date.now() });
      } catch {}
      capsule = carryForwardCapsule(capsule, priorCapsule);
      capsuleToPersist = capsule;
    } else {
      const detailed = formatRetrievalDetailed(merged, { maxChars, textOnly: contentStale });
      output = detailed.text;
      injectedPaths = buildInjectedPaths(detailed.files);
    }
  } catch {
    output = "";
    injectedPaths = [];
  }

  if (!output || !output.trim()) {
    // No results from either source — fall back to static summary.
    // TELEMETRY (T1.3): this is the empty-injection numerator — a prompt the
    // classifier flagged for retrieval (retrieve:true) that yielded nothing,
    // so the static summary is shown instead. Pairing this count against the
    // retrieval.classified{retrieve:true} count gives the empty-injection rate
    // that surfaces NL-recall regressions (cf. the A4 gap).
    recordEvent(root, "retrieval.empty_fallback", {});
    if (await injectStaticSummary(root, data, contextPrefix)) recordPrefixDelivered();
    await statusLinePromise;
    return;
  }

  // ARM DECISION (009 #1 follow-up): now that output is non-empty we have a real
  // injection that COULD be withheld. Decide armed vs holdback. See decideArm.
  const injPathsFile = path.join(
    root,
    ".planning",
    "intel",
    `.last_injected_paths.retrieval.${sessionKey}`
  );
  const arm = decideArm(data, contentStale);

  if (arm === "holdback") {
    // Counterfactual turn: persist what we WOULD have surfaced (tagged holdback)
    // so the PostToolUse hook scores the agent's opens with NO injection this
    // turn, then show the STATIC summary so the agent still has SOME orientation
    // (the arm withholds the graph-authority CONTRIBUTION, not "sextant entirely").
    // We do NOT emit <codebase-retrieval>, do NOT record retrieval.injected
    // (nothing was injected), and do NOT touch the dedupe hash (no block shown).
    persistInjectedSet(injPathsFile, {
      ts: Date.now(),
      stale: contentStale === true,
      arm: "holdback",
      paths: injectedPaths,
    });
    recordEvent(root, "retrieval.holdback", { fileCount: injectedPaths.length });
    if (await injectStaticSummary(root, data, contextPrefix)) recordPrefixDelivered();
    await statusLinePromise;
    return;
  }

  // 6. Dedupe and inject (ARMED path)
  const cachePath = path.join(
    root,
    ".planning",
    "intel",
    // WHY: Separate cache namespace from static summary path (see injectStaticSummary).
    `.last_injected_hash.retrieval.${sessionKey}`
  );

  // WHY the contentStale prefix (T1.2 honesty leak fix): the STALE marker is
  // prepended to the body AFTER this point (see below), so hashing `output`
  // alone means a content-stale turn whose surviving text-only body is
  // byte-identical to a PRIOR fresh turn in the same session would hash-match,
  // hit the early-return, and NEVER emit the marker — Claude silently keeps the
  // prior un-marked, fresh-framed block. Folding contentStale into the hash
  // input puts fresh and stale turns in disjoint hash namespaces so a stale turn
  // can never dedupe away against a fresh one (and vice-versa). Within a single
  // freshness state, identical bodies still dedupe as before.
  const h = crypto
    .createHash("sha256")
    // contextPrefix folded in (docs/028/031): a turn whose body is byte-identical to a
    // prior turn but carries a NEW retraction must not dedupe the delta away.
    .update((contentStale ? "stale:" : "fresh:") + contextPrefix + output)
    .digest("hex");
  const last = tryReadFile(cachePath);

  if (last === h) {
    await statusLinePromise;
    return;
  }

  // Close the retrieval-to-publication TOCTOU window for structural output.
  // A concurrent child/edit can move HEAD or status after checkFreshness and
  // graph reads but before stdout. Withhold the whole block and every staged
  // capsule/snapshot side effect instead of presenting old facts as current.
  if (!contentStale) {
    let current = null;
    try {
      current = require("../lib/freshness").captureCurrentState(root);
    } catch {}
    if (!sameValidatedRepo(freshness.validatedRepo, current)) {
      recordEvent(root, "retrieval.skipped", { reason: "fingerprint_moved" });
      try {
        if (require("../lib/coherence").coherenceEnabled(root)) {
          recordEvent(root, "coherence.skipped", { reason: "fingerprint_moved" });
        }
      } catch {}
      await statusLinePromise;
      return;
    }
  }

  // Cross the actual output boundary before minting any parent "served" state
  // or dedupe marker. If stdout throws, staged capsule/claim/snapshot state is
  // discarded and a later prompt remains eligible to retry the same payload.
  const safe = stripUnsafeXmlTags(output);
  const STALE_MARKER =
    "⚠ index stale: repo changed since last scan — showing live text matches only, " +
    "structural ranking suppressed; rescan triggered.\n";
  const body = contentStale ? STALE_MARKER + safe : safe;
  try {
    process.stdout.write(`${contextPrefix}<codebase-retrieval>\n${body}\n</codebase-retrieval>`);
  } catch {
    await statusLinePromise;
    return;
  }

  try {
    fs.writeFileSync(cachePath, h);
  } catch {}

  // The block crossed the ARMED/non-deduped stdout boundary, so its claims can
  // now be recorded as served. Holdback, dedupe, and failed-output paths above
  // intentionally leave the prior served baseline/evidence untouched.
  if (capsuleToPersist) {
    try {
      const { writeCapsulePreservingEvidence } = require("../lib/capsule");
      if (writeCapsulePreservingEvidence(root, sessionKey, capsuleToPersist)) {
        recordEvent(root, "claim.served", {
          n: Array.isArray(capsuleToPersist.servedClaims)
            ? capsuleToPersist.servedClaims.length
            : 0,
        });
        try {
          const coherence = require("../lib/coherence");
          if (coherence.coherenceEnabled(root) && parentKey) {
            parentSnapshotToPersist = coherence.buildSnapshot({
              taskId: coherenceTaskId || capsuleToPersist.taskId,
              agentKey: parentKey,
              parentAgentKey: null,
              spawnToolUseId: null,
              kind: "parent",
              agentType: null,
              state: "served",
              createdAt: Date.now(),
              repo: capsuleToPersist.repo,
              intent: capsuleToPersist.intent,
              workset: coherence.visibleRoleWorkset(
                capsuleToPersist.workset,
                injectedPaths
              ),
              servedClaims: capsuleToPersist.servedClaims,
              blockHash: h,
            });
          }
        } catch {}
      }
    } catch {}
  }

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

  // OUTCOME SUBSTRATE (009 #1): persist the per-session set of injected paths
  // (each tagged with the signal that surfaced it) so the PostToolUse hook can
  // later score whether the agent opened/edited what we surfaced. Per-session
  // file, OVERWRITTEN each injection so a subsequent open is always compared
  // against the MOST RECENT surfaced set. Separate namespace from the dedupe-hash
  // file (.last_injected_hash.*) and the statusline marker (.last_retrieval).
  // Best-effort; a failed write just means that turn's opens go unscored.
  persistInjectedSet(injPathsFile, {
    ts: Date.now(),
    stale: contentStale === true,
    arm: "armed",
    paths: injectedPaths,
  });

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

  if (parentSnapshotToPersist) {
    try {
      const coherence = require("../lib/coherence");
      if (coherence.writeSnapshot(root, parentSnapshotToPersist)) {
        recordEvent(root, "coherence.agent_registered", {
          kind: "parent",
          state: parentSnapshotToPersist.state,
          claims: parentSnapshotToPersist.servedClaims.length,
        });
      }
    } catch {}
  }
  recordPrefixDelivered();
  await statusLinePromise;
}

module.exports = { run, buildInjectedPaths, decideArm, capsuleEnabled };
