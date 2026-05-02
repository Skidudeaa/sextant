# Retrieval Evaluation Findings

## Eval Harness

Self-referential harness: 19 queries against the sextant index. Each runs with and without graph boosts to isolate the graph's effect.

```bash
node scripts/eval-retrieve.js            # terminal
node scripts/eval-retrieve.js --verbose  # hit lines + scoring signals
node scripts/eval-retrieve.js --json     # machine-readable
```

19 cases, 7 categories: symbol, multiword, path, cross-file, scoring, scope, negative.

---

## Bugs Found by Eval

### Silent graph boost failure (c578e94)
rg returns `./lib/retrieve.js`, graph stores `lib/retrieve.js`. Path mismatch caused `fanInByPaths` to silently return empty — graph boosts never fired.

### Definition-site ranking inversion (bb18522, dbb9348)
Fan-in boost promoted hub files (intel.js, fan-in=5) above definition files. `rerankFiles` sorted by raw fan-in before adjusted scores, so all hit-level signals were ignored at file level.

### Index format drift (1041f20)
Old v1 entries with absolute-path keys and string import arrays silently degraded resolution to 54%. Auto-migration on load fixes this transparently.

### rg saturation for common terms (48490a6)
For "Flask" (1143 matches) or "useState" (2705 matches), docs/changelogs consumed the raw hit budget before source files reached the scorer.

---

## Scoring Evolution

### v1 → v2: Definition-site priority

| Metric | v1 | v2 | Delta |
|--------|-----|-----|-------|
| MRR | 0.838 | 0.931 | **+0.093** |
| nDCG | 0.920 | 0.966 | **+0.046** |
| Graph Lift nDCG | -0.044 | 0.001 | **+0.045** |

Fixes: exact_symbol +25%→+40%, definition-site priority +25%, fan-in suppression, file sort by adjusted score.

### v2 → v3: Source-first collection + cross-project fixes

| Metric | v2 | v3 | Delta |
|--------|-----|-----|-------|
| MRR | 0.931 | 0.935 | +0.004 |
| nDCG | 0.966 | 0.969 | +0.003 |

Fixes: two-phase rg (source files first), doc penalty (-40%), CommonJS pattern recognition, Python entry points, Python def/class in definition detection.

### v3 → v4: Scoring consolidation + hook-path suppression

| Metric | v3 | v4 | Delta |
|--------|-----|-----|-------|
| MRR | 0.935 | 0.956 | +0.021 |
| nDCG | 0.969 | 0.949 | -0.020 |

Fixes: scoring constants extracted to shared `scoring-constants.js` module, graph-retrieve.js fan-in normalized from absolute points to relative %, definition-site suppression added to hook path. MRR improved; nDCG trade-off from tighter suppression of non-definition files.

---

## Cross-Project Validation

Tested cold-start against three real projects:

| Project | Files | Resolution | Scan time |
|---------|-------|-----------|-----------|
| Express (JS/CJS) | 142 | 100% | 0.7s |
| Flask (Python) | 83 | 100% | 5.3s |
| React (monorepo) | 4,337 | 96% | 7.3s |

### Key results

| Query | Before fix | After fix |
|-------|-----------|-----------|
| Flask "Flask" | CHANGES.rst only | **src/flask/app.py → `class Flask(App):`** |
| React "beginWork" | #1 definition | **#1 definition** (line 4164) |
| Express "createApplication" | #1 definition | **#1 definition** |
| Express "logerror" | #1 definition | **#1 definition** |

### React "useState" — FIXED

React "useState" (716 source files match) — previously failed because definition file couldn't reach the scorer within rg raw limits. Fixed by export-graph symbol lookup (milestone 5): queries the exports table directly, bypassing rg hit order.

---

## Harness Metrics

Current (v5): **19/19 pass, MRR 0.954, nDCG 0.925, Mean P@k 0.578, Mean Useful 0.906, Graph Lift nDCG −0.008 (neutral)**

### v4 → v5: Hit-count contribution + hotspot gate

Two small scoring fixes shipped together:

| Metric | v4 | v5 | Delta |
|--------|-----|-----|-------|
| MRR | 0.925* | 0.954 | **+0.029** |
| nDCG | 0.926* | 0.925 | -0.001 |
| Graph Lift nDCG | -0.012 | -0.008 | +0.004 (negative → neutral) |

\* baseline re-measured after docs/ directory expanded with plans and ideas; the v4 numbers above reflect the scoring pipeline at commit `bdf9a7c` without the subsequent doc additions.

**Fix 1 — hit-count contribution to file-level sort:** `rerankFiles()` now adds a log-scaled `hitCountContribution = bestHitScore × log1p(hitCount) × 0.075` to the primary sort key. Without it, "variable-name" queries (e.g. `resolutionPct`, `extractImports`) rank purely by graph boost when every raw hit score is uniform — inflating hub files with a single mention over files that actually contain the identifier many times. The cross-file query `extractImports` went from MRR 0.5 to 1.0 by picking up the correct dispatcher (3 hits) over a sibling implementation (2 hits).

