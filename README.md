# sextant

**A small, honest map of your repo — injected into your coding agent before it guesses.**

Most "codebase intelligence" tools can't tell you whether they help. Sextant can:
on real Claude Code sessions, the files it surfaces for a query get opened **~2×
more often than chance** — measured on real agent behavior, adversarially verified,
caveats and all. ([the proof ↓](#does-it-actually-work-the-proof))

## The Problem

LLMs confidently hallucinate file structure in unfamiliar codebases. They pick
the wrong starting files, miss blast radius, and invent modules that don't exist.
More retrieval makes this faster, not rarer. Sextant solves it differently: it
builds a small, honest map of your repository and injects it into Claude Code
sessions before the first prompt -- so the model starts oriented, not guessing.

And it refuses to lie. When the index goes stale (you switched branches, files
moved), sextant doesn't ship confident-but-wrong structure — it withholds the
structural claims and says so. Drift is loud; the tool never amplifies the
hallucination it exists to prevent.

## Does it actually work? (the proof)

Every codebase-intelligence tool claims to help. Almost none measure it. Sextant's
offline benefit harness replays **real Claude Code session transcripts** and asks
the only question that matters: when sextant surfaced a file, *did the agent open
it?* — scored against a permutation null (would a random plausible repo file have
been opened just as often?).

**On 110 real sessions across 9 repos (5,628 file-opens):**

| Signal | Raw open-rate | Chance baseline | **Lift** |
|--------|--------------|-----------------|----------|
| **Query-aware retrieval** | 5.6% | 2.2% | **2.52×** |
| Static summary (recent-changes etc.) | 14.6% | 10.6% | 1.38× |

The files sextant surfaces for a query are opened **~2.5× more than chance**, and
when one is opened it lands early (median first-touch rank 2). The static summary
*looks* more useful (14.6% raw) but most of that is the **correlation trap** —
"recent changes" lists the files you're already editing, which the agent opens
anyway. Query-relevance carries ~1.8× more genuine signal than recency.

This isn't a vanity number. A 6-agent adversarial workflow rebuilt the measurement
from scratch and attacked six validity threats (against the original anchor; the
current numbers re-derive on the same harness with a stricter matcher that removes
the one overcount the workflow itself flagged); two "refutations" were themselves
overturned on reproduction (one "fairer" baseline was drawing from already-opened
files — biased by construction). **Honest caveat:** the permutation null controls
for "plausible repo files" but not for "the agent would've opened the canonical
file anyway" — so this is *strong correlation*, not yet *proven causation*. The
[injection-OFF holdback arm](#measuring-benefit) is the causal upgrade, shipped
and accruing.

Reproduce it yourself: `sextant eval-trajectory`. Full method + caveats:
[docs/010-benefit-proof.md](docs/010-benefit-proof.md).

## How It Works

```
Source files
    |
    v
Extract imports/exports (regex + AST)
    |
    v
Resolve paths (relative, tsconfig, workspace, Python dot-notation)
    |
    v
Build dependency graph (SQLite via sql.js)
    |
    v
Generate summary (<2200 chars: health, hotspots, entry points, recent changes)
    |
    v
Inject into Claude Code (SessionStart hook + query-aware UserPromptSubmit hook)
```

On each user prompt, sextant classifies the input (<1ms), runs graph retrieval
and text search in parallel if code-relevant (~50ms), and injects ranked results
as context. Non-code prompts get the static summary instead.

## Quick Start

### Install (first time)

```bash
git clone git@github.com:Skidudeaa/sextant.git
cd sextant
npm install
npm link              # makes `sextant` (and the legacy `codebase-intel` alias) globally available
```

### Update (already cloned)

```bash
cd /path/to/sextant
git pull origin main
npm install           # safe no-op when there are no new deps
npm link              # re-link only if the global binary needs refreshing (idempotent)
```

### Verify the install

```bash
sextant --help                                                      # lists subcommands
git -C "$(npm prefix -g)/lib/node_modules/sextant" log -1 --oneline # confirm global binary points at the latest commit
```

### Set up a project

```bash
cd your-project
sextant init          # creates .planning/intel/, wires Claude Code hooks, registers MCP server
sextant scan --force  # indexes JS / TS / Python / Swift (default globs)
sextant health --pretty   # visual summary; shows a Swift Health block when .swift files are indexed
sextant doctor            # detailed diagnostics + Actions block with copy-pasteable commands
```

On the next Claude Code session the watcher auto-starts, the SessionStart hook injects the static summary, and the UserPromptSubmit hook classifies each prompt and injects code-relevant context.

### Status line (optional but recommended)

To see sextant status at the bottom of Claude Code, install the status line script:

```bash
cp /path/to/sextant/scripts/statusline-command.sh ~/.claude/statusline-command.sh
```

Then add to your global `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "command": "~/.claude/statusline-command.sh"
  }
}
```

Works on both macOS and Linux. Requires `jq` and optionally `sqlite3` for export counts.

That's it. On the next Claude Code session:

1. The **SessionStart hook** injects the codebase summary and starts the file watcher
2. The **UserPromptSubmit hook** classifies each prompt and injects code-relevant context
3. The **watcher** keeps the index fresh as you edit files

## What You'll See

The status line at the bottom of Claude Code is your only visual indicator:

```
root@host ~/project (main) ◆ 97% · 64 files · ⟳ 3s · → 8s ← resolver.js
```

When something needs action, an action slot appears with the literal command to run:

```
root@host ~/project (main) ◆ 60% · 12 files · ⏸ off  ⚠ run: sextant watch-start
```

| Part | Meaning |
|------|---------|
| `◆` | Health indicator (green/yellow/red) |
| `97%` | Import resolution rate |
| `64 files` | Indexed file count |
| `⟳ 3s` / `⏸ off` | Watcher status + heartbeat age |
| `→ 8s` | When context was last sent to Claude |
| `← resolver.js` | Last file the watcher processed |
| `⚠ run: <cmd>` | Action hint (only when something needs attention) |

### Operational ergonomics — telling you what to type

Sextant runs in the background, so when something goes wrong you might not remember whether to scan, rescan, init, or restart the watcher. Two surfaces solve this without taking any action on your behalf:

- **Status line action slot** — appears only when an actionable condition is detected (watcher off/stale, resolution below 90%) and carries the literal command to copy. Highest-priority action shown alone; fix it, the next one appears next render.
- **`sextant doctor` Actions block** — top-of-output checklist that exhaustively lists every applicable item (state-dir missing, graph.db missing/empty, watcher dead or stale, resolution degraded, settings.json missing) with a `→ sextant <cmd>` line under each.

Detection and recommendation live in code; execution stays in your hands. Sextant never auto-runs a scan or restarts a watcher.

### Visibility model

There are three output channels and they go to different places:

| Channel | Destination | Audience |
|---------|-------------|----------|
| Hook stdout | Injected as `<system-reminder>` context | Claude only |
| Hook stderr | Nowhere | Nobody |
| `statusLine` in settings.json | Bottom of Claude Code terminal | User only |

There is no channel that both the user and Claude see simultaneously.

## Features

- **Benefit proof, not just no-regression** -- `sextant eval-trajectory` replays real session history to measure whether the agent opened what sextant surfaced (permutation-null open-rate lift); the injection-OFF holdback arm makes it causal over time
- **Health-gated scoring** -- graph boosts disabled when import resolution drops below 90%
- **Freshness gate** -- when stored graph state diverges from git HEAD / status / scanner version, the injection drops to a minimal body (filesystem + git fields only) instead of leaking stale numbers; an atomic single-flight rescan is enqueued in the background
- **Three-layer retrieval** -- rg text search + export-graph symbol lookup + re-export chain tracing
- **Swift declarations + relations** -- tree-sitter walker produces top-level types, members one level deep, and conformance/inheritance edges with `confidence={direct|heuristic}`
- **Query-aware hooks** -- classifies each prompt, retrieves code-relevant context in <200ms
- **AST export extraction** -- JS/TS via @babel/parser with regex fallback on parse failure
- **TS ESM Node16 awareness** -- `.ts` source importing `./foo.js` resolves to `./foo.ts` per the NodeNext convention; opt-in via importer extension so pure-JS projects keep literal semantics
- **MCP server** -- 5 tools (search, related, explain, health, scope) registered per-project via `.mcp.json`
- **Definition over hub** -- definition-site scoring beats high fan-in hub files
- **Source-first search** -- source files searched before docs/config to prevent changelog saturation
- **Re-export chain tracing** -- follows barrel-file re-exports up to 5 hops to find original definitions
- **Cross-project validated** -- Express (142 files), Flask (83 files), React (4,337 files), Vapor 4.121.4 (294 files; manual-trigger via `scripts/eval-swift-external.sh`)

## Commands

| Command | Description |
|---------|-------------|
| `sextant init` | Create `.planning/intel/`, wire Claude Code hooks, register MCP server |
| `sextant scan [--force]` | Index imports/exports, build dependency graph |
| `sextant rescan [--force]` | Scan + prune deleted files |
| `sextant watch` | Live file watching with terminal dashboard |
| `sextant watch-start` | Start watcher in background (detached) |
| `sextant watch-stop` | Stop background watcher |
| `sextant health [--pretty]` | Resolution %, index age, top unresolved |
| `sextant doctor` | Visual diagnostic with trends and hints |
| `sextant summary` | Print what Claude sees |
| `sextant retrieve <query>` | Ranked search with graph context |
| `sextant query <imports\|dependents\|exports> --file <path>` | Query the dependency graph directly |
| `sextant inject` | Print the current `<codebase-intelligence>` body to stdout (freshness-gated, same contract as the hooks) |
| `sextant update --file <relPath>` | Re-extract a single file and update the graph (used by the watcher; useful for ad-hoc reindex) |
| `sextant telemetry [--json \| --tail N] [--include-old]` | Audit the dataset: stale rate, scan percentiles, open-precision + per-arm holdback `benefitDelta` |
| `sextant eval-trajectory [--json] [--repo <name>] [--size-matched]` | Replay real session history → retrieval open-rate lift vs a permutation null (the benefit proof) |
| `sextant zoekt <index\|serve\|search>` | Manage Zoekt code search (optional) |
| `sextant mcp` | Start the MCP server (stdio, used by Claude Code) |
| `sextant hook sessionstart` | SessionStart hook entry point |
| `sextant hook refresh` | UserPromptSubmit hook entry point (retrieval + holdback arm) |
| `sextant hook posttooluse` | PostToolUse hook — scores whether the agent opened what was surfaced |

## Configuration

Optional `.codebase-intel.json` at project root:

```json
{
  "globs": ["**/*.{js,ts,py}"],
  "ignore": ["legacy/**", "vendor/**"],
  "vendored": ["mcp-servers"],
  "vendoredDetection": true,
  "gitignoreHonoring": true,
  "summaryEverySec": 5
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `globs` | `["**/*.{js,ts,py}"]` | File patterns to index |
| `ignore` | `[]` | Patterns to exclude |
| `vendored` | `[]` | Explicit subdirs to exclude from indexing (always honored, additive to auto-detection) |
| `vendoredDetection` | `true` | Auto-detect vendored subtrees at depth=1 (nested `.git/`, conventional dirnames like `vendor/`/`Pods/`/`Carthage/`/`target/`, GitHub-tarball naming). Set to `false` to disable. |
| `gitignoreHonoring` | `true` | Honor the project's root `.gitignore` (semantics-correct via the `ignore` npm package, including negations and anchored patterns). Set to `false` to ignore the file. |
| `summaryEverySec` | `5` | Minimum interval (seconds) between summary regenerations |

The summary header lists detected vendored exclusions (`Vendored excluded: N (path1, path2, …)`) so you can audit and override when the heuristic guesses wrong.

## Language Support

| Language | Import extraction | Export extraction |
|----------|------------------|-------------------|
| JavaScript / TypeScript | Regex (96-100% accurate) | AST via `@babel/parser`, regex fallback |
| Python | AST via stdlib `ast` (subprocess) | AST via stdlib `ast` (subprocess) |
| Swift | tree-sitter (declarations + relations only — `import` statements not yet resolved as graph edges) | n/a — Swift has no `export` semantics |

> Swift v1 is **repo-local source orientation**, not SDK / framework
> introspection. See [docs/swift-v1-scope.md](docs/swift-v1-scope.md) for what
> works, what doesn't, and how to recover from parser failure.

## Architecture

The central orchestrator is `lib/intel.js` (highest fan-in in the project). Key modules:

- **`lib/graph.js`** -- SQLite dependency graph (files, imports, exports, re-exports)
- **`lib/retrieve.js`** -- three-layer ranked search (rg + export-graph + re-export chains)
- **`lib/scoring.js`** + **`lib/scoring-constants.js`** -- definition-site priority, fan-in suppression, health gating
- **`lib/classifier.js`** -- heuristic prompt classification (<1ms, no LLM calls)
- **`lib/graph-retrieve.js`** -- fast graph-only search for hooks (<50ms, no subprocesses)
- **`lib/summary.js`** -- bounded markdown generation (<2200 chars)
- **`mcp/server.js`** -- JSON-RPC 2.0 MCP server over stdio

See [DESIGN_PHILOSOPHY.md](DESIGN_PHILOSOPHY.md) for the guiding principles (orientation over intelligence, drift must be loud, degrade don't guess).

## Measuring benefit

Sextant carries two kinds of evidence, deliberately kept distinct:

1. **Offline fixture evals** (MRR / nDCG / graphLiftNDCG) prove *no-regression* — a
   scoring change can't silently bury a canonical definition. See [Eval Results](#eval-results).
2. **Real-behavior benefit** (`sextant eval-trajectory` + the holdback arm) proves
   the tool *helps* — the [2.52× open-rate lift](#does-it-actually-work-the-proof)
   above, on real sessions. This is the honest answer to "but does it actually work?"

### The holdback arm — turning correlation into causation

The 2.52× lift is strong correlation, not proven causation (the agent might open
the canonical file regardless). The fix is a clean A/B: on a configurable fraction
of turns, sextant **withholds** the retrieval block (still falling back to the
static summary, so the agent keeps orientation) and tags the turn `holdback`. The
PostToolUse hook scores opens on both arms; `sextant telemetry` then reports:

```
  by arm (injection-OFF holdback):
    - armed      open-precision XX%
    - holdback   open-precision YY%
  BENEFIT DELTA (armed − holdback): ZZ pts — the causal open-rate lift the injection buys
```

Default-off (`SEXTANT_HOLDBACK_PCT` unset → byte-identical to normal behavior). Opt
in on a repo to earn the causal baseline. See [docs/010-benefit-proof.md](docs/010-benefit-proof.md).

## Eval Results

21/21 self-eval queries pass on the sextant repo itself: MRR 0.900, nDCG 0.920, graph lift +0.012. External Vapor 4.121.4 benchmark (294 Swift files, 15 queries) — CLI path: MRR 0.811, nDCG 0.800 (`fixtures/vapor-baseline.json`); hook fast path: MRR 0.755, nDCG 0.741, 13/15 pass (`fixtures/vapor-hook-baseline.json`). Cross-project validated on Express (142 files), Flask (83 files), React (4,337 files). Swift synthetic corpus (`fixtures/swift-eval/`, 13 cases): MRR 0.917, nDCG 0.935.

### Running the eval suite

These all run from a clean clone in under a minute (Vapor benchmark excluded — it's manual-trigger only):

```bash
npm run test:unit                                                                                         # 763 pass on a clean run (a few spawn-based tests can flake under full-suite concurrency; they pass in isolation / on re-run)
npm run test:eval                                                                                         # 21/21 self-eval, MRR 0.900, nDCG 0.920
node scripts/eval-retrieve.js --dataset fixtures/mixed-eval/eval-dataset.json --root fixtures/mixed-eval  # 7/7 mixed-language fixture
node scripts/eval-retrieve.js --dataset fixtures/swift-eval/eval-dataset.json --root fixtures/swift-eval  # 13/13 synthetic Swift fixture
sextant eval-trajectory                                                                                   # real-behavior benefit lift (reads ~/.claude/projects)
```

The Vapor benchmark clones `vapor/vapor` at a pinned tag, scans, and diffs against the committed baseline (~1–3 min):

```bash
bash scripts/eval-swift-external.sh                                       # diff CLI + hook (both gates must pass)
bash scripts/eval-swift-external.sh hook-diff                             # hook gate only
bash scripts/eval-swift-external.sh regen-baseline                        # refresh CLI baseline after intentional scoring changes
bash scripts/eval-swift-external.sh regen-hook-baseline                   # refresh hook baseline
VAPOR_SHA=4.121.4 bash scripts/eval-swift-external.sh regen-baseline      # pin to a different Vapor tag
VAPOR_DIR=/somewhere/else bash scripts/eval-swift-external.sh             # override clone target if /tmp is restricted
```

See [EVAL_FINDINGS.md](EVAL_FINDINGS.md) for methodology, scoring evolution, and bugs found by eval. See [docs/swift-v1-scope.md](docs/swift-v1-scope.md) for what Swift v1 is and isn't.

## State Directory

All state lives in `.planning/intel/` (add `.planning/` to `.gitignore`):

| File | Purpose |
|------|---------|
| `graph.db` | SQLite dependency graph -- single source of truth |
| `summary.md` | The summary injected into Claude Code |
| `history.json` | Health trend snapshots for sparkline display |
| `.watcher_heartbeat` | Watcher alive signal (mtime checked by status line) |
| `.watcher_last_file` | Last file the watcher processed |
| `.last_injected_hash.*` | Per-session context deduplication (SHA-256) |
| `.last_injected_paths.retrieval.*` | Per-session surfaced `{path, source, arm}` set — scored by the PostToolUse hook for the benefit loop |
| `telemetry.jsonl` (+ `.old`) | Append-only events: freshness, retrieval, open-precision / holdback (rotates past 1 MiB) |

## Requirements

- Node.js 18+
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) for text search layer
- Optional: [Zoekt](https://github.com/sourcegraph/zoekt) for large-repo text search
- Optional: Python 3 for Python project indexing

## Troubleshooting

### `git pull` aborts with "Your local changes to `package-lock.json` would be overwritten"

This happens when a stale clone's local `package-lock.json` diverges from what's on `main` — usually just metadata churn (name/version/bin entries from the `codebase-intel` → `sextant` rename, integrity-hash format from a different npm version) rather than intentional dep edits. Confirm with a quick diff and discard:

```bash
git diff package-lock.json | head -20         # confirm it's metadata churn, not intentional edits
git checkout -- package-lock.json
git pull origin main
npm install
npm link                                      # only if your global binary needs refreshing
```

If your local clone is many commits behind (>20), expect `npm install` after the pull to bump the lockfile slightly to match your local Node/npm. **Don't commit that** — it's environment churn, not real change. Repeat `git checkout -- package-lock.json` if it reappears.

### `npm install` reports vulnerabilities

The committed `package-lock.json` is the authoritative one; `npm audit` should report **0 vulnerabilities** on a clean pull. If it doesn't, you're probably on a stale lockfile — `git pull origin main && npm install` will bring you to the upstream version. If a real CVE lands on a transitive dep, the fix is committed upstream as a `chore(deps): npm audit fix` — pull rather than running `npm audit fix` locally so the lockfile stays authoritative across machines.

### `sextant: command not found`, or running stale code after a pull

`npm link` symlinks `bin/intel.js` into your global `node_modules`. The symlink can go stale if you switch Node versions, reinstall sextant globally, or pull while the link points at an older checkout. Verify the global binary is at the latest commit:

```bash
git -C "$(npm prefix -g)/lib/node_modules/sextant" log -1 --oneline
# Should match `git log -1 --oneline` in your sextant clone.
# If it doesn't:
cd /path/to/sextant && npm link
```

### Swift parser shows `init_failed` or `unavailable` in `sextant doctor`

The tree-sitter Swift WASM at `vendor/tree-sitter-swift.wasm` either didn't load (missing) or has an ABI mismatch with `web-tree-sitter`. Update the WASM following `vendor/README.md` — pull from the upstream `alex-pinkus/tree-sitter-swift` GitHub releases, **not** from the `tree-sitter-wasms` npm package (its bundled artifact uses an incompatible ABI). See [docs/swift-v1-scope.md](docs/swift-v1-scope.md) for full recovery instructions.

## License

MIT
