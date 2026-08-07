# 039 — Session handoff: retrieval ranking — the "same results every query" root cause

Date: 2026-08-07. Branch `main` — committed and **pushed** this session.

## What this session did

Started from a user report: sextant MCP queries on somaNotes (census frontend work) appeared to return the same files for every query — `static/js/census/index.js` (score 551.1) topping nearly everything, including a query whose shown hit line didn't contain the queried symbol.

The diagnosis went through three theories, two of them wrong:

1. **Zoekt's flat scoring is the problem** — investigated, and an experiment ran: enabling zoekt's opt-in `UseBM25Scoring` (graded tf scores instead of the saturated ~501 constant). It regressed both harnesses (self-eval nDCG 0.907→0.886; hook eval 21/21 → 19/21, `multi-003` collapsed 0.20→0.0). **Reverted.** Honest caveat recorded in the changelog: the experiment is confounded — the eval gates co-evolved with the flat base, so the regression proves the stack is *coupled* to flat scoring, not that flat scoring is optimal.
2. **The graph is broken/gated off on somaNotes** — disproven live: 2032 files, 100% resolution, index 45s old, and real structure (`state.js` fanIn 29, `index.js` fanOut 39).
3. **The actual root cause: the graph lane's answers were being thrown away by the score bridge.** Zoekt-sourced hits live in the ~501 band; rg-sourced graph-injected hits arrive `score: null` → base=1. The `SWIFT_DECL_TYPE_INJECT_SCORE = 600` floor existed only for the Swift-decl lane. Live proof (`class CensusState selectPatient clearPatient`): the exports table correctly injected `state.js` (`export const CensusState`, fanIn 29) — it scored adjusted **2.1**, below markdown docs (300.6) and a comment-line mention (544.0).

## Shipped (one commit, `feat(retrieve)`)

| fix | file | what |
|---|---|---|
| Export-injection score floor | `lib/retrieve.js` | `EXPORT_GRAPH_INJECT_SCORE = 600` for the export-graph lane, gated to `exportPathAuthority === 2` (e2e fixtures exporting a matching symbol otherwise outrank use sites — observed live). `hitScore` callback now receives `{kind, path}`. |
| Coverage-ranked AND fallback | `lib/zoekt.js` | New `shapeAndFallbackHits`: Tier-2 fallback (phrase missed) ranks by the Tier-3 token-coverage ranker for 2+ token queries; `rankByTokenCoverage` keeps the per-file line covering the *most tokens* (was: highest-scored line). Single-token path byte-identical. |
| Entry-point boost suppression | `lib/retrieve.js` | `ENTRY_POINT_BOOST` included in the halved `graphPortion` when a def-site match exists (was the one exempt boost, pinning shell files at #1). |

**Live verification on somaNotes** (query-side only, no reindex):
- `class CensusState selectPatient clearPatient` → `state.js` **#1 at 1162.8** (was 6th at 2.1)
- `initChartRail` → chart-rail.js #1; index.js entry boost correctly halved (551→526)
- `navCensusLink addEventListener` → keeps index.js:7678, the actual nav wiring (was an unrelated `filterContainer.addEventListener` line); index.js at #1 is now the *correct* answer

**Gates:** 1404/1404 unit, 21/21 self-eval, 21/21 hook eval — both byte-identical to baseline.

## Deploy state

- Global `sextant` is a symlink: `/root/.npm-global/lib/node_modules/sextant → /root/sextant`. The fixes are live in the code — but **any already-running MCP server process still has the old code in memory**. Restart the agent session (or the sextant MCP server) in each repo to pick it up. No reindex needed anywhere.
- Zoekt daemon untouched (query-side changes only).

## Open — resume here

1. **Eval corpus gap (the reason this bug lived so long).** No eval case is a true multi-token scattered-token query where the def file can only enter via export injection. Add cases — the somaNotes queries above are ready-made, but they're on an external repo; either add equivalent synthetic cases to `scripts/eval-dataset.json` or build a small JS fixture corpus with a star-topology frontend. This is the highest-value follow-up: it converts a live catch into a permanent gate.
2. **Doc penalty may be too weak for plan docs.** `initChartRail` #2 was `docs/superpowers/plans/2026-08-07-census-a3-single-document-navigation.md` at 776.5 (exact-symbol +40%, symbol-contains +12% stack outweighs the −40% doc penalty). A doc containing the literal symbol outranking usage files is arguably wrong; consider capping enhanced line signals on doc paths rather than raising the blanket penalty.
3. **BM25/graded-base recalibration** — still the open project if per-query text discrimination is ever wanted at the base layer: log-scaled bases + retuned penalties/injection floors, gated on both harnesses. Do NOT just flip `UseBM25Scoring` (measured regression, this session).
4. **Watch first real-world reads.** After MCP restarts, check whether the census-session query pattern (hub at #1 regardless of query) is actually gone. Telemetry `mcp.invoked` rows won't show ranking quality — this needs a qualitative re-run of the original queries.
5. Carried from 038: holdback benefit delta re-check ~08-20 (command in 038), MCP tool-surface verdict ~08-20, start recording rejections (`sextant reject`), `sextant scan --force` on dogfooding repos for the schema 4→5 self-heal.
