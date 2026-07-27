"use strict";

// ARCHITECTURE: Offline benefit harness. Replays real Claude Code session
// transcripts (~/.claude/projects/**/*.jsonl) to answer the one question every
// offline fixture proxy (MRR / nDCG / graphLiftNDCG) cannot: when sextant
// injected a file into a session, did the agent then OPEN it — and did it open
// it FIRST, or after flailing through other files?
//
// WHY this is the honest complement to the live outcome substrate (009 #1):
// the PostToolUse hook measures in-field, going forward; this replays history
// that already exists, so it yields a real number TODAY. Both are correlational
// until the injection-OFF holdback arm lands (the agent often opens the
// canonical file regardless) — so this module reports a CHANCE BASELINE
// alongside every rate, and leads with orientation-latency / first-touch (a
// populated distribution), keeping hallucinated-path strictly as a tripwire.
// (009 #12, with the doc's degeneracy correction folded in.)
//
// PURE CORE: extractEvents / analyzeSession / aggregate operate on already-parsed
// records and event lists, so they unit-test without touching the filesystem.
// The IO layer (loadSession) is the only fs-dependent surface.

const fs = require("fs");
const path = require("path");

const OPEN_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

// First-touch window: after a retrieval injection, how many of the agent's next
// file-opens we scan for a surfaced path before declaring the injection "not
// acted on". Bounded so a surfaced file opened 30 reads later (likely incidental,
// not orientation) doesn't count as a first-touch win. Coverage (opened-ever)
// uses no window; this bound is first-touch-specific.
const FIRST_TOUCH_WINDOW = 8;

/**
 * Classify the surfacing signal from a retrieval line's detail string, mirroring
 * the source tags the PostToolUse hook (component 14) and format-retrieval.js
 * emit. The detail is everything after `— ` on a `- \`path\` — detail` line.
 * Returns the canonical source key so per-signal attribution is comparable to
 * the live telemetry's path_hit{source}.
 */
function classifyDetailSource(detail) {
  if (!detail) return "text_only";
  const d = detail.trim();
  if (/^exports\b/.test(d) || /^export match\b/.test(d)) return "exported_symbol";
  if (/^defines\b/.test(d)) return "swift_decl_type";
  if (/^declares\b/.test(d)) return "swift_decl_other";
  if (/^re-export/.test(d)) return "reexport_chain";
  if (/^path match\b/.test(d)) return "path_match";
  // Only a zoekt excerpt (`L12: ...`) and/or fan-in: live text evidence, no graph label.
  return "text_only";
}

// REGION SUBSTRATE (docs/025 Phase A): recover the SURFACED SYMBOL from a
// rendered detail so an export/decl row (which carries no line) can still be
// region-scored by name. Mirrors format-retrieval's label verbs.
function detailSymbol(detail) {
  if (!detail) return null;
  const d = detail.trim();
  let m;
  if ((m = d.match(/^exports\s+([A-Za-z_$][\w$]*)/))) return m[1];
  if ((m = d.match(/^defines\s+([A-Za-z_$][\w$]*)/))) return m[1];
  if ((m = d.match(/^declares\s+([A-Za-z_$][\w$]*)/))) return m[1];
  if ((m = d.match(/^re-exports?\s+([A-Za-z_$][\w$]*)/))) return m[1];
  // path_match's term is a FILENAME token, not a code symbol — matching it to a
  // region name is meaningless, so it is deliberately not extracted (path_match
  // rows region-score by line only, which they rarely carry).
  return null;
}

/**
 * Parse a `<codebase-retrieval>` block into the set of surfaced files, each
 * tagged with the signal that surfaced it. Returns [] for an empty/again block.
 * Robust to the textOnly variant (no detail) and the tool-reminder trailer.
 */
function parseRetrievalBlock(text) {
  const out = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    // - `path` — detail   |   - `path`
    const m = line.match(/^-\s+`([^`]+)`(?:\s+—\s+(.*))?$/);
    if (!m) continue;
    const p = m[1].trim();
    if (!p) continue;
    const detail = m[2];
    const entry = { path: p, source: classifyDetailSource(detail) };
    // REGION SUBSTRATE (docs/025 Phase A): recover the surfaced line from the
    // rendered detail (`L44` for a swift decl, `L12: …` for a zoekt excerpt) so
    // the offline region pass can ask whether the agent's edit landed in it.
    // Additive — path/source consumers ignore it.
    if (detail) {
      const lm = detail.match(/\bL(\d+)/);
      if (lm) entry.line = parseInt(lm[1], 10);
      const sym = detailSymbol(detail);
      if (sym) entry.symbol = sym;
    }
    out.push(entry);
  }
  return out;
}

/**
 * Parse the file-bearing rows of a `<codebase-intelligence>` static summary.
 * These are ORIENTATION signals (hotspots / entry points / recent changes), not
 * query-aware retrieval — weaker evidence (an agent may open a hotspot for many
 * reasons), so they're tracked under source "static_summary" and reported
 * separately. Recent-changes rows are `- DATE \`path\``; hotspot/entry rows are
 * `- \`path\`: N` / `- \`path\` (lang)`.
 */
