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

### Known limitation

React "useState" (716 source files match) — definition file doesn't reach the scorer within raw limits. Would require export-graph-based symbol lookup.

---

## Harness Metrics

- **P@k**: fraction of top-k results that are relevant
- **MRR**: reciprocal rank of primary relevant file (capped at rank 10)
- **nDCG**: rank-ordering quality with graded relevance (primary=2, secondary=1, acceptable=0.5)
- **Usefulness**: composite of file rank, hit quality, precision, related expansion
- **Graph Lift**: delta between graph-on and graph-off runs

### Graph isolation
- Graph ON: `rerankMinResolutionPct: 0` (forces boosts)
- Graph OFF: `rerankMinResolutionPct: 101` (disables boosts)

---

## Next Steps

1. **Export-graph symbol lookup** — use the existing exports table to find which file exports a queried symbol, boosting it regardless of rg hit order. Would fix the "useState" class of failures.
2. **Entry point refinement** — current heuristic (`index.js`, `app.py`) triggers on fixtures/examples. Consider gating on fan-in or path depth.
3. **Template string imports** — regex extractor silently misses `require(\`./\${name}\`)`. Would need AST-based JS extraction or heuristic fallback.
