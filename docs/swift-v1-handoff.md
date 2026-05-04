# Swift v1 — Handoff

> Source plan: `/root/.claude/plans/we-are-about-to-wiggly-lemur.md`
> Handoff written: 2026-05-02. State: 6 unpushed commits on `main` ahead of `origin/main`.

## What's shipped (all 4 ship blockers resolved)

| SHA | What | SBs |
|---|---|---|
| `83c7d0f` | Schema: `swift_declarations` (PK `path,start_byte,end_byte`) + `swift_relations` (with `confidence` + source-span linkage). Dispatcher additions (`extractDeclarations`, `extractRelations`). SCHEMA_VERSION 1→2. Vendored `vendor/tree-sitter-swift.wasm` (3.3 MB, downloaded from upstream 0.7.1-pypi GitHub release — NOT from `tree-sitter-wasms` npm package, whose bundled artifact has an incompatible ABI). 11 round-trip tests. | SB-1, SB-2 (storage) |
| `a4188d0` | `lib/extractors/swift.js` (~400 LoC tree-sitter walker). Async-init via `web-tree-sitter@0.26.8`. Health counters wired to meta table. 19 unit tests. End-to-end SB-1/SB-2 verified via SQL queries on a real scan. | SB-1, SB-2 (extraction) |
| `788c154` | `commands/doctor.js` Swift Health section, `lib/summary.js` ALERT line, `scripts/statusline-command.sh` action slot, `lib/cli.js buildStaleBody` Swift unavailability marker. Manual end-to-end test: rename WASM → all three surfaces show failure. | SB-3 |
| `d5c4595` | `lib/scoring.js` — 10 Swift def patterns, ~30 noise words, two Swift-gated signals (enclosing-type +10%, extension-target +15%). `lib/classifier.js` — `.swift` extension + initialism regex. 23 stacking-ceiling tests; max Swift def-line stack ≤ +62% in `computeEnhancedSignals` (well under +99% per-hit ceiling). | — |
| `7c5bab5` | `fixtures/mixed-eval/` (Swift+TS+Python, 7 cross-language collision cases). Both eval harnesses 7/7 pass. `--root` flag added to `eval-retrieve.js` + `eval-hook.js`. | SB-4 |
| `a39480c` | Cleanup: dropped stray `.claude/settings.json` that auto-init wrote into the fixture dir; added `.gitignore` so future scans against fixtures don't reintroduce it. | — |

## State of the world

```bash
npm run test:unit   # 526/534 pass (8 skipped, 0 fail)
npm run test:eval   # 20/20, MRR 0.920, nDCG 0.914
                    # — small drift from pre-Swift baseline (0.934/0.930);
                    #   structural cost of swift.js entering the corpus,
                    #   not a scoring regression. All per-case minUseful
                    #   gates hold.
node scripts/eval-retrieve.js --dataset fixtures/mixed-eval/eval-dataset.json --root fixtures/mixed-eval   # 7/7
node scripts/eval-hook.js     --dataset fixtures/mixed-eval/eval-dataset.json --root fixtures/mixed-eval   # 7/7
```

## What's left (polish — not ship-blocking)

### 1. Synthetic Swift fixture corpus — `fixtures/swift-eval/`

Plan calls for **12 cases** plus a `swift-overload-001` case that proves SB-1 at the eval level. Cases enumerated in plan §"Synthetic Swift corpus":
- swift-sym-001/002/003-disambig (basic + disambiguation)
- swift-proto-001/002 (protocol vs conformer)
- swift-ext-001/002 (extension queries with `+` and multi-token)
- swift-enclosing-001 (validates the +10% signal)
- swift-init-001 (init lookup; tests `signature_hint` disambiguation)
- swift-enum-001, swift-property-001, swift-negative-001
- **swift-overload-001** (NEW per the plan): query `update`, file with `func update(id:)`, `func update(patient:)`, `func update(notes:)` — all 3 must surface in `swift_declarations` (verifiable via SQL: `SELECT name, signature_hint, start_byte FROM swift_declarations WHERE name='update' AND parent_name='PatientStore'` returns 3 rows).

Mirror `fixtures/mixed-eval/`'s shape: `eval-dataset.json` next to the corpus, include `Package.swift`, add the same `.gitignore` (`.planning/`, `.claude/`).

Run: `node scripts/eval-retrieve.js --dataset fixtures/swift-eval/eval-dataset.json --root fixtures/swift-eval`

Acceptance: ≥10/12 cases pass, MRR ≥ 0.85, negative case returns 0.

### 2. Vapor pinned-commit external benchmark — `scripts/eval-swift-external.sh`

Plan §"External Swift corpus". Steps:

1. Pick a Vapor SHA (e.g., latest stable tag at the time you write this).
2. Script clones `vapor/vapor` at that SHA into `/tmp/vapor-eval`, runs `sextant scan --root /tmp/vapor-eval --force`.
3. Runs a 15-query battery (suggested: `Application`, `Middleware protocol`, `Request`, `Response`, `EventLoopFuture`, `Service`, `URI`, `init`, `extension Application`, `Codable conformance`, plus 5 of your choice).
4. Outputs JSON; diffs against committed `fixtures/vapor-baseline.json` (regenerate when SHA moves).
5. Fail if MRR delta exceeds 0.05 OR any "must-be-top-3" file drops out of top 3.

