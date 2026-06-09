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
npm run test:unit    # unit tests (763 in 197 suites, ~12s)
npm run test:eval    # just the 21-query eval harness
```

No build step. CommonJS throughout, no transpilation.

## Deploying to a new project

```bash
cd /path/to/project
sextant init         # creates .planning/intel/, wires SessionStart+UserPromptSubmit hooks into .claude/settings.json, registers sextant MCP server in .mcp.json
sextant scan --force # indexes files, builds dependency graph
```

The watcher auto-starts on next Claude Code session. To start manually: `sextant watch-start`

## Architecture

### Pipeline

1. **Extractors** (`lib/extractors/`) parse imports/exports from source files
   - JS/TS imports: regex-based (`javascript.js`)
   - JS/TS exports: AST-based via `@babel/parser` (`js_ast_exports.js`), falls back to regex on parse failure
   - Python: AST-based via `python_ast.py` (`python.js`)
   - Swift declarations + relations: tree-sitter via `web-tree-sitter` (`swift.js`); span-based decl identity, heuristic edge confidence; WASM at `vendor/tree-sitter-swift.wasm`. Repo-local source orientation only — see `docs/swift-v1-scope.md`
   - Registry: `extractors/index.js` maps extensions to extractors

2. **Resolver** (`lib/resolver.js`) maps import specifiers to file paths
   - JS/TS: relative paths, tsconfig `paths`/`baseUrl`, workspace packages
   - Python: relative imports (dot notation), local package imports
   - Returns `{ specifier, resolved, kind }` where kind is `relative|external|tsconfig|workspace|asset|unresolved`

3. **Graph** (`lib/graph.js`) stores the dependency graph in SQLite (via sql.js)
   - Tables: `files`, `imports`, `exports`, `reexports`, `meta`, `swift_declarations`, `swift_relations`, `swift_entry_files`
   - Provides fan-in/fan-out queries, neighbor expansion, hotspot detection
   - `findExportsBySymbol()` — export-graph lookup for common-term retrieval
   - `findReexportChain()` — BFS through re-export chains for barrel-file tracing
   - `setSwiftEntryFile()` / `getSwiftEntryFiles()` — per-file `@main` attribute markers, populated by `intel.js` after each Swift indexOneFile

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
    - `sextant_scope` — vendored exclusions with detection reason (auto-detected nested-git-repo / vendor-dirname / tarball-name, plus user-config)
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
      - `retrieval.classified { retrieve, confidence, termCount }` / `retrieval.injected { source, fileCount }` / `retrieval.empty_fallback {}` / `retrieval.stale_hit { reason, contentChanged }` — the T1.3/T1.2 hook-pipeline counters (fire-rate, empty-injection rate, provenance, retrieval-lane stale rate)
      - `retrieval.path_hit { source, tool, arm }` / `retrieval.path_miss { tool, arm }` — the 009 #1 outcome substrate: did the agent open/edit a file retrieval surfaced? Emitted by the PostToolUse hook (component 14). `source` attributes the hit to the signal that surfaced the file (exported_symbol / swift_decl_type / reexport_chain / path_match / text_only) so opens are measurable per-signal. `arm` (armed|holdback) is the 009 #1 follow-up counterfactual tag (component 15a)
      - `retrieval.holdback { fileCount }` — the holdback arm withheld a retrieval block this turn (the agent oriented WITHOUT injection); the baseline arm of the armed-vs-holdback A/B
    - Bounded growth: rotates to `.old` past `TELEMETRY_MAX_BYTES` (1 MiB)
    - Never throws; failures are silently absorbed (telemetry must never break the hook)
    - Audit surface: `sextant telemetry [--json | --tail N] [--include-old]` — prints stale rate, stale-reason breakdown, scan duration percentiles (p50/p95/p99) split by trigger, success rate, retrieval fire/empty-injection rates, **open-precision (path_hit / scored opens) + per-source breakdown + per-arm split with `benefitDelta` (armed − holdback open-precision = the causal lift, null until a holdback arm runs)**, event counts by name, observation window
    - Dataset feeds the future Option-5 adaptive sync/async decision (per-repo p95 scan duration drives whether sync rescan is safe)

14. **Outcome substrate** (`commands/hook-posttooluse.js`) — the PostToolUse half of the benefit-proof loop (009 #1)
    - The retrieval hook persists the per-session set of injected paths (each tagged with the signal that surfaced it) to `.planning/intel/.last_injected_paths.retrieval.<sessionKey>`. This hook fires after a file-targeting tool (Read/Edit/Write/MultiEdit/NotebookEdit), normalizes the touched path to repo-relative, and emits `retrieval.path_hit { source }` if it's in the most-recent injected set, else `retrieval.path_miss`. Turns "did the agent use what we surfaced?" from unanswerable into a logged open-rate
    - **Out-of-band**: writes NOTHING to stdout (a PostToolUse hook's stdout can reach the transcript/context) → zero context-budget cost. Never throws
    - **v1 = "loop wired, baseline pending"**: open-precision is a correlation with no counterfactual (the agent often opens the canonical file regardless of injection). The per-turn injection-OFF holdback arm that makes it a real benefit number is the explicit follow-up; this ships the loop + the per-source attribution it needs. `path_miss` includes opens of unrelated files (after an injection) — precision-flavored, not coverage

15. **Benefit-proof instruments** (009 #1 + #12) — the answer to "does sextant actually help the agent?", measured on real behavior instead of fixture proxies. Two complementary instruments; the verified result lives in `docs/010-benefit-proof.md` (retrieval **2.52× open-rate lift** over a permutation-null on 110 real sessions — suffix-matcher v2, 2026-06-09; the 6-agent-verified v1 anchor was 1.98×/74 sessions with basename matching; static summary only 1.38× = the recency correlation trap; median first-touch rank 2). Both are correlational until the holdback arm accumulates.

    a. **Injection-OFF holdback arm** (`commands/hook-refresh.js:decideArm`) — the per-turn A/B counterfactual that turns open-precision into a *causal* benefit number. On a `holdback` turn the hook still RUNS retrieval and PERSISTS the set it would have surfaced (tagged `arm:"holdback"`), but does NOT emit the `<codebase-retrieval>` block — it falls back to the static summary so the agent keeps SOME orientation (the arm withholds the graph-authority *contribution*, not sextant entirely). The PostToolUse hook stamps `arm` on every `path_hit`/`path_miss`; `sextant telemetry` splits open-precision by arm → `benefitDelta` = armed − holdback. **Default-off**: `SEXTANT_HOLDBACK_PCT` unset/0 → always armed → byte-identical to pre-holdback behavior (a normal install is never degraded). Opt in by setting the env var on a dogfooding repo to earn the baseline. **Never holds back on a content-stale turn** (the graph authority is already suppressed; withholding there conflates "we withheld" with "index stale"). Tests force armed-vs-holdback via `SEXTANT_HOLDBACK_FORCE` / stdin `_holdbackForce` (deterministic; the hook is plain Node so `Math.random` is fine in prod).

    b. **Offline trajectory replay** (`lib/trajectory.js`, `sextant eval-trajectory`) — replays real Claude Code session transcripts (`~/.claude/projects/**/*.jsonl`), finds every turn where sextant injected files (`<codebase-retrieval>` / `<codebase-intelligence>` in `attachment` records), and scores whether the agent then OPENED them (matching repo-relative + basename against subsequent Read/Edit/Write `tool_use`). The headline is the **permutation-null LIFT** (actual coverage vs coverage of a plausible random same-repo surfaced set), not raw coverage — raw coverage is uninterpretable (the agent opens central files anyway). Reports lift (retrieval + static contrast), orientation-latency (first-touch rank distribution), and per-source coverage. Excludes nested `subagents/`/`workflows/` transcripts (they inherit injected context but aren't real orientation). Verified by a 6-agent adversarial reproduction (see `docs/010-benefit-proof.md`). This is the *before-merge* proof; the holdback arm is the *in-field* proof.

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

The statusline shows (healthy): `◆ 100% · 80 files · ⟳ 3s · → 12s ← config.py`
- `◆` green/yellow/red = health (resolution % alone; the absolute fraction lives in `sextant doctor`, not the at-a-glance line)
- `⟳`/`⏸` = watcher running/off
- `→ Xs` = when context was last sent to Claude
- `← file` = last file watcher processed
- `🔍 N · Xm` = last query-aware retrieval (file count + age)

When something needs action: `◆ 60% · 5 files · ⏸ off  ⚠ run: sextant watch-start`
- `⚠ run: <cmd>` slot only appears when an actionable condition is detected; carries the literal command to copy. Priority: watcher off/stale → resolution <90%. The statusline shows only the highest-priority action; `sextant doctor`'s top-of-output Actions block lists all applicable actions exhaustively.

### CLI Commands (`commands/`)

`bin/intel.js` is a slim ~110-line dispatcher. All command logic lives in `commands/*.js`:
- Each file exports `{ run }` where `run` is `async function run(ctx)`
- `ctx = { argv, roots, root }` — commands import `flag(argv, name)` and `hasFlag(argv, name)` from `lib/cli.js`, calling them with `process.argv`
- Hook commands (`hook-sessionstart.js`, `hook-refresh.js`, `hook-posttooluse.js`) bypass `rootsFromArgs` and use `process.cwd()` (whitelisted in `test/command-conventions.test.js`)
- `scan.js` handles both `scan` and `rescan` (checks `ctx.argv[0]` for `pruneMissing`)
- Shared utilities in `lib/cli.js`: `stripUnsafeXmlTags`, `getWatcherStatus`, `renderBanner`, `renderStatusLine`, `readStdinJson`, etc.
- `sextant mcp` launches the MCP server (`mcp/server.js`) over stdio for Claude Code integration
- `sextant eval-trajectory [--projects <path>] [--repo <name>] [--json] [--size-matched] [--include-subagents]` — the offline benefit-proof harness (component 15b); replays real session transcripts and reports retrieval open-rate lift vs a permutation null. Reads `~/.claude/projects` by default, NOT a repo root

### Injection into Claude Code

Three hooks are automatically wired into `.claude/settings.json` by `sextant init` (merging into any existing settings, preserving other MCP servers and hook entries). The merge is idempotent and self-deploying — `intel.init` runs on every prompt, so an existing install picks up a newly-added hook without a manual re-init:
- **SessionStart**: `sextant hook sessionstart` — injects static summary + auto-starts watcher (unchanged)
- **UserPromptSubmit**: `sextant hook refresh` — query-aware retrieval pipeline:
  1. Classifies prompt via `shouldRetrieve()` (<1ms)
  2. If code-relevant: runs graph retrieval + Zoekt HTTP search in parallel (35-70ms)
  3. Merges results, formats as compact markdown, dedupes via SHA-256, injects as `<codebase-retrieval>`; persists the injected `{path, source}` set (tagged `arm`) for the outcome substrate. On a `holdback` turn (009 #1 follow-up, default-off via `SEXTANT_HOLDBACK_PCT`) the block is withheld and the static summary shown instead — the counterfactual baseline (component 15a)
  4. If not code-relevant or no results: falls back to static summary injection as `<codebase-intelligence>` (v1 behavior)
- **PostToolUse** (matcher `Read|Edit|Write|MultiEdit|NotebookEdit`): `sextant hook posttooluse` — the 009 #1 outcome substrate (component 14). Scores whether the agent opened/edited a file retrieval surfaced, emitting `retrieval.path_hit`/`path_miss`. Out-of-band (no stdout), never throws.

The legacy `tools/codebase_intel/refresh.js` standalone script has been removed. All installs use `sextant hook refresh`.

### Per-Repo State

All state lives in `.planning/intel/` (never committed):
- `graph.db` — SQLite database: dependency graph + file metadata + resolution stats (single source of truth). Also holds `swift_declarations` and `swift_relations` tables for Swift-source orientation. `meta` table carries `generated_at`, `scanned_head`, `scanned_status_hash`, `scanner_version`, `schema_version` (the freshness gate's anchors).
- `summary.md` — the injected summary
- `history.json` — health snapshots for sparkline trends
- `telemetry.jsonl` (+ `.old`) — append-only freshness-gate events; rotates past 1 MiB
- `.rescan_pending` — atomic single-flight marker for the freshness gate's async rescan; orphaned markers expire after 5 minutes
- `.scan_in_progress` — cooperative-pause marker: while it's fresh (<90s), a live watcher defers its graph.db writes so a concurrent `scan`/`rescan` can't be clobbered; refreshed during the scan, cleared (pid-aware) on exit
- `.watcher_heartbeat` — watcher alive signal (mtime checked by statusline)
- `.watcher_last_file` — last file the watcher processed
- `.last_injected_hash.summary.*` — per-session dedupe hashes for static summary injection
- `.last_injected_hash.retrieval.*` — per-session dedupe hashes for query-aware retrieval injection
- `.last_injected_paths.retrieval.*` — per-session set of injected `{ts, stale, arm, paths:[{path, source}]}` (009 #1 outcome substrate + holdback arm); the PostToolUse hook scores file-opens against it and reads `arm` (armed|holdback) to tag the event. Overwritten each injection (compared against the most-recent surfaced set). On a holdback turn it carries the paths sextant WOULD have surfaced even though no block was emitted (the counterfactual)
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
- **Project center vs vendored subtrees**: `lib/project-scope.js` detects vendored subtrees at depth=1 from the working tree using three strong signals (any single match marks vendored): (1) nested `.git/` directory with HEAD/refs, (2) conventional vendor dirnames (`vendor/`, `Pods/`, `Carthage/`, `third_party/`, `bower_components/`, `external/`, `deps/`, `target/`), (3) GitHub-tarball-extract naming (`<owner>-<repo>-<short-hash>/`). Detected paths get added to `cfg.ignore` so they never enter the graph. The summary header surfaces "Vendored excluded: N (path1, path2, …)" so users can audit and override via `.codebase-intel.json` (`vendored: [...]` adds, `vendoredDetection: false` disables auto-detection). Conservative by design — manifest-only signals (subdir has `pyproject.toml` while root has `Package.swift`) would catch more vendored cases but false-positive on polyglot monorepos; users can list those explicitly.
- **`.gitignore` honoring**: `lib/config.js:loadRepoConfig` reads the root `.gitignore` (when present) and builds a filter via the `ignore` npm package. Returned as `cfg.gitignoreFilter` (a `(relPath) => boolean` predicate). `intel.scan` filters fast-glob output through it; the watcher (`watch.js`) appends it to chokidar's `ignored` array as a function. Default-on; opt out via `.codebase-intel.json:gitignoreHonoring: false`. Scope: root `.gitignore` only — nested `.gitignore` files in subdirs are not honored (would require multi-file chaining via `ignore`'s `add(ig)` API; deferred). Negations (`!path`) follow strict gitignore semantics: only effective when the parent directory is not excluded. The static `cfg.ignore` glob array still applies as the fast-pruning layer; the filter is the correctness backstop for everything fast-glob enumerated.
- **Coverage diagnostics** (`lib/coverage-diagnostics.js`): tree-wide JS/TS default globs + a loud diagnosis (`globs-too-narrow` / `unsupported-language` / `empty-repo`) when the index is empty or covers <50% of supported sources. Computed once per scan, persisted to graph meta as `coverage_note` (per-SCAN, not per-flush — embedded counts can drift until the next bulk scan), surfaced as `ALERT: COVERAGE <KIND>` in the summary (message XML-escaped), a kind-aware statusline hint, and a doctor action. Opt out via `.codebase-intel.json:coverageDiagnostics: false` — for deliberately-narrowed globs (e.g. one package of a monorepo) where the partial-coverage warning would fire on every scan. CAVEAT on the expanded ignore floor (`out/`, `coverage/`, `.cache/`, etc.): a repo whose real source lives in a dir with one of those conventional names is silently excluded — override via `.codebase-intel.json` `ignore`/`globs`.
- **Swift entry-point detection**: two complementary signals merged in summary's "Likely entry points" list. (1) Filename heuristics in `isEntryPoint()`: `main.swift`, `AppDelegate.swift`, `<Type>App.swift` (SwiftUI App-protocol convention). (2) `@main` attribute scan in `lib/extractors/swift.js:hasAtMain()` — narrow regex over file content (precise word boundaries to reject `@mainView`, `xx@main`, `@@main`); `intel.js` calls it per-Swift-file and toggles a row in the new `swift_entry_files` table. Summary unions both signals, deduped, with `— @main` tag on rows that filename heuristic missed. Test/fixture path exclusion applies to both signals identically.
- **No redundant metrics**: don't display values that are always identical (e.g., indexed files vs graph nodes)
- **graph.db is single source of truth**: index.json was eliminated — file metadata, imports, exports all live in SQLite. No more O(N) JSON.stringify per flush.
- **Test fixtures cause false-positive imports**: regex extractors parse test files and find import specifiers inside string literals (e.g., `import("./lazy")` in a test assertion). This produces harmless unresolved imports in health output — 99% resolution with 1 false positive is clean.
- **Query-aware hooks**: the UserPromptSubmit hook classifies prompts and runs graph + Zoekt retrieval for code-relevant prompts, falling back to static summary for non-code prompts
- **Graph-only fast path**: graph-retrieve.js runs in <50ms with no subprocesses — purely in-memory SQLite queries. Used in hooks alongside Zoekt HTTP for the 200ms budget.
- **Shared deadline**: zoekt.searchFast() uses a 180ms total budget, not stacked independent timeouts. Graph and Zoekt run in parallel.
- **Separate cache namespaces**: retrieval and summary dedupe hashes use distinct files (`.last_injected_hash.retrieval.*` vs `.last_injected_hash.summary.*`) to prevent alternating code/non-code prompts from invalidating each other's dedupe.
- **Sextant MCP server**: replaces standalone Python Zoekt MCP with graph-ranked search. Registered per-project via `.mcp.json`. Five tools: search, related, explain, health, scope.
- **Silent absence over false confidence**: when the freshness gate detects stale state, the injected `<codebase-intelligence>` body is rebuilt from scratch with only filesystem/git-derived fields (no graph-derived numbers). Stale structural claims never enter the prompt; the LLM has nothing to misquote. The old "ALERT: INDEX STALE -- ship anyway" model is gone — it cried wolf on idle repos and still leaked stale numbers when the repo HAD changed.
- **Freshness ≠ age**: a 5-day-old graph of an unchanged repo is fresh; a 1-minute-old graph after `git checkout` is stale. The gate compares git HEAD + status fingerprint + version stamps, not wall-clock elapsed time. The fingerprint excludes `.planning/` so sextant's own writes don't pollute the signal.
- **Atomic single-flight rescan**: stale detection enqueues at most one async rescan per repo at a time, gated by an `O_CREAT|O_EXCL` marker file with a 5-minute orphan-recovery window. The spawned `sextant scan` runs with `--allow-concurrent --force`; the watcher's RAM cache gets invalidated correctly via the mtime-gated `loadDb()`, so concurrent execution is safe.
- **Cooperative watcher pause (scan/watcher coexistence)**: `scan`/`rescan` no longer hard-refuse while the watcher is live. The scan drops a `.scan_in_progress` marker (refreshed on progress, cleared pid-aware in `finally`); the watcher, advertising `scanPauseProtocol` in its heartbeat, **defers its graph.db writes** while the marker is fresh and resumes after — its post-scan persist reloads the scan's result via the mtime-gated `loadDb()` instead of clobbering it. The deferral lives on the actual writer (`intel.js:scheduleGraphPersist`'s timer callback), not just `watch.js:flush()`, so a persist timer armed *before* the marker appeared is also caught — the gap an adversarial review found. `scan` still refuses only when the running watcher predates the protocol (no `scanPauseProtocol` in its heartbeat); `--allow-concurrent` bypasses the refusal but the marker still pauses a current watcher. Defense in depth: `graph.js:persistDb` now does its `loadDb` *inside* the write lock, closing a load-then-write TOCTOU for any other concurrent writer.

## Eval Harness

Self-referential evaluation: 21 queries across 7 categories (symbol, multiword, path, cross-file, scoring, scope, negative). Measures P@k, MRR, nDCG, usefulness, graph lift.

```bash
node scripts/eval-retrieve.js             # terminal output
node scripts/eval-retrieve.js --verbose   # hit lines + scoring signals
node scripts/eval-retrieve.js --json      # machine-readable
```

Current metrics on HEAD (chronology lives in `CHANGELOG.md`, not here):

| Corpus | Path | MRR | nDCG | Pass | graphLiftNDCG |
|--------|------|-----|------|------|----------------|
| Self-eval (JS) | CLI | 0.900 | 0.920 | 21/21 | +0.012 (neutral) |
| Vapor 4.121.4 (`fixtures/vapor-baseline.json`) | CLI | 0.811 | 0.800 | 15/15 | +0.086 |
| Vapor 4.121.4 (`fixtures/vapor-hook-baseline.json`) | hook | 0.755 | 0.741 | 13/15 | n/a |

Self-eval lift is neutral by nature — this small JS corpus's defs are already surfaced by rg+zoekt+def-site scoring, so injection has nothing to rescue. Vapor's two failures (`vapor-elf-001`, `vapor-init-001`) are accepted debt. The hook baseline is graph-only (production hooks never disable the graph, so no withGraph/withoutGraph A/B). Both Vapor baselines are gated by `bash scripts/eval-swift-external.sh diff` — warm the index first (cold-zoekt flakes the first run).

**Hook query construction (`lib/zoekt.js`).** Multi-token queries go to zoekt as a literal phrase (`quoteIfPhrase`) so `protocol Middleware` matches the adjacent substring instead of AND-ing the words as independent clauses — without this, Swift phrase queries fall out of the top-10. But a scattered natural-language question matches no phrase → 0 hits → the merged set collapses to incidental filename matches, often only test files, with the canonical source absent. Three recall tiers recover this; each fires ONLY when the prior returns zero, so any query that already matched is byte-identical (self-eval/Vapor unchanged):

1. **Phrase** — the default above.
2. **AND** — `escapeForZoekt` re-issues the query unquoted (zoekt whitespace-AND); `bestPerFile` keeps the per-line cap covering distinct files, not N lines of one. In both `searchFast` (hook) and `search` (CLI/MCP). Best-effort within the hook's 180ms budget — a cold-daemon first query may skip it.
3. **Token-coverage OR** — `rankByTokenCoverage` unions the tokens and ranks by how many *distinct* query tokens each file covers (not raw hit count). In `search` ONLY: a third sequential round-trip pushes `searchFast` past 180ms, so the hook stops at AND and the deliberate `sextant_search` path (10s budget) gets full recall.

**Canonical-def ranking (`lib/merge-results.js`, hook path).** The merge fuses graph (~100–161) and zoekt (~500) scores; unchecked, any zoekt-corroborated file outscores a graph-only definition. `DEF_SCORE_FLOOR` (600) lifts `exported_symbol`/`swift_decl_type` signals onto the zoekt scale (mirrors the CLI's `retrieve.js:injectGraphMatches`). A re-export shim must NOT receive that floor, so: `python.js:normalizeExports` keeps the construct kind of locally-defined `__all__` names (only genuinely re-exported names get `kind:"explicit"`); `graph-retrieve.js` routes `"explicit"` to `HIT_REEXPORT_CHAIN` (no floor, not def-suppressive); the merge withholds the ×1.2 fusion bonus from `reexport_chain` (a barrel's graph edge and its `from .mod import X` line are one fact, not independent corroboration); and `python_ast.py` captures annotated module constants (`X: T = {...}`) so a signal-less constant is floorable. Net: the definition outranks its re-export barrel for class and constant symbols alike. CLI/MCP `retrieve()` does not call `mergeResults`, so self-eval and Vapor-CLI are unaffected by this layer.

**Python fixture (`fixtures/python-eval/`).** Synthetic corpus covering layouts the JS+Swift corpora can't: co-located `test_*.py` (pytest convention, not under a `tests/` dir), NL-scatter queries, and `__init__.py` re-exports. `npm run test:eval:python` runs the deterministic CLI path; the hook path needs a warm zoekt index first (`node -e "require('./lib/zoekt').buildIndex(require('path').resolve('fixtures/python-eval'),{force:true})"` then `node scripts/eval-hook.js --root fixtures/python-eval --dataset fixtures/python-eval/eval-dataset.json`). Guard cases:
- `py-penalty-001` (`FLAG_REGISTRY`) — def-over-barrel: the defining module must outrank its `__init__` re-export. Fail-pre/pass-post across the re-export-kind stack.
- `py-nl-001` — NL-scatter recall: the canonical source is absent without the AND fallback. Uses `eval-hook.js`'s `minRecall`/`maxPrimaryRank` gates (recall was computed but never gated, which is how the NL-recall gap shipped unseen).
- `py-reexport-001` — def-over-barrel for a re-exported class.

The **test-path penalty** itself is hard-locked at the function level by `test/merge-results.test.js` (reverting `C.TEST_PENALTY` fails two assertions), not by any fixture case — fixture ranking shifts once a symbol gains a def signal, so a function-level lock is the durable guard.

Backend choice matters. The eval harness uses `backend: "auto"` (zoekt when installed, else rg) — the same path production hooks and the MCP server take. Pinning to `"rg"` measured an inferior code path: common-name def lookups in multi-thousand-file Swift repos (Vapor's `Application`/`Request`/`Response`) come out at MRR 0.20 because rg's text-frequency ranking buries the canonical class def behind higher-fan-in consumer files. With zoekt the same queries surface the canonical file at rank 1.

`quoteIfPhrase` also escapes regex metacharacters (zoekt's query syntax is regex) so a single-token query like `View+Toolbar` matches the literal `+` instead of `View(+Toolbar)` one-or-more — without this, swift-ext-001 in the synthetic Swift fixture regresses to 0 hits. (`escapeForZoekt`, used by the AND/OR fallbacks above, escapes the same way but without the quote-wrapping.)

Swift declaration injection lives in two places now:
- **CLI/MCP path (`lib/retrieve.js:injectGraphMatches`)**: shared helper for both export-graph (JS/TS/Python) and swift-decl injection. When the queried symbol matches a row in `swift_declarations` and the canonical file isn't in the result set, inject it via a targeted rg search. The rg re-search now uses the *matched symbol* (the term that triggered the swift-decl row), not the full original query — earlier code passed the full multi-token query (e.g. `extension Application`) which silently dropped canonical files when their content didn't contain the literal phrase (`Application.swift` has `class Application`, not `extension Application`). Authoritative type kinds (struct/class/protocol/enum/actor/typealias) get a hit-score floor of 600 so they compete with zoekt-sourced hits at base 500.
- **Hook fast path (`lib/graph-retrieve.js`)**: Layer 2 calls `findDeclarationsBySymbol` for each query term. Pure in-memory graph query, no rg subprocess — fits the <50ms budget. Type kinds get score 100 (== `GR_EXPORTED_SYMBOL`); other kinds get 80 (== `GR_REEXPORT_CHAIN`). Definition-site suppression (lines 130-141) treats `swift_decl_type` as suppressive alongside `exported_symbol` so test-file fan-in doesn't outrank the canonical type def.

Test-path penalty extended to Swift conventions (`lib/merge-results.js:fileTypePenalty` and `lib/retrieve.js:isTestPath`):
- `(^|/)XCT\w+/` — Apple's XCTest framework convention (`XCTVapor`, `XCTAssertions`).
- `(^|/)\w+Testing/` — Swift Testing framework convention (`VaporTesting`).
- `merge-results.js` previously checked only `/test/` (singular), missing Swift's `/Tests/` (plural) directories — that bug let `URITests.swift` outrank canonical `URI.swift` in hook output.

**Graph lift, and the metric that hid it (issue #2, resolved).** `graphLiftNDCG` = mean nDCG(graph ON) − mean nDCG(graph OFF). The graph-OFF arm in `scripts/eval-retrieve.js:runCase` uses `retrieve(..., { noGraph: true })`, which forces the *entire* graph lane off — injection (export-graph / swift-decl / re-export chain), related-expansion, and rerank boosts. **This is deliberate and load-bearing.** The prior implementation toggled only `rerankMinResolutionPct: 101`, which disabled reranking but left injection running in *both* arms (injection is gated by `graphAvailable`, not `useGraphBoost` — `lib/retrieve.js:650`). On Swift, where the graph's primary value-add is injecting a canonical decl rg/zoekt never reached (not reranking fan-in), that made the metric structurally blind to the graph layer: it reported 0.000 on Vapor while the graph was in fact taking `URI.swift` from out-of-top-3 to rank 1.

With the corrected metric:
- **Self-eval corpus**: graphLiftNDCG ≈ neutral (+0.012). Genuinely no headroom — this small JS repo's defs are already surfaced by rg + zoekt + def-site scoring; nothing for injection to rescue.
- **Vapor 4.121.4 (committed reproducible fixture)**: graphLiftNDCG **+0.086 (positive)**. Driven by injection-dependent queries — `vapor-uri-001 'URI'` lifts +1.000 (nDCG 0.000 → 1.000; canonical `URI.swift` is buried by `URITests.swift` text frequency without the graph), `vapor-ext-001` +0.610. The genuinely-neutral starred queries are neutral for understood reasons: `vapor-svc-001 'Service'` is already nDCG 1.0 graph-OFF (text scoring saturates, no headroom); `vapor-init-001 'public init'` is nDCG 0.0 both ways — `init` matches 182 declarations with no disambiguating signal (pre-existing acceptable debt). Per-corpus condition: **graph lift is positive when rg/zoekt text frequency buries a canonical decl behind its own test/consumer files; neutral when text scoring already surfaces the def or no signal can disambiguate.**

The hook fast path's merge layer (`lib/merge-results.js:lineLevelAdjustment`) matches query terms **case-sensitively** — `{ caseSensitive: true }` is threaded into `scoring.computeEnhancedSignals`, and the def-site guard compares `String(t) === defSym`. So a consumer line like Swift's `let uri = URI(...)`, where `extractSymbolDef` returns the variable `uri`, does NOT inherit the def-site stack against query `URI` (the type) — which is what keeps `URI.swift` ahead of `URITests.swift` on the hook path. Locked by `test/merge-results.test.js` ("case-sensitive symbol matching (Swift bug-2)"). Resolved in `522741f`; before that the layer lowercased terms, the `uri !== URI` distinction was dead code, and the consumer line falsely earned the +65% def-site stack.

Any scoring change should re-run `npm run test:eval` and confirm `graphLiftNDCG` hasn't regressed — and `bash scripts/eval-swift-external.sh diff` to confirm the committed Vapor positive-lift target holds. A graph-side win claim needs a committed fixture exercising it; Vapor is now that fixture.

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
- Compiler-backed Swift semantics (USRs, cross-module refs, `.swiftinterface` ingestion) — orthogonal to repo-local orientation; would require a Swift toolchain dependency. See `docs/swift-v1-scope.md`.

Use eval metrics to justify changes.
