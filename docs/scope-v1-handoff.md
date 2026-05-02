# Project Scope v1 — Handoff

> Written 2026-05-02 at session end, pairs with the dogfooding-feedback
> case that motivated it. Read this before touching `lib/project-scope.js`,
> `lib/utils.js:isEntryPoint`, or the `swift_entry_files` table.

## Status

**Project Scope v1 is shipped.** Single commit on `main`:

```
0d774bd feat(scope): exclude vendored subtrees + detect Swift entry points
```

Local only as of writing — not yet pushed. `origin/main` is at the
preceding `a1db872` (README troubleshooting). One git push needed before
external sextant installs see the fix.

## Why this exists

Dogfooding feedback (2026-05-02) from another Claude Code session using
sextant on a Swift iOS project. The user surfaced three orthogonal failure
modes that compounded:

1. **Vendored-tree pollution.** The project tree contained
   `mcp-servers/`, `mcp-servers-repo/`, and an unpacked GitHub tarball
   `mbadolato-iTerm2-Color-Schemes-f279991/`. All Python under those
   subtrees got indexed as if it were the user's project.
2. **Hotspot/entry-point math was path-blind.** Vendored Python files
   dominated raw fan-in; `isEntryPoint()` knew JS+Python filenames but
   not Swift, so the Swift app's `@main` entry point never surfaced
   even after the vendored noise was diagnosed.
3. **No "project center" concept anywhere.** Sextant treated cwd
   uniformly — no signal to the user about WHAT got included, so the
   confidently-wrong hotspots looked authoritative.

The bug surface was a values violation: sextant pitches itself as
*honest, health-aware orientation* (`DESIGN_PHILOSOPHY.md`), and surfacing
`mcp_server/__main__.py` as a "likely entry point" of a Swift iOS app is
a confident hallucination.

## Headline numbers

| Surface | Result |
|---|---|
| Synthetic Swift+vendored E2E fixture | 8 source files (4 Swift + 4 Python) → 3 indexed (real Swift only) |
| MyApp.swift surfaces as entry point | yes (filename heuristic + @main scan, both signals fire) |
| Vendored-excluded transparency line | yes (`Vendored excluded: 3 (mcp-servers-repo, mbadolato-…, Pods)`) |
| Eval | 20/20 cases, MRR 0.925, nDCG 0.930 (no regression) |
| Unit tests | 564 pass (was 547; +23 added across 4 test files + 1 new file) |
| Live sextant repo summary | unchanged hotspots; `vendor/` (tree-sitter WASM dir) caught as the lone vendored exclude |

## What v1 actually does

### Vendored detection (`lib/project-scope.js`)

Walks **depth=1** of the working tree. For each immediate subdirectory,
checks three signals; **any one match** is sufficient to mark vendored:

1. **Nested .git/** with `HEAD` or `refs/` inside → separate repo.
2. **Conventional vendor dirnames**: `vendor`, `vendored`, `third_party`,
   `third-party`, `external`, `Pods`, `Carthage`, `bower_components`,
   `deps`.
3. **Tarball-extract naming**: matches
   `/^[A-Za-z][A-Za-z0-9_.]*(?:-[A-Za-z0-9_.]+)+-[a-f0-9]{6,40}$/` —
   GitHub-tarball download convention `<owner>-<repo>-<short-hash>`.

Detected paths are converted to `**/<path>/**` ignore globs and merged
into `cfg.ignore` inside `loadRepoConfig` (`lib/config.js`). They never
reach `fast-glob`'s match list, so they never enter the graph.

### Swift entry-point detection

Two complementary signals merged in `lib/summary.js`:

1. **Filename heuristics** in `lib/utils.js:isEntryPoint()`:
   - `(^|/)main\.swift$`
   - `(^|/)AppDelegate\.swift$`
   - `(^|/)[A-Z][A-Za-z0-9_]*App\.swift$` (SwiftUI App-protocol convention)
   - All gated by the existing `ENTRY_POINT_EXCLUDE` regex (tests/
     fixtures/examples/etc).

2. **@main attribute scan** in `lib/extractors/swift.js:hasAtMain()`:
   ```js
   const AT_MAIN_RE = /(?:^|[^A-Za-z0-9_@])@main(?![A-Za-z0-9_])/m;
   ```
   `intel.js` calls it for every Swift file in
   `indexOneFileUnlocked`; it toggles a row in the new
   `swift_entry_files` table. `deleteFile` cascades this row.

`writeSummaryMarkdown` unions both signals, dedupes, and tags
@main-only matches with `— @main` so the user can audit which signal
won.

### Transparency

New summary header line listing detected vendored exclusions:

```
- **Vendored excluded**: 3 (`mcp-servers-repo`, `mbadolato-iTerm2-Color-Schemes-f279991`, `Pods`)
```

Override knobs in `.codebase-intel.json`:

| Field | Effect |
|---|---|
| `"vendoredDetection": false` | Disable auto-detection entirely |
| `"vendored": ["foo", "bar"]` | Add explicit subdirs to the exclusion (always honored) |

## Ship blockers — NONE

Everything that needed to land for v1 landed. No deferred-but-required
work.

## Acceptable debt (deliberate v1 scope cuts)

Read these before extending — they're known gaps, not bugs.

### 1. Manifest-only vendored without nested `.git/` is NOT auto-caught

A subdirectory whose only "vendored" signal is "has its own
`pyproject.toml` while root has `Package.swift`" won't auto-detect.
Example: in the dogfooding case, `mcp-servers/` (no `.git/`, just
`pyproject.toml`) wouldn't be caught — but the v1 fix still helps that
user because their `mcp-servers-repo/` (with `.git/`) IS caught and
their tarball-named dir IS caught.

**Why we punted**: the manifest-disagreement signal would catch
`mcp-servers/` but it false-positives on polyglot monorepos (root
`package.json` + service-`pyproject.toml`). v1 stayed conservative.

**User escape hatch**: list it in `.codebase-intel.json:vendored`.

### 2. Depth=1 only

A vendored dir nested under another non-vendored dir (e.g.,
`Sources/ThirdParty/foo/`) won't auto-detect. Same reasoning as above —
going deeper risks false positives in nested project structures (Swift
package targets, JS workspaces, etc.). User can list explicitly.

### 3. No `.gitignore` honoring (yet)

The `ce-web-researcher` agent's prior-art digest (in this session's
context) recommended layering in `.gitignore` honoring via the `ignore`
npm package as a v2. Quoting the digest:

> For the 200ms hook path: pure in-memory heuristics only. Load
> `.gitignore` once at scan time using the `ignore` npm package, build
> a compiled filter, and run paths through `.ignores()` at file-walk
> time. No subprocess.

This catches the long tail (`mcp-servers/` without `.git/` becomes
caught by `.gitignore` if the user gitignored it). v1 ships without it
because the strong-signal heuristics already cover the dominant case.

### 4. `target/` (Cargo build dir) not in vendor list

The research suggested adding it. v1 only added what was directly
implicated by the dogfooding case + clearly-conventional names. Easy
follow-up: add `target/` to `VENDORED_DIR_NAMES`. Risk: a JS project
with a `target/` directory for build output would already be filtered
by `**/build/**` or similar; `target` as a dirname is mildly more
ambiguous.

### 5. The dogfooding feedback was offsite

The bug originated from a Swift iOS project that's not in this repo.
The synthetic E2E fixture
(`test/swift-vendored-integration.test.js`) reproduces the *shape* of
the bug, but it isn't real-data validation. The successor needs to
either (a) get the user to re-run sextant on that same project and
verify the summary, or (b) accept the synthetic fixture as the
regression bar.

## v2 follow-up — proactive options

If the user re-tests on the original Swift project and reports new
gaps:

| Gap | v2 fix | Effort |
|---|---|---|
| `mcp-servers/` (manifest-only, no `.git/`) still polluting | `.gitignore` honoring via `ignore` npm package | small |
| Nested vendored at depth >1 | Recursive walk with cycle protection | medium (recursion depth bound + perf bound) |
| Cargo's `target/` building dir included | Add to `VENDORED_DIR_NAMES` | trivial |
| Manifest-disagreement signal for stricter polyglot detection | Read root + subdir manifests; flag when languages disagree AND root has only one primary manifest | medium (false-positive risk in polyglot monorepos) |

## Verification commands

For a successor to confirm clean state in 30 seconds:

```bash
cd /root/sextant
git log --oneline -3                    # 0d774bd at top
npm run test:unit                        # 564 pass, 0 fail (8 skip)
npm run test:eval                        # 20/20 pass, MRR ~0.925, nDCG ~0.930
node bin/intel.js summary                # live: 94 files, 'Vendored excluded: 1 (vendor)'
node --test test/swift-vendored-integration.test.js  # 5/5 pass
```

End-to-end synthetic test (proves the bug case is fixed):

```bash
# Quick synthetic Swift app + 3 vendored subtrees:
TMP=$(mktemp -d)
mkdir -p "$TMP/Sources/MyApp"
echo "@main struct MyApp: App {}" > "$TMP/Sources/MyApp/MyApp.swift"
mkdir -p "$TMP/Pods" "$TMP/mbadolato-iTerm2-Color-Schemes-abc123" "$TMP/repo/.git"
echo "ref: refs/heads/main" > "$TMP/repo/.git/HEAD"
node /root/sextant/bin/intel.js scan --root "$TMP" --force
node /root/sextant/bin/intel.js summary --root "$TMP"
# Should show: 'Vendored excluded: 3' and 'Likely entry points: …MyApp.swift'
rm -rf "$TMP"
```

## Risk surfaces (where it could break)

1. **`loadRepoConfig` is called from many places** — `commands/scan.js`,
   `commands/doctor.js`, `commands/watch.js`, `watch.js`, `lib/summary.js`.
   The new `detectProjectScope()` call is wrapped in try/catch and
   returns empty on error, but a slow filesystem walk would slow every
   call. Currently depth=1 with `readdirSync({ withFileTypes: true })`
   — fast, but watch out if extending depth.

2. **The `swift_entry_files` table is a new schema entry.** It's
   added via `CREATE TABLE IF NOT EXISTS` so existing graph.dbs are
   forward-compatible — but the table will be empty until next scan.
   `SCHEMA_VERSION` was NOT bumped (deliberate; bumping invalidates all
   existing dbs across all sextant installs). New users get the table
   on first scan; existing users get it on next rescan.

3. **`hasAtMain` regex is content-only, not AST-aware.** False
   positives possible if a string literal or comment contains literal
   `@main` (e.g., a docstring saying "use the @main attribute…"). The
   word-boundary precision is tight, but content-based detection has a
   theoretical false-positive surface. If this becomes a problem,
   migrate to AST-walking the `attribute` node in
   `lib/extractors/swift.js:walkClassLike`.

4. **Filename heuristic `<Type>App\.swift` is permissive.** Things
   like `RandomApp.swift` or `BookApp.swift` at non-test paths would
   match. The `ENTRY_POINT_EXCLUDE` regex filters tests/fixtures/
   examples but not "looks like an app but isn't". In practice, the
   summary's entry-point list is capped at 5 and surfacing more isn't
   harmful — just possibly noisy.

## Test coverage map

| Test file | What it locks in |
|---|---|
| `test/project-scope.test.js` | All three vendor signals + the user's exact dogfooding case (13 cases) |
| `test/utils.test.js` | Swift entry-point filename heuristics + JS/Python coverage stays green (10 cases) |
| `test/extractors/swift.test.js` | `hasAtMain` regex precision — accepts canonical, rejects `@mainView`/`xx@main`/`@@main` (9 new cases) |
| `test/graph-swift.test.js` | `setSwiftEntryFile` / `clear` / `get` + `deleteFile` cascade (6 new cases) |
| `test/swift-vendored-integration.test.js` | Full E2E regression — Swift app + 3 vendored subtrees → correct summary (5 cases) |

## Files touched (commit `0d774bd`)

```
new file:   lib/project-scope.js                          (180 LoC)
modified:   lib/config.js                                  (+71 / -16)
modified:   lib/extractors/swift.js                        (+23)
modified:   lib/graph.js                                   (+46)
modified:   lib/intel.js                                   (+15)
modified:   lib/summary.js                                 (+36 / -2)
modified:   lib/utils.js                                   (+13)
modified:   CLAUDE.md                                      (+5 / -1)
new file:   test/project-scope.test.js                     (~190 LoC, 13 cases)
new file:   test/utils.test.js                             (~85 LoC, 10 cases)
new file:   test/swift-vendored-integration.test.js        (~170 LoC, 5 cases)
modified:   test/extractors/swift.test.js                  (+51, 9 new cases)
modified:   test/graph-swift.test.js                       (+69, 6 new cases)
```

## Things not done that you might think are done

Closure pass landed in a follow-up commit on top of `cc8661b`:

- ~~**Not pushed to `origin/main`.**~~ — pushed `0d774bd` + `cc8661b`.
- ~~**README not updated.**~~ — added `vendored` and `vendoredDetection`
  rows to the Configuration table; eval-results paragraph and
  `npm run test:eval` comment now reflect the live 20/20 numbers.
- ~~**MCP server's `sextant_health` tool not extended.**~~ — extended
  with `vendoredExcluded: number` and `vendoredPaths: string[]` (capped
  at 10). Reads `loadRepoConfig().vendoredSignals` so it honors
  `vendoredDetection: false` and merges explicit `vendored: [...]`
  identically to the scanner. Test coverage in
  `test/mcp-server.test.js` (3 new cases).
- ~~**Eval harness count drift.**~~ — CLAUDE.md updated: `19 queries` →
  `20 queries`; metrics line `MRR 0.954, nDCG 0.920, 19/19` →
  `MRR 0.925, nDCG 0.930, 20/20`; rg-only-perfect-nDCG count
  `17/19` → `13/19`; worst-case example `multi-003 (resolutionPct,
  −0.164)` → `cross-003 (extractImports, −0.060)`. Mean delta sign
  also flipped from `−0.006` to `+0.005` (still ≈ neutral).
- **No CHANGELOG entry.** Convention in this repo is sparse on changelog
  updates per-feature; matched what was here. Still skipped.

## Open questions for the user

1. Do you want v2 `.gitignore` honoring proactively, or wait until the
   Swift project gets re-tested?
2. Should `target/` (Cargo) be added to `VENDORED_DIR_NAMES` now or
   wait for Rust-project feedback?
3. Is the MCP `sextant_health` extension worth shipping, or is the
   summary header sufficient?

---

**Last verification before this doc was written**: live summary on
`/root/sextant` shows `Vendored excluded: 1 (vendor)`, hotspots correct,
94 files, 100% resolution. Watcher pid 1852117. Next session can pick
up clean.