// SECTION SLUGS (docs/035 #7 S4). The static body is not one signal — it is
// five or six, each with its own byte cost and its own claim on the 2200-char
// clamp, and `parseStaticBlock` was blind to all of it: every row came back
// tagged `static_summary`, so "which section earns its bytes" had no answer and
// any eviction from the body would have been taste.
//
// This is the adjudication instrument for the allocation question, which is the
// one docs/035 says gates further spending on either lane: the static summary
// produces ~93.6% of credited opens on 12.3% coverage, retrieval ~6.4% on 3.2%
// coverage but at 1.74x permutation lift, and only the lift number has ever
// been cited. Section rates say WHICH static bytes are carrying that, and
// therefore which (if any) are safe to displace.
//
// Matched on the rendered headings in lib/summary.js. Unknown headings fall
// back to `static:other` rather than being dropped — a renamed section must
// show up as an unattributed bucket, not silently vanish from the denominator.
const STATIC_SECTION_SLUGS = [
  [/^#+\s*Structure/i, "structure"],
  [/^#+\s*Dependency hotspots/i, "hotspots"],
  [/^#+\s*Public API/i, "public_api"],
  [/^#+\s*Likely entry points/i, "entry_points"],
  [/^#+\s*Recent changes/i, "recent"],
  [/^#+\s*Commands/i, "commands"],
  [/^#+\s*Required env/i, "required_env"],
  [/^#+\s*Signals/i, "signals"],
];

function staticSectionSlug(headingLine) {
  for (const [re, slug] of STATIC_SECTION_SLUGS) {
    if (re.test(headingLine)) return slug;
  }
  return "other";
}

function parseStaticBlock(text) {
  const out = [];
  // Rows above the first heading are the header block (Root / Indexed files /
  // Misses / Vendored). They carry paths too — `Misses` in particular — and
  // must not be attributed to whatever section happens to come first.
  let section = "header";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^#+\s/.test(line)) {
      section = staticSectionSlug(line);
      continue;
    }
    const m = line.match(/`([^`]+\.[A-Za-z0-9]+)`/); // a backticked thing with a file extension
    if (!m) continue;
    const p = m[1].trim();
    if (!p || p.includes(" ")) continue;
    out.push({ path: p, source: `static:${section}` });
  }
  return out;
}

function extractInjectionText(rec) {
  // Injections land in `attachment` records at .attachment.content (confirmed by
  // recon). Be defensive: also scan a couple of other string-bearing shapes.
  const a = rec && rec.attachment;
  if (a && typeof a.content === "string") return a.content;
  if (a && a.content && typeof a.content.text === "string") return a.content.text;
  return null;
}

/**
 * Walk a session's records (in file order, which is chronological) and produce a
 * flat, timestamp-ordered event stream of injections and file-opens.
 *
 * @param {object[]} records parsed JSONL records
 * @param {{sessionCwd?: string}} [opts]
 * @returns {{events: Array, cwd: string|null}}
 *   event = { kind: "inject"|"open", ts, ... }
 *     inject: { kind, ts, mode: "retrieval"|"static", files: [{path, source}] }
 *     open:   { kind, ts, tool, path }  (path = repo-relative)
 */
function extractEvents(records, opts = {}) {
  // Capture cwd from any record that carries it (attachments reliably do).
  let cwd = opts.sessionCwd || null;
  if (!cwd) {
    for (const r of records) {
      if (r && typeof r.cwd === "string") { cwd = r.cwd; break; }
    }
  }

  const toRel = (abs) => {
    if (typeof abs !== "string") return null;
    if (cwd && abs.startsWith(cwd + path.sep)) return abs.slice(cwd.length + 1);
    if (cwd && abs === cwd) return "";
    // Not under cwd (e.g. an absolute path outside the repo): keep basename so a
    // surfaced path that the agent opened via an absolute outside-root form can
    // still match on basename in analyzeSession's fallback. Mark with leading
    // marker so analyze can tell it wasn't cleanly normalized.
    return abs;
  };

  const events = [];
  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    const ts = r.timestamp || null;

    if (r.type === "attachment") {
      const text = extractInjectionText(r);
      if (text && text.includes("<codebase-retrieval>")) {
        const files = parseRetrievalBlock(text);
        if (files.length) events.push({ kind: "inject", ts, mode: "retrieval", files });
      } else if (text && text.includes("<codebase-intelligence>")) {
        const files = parseStaticBlock(text);
        if (files.length) events.push({ kind: "inject", ts, mode: "static", files });
      }
      continue;
    }

    if (r.type === "assistant" && r.message && Array.isArray(r.message.content)) {
      for (const c of r.message.content) {
        if (c && c.type === "tool_use" && OPEN_TOOLS.has(c.name)) {
          const fp = c.input && c.input.file_path;
          const rel = toRel(fp);
          if (rel != null && rel !== "") {
            events.push({ kind: "open", ts, tool: c.name, path: rel, rawPath: fp });
          }
        }
      }
    }
  }

  // Stable chronological order. Records are already in order; ts is a tiebreaker
  // only where present. Keep original order for equal/absent ts.
  events.forEach((e, i) => { e._i = i; });
  events.sort((a, b) => {
    if (a.ts && b.ts && a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    return a._i - b._i;
  });
  return { events, cwd };
}

// Suffix matcher for "did the agent open this surfaced path?". An opened path
// o matches surfaced repo-rel p iff o === p or o ends with "/" + p — which
// covers an absolute-path open of a surfaced repo-rel file through a different
// root/symlink prefix (the case toRel can't normalize). Basename-only matching
// was deliberately dropped: it counted `lib/config.js` as opened when the agent
// opened `config/config.js` (same basename, different file), inflating coverage
// on BOTH the actual and the permutation-null arm.
//
// buildOpenedSuffixSet precomputes every "/"-aligned suffix of each opened path
// (plus the full path) so a surfaced p matches in O(1) — coverageOf runs K=200
// times per injection in the permutation null, so per-lookup cost matters.
function buildOpenedSuffixSet(paths) {
  const set = new Set();
  for (const p of paths) {
    if (typeof p !== "string" || !p) continue;
    set.add(p);
    for (let i = p.indexOf("/"); i !== -1; i = p.indexOf("/", i + 1)) {
      set.add(p.slice(i + 1));
    }
  }
  return set;
}

// Inverse direction (one opened path against a Set of surfaced rel paths):
// used by the first-touch scan, which walks opens in order.
function openMatchesSurfaced(openPath, surfacedSet) {
  if (typeof openPath !== "string" || !openPath) return false;
  if (surfacedSet.has(openPath)) return true;
  for (let i = openPath.indexOf("/"); i !== -1; i = openPath.indexOf("/", i + 1)) {
    if (surfacedSet.has(openPath.slice(i + 1))) return true;
  }
  return false;
}

/**
 * Score one session's event stream.
 *
 * Metrics (all per-injection, then aggregated by the caller):
 *  - coverage: of the files an injection surfaced, how many did the agent open
 *    at any point afterward (until session end). Precision-flavored "did they
 *    use what we surfaced".
 *  - firstTouch: among the agent's next FIRST_TOUCH_WINDOW opens after an
 *    injection, the 1-indexed rank of the first open that hits a surfaced file
 *    (null = miss within window). The orientation-latency distribution.
 *  - chance baseline inputs: distinctOpened (session-wide) and surfaced-set size,
 *    so the aggregate can state "surfaced files were X% of opened files but got
 *    Y% of first-after-injection opens" — the lift framing that separates signal
 *    from "the agent opens everything eventually".
 */
function analyzeSession(events) {
  const opens = events.filter((e) => e.kind === "open");
  const distinctOpened = new Set(opens.map((o) => o.path));

  const result = {
    retrieval: { injections: 0, surfaced: 0, surfacedOpened: 0,
      firstTouchRanks: [], firstTouchMissWithinWindow: 0,
      bySource: {} /* source -> {surfaced, opened} */ },
    static: { injections: 0, surfaced: 0, surfacedOpened: 0,
      firstTouchRanks: [], firstTouchMissWithinWindow: 0,
      bySource: {} /* docs/035 #7 S4: static:<section> -> {surfaced, opened} */ },
    opensTotal: opens.length,
    distinctOpened: distinctOpened.size,
    // For chance baseline: how many of the session's distinct opened files were
    // ever surfaced by a retrieval injection.
    surfacedDistinct: new Set(),
  };

  // Index opens by position for windowed first-touch.
  const openSeq = events
    .map((e, idx) => ({ e, idx }))
    .filter((x) => x.e.kind === "open");

  // Build a quick matcher: an open hits a surfaced path if repo-rel equal, or
  // suffix-equal after a "/" (covers an absolute-path open of a surfaced
  // repo-rel file; see buildOpenedSuffixSet for why basename matching is gone).
  const opensAfter = (injIdx) => openSeq.filter((x) => x.idx > injIdx).map((x) => x.e);

  events.forEach((ev, injIdx) => {
    if (ev.kind !== "inject") return;
    const bucket = ev.mode === "retrieval" ? result.retrieval : result.static;
    bucket.injections += 1;

    const surfacedPaths = ev.files.map((f) => f.path);
    const surfacedSet = new Set(surfacedPaths);
    bucket.surfaced += surfacedPaths.length;

    const after = opensAfter(injIdx);
    const openedSuffixes = buildOpenedSuffixSet(after.map((o) => o.path));

    const isOpened = (p) => openedSuffixes.has(p);

    // Coverage + per-source (retrieval only carries source tags worth splitting).
    for (const f of ev.files) {
      const opened = isOpened(f.path);
      if (opened) {
        bucket.surfacedOpened += 1;
        result.surfacedDistinct.add(f.path);
      }
      // Both modes now. The static half was excluded ("retrieval only carries
      // source tags worth splitting"), which was true only because
      // parseStaticBlock emitted one constant tag for the whole body.
      const s = (bucket.bySource[f.source] = bucket.bySource[f.source] || { surfaced: 0, opened: 0 });
      s.surfaced += 1;
      if (opened) s.opened += 1;
    }

    // First-touch: scan the next window of opens for the first surfaced hit.
    const window = after.slice(0, FIRST_TOUCH_WINDOW);
    let rank = null;
    for (let i = 0; i < window.length; i++) {
      const o = window[i];
      if (openMatchesSurfaced(o.path, surfacedSet)) {
        rank = i + 1;
        break;
      }
    }
    if (rank != null) bucket.firstTouchRanks.push(rank);
    else if (window.length > 0) bucket.firstTouchMissWithinWindow += 1;
  });

  result.surfacedDistinct = result.surfacedDistinct.size;
  return result;
}

/** Sum per-session results into corpus aggregates with derived rates. */
function aggregate(sessionResults) {
  const agg = {
    sessions: sessionResults.length,
    retrieval: { injections: 0, surfaced: 0, surfacedOpened: 0,
      firstTouchRanks: [], firstTouchMissWithinWindow: 0, bySource: {} },
    static: { injections: 0, surfaced: 0, surfacedOpened: 0,
      firstTouchRanks: [], firstTouchMissWithinWindow: 0, bySource: {} },
    opensTotal: 0,
  };

  for (const r of sessionResults) {
    for (const mode of ["retrieval", "static"]) {
      agg[mode].injections += r[mode].injections;
      agg[mode].surfaced += r[mode].surfaced;
      agg[mode].surfacedOpened += r[mode].surfacedOpened;
      agg[mode].firstTouchRanks.push(...r[mode].firstTouchRanks);
      agg[mode].firstTouchMissWithinWindow += r[mode].firstTouchMissWithinWindow;
    }
    for (const mode of ["retrieval", "static"]) {
      for (const [src, v] of Object.entries(r[mode].bySource || {})) {
        const s = (agg[mode].bySource[src] = agg[mode].bySource[src] || { surfaced: 0, opened: 0 });
        s.surfaced += v.surfaced;
        s.opened += v.opened;
      }
    }
    agg.opensTotal += r.opensTotal;
  }

  const derive = (b) => {
    const ftAttempts = b.firstTouchRanks.length + b.firstTouchMissWithinWindow;
    const ranks = b.firstTouchRanks.slice().sort((a, c) => a - c);
    const median = ranks.length ? ranks[Math.floor((ranks.length - 1) / 2)] : null;
    return {
      injections: b.injections,
      surfaced: b.surfaced,
      surfacedOpened: b.surfacedOpened,
      coveragePct: b.surfaced ? +(100 * b.surfacedOpened / b.surfaced).toFixed(1) : null,
      // Of injections whose next opens we could observe, how often a surfaced
      // file was among the first FIRST_TOUCH_WINDOW opens.
      firstTouchAttempts: ftAttempts,
      firstTouchHits: b.firstTouchRanks.length,
      firstTouchHitPct: ftAttempts ? +(100 * b.firstTouchRanks.length / ftAttempts).toFixed(1) : null,
      firstTouchRank1Pct: ftAttempts ? +(100 * b.firstTouchRanks.filter((r) => r === 1).length / ftAttempts).toFixed(1) : null,
      medianFirstTouchRank: median,
    };
  };

  const out = {
    sessions: agg.sessions,
    opensTotal: agg.opensTotal,
    retrieval: derive(agg.retrieval),
    static: derive(agg.static),
    bySource: {},
  };
  const rate = (v) => ({
    surfaced: v.surfaced,
    opened: v.opened,
    coveragePct: v.surfaced ? +(100 * v.opened / v.surfaced).toFixed(1) : null,
  });
  for (const [src, v] of Object.entries(agg.retrieval.bySource)) out.bySource[src] = rate(v);
  // docs/035 #7 S4: per-SECTION rates for the static body — the input to the
  // allocation question. Reported separately from bySource so the retrieval
  // per-signal numbers keep their existing meaning and shape.
  out.staticBySource = {};
  for (const [src, v] of Object.entries(agg.static.bySource)) out.staticBySource[src] = rate(v);
  return out;
}

// ---- Permutation-null lift --------------------------------------------------
//
// Raw coverage (6.9%) is uninterpretable alone: is it above what you'd get
// surfacing random PLAUSIBLE repo files? The permutation null answers exactly
// that. For each injection we recompute coverage after swapping its surfaced set
// for one drawn from a DIFFERENT session in the SAME repo (a plausible-but-not-
// query-matched set). lift = actual / null. lift>1 means query-relevance
// surfaces files the agent opens MORE than chance; lift≈1 means no signal beyond
// plausibility. This is the closest thing to a counterfactual available offline
// (the live injection-OFF holdback arm is the rigorous upgrade).

// Deterministic LCG so the same corpus yields the same lift (reproducibility +
// testability; Math.random would make the number wobble run-to-run).
function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

function coverageOf(events, injIdx, surfaced) {
  let opened = 0;
  const openedPaths = [];
  for (let i = injIdx + 1; i < events.length; i++) {
    const e = events[i];
    if (e.kind === "open") openedPaths.push(e.path);
  }
  // Same suffix semantics as analyzeSession's isOpened — the actual and null
  // arms MUST share one matcher or the lift comparison is apples-to-oranges.
  const openedSuffixes = buildOpenedSuffixSet(openedPaths);
  for (const p of surfaced) {
    if (openedSuffixes.has(p)) opened++;
  }
  return { surfaced: surfaced.length, opened };
}

/**
 * Compute actual-vs-null coverage lift for one injection mode.
 *
 * @param {Array<{repo:string, events:Array}>} sessions parsed sessions w/ repo tag
 * @param {"retrieval"|"static"} mode
 * @param {{K?:number, seed?:number, sizeMatched?:boolean}} [opts]
 *   sizeMatched: draw null sets whose cardinality matches the real set (guards
 *   the size-bias threat the null-fairness skeptic checks).
 */
function computeLift(sessions, mode, opts = {}) {
  const K = opts.K || 200;
  const rng = makeRng(opts.seed || 12345);
  const sizeMatched = opts.sizeMatched === true;

  // Pool of surfaced-sets per repo, tagged by session index within repo.
  const byRepo = new Map();
  sessions.forEach((s) => {
    if (!byRepo.has(s.repo)) byRepo.set(s.repo, []);
    byRepo.get(s.repo).push(s.events);
  });

  let aS = 0, aO = 0, nS = 0, nO = 0;
  for (const [, repoSessions] of byRepo) {
    const pool = [];
    repoSessions.forEach((events, si) => {
      events.forEach((e) => {
        if (e.kind === "inject" && e.mode === mode) pool.push({ si, set: e.files.map((f) => f.path) });
      });
    });
    if (pool.length < 2) continue;

    repoSessions.forEach((events, si) => {
      events.forEach((e, injIdx) => {
        if (e.kind !== "inject" || e.mode !== mode) return;
        const real = coverageOf(events, injIdx, e.files.map((f) => f.path));
        aS += real.surfaced; aO += real.opened;
        const want = real.surfaced;
        for (let k = 0; k < K; k++) {
          let pick, tries = 0;
          do { pick = pool[Math.floor(rng() * pool.length)]; tries++; } while (pick.si === si && tries < 20);
          let set = pick.set;
          if (sizeMatched && set.length !== want) {
            // Resize by sampling-with-replacement to the real cardinality, so set
            // size can't bias the null up or down.
            const resized = [];
            for (let j = 0; j < want; j++) resized.push(set[Math.floor(rng() * set.length)]);
            set = resized;
          }
          const nc = coverageOf(events, injIdx, set);
          nS += nc.surfaced; nO += nc.opened;
        }
      });
    });
  }

  const actual = aS ? 100 * aO / aS : null;
  const nul = nS ? 100 * nO / nS : null;
  return {
    actualPct: actual == null ? null : +actual.toFixed(2),
    nullPct: nul == null ? null : +nul.toFixed(2),
    lift: (actual && nul) ? +(actual / nul).toFixed(2) : null,
    surfaced: aS, opened: aO,
  };
}

// ---- IO layer ---------------------------------------------------------------

function readRecords(file) {
  const out = [];
  let data;
  try { data = fs.readFileSync(file, "utf8"); } catch { return out; }
  for (const line of data.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return out;
}

/**
 * Discover session files under a projects root. By default EXCLUDES nested
 * subagent/workflow sub-transcripts (they inherit injected context but are not
 * real interactive orientation — counting them double-counts and pollutes the
 * agent-behavior signal).
 */
function discoverSessions(projectsRoot, opts = {}) {
  const includeSubagents = opts.includeSubagents === true;
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!includeSubagents && (e.name === "subagents" || e.name === "workflows")) continue;
        walk(full);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        out.push(full);
      }
    }
  };
  walk(projectsRoot);
  return out;
}

function repoOf(file, projectsRoot) {
  const rel = file.startsWith(projectsRoot) ? file.slice(projectsRoot.length).replace(/^[/\\]/, "") : file;
  return rel.split(/[/\\]/)[0];
}

// Does a project-directory name refer to the repo the user named?
//
// WHY this is not `===` (docs/033 Tier 1 #2): repoOf returns Claude Code's
// MANGLED project directory (`/root/sextant` -> `-root-sextant`), so the
// natural `--repo sextant` matched NOTHING and buildReport rendered a confident
// empty report — indistinguishable from a real "no sessions" finding.
//
// Inverting the mangling exactly is impossible (a `-` in the directory name and
// a `/` in the path both encode to `-`), so match by suffix instead of trying:
//   sextant        -> `-root-sextant` ends with `-sextant`      ✓
//   root/sextant   -> query slashes normalize to `-`            ✓
//   /root/sextant  -> same, leading separator dropped           ✓
//   -root-sextant  -> exact                                     ✓
// A query may legitimately match several projects; the caller reports the count.
function repoMatches(dirName, query) {
  if (typeof dirName !== "string" || typeof query !== "string" || !query) return false;
  const d = dirName.toLowerCase();
  const q = query.toLowerCase().replace(/[/\\]/g, "-").replace(/^-+/, "");
  if (!q) return false;
  return d === query.toLowerCase() || d === q || d.endsWith(`-${q}`);
}

// Every project directory that holds at least one session transcript, for the
// "did you mean" list a zero-match filter prints before exiting non-zero.
function listRepos(projectsRoot, opts = {}) {
  const seen = new Set();
  for (const f of discoverSessions(projectsRoot, opts)) seen.add(repoOf(f, projectsRoot));
  return [...seen].sort();
}

function analyzeFiles(files) {
  const perSession = [];
  for (const f of files) {
    const records = readRecords(f);
    if (!records.length) continue;
    const { events } = extractEvents(records);
    const hasInject = events.some((e) => e.kind === "inject");
    if (!hasInject) continue;
    const r = analyzeSession(events);
    r._file = f;
    perSession.push(r);
  }
  return { perSession, aggregate: aggregate(perSession) };
}

// Tools whose tool_use we can localize to an edited region offline.
const REGION_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * REGION SUBSTRATE (docs/025 Phase A) — the offline, retrospective half of the
 * region-outcome measurement. Self-contained: it does its OWN record walk and
 * does not touch analyzeSession/aggregate, so the file-level lift numbers stay
 * byte-identical. Answers the Phase-A kill-criterion question over history:
 * when retrieval surfaced a file WITH a line, and the agent later edited that
 * file, did the edit land in the region we pointed at (in-region) or a DIFFERENT
 * region (headroom — right file, reclaimable within-file navigation)?
 *
 * Correlation: an Edit tool_use (assistant record, carries `id`) → its result
 * (user record, `toolUseResult.{filePath, content, structuredPatch}` keyed by
 * `tool_use_id`). We resolve the edited region against the post-edit `content`
 * (allowSpawn:true — offline, python3 latency is fine) and test containment of
 * the surfaced line.
 *
 * Honest scope (v1): this is the IMMEDIATE in-region edit rate. Retained-to-final
 * -diff survival is the next refinement (docs/025) — labelled as such, not
 * silently conflated with "retained work."
 *
 * @returns {{scored, hits, misses, bySource:{[src]:{hits,misses}}, navRanks:number[]}}
 */
function analyzeRegions(records, cwd) {
  const regionsLib = require("./regions");
  const toRel = (abs) => {
    if (typeof abs !== "string") return null;
    if (cwd && abs.startsWith(cwd + path.sep)) return abs.slice(cwd.length + 1);
    if (cwd && abs === cwd) return "";
    return null; // outside the repo → not scoreable
  };

  // Pass 1: index every edit RESULT by its tool_use_id.
  const editResults = new Map(); // id → { relPath, structuredPatch, content }
  for (const r of records) {
    if (!r || r.type !== "user" || !r.toolUseResult) continue;
    const tur = r.toolUseResult;
    const relPath = toRel(tur.filePath);
    if (relPath == null || relPath === "") continue;
    const ids = [];
    const mc = r.message && Array.isArray(r.message.content) ? r.message.content : [];
    for (const c of mc) {
      if (c && c.type === "tool_result" && typeof c.tool_use_id === "string") ids.push(c.tool_use_id);
    }
    for (const id of ids) {
      editResults.set(id, {
        relPath,
        structuredPatch: Array.isArray(tur.structuredPatch) ? tur.structuredPatch : null,
        // Prefer post-edit content; fall back to the pre-edit originalFile when
        // the result omitted content (~90% of edit results in practice). Function
        // spans are large, so resolving the enclosing region from originalFile at
        // the same line is negligibly different for region identity.
        content: typeof tur.content === "string" ? tur.content : (typeof tur.originalFile === "string" ? tur.originalFile : null),
      });
    }
  }

  // Pass 2: walk chronologically; track the most-recent surfaced {line, source}
  // per path and the running open-count, and score each localizable edit.
  const surfaced = new Map(); // relPath → { line, source }
  let opensSinceInject = new Map(); // relPath → opens observed since it was surfaced
  const out = { scored: 0, hits: 0, misses: 0, bySource: {}, navRanks: [] };

  for (const r of records) {
    if (!r || typeof r !== "object") continue;

    if (r.type === "attachment") {
      const text = extractInjectionText(r);
      if (text && text.includes("<codebase-retrieval>")) {
        for (const f of parseRetrievalBlock(text)) {
          const line = typeof f.line === "number" && f.line > 0 ? f.line : null;
          const symbol = typeof f.symbol === "string" && f.symbol ? f.symbol : null;
          if (line != null || symbol != null) {
            surfaced.set(f.path, { line, symbol, source: f.source });
            opensSinceInject.set(f.path, 0);
          }
        }
      }
      continue;
    }

    if (r.type === "assistant" && r.message && Array.isArray(r.message.content)) {
      for (const c of r.message.content) {
        if (!c || c.type !== "tool_use") continue;
        // Count every file-open toward the navigation latency of pending surfaces.
        if (OPEN_TOOLS.has(c.name)) {
          for (const k of opensSinceInject.keys()) opensSinceInject.set(k, opensSinceInject.get(k) + 1);
        }
        if (!REGION_EDIT_TOOLS.has(c.name) || typeof c.id !== "string") continue;
        const res = editResults.get(c.id);
        if (!res) continue;
        const surf = surfaced.get(res.relPath);
        if (!surf) continue; // this file was never surfaced WITH a line
        let content = res.content;
        if (content == null) continue; // can't localize without post-edit content
        const editedLines = regionsLib.deriveEditedLines(c.input, res, content);
        const regions = regionsLib.editedRegions(res.relPath, content, editedLines, { allowSpawn: true });
        const verdict = regionsLib.scoreEditedRegion(surf.line, surf.symbol, regions);
        if (!verdict) continue;
        out.scored += 1;
        const bs = (out.bySource[surf.source] = out.bySource[surf.source] || { hits: 0, misses: 0 });
        if (verdict.hit) { out.hits += 1; bs.hits += 1; }
        else { out.misses += 1; bs.misses += 1; }
        const nav = opensSinceInject.get(res.relPath);
        if (typeof nav === "number") out.navRanks.push(nav);
        // First edit consumes the surface (avoid double-counting repeat edits).
        surfaced.delete(res.relPath);
        opensSinceInject.delete(res.relPath);
      }
    }
  }
  return out;
}

/**
 * Full offline-benefit report over a projects root. The single entry point the
 * `sextant eval-trajectory` command calls. Returns the aggregate metrics plus
 * the permutation-null lift for retrieval and static — the interpretable form.
 *
 * @param {string} projectsRoot e.g. ~/.claude/projects
 * @param {{repo?:string, includeSubagents?:boolean, K?:number, seed?:number, sizeMatched?:boolean}} [opts]
 */
function buildReport(projectsRoot, opts = {}) {
  let files = discoverSessions(projectsRoot, { includeSubagents: opts.includeSubagents });
  if (opts.repo) files = files.filter((f) => repoMatches(repoOf(f, projectsRoot), opts.repo));

  const sessions = []; // { repo, events } for lift
  const perSession = [];
  const reposSeen = new Set();
  // REGION SUBSTRATE (docs/025 Phase A): corpus-wide region tallies.
  const reg = { scored: 0, hits: 0, misses: 0, bySource: {}, navRanks: [] };
  for (const f of files) {
    const records = readRecords(f);
    if (!records.length) continue;
    const { events, cwd } = extractEvents(records);
    if (!events.some((e) => e.kind === "inject")) continue;
    const repo = repoOf(f, projectsRoot);
    reposSeen.add(repo);
    sessions.push({ repo, events });
    const r = analyzeSession(events);
    r._file = f;
    perSession.push(r);
    const rr = analyzeRegions(records, cwd);
    reg.scored += rr.scored;
    reg.hits += rr.hits;
    reg.misses += rr.misses;
    reg.navRanks.push(...rr.navRanks);
    for (const [src, v] of Object.entries(rr.bySource)) {
      const s = (reg.bySource[src] = reg.bySource[src] || { hits: 0, misses: 0 });
      s.hits += v.hits;
      s.misses += v.misses;
    }
  }

  const liftOpts = { K: opts.K, seed: opts.seed, sizeMatched: opts.sizeMatched };
  const navSorted = reg.navRanks.slice().sort((a, b) => a - b);
  return {
    projectsRoot,
    sessionsScanned: files.length,
    sessionsWithInjection: perSession.length,
    repos: [...reposSeen].sort(),
    aggregate: aggregate(perSession),
    lift: {
      retrieval: computeLift(sessions, "retrieval", liftOpts),
      static: computeLift(sessions, "static", liftOpts),
    },
    // REGION SUBSTRATE (docs/025 Phase A): immediate in-region edit rate. precision
    // = hits/(hits+misses); missPct = right-file-wrong-region headroom the kill
    // criterion reads. Retained-to-final-diff survival is the next refinement.
    regions: {
      scored: reg.scored,
      inRegion: reg.hits,
      wrongRegion: reg.misses,
      precisionPct: reg.scored ? +(100 * reg.hits / reg.scored).toFixed(1) : null,
      wrongRegionPct: reg.scored ? +(100 * reg.misses / reg.scored).toFixed(1) : null,
      medianNavBeforeEdit: navSorted.length ? navSorted[Math.floor((navSorted.length - 1) / 2)] : null,
      bySource: Object.fromEntries(
        Object.entries(reg.bySource).map(([src, v]) => {
          const n = v.hits + v.misses;
          return [src, { inRegion: v.hits, wrongRegion: v.misses, precisionPct: n ? +(100 * v.hits / n).toFixed(1) : null }];
        })
      ),
    },
    _sessions: sessions, // exposed for repo-holdout / advanced analysis
  };
}

module.exports = {
  // pure
  classifyDetailSource,
  parseRetrievalBlock,
  parseStaticBlock,
  extractEvents,
  analyzeSession,
  analyzeRegions,
  aggregate,
  computeLift,
  makeRng,
  // io
  readRecords,
  discoverSessions,
  analyzeFiles,
  buildReport,
  repoOf,
  repoMatches,
  listRepos,
  FIRST_TOUCH_WINDOW,
  OPEN_TOOLS,
};