**Fix 2 — hotspot gate when no def-site exists:** in `rerankAndCapHits()`, when no hit in the result set is a definition-site match, the +15% HOTSPOT_BOOST is stripped from hotspot files. This prevents architecturally-central hubs from dominating results for queries that are variable names or config keys rather than function/class names. The existing fan-in suppression path (halve graph contribution for non-def files) is preserved unchanged for the "def-site exists" case. Moved Graph Lift nDCG from "negative" to "neutral".

Trade-off: `multi-003 resolutionPct` nDCG dropped 0.38 → 0.24 because `intel.js` moved from rank 1 to rank 4 (it has only one mention of the variable). The eval considers `summary.js` and `intel.js` the canonical relevant files — this is a case where the eval's relevance labels conflict with raw occurrence density. MRR for the same query improved slightly (0.143 → 0.167).

- **P@k**: fraction of top-k results that are relevant
- **MRR**: reciprocal rank of primary relevant file (capped at rank 10)
- **nDCG**: rank-ordering quality with graded relevance (primary=2, secondary=1, acceptable=0.5)
- **Usefulness**: composite of file rank, hit quality, precision, related expansion
- **Graph Lift**: delta between graph-on and graph-off runs

### Graph isolation
- Graph ON: `rerankMinResolutionPct: 0` (forces boosts)
- Graph OFF: `rerankMinResolutionPct: 101` (disables boosts)

---

## Swift v1 Eval Results

### Synthetic — `fixtures/swift-eval/`

13 cases across 7 categories: symbol, multi-overload disambiguation, protocol, extension (with `+` syntax and literal `extension` keyword), enclosing-type, init, enum, property, negative, overload-identity (SB-1).

| Metric | Value |
|---|---|
| Pass rate | 13/13 |
| MRR | 0.958 |
| nDCG | 0.977 |
| Mean Useful | 0.784 |
| Graph Lift nDCG | 0.000 (neutral) |

Both Swift-gated scoring signals exercised and visible in verbose output:
- `swift_enclosing_type:+10%` fires on `swift-enclosing-001` (multi-token query where one term equals the enclosing type name; the +10% boost lands on a hit whose `before` context exposes the `class PatientStore` line).
- `swift_extension_target:+15%` fires on `swift-ext-001` (`View+Toolbar` — `+` token activates `looksLikeExtensionQuery()`) and `swift-ext-002` (literal `extension` keyword).

SB-1 invariant verified at the SQL level — `PatientStore.update` has 3 distinct rows in `swift_declarations` keyed by byte span, each with a distinct `signature_hint` (`id:`, `patient:`, `notes:for:`).

### External — Vapor 4.121.4

15-query battery covering Vapor's public surface: `Application`, `Middleware protocol`, `Request`, `Response`, `EventLoopFuture` extensions, `Service` ★, `URI` ★, `init` ★, `extension Application`, `Codable` conformance, `Routes`, `ContentEncoder protocol`, `WebSocket`, `AbortError protocol`, `Validatable protocol`. Three starred ★ queries are the pathological-lift cases the original Swift v1 plan named.

| Metric | Value |
|---|---|
| Pass rate | 15/15 |
| MRR | 0.591 |
| nDCG | 0.604 |
| Graph Lift nDCG | 0.000 (neutral) on all 3 starred queries |

Run via `bash scripts/eval-swift-external.sh` (manual-trigger only, NOT in `npm test`). Diff mode gates on mean MRR delta ≥ -0.05 and per-case top-3 retention. Baseline at `fixtures/vapor-baseline.json`; regenerate via `bash scripts/eval-swift-external.sh regen-baseline` when bumping `VAPOR_SHA`.

**Honest finding worth keeping visible**: graph lift on Vapor is currently neutral, contradicting the original plan's expectation that Vapor would be where graph-machinery value showed up. Tracked as Skidudeaa/sextant#2 with three exit paths (scoring change → measurable lift, second corpus where lift IS positive, or documented "this corpus shape doesn't benefit" finding).

**Second finding**: test-tagged sources outside `Tests/` directories (`Sources/XCTVapor/`, `Sources/VaporTesting/`) aren't caught by `TEST_PENALTY`'s path heuristic and outrank canonical defs on common-name queries. Tracked as Skidudeaa/sextant#1.

---

## Next Steps

1. ~~**Export-graph symbol lookup**~~ — DONE. Queries exports table for each query term, injects files rg missed.
2. ~~**Entry point refinement**~~ — DONE. Path exclusion for fixtures/tests/examples + entry point demoted from sort key to +10% scoring signal.
3. ~~**Re-export chain tracing**~~ — DONE. BFS through `reexports` table up to 5 hops, follows barrel-file chains to original definition.
4. **Template string imports** — regex extractor silently misses `require(\`./\${name}\`)`. Would need AST-based JS extraction or heuristic fallback.
5. **Broaden `TEST_PENALTY` matcher** (#1) — catch SwiftPM-style test-helper targets that live outside `Tests/`.
6. **Investigate Vapor graph-lift neutrality** (#2) — quantify which corpus shapes benefit from the structural lane.
