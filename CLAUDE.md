# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## What This Project Is

`sextant` (formerly `codebase-intel`) is a health-aware codebase intelligence service that keeps LLM coding agents oriented by continuously mapping repository structure and injecting factual summaries into Claude Code sessions. It solves orientation failures (hallucinated structure, wrong starting files, missed blast radius) by providing a small, honest map before the first prompt and keeping it fresh mid-session.

It is **not** a semantic code understanding engine, LSP, vector database, or IDE replacement. See `DESIGN_PHILOSOPHY.md` for the guiding principles (orientation > intelligence, drift must be loud, degrade don't guess).

**This project is independent of the GSD (Get Shit Done) Claude Code plugin.** It was originally developed inside a GSD fork but has been split into its own repo. GSD does not depend on sextant and sextant does not depend on GSD.

## Commands

```bash
npm install          # install dependencies (chokidar, fast-glob, sql.js, @babel/parser)
npm link             # make `sextant` globally available (`codebase-intel` still works as alias)
npm test             # unit tests (node:test) + 5 bash integration scripts + eval harness
npm run test:unit    # unit tests (326+, ~900ms)
npm run test:eval    # just the 19-query eval harness
```

No build step. CommonJS throughout, no transpilation.

## Deploying to a new project

```bash
cd /path/to/project
sextant init         # creates .planning/intel/, registers sextant MCP server in .mcp.json
sextant scan --force # indexes files, builds dependency graph
```

The watcher auto-starts on next Claude Code session. To start manually: `sextant watch-start`

## Architecture

### Pipeline

1. **Extractors** (`lib/extractors/`) parse imports/exports from source files
   - JS/TS imports: regex-based (`javascript.js`)
   - JS/TS exports: AST-based via `@babel/parser` (`js_ast_exports.js`), falls back to regex on parse failure
   - Python: AST-based via `python_ast.py` (`python.js`)
   - Registry: `extractors/index.js` maps extensions to extractors

2. **Resolver** (`lib/resolver.js`) maps import specifiers to file paths
   - JS/TS: relative paths, tsconfig `paths`/`baseUrl`, workspace packages
   - Python: relative imports (dot notation), local package imports
   - Returns `{ specifier, resolved, kind }` where kind is `relative|external|tsconfig|workspace|asset|unresolved`

3. **Graph** (`lib/graph.js`) stores the dependency graph in SQLite (via sql.js)
   - Tables: `files`, `imports`, `exports`, `reexports`, `meta`
   - Provides fan-in/fan-out queries, neighbor expansion, hotspot detection
   - `findExportsBySymbol()` — export-graph lookup for common-term retrieval
   - `findReexportChain()` — BFS through re-export chains for barrel-file tracing

4. **Intel** (`lib/intel.js`) orchestrates everything — the central module (highest fan-in)
   - Per-root state management via `stateByRoot` Map
   - Serialized operations via `withQueue()` promise chain
   - Debounced flushing for graph and summary writes (graph.db is single source of truth)
   - One-time migration of legacy `index.json` into graph.db on init
   - Separates re-exports from regular exports during indexing

5. **Summary** (`lib/summary.js`) generates bounded markdown summaries (~2200 chars max)
   - Health metrics, module types, dependency hotspots, entry points, recent git changes
   - Emits `ALERT:` lines when resolution < 90% or index is stale

6. **Retrieve** (`lib/retrieve.js`) provides ranked search — three layers:
   - **Layer 1: rg text search** — two-phase (source files first, then docs/config), 5x raw limit
   - **Layer 2: Export-graph lookup** — queries exports table for each query term, injects files that export the symbol even if rg missed them
   - **Layer 3: Re-export chain tracing** — follows barrel-file re-exports to find original definition files
   - **Scoring** (`lib/scoring.js` + `lib/retrieve.js`, constants in `lib/scoring-constants.js`): exact symbol +40% (scoring.js), definition-site +25% (retrieve.js) — these stack to +65% on the defining line. Additional: export match +10%, symbol-contains-query +12%, export line +5%, def line +3%, fan-in up to +15%, hotspot +15%, entry point +10%. Penalties: test −25%, doc −40%, vendor −50%, noise −8%/−15%. Fan-in suppression halves graph boost for non-definition files when a definition match exists.
   - **Health gating**: graph boosts disabled when resolution < 90%

7. **Watcher** (`watch.js`) — chokidar file watcher with live dashboard
   - Writes heartbeat every 30s (periodic) + on each flush (activity)
   - Writes last-processed filename to `.watcher_last_file`
   - Auto-started by SessionStart hook when heartbeat is missing/stale
   - `watch-start`/`watch-stop` CLI commands, `/watch` slash command in Claude Code

8. **Classifier** (`lib/classifier.js`) — heuristic prompt classification (<1ms)
   - Decides whether a user prompt warrants code retrieval or static summary
   - Positive signals: identifier shapes (+3), file paths (+4), technical questions (+3), action + code target (+3)
   - Negative signals: very short with no identifiers (-3), git commands (-4), meta/conversational (-3)
   - Threshold: score >= 3 triggers retrieval, 1-2 borderline (fewer results), <= 0 skips
   - SKIP_TERMS set (~200 words): action verbs are signals for detection but noise for search terms

9. **Graph Retrieval** (`lib/graph-retrieve.js`) — fast graph-only search for hooks (<50ms)
   - Three layers: export-graph symbol lookup, re-export chain tracing, filename path matching
   - No subprocesses — purely in-memory SQLite queries against graph.db
   - Uses `graph.loadDb()` directly (not `intel.init()`) to avoid 90ms init overhead

10. **Merge + Format** (`lib/merge-results.js`, `lib/format-retrieval.js`) — result fusion
    - Merges graph structural results with Zoekt text search hits
    - Graph hits get 1.4x authority boost, files in both sources get 1.2x fusion bonus
    - Formats as compact markdown (~500-1000 chars) with file path, match reason, fan-in

11. **MCP Server** (`mcp/server.js`) — JSON-RPC 2.0 over stdio, replaces standalone Zoekt MCP
    - `sextant_search` — wraps full `retrieve()` pipeline (graph + zoekt + rg + scoring)
    - `sextant_related` — calls `graph.neighbors()`
    - `sextant_explain` — fan-in, exports, imports for a file
    - `sextant_health` — index resolution, file count, age
    - Registered per-project via `.mcp.json` by `sextant init`

12. **Freshness gate** (`lib/freshness.js`, `lib/cli.js applyFreshnessGate`) — silent-absence model for stale state
    - At every injection point (SessionStart hook, UserPromptSubmit hook, `sextant summary`, `sextant inject`), compares stored scan-state to current state
    - Signals: git HEAD, `git status --porcelain` hash (filtered to exclude `.planning/`), scanner version (`SCANNER_VERSION`), graph-schema version (`SCHEMA_VERSION`)
    - When stale: emits a minimal body with only filesystem/git-derived fields (root, branch+HEAD, signals, recent commits, "rescan requested|pending|unavailable" marker) — no hotspots, no fan-in, no entry points, no graph-derived numbers
    - Triggers atomic single-flight async rescan via `.planning/intel/.rescan_pending` marker (5-minute orphan-recovery window); spawned scan uses `--allow-concurrent --force` and is safe under the mtime-gated cache
    - Scan-state recorded inside `persistGraphUnlocked` and the bulk-scan finalize, so on-disk state is atomic with `generated_at`

13. **Telemetry** (`lib/telemetry.js`, `commands/telemetry.js`) — append-only JSONL at `.planning/intel/telemetry.jsonl`
    - Recorded events:
      - `freshness.fresh_hit {}` — every fresh read (denominator for stale_rate)
      - `freshness.stale_hit { reason, rescanState }` — every stale read
      - `freshness.blackout_turn { reason }` — every minimal-body emission
      - `scan.completed { durationMs, success, trigger, pruneMissing, forceReindex, error? }` — every scan exit (success or failure); `trigger` is `freshness_gate` or `manual` based on the `SEXTANT_RESCAN_TRIGGER` env var
    - Bounded growth: rotates to `.old` past `TELEMETRY_MAX_BYTES` (1 MiB)
    - Never throws; failures are silently absorbed (telemetry must never break the hook)
    - Audit surface: `sextant telemetry [--json | --tail N] [--include-old]` — prints stale rate, stale-reason breakdown, scan duration percentiles (p50/p95/p99) split by trigger, success rate, event counts by name, observation window
    - Dataset feeds the future Option-5 adaptive sync/async decision (per-repo p95 scan duration drives whether sync rescan is safe)

### Visibility Model (CRITICAL — read this)

There are three output channels. They go to different places:

| Channel | Where it goes | What sees it |
|---------|--------------|-------------|
| Hook **stdout** | Injected as Claude context (`<system-reminder>`) | Claude only |
| Hook **stderr** | Nowhere visible | Nobody |
| **statusLine** in settings.json | Persistent line at bottom of Claude Code | User only |

**There is no channel that both the user and Claude see simultaneously.**

- Do NOT write user-facing UI to stderr in hooks — nobody sees it
- The user's only visual indicator is the `statusLine` configured in `~/.claude/settings.json`, which runs `~/.claude/statusline-command.sh`. The script is shipped in `scripts/statusline-command.sh` (cross-platform, macOS + Linux).
- Claude's input comes via two XML tags on stdout: `<codebase-intelligence>` (static summary) and `<codebase-retrieval>` (query-aware results)

The statusline shows: `◆ 100%(35/35) · 27 files · 130exp · ⟳ 3s · → 12s ← config.py`
- `◆` green/yellow/red = health
- `⟳`/`⏸` = watcher running/off
- `→ Xs` = when context was last sent to Claude
- `← file` = last file watcher processed

### CLI Commands (`commands/`)

`bin/intel.js` is a slim ~110-line dispatcher. All command logic lives in `commands/*.js`:
- Each file exports `{ run }` where `run` is `async function run(ctx)`
- `ctx = { argv, roots, root }` — commands import `flag(argv, name)` and `hasFlag(argv, name)` from `lib/cli.js`, calling them with `process.argv`
- Hook commands (`hook-sessionstart.js`, `hook-refresh.js`) bypass `rootsFromArgs` and use `process.cwd()`
- `scan.js` handles both `scan` and `rescan` (checks `ctx.argv[0]` for `pruneMissing`)
- Shared utilities in `lib/cli.js`: `stripUnsafeXmlTags`, `getWatcherStatus`, `renderBanner`, `renderStatusLine`, `readStdinJson`, etc.
- `sextant mcp` launches the MCP server (`mcp/server.js`) over stdio for Claude Code integration

### Injection into Claude Code

Two hooks are automatically wired into `.claude/settings.json` by `sextant init` (merging into any existing settings, preserving other MCP servers and hook entries):
- **SessionStart**: `sextant hook sessionstart` — injects static summary + auto-starts watcher (unchanged)
- **UserPromptSubmit**: `sextant hook refresh` — query-aware retrieval pipeline:
  1. Classifies prompt via `shouldRetrieve()` (<1ms)
  2. If code-relevant: runs graph retrieval + Zoekt HTTP search in parallel (35-70ms)
  3. Merges results, formats as compact markdown, dedupes via SHA-256, injects as `<codebase-retrieval>`
  4. If not code-relevant or no results: falls back to static summary injection as `<codebase-intelligence>` (v1 behavior)

The legacy `tools/codebase_intel/refresh.js` standalone script has been removed. All installs use `sextant hook refresh`.

### Per-Repo State

All state lives in `.planning/intel/` (never committed):
- `graph.db` — SQLite database: dependency graph + file metadata + resolution stats (single source of truth). `meta` table also carries `generated_at`, `scanned_head`, `scanned_status_hash`, `scanner_version`, `schema_version` (the freshness gate's anchors).
- `summary.md` — the injected summary
- `history.json` — health snapshots for sparkline trends
- `telemetry.jsonl` (+ `.old`) — append-only freshness-gate events; rotates past 1 MiB
- `.rescan_pending` — atomic single-flight marker for the freshness gate's async rescan; orphaned markers expire after 5 minutes
- `.watcher_heartbeat` — watcher alive signal (mtime checked by statusline)
- `.watcher_last_file` — last file the watcher processed
- `.last_injected_hash.summary.*` — per-session dedupe hashes for static summary injection
- `.last_injected_hash.retrieval.*` — per-session dedupe hashes for query-aware retrieval injection
- `index.json.migrated` — legacy index.json renamed after one-time migration to graph.db

## Key Design Decisions

- **Health-gated ranking**: graph reranking disabled when import resolution drops below 90%
- **Definition over hub**: scoring prioritizes files that define a symbol over files that merely import it — fan-in suppression + definition-site priority signals
- **Source-first search**: rg searches source files before docs/config to prevent changelog saturation
- **Export-graph lookup**: queries the exports table to find which file exports a queried symbol, bypassing rg hit order entirely. Solves "common term in large repo" failures (React `useState`, etc.)
- **Re-export chain tracing**: follows `export { X } from './Y'` chains through barrel files to find original definition. Uses the `reexports` table with BFS up to 5 hops.
- **AST export extraction**: `@babel/parser` extracts exports from JS/TS (including re-exports with source specifiers). Falls back to regex on parse failure. Imports still use regex (96-100% accurate).
- **Auto-migration**: legacy index.json files are automatically migrated into graph.db on first init and renamed to `.migrated`. Stale v1 format entries (absolute-path keys, string imports) are flagged for re-extraction.
- **Queue serialization**: all operations on a root are serialized through a promise chain to prevent concurrent SQLite access
- **Summary is clamped**: hard-capped at ~2200 chars to stay within useful context budget
- **Periodic heartbeats**: watcher pings every 30s even when idle — writing only on flush makes idle watchers look dead
- **Entry point path exclusion**: `isEntryPoint()` rejects files in `fixtures/`, `tests/`, `examples/`, `demos/` etc. — prevents false positives from ranking above real results
- **No redundant metrics**: don't display values that are always identical (e.g., indexed files vs graph nodes)
- **graph.db is single source of truth**: index.json was eliminated — file metadata, imports, exports all live in SQLite. No more O(N) JSON.stringify per flush.
- **Test fixtures cause false-positive imports**: regex extractors parse test files and find import specifiers inside string literals (e.g., `import("./lazy")` in a test assertion). This produces harmless unresolved imports in health output — 99% resolution with 1 false positive is clean.
- **Query-aware hooks**: the UserPromptSubmit hook classifies prompts and runs graph + Zoekt retrieval for code-relevant prompts, falling back to static summary for non-code prompts
- **Graph-only fast path**: graph-retrieve.js runs in <50ms with no subprocesses — purely in-memory SQLite queries. Used in hooks alongside Zoekt HTTP for the 200ms budget.
- **Shared deadline**: zoekt.searchFast() uses a 180ms total budget, not stacked independent timeouts. Graph and Zoekt run in parallel.
- **Separate cache namespaces**: retrieval and summary dedupe hashes use distinct files (`.last_injected_hash.retrieval.*` vs `.last_injected_hash.summary.*`) to prevent alternating code/non-code prompts from invalidating each other's dedupe.
- **Sextant MCP server**: replaces standalone Python Zoekt MCP with graph-ranked search. Registered per-project via `.mcp.json`. Four tools: search, related, explain, health.
- **Silent absence over false confidence**: when the freshness gate detects stale state, the injected `<codebase-intelligence>` body is rebuilt from scratch with only filesystem/git-derived fields (no graph-derived numbers). Stale structural claims never enter the prompt; the LLM has nothing to misquote. The old "ALERT: INDEX STALE -- ship anyway" model is gone — it cried wolf on idle repos and still leaked stale numbers when the repo HAD changed.
- **Freshness ≠ age**: a 5-day-old graph of an unchanged repo is fresh; a 1-minute-old graph after `git checkout` is stale. The gate compares git HEAD + status fingerprint + version stamps, not wall-clock elapsed time. The fingerprint excludes `.planning/` so sextant's own writes don't pollute the signal.
- **Atomic single-flight rescan**: stale detection enqueues at most one async rescan per repo at a time, gated by an `O_CREAT|O_EXCL` marker file with a 5-minute orphan-recovery window. The spawned `sextant scan` runs with `--allow-concurrent --force`; the watcher's RAM cache gets invalidated correctly via the mtime-gated `loadDb()`, so concurrent execution is safe.

## Eval Harness

Self-referential evaluation: 19 queries across 7 categories (symbol, multiword, path, cross-file, scoring, scope, negative). Measures P@k, MRR, nDCG, usefulness, graph lift.

```bash
node scripts/eval-retrieve.js             # terminal output
node scripts/eval-retrieve.js --verbose   # hit lines + scoring signals
node scripts/eval-retrieve.js --json      # machine-readable
```

Current self-eval metrics on HEAD: **MRR 0.954, nDCG 0.920, 19/19 pass.**

Graph-boost lift on the self-eval corpus is currently ≈ neutral (mean nDCG delta −0.006 vs rg-only). rg already achieves perfect nDCG on 17/19 queries, so the graph layer has no headroom to add; on multi-003 (`resolutionPct`) graph boosts promote a different def-site than the ground truth prefers, netting −0.164 on that one case. The machinery's intended value is on corpora where rg misses definitions entirely — larger repos with barrel re-exports (React `useState`, `createElement`) and common-name floods. Those external validations were done by hand during development but are NOT committed as reproducible fixtures; don't cite them as measured evidence without re-running against the actual repos.

Any scoring change should re-run `npm run test:eval` and confirm the `graphLiftNDCG` hasn't regressed further — and should include a new eval fixture that exercises the intended win case if claiming a graph-side win.

## Repo History (why this exists separately)

**The confusion**: This project started inside a fork of the GSD (Get Shit Done) Claude Code plugin at `/root/gsd` → `Skidudeaa/get-shit-done`. The codebase-intel code was developed alongside 91 GSD plugin files (agents, commands, templates) in the same repo. The directory was named `gsd`, the remote pointed to `get-shit-done`, and the GSD plugin was still actively used — creating constant confusion about what was what.

**The reality**: Sextant and GSD are completely independent. GSD's hooks (`session-start.js`, `gsd-check-update.js`, `context-monitor.js`) don't reference sextant. GSD's `map-codebase` command writes to `.planning/codebase/` — different directory, different format. Zero cross-dependencies.

**What happened (2026-03-23)**:
- Split sextant into its own repo: `Skidudeaa/sextant`
- Archived the fork: `Skidudeaa/get-shit-done` (archived on GitHub, backed up locally at `/root/gsd-archived`)
- GSD plugin is installed normally via its package manager (`/gsd:update`), no local clone needed
- Binary renamed from `codebase-intel` to `sextant` (alias kept for backward compat)
- Existing hooks in projects use `codebase-intel` command name — still works via alias

**If confused**: sextant lives at `/root/sextant`. GSD is a Claude Code plugin installed globally. They don't talk to each other. The old `/root/gsd-archived` is a backup you probably don't need.

## Development History

Built in a single intensive session. Key milestones:

1. **Scoring fix**: definition-site priority signals + fan-in suppression. Solved hub files (intel.js) outranking definition files in manual spot-checks. (Historical numbers like "MRR 0.838 → 0.931" appeared in prior drafts but were never committed as a reproducible before/after harness — treat them as directional, not load-bearing.)
2. **File sort fix**: promoted `bestAdjustedHitScore` above raw fan-in in `rerankFiles()`. The linchpin that made all scoring signals flow through to file ranking.
3. **Auto-migration**: stale v1 index entries (absolute paths, string imports) detected and re-extracted on load. Resolution jumped from 54% to 100%.
4. **Source-first rg**: two-phase collection (source files first, then docs). Fixed Flask "Flask" query where CHANGES.rst dominated results.
5. **Export-graph lookup**: queries exports table for each query term, injects files rg missed. Fixed React "useState" (716 source files, definition never reached scorer).
6. **AST export extraction**: `@babel/parser` for JS/TS exports with re-export tracking. 1,004 re-exports captured in React. Fixed React "createElement" via barrel-file chain tracing.
7. **Entry point refinement**: path exclusion + removed entry point as sort key (kept as +10% scoring signal only). Fixed Express fixtures outranking lib files.
8. **Visibility model**: learned (the hard way) that stderr from hooks is invisible. Moved user-facing output to Claude Code's `statusLine` config.
9. **Watcher lifecycle**: heartbeat file, auto-start from SessionStart hook, `/watch` slash command, `watch-start`/`watch-stop` CLI.
10. **Repo split**: separated from GSD fork into independent `Skidudeaa/sextant` repo. Binary renamed to `sextant` with `codebase-intel` alias for backward compatibility.
11. **Query-aware retrieval (v2)**: UserPromptSubmit hook now classifies prompts and runs graph + Zoekt search in parallel (35-70ms). Classifier, graph-retrieve, merge-results, format-retrieval pipeline. MCP server replaces standalone Python Zoekt MCP.

## What NOT to add

- Embeddings or vector search
- LLM calls in the pipeline
- Semantic claims (LSP-like behavior)
- Summaries > 2200 chars
- UI that writes to stderr in hooks (nobody sees it)

Use eval metrics to justify changes.