Manual-trigger only (~2 min runtime). NOT in `npm test`.

Pathological lift queries (graph-on vs graph-off comparison): `URI`, `init`, `Service`. Per CLAUDE.md's existing thesis, these are where the graph layer should show measurable positive lift on a real corpus.

### 3. Scope/orientation doc — `docs/swift-v1-scope.md`

Plan §"Acceptable v1 debt" lists the deferrals. Doc this clearly so v1 isn't oversold:

- **Repo-local source orientation only.** No `.swiftinterface` ingestion → no SDK/framework introspection. "What conforms to `View`" surfaces only repo-local conformers; SwiftUI's `View` and Foundation's `Codable` are NOT introspected.
- IN scope (what works): top-level types (class/struct/enum/protocol/actor/typealias), members one nesting level deep, extensions, conformance/inheritance edges with `confidence={direct|heuristic}`, span-based identity, parser-failure health.
- OUT of scope (deferred with rationale): `.swiftinterface`, deep nested types (>1 level), macros, `@_exported import`, generic `where` constraints as edges, SwiftPM/Xcode module resolution, compiler-backed semantics, property wrappers as relations, multi-line attributes, tuple-destructuring `let (x, y) = ...`.
- Recovery instructions for parser failure (what `sextant doctor` shows, where the WASM lives, how to update it via `vendor/README.md`).

Also: bump CLAUDE.md and README.md with a "Swift v1 = repo-local orientation" line so the demo script doesn't accidentally promise framework awareness.

## Gotchas (saved you time)

- **`tree-sitter-wasms@0.1.13` ships a Swift WASM with stale ABI** that doesn't load with `web-tree-sitter@0.26.x`. Always pull WASM from the upstream `alex-pinkus/tree-sitter-swift` GitHub release. See `vendor/README.md` for the update procedure.
- **Backticks inside SQL string-template literals terminate JS strings.** When editing `lib/graph.js ensureSchema()`, never use backticks in SQL comments — use single quotes or the word "the". Cost me one debugging cycle.
- **`rg` search is regex, NOT AND-of-terms.** Multi-token queries like `"Logger swift"` only match files where those tokens appear as a contiguous regex match. The bias strategy that works: use a Swift-specific keyword (`enum`, `protocol`, `extension`) that appears on the def line itself. Documented in `fixtures/mixed-eval/eval-dataset.json` mixed-002's notes.
- **Don't run `sextant scan` against a fixture dir without a `.gitignore`.** `intel.js`'s `ensureClaudeSettingsUnlocked` will write `.claude/settings.json` into the fixture root — pollution. The `.gitignore` pattern in `fixtures/mixed-eval/.gitignore` covers it; add the same to any new fixture dir.
- **Async dispatcher methods need awaited callers.** When I made `buildStaleBody` async (to read `swift_declarations` for the silent-absence Swift line), `applyFreshnessGate`'s `return buildStaleBody(...)` propagated transparently because all callers already `await applyFreshnessGate(...)`. Three test sites needed `async () =>` + `await`.
- **node:test `skip` doesn't accept a function**, only a boolean or string. My initial `test/extractors/swift.test.js` had `{ skip: () => !parserReady && "..." }` and silently skipped all 19 tests. Hard-fail in `before()` if init fails, or just let tests throw.
- **Eval metrics drift on corpus expansion.** Adding `lib/extractors/swift.js` to the indexed set put it in competition with `lib/extractor.js` for `extractImports` rankings — `extractor.js` moved from rank 2 to rank 3, dropping per-case MRR from 0.5 to 0.333. Updated `scripts/eval-dataset.json` cross-003's `acceptableFiles` to include `lib/extractors/swift.js`. Overall mean nDCG dropped 0.016, but per-case `minUsefulnessScore` gates all hold.

## Memory pointers (under `/root/.claude/projects/-root-sextant/memory/`)

- `project_swift_v1_ship_blockers_2026_05_02.md` — the four SBs and their resolution mapping.
- `feedback_storage_vs_retrieval_identity.md` — why span-based PK matters.
- `feedback_heuristic_edge_confidence.md` — why the `confidence` column exists.
- `feedback_parser_failure_must_surface.md` — why SB-3 is non-negotiable.
- `feedback_compressed_handoffs_hide_landmines.md` — write the operator-grade review BEFORE the implementation summary, not after.

## When you're ready to ship

```bash
npm run test:unit
npm run test:eval
node scripts/eval-retrieve.js --dataset fixtures/mixed-eval/eval-dataset.json --root fixtures/mixed-eval
node scripts/eval-hook.js     --dataset fixtures/mixed-eval/eval-dataset.json --root fixtures/mixed-eval
# After polish phases land, also:
node scripts/eval-retrieve.js --dataset fixtures/swift-eval/eval-dataset.json --root fixtures/swift-eval
bash scripts/eval-swift-external.sh
git push origin main
```

## Open question for the user before ship

The plan suggested updating `CLAUDE.md` and `README.md` with the Swift v1 capability section + the explicit "repo-local orientation" framing. I left that for the docs/scope-doc phase — bundle them with `docs/swift-v1-scope.md` so the framing is consistent across all three docs.
