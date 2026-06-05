# Project Todos

Roadmaps: `docs/ideas/006-next-targets-roadmap.md` (functional targets),
`docs/ideas/007-signal-expansion-menu.md` (new target-codebase signals),
`docs/ideas/008-iteration-review-findings.md` (review audit + ranked actions). The Tier-1
honest-hook-path cluster + step 4 are merged to `main` (origin/main == 6b03f0b). The
review-found honesty-leak cluster is on branch `feat/hookpath-honesty-and-swift-labels`
(**PR #5, open**). Next up: 007 declared-manifest cluster (package.json scripts → Commands).

## Active — review-found (branch `feat/hookpath-honesty-and-swift-labels`, remaining)

- [ ] [Review #5 — NEEDS DECISION] Swift partial-parse signal in the summary. Bare-count
  `ALERT: SWIFT FACTS INCOMPLETE` on any `filesParseErrors>0` would cry wolf on EVERY real
  Swift repo — the field report (`project_swift_parser_diagnostics`) found 7/42 Vapor files
  partial-parse routinely from tree-sitter grammar limits, NOT defects. Decision needed: a
  high-rate threshold for the ALERT, or a quiet non-ALERT coverage line (no statusline
  escalation), or skip. `lib/summary.js:300-313`, `getSwiftHealthCounters` exposes the count.
- [ ] [Review #6 remainder] Regression locks NOT yet added (db_load_failed lock SHIPPED):
  (a) Python package-only `__init__.py` `— declared` tag (`summary.js:158-159` + entry-points.test);
  (b) pyproject TOML robustness branches (single-quote / inline-comment / decoy-in-later-table);
  (c) text_only source label via a real hook run (needs zoekt-only survivor OR extract a
  `labelInjectedSource` helper to unit-test); (d) eval-retrieve `liftFloorBreaches` `!isNegative`
  exclusion (print-only, low value).
- [ ] [Review #4] Extract `isTestPath`/`isVendorPath`/`isDocPath` into a shared
  `lib/path-classify.js`; converge `merge-results.js:fileTypePenalty` onto the broader CLI
  predicates. CLI and hook silently disagree what a file IS (foo.test.py, .adoc, top-level
  vendor//dist//build escape the hook penalty). MEDIUM RISK — changes hook ranking; the
  committed corpora have none of these shapes in gold sets, so the parametrized cross-module
  agreement test is the only guard. Re-run `npm run test:eval` AND `eval-swift-external.sh diff`
  (warm zoekt). This is ALSO the prerequisite for the Tier-3 test-to-code map.
- [ ] [Review #9] Tighten Gate 2 (top-3 retention) in `compare-vapor-eval.js` — it cements
  WRONG baseline answers (4/15 hook cases) so a genuine fix that promotes the canonical file is
  reported as a FAIL. Add an order-sensitive per-case rank gate that reads dataset relevantFiles.
- [ ] [Review #10] Gate 3 accepted-debt bound for vapor-codable-001 sits 0.0049 from the cliff
  (-0.3151 vs -0.32) — a single near-tied conformer reorder within the cold-zoekt noise envelope
  trips it (cry-wolf). Widen to -0.34 OR convert to a frozen-rank assertion on URI.swift; fix the
  misnamed displaced-file comment. (Supersedes the old "[Revisit] codable allowlist" item.)
- [ ] [Review #11] Add a default-on top-k floor to the CLI eval pass criterion (mirror
  eval-hook.js `maxPrimaryRank`) — today `usefulness>=0.5` tolerates the primary relevant file at
  rank 8-9, so a "PASS" can hide the answer outside top-5.

## Active — roadmap 006 (functional targets)

- [ ] [T2.2] Classifier calcification guard — lock CURRENT classifier verdicts as a
  no-regression suite (extend `test/classifier.test.js`); quarantine prompt "merge results
  scoring" (empirically retrieve:false) as an explicit xfail product decision for Amo. ~0.5-1d
- [ ] [T2.1] Symbol-level blast radius — capture imported-symbol names (parsed then discarded in
  js_ast_imports.js / python_ast.py); INDEXED import_symbols table (SCHEMA_VERSION bump);
  findSymbolImporters; surface in sextant_explain + 1-line hook note. Fixture on a Python
  from-import edge; make `*` namespace fallback LOUD; symbol-coverage health metric in doctor.
  Pairs with 007 cross-package fan-in (symbol → file → package altitudes). ~2-3d
- [ ] [T2.3 revise] Wire swift_relations into sextant_related — MCP/deliberate path ONLY (10s
  budget), NOT the <50ms hook lane (conformer injection displaces canonical def). findRelationsByTarget
  has zero callers; symbol-keyed branch is a contract change; ground eval on a real "what implements
  Middleware" conformer-set query. ~1-2d
- [ ] [T2.4 kill-on-no-fixture] Two-token NL recall — REVIEW VERDICT: inert on every existing
  corpus (25/27 realistic 2-token queries already resolve via phrase/AND; the AND-zero cases float
  a test file). Drop unless a real dogfooded 2-token miss appears on a NEW repo.
- [ ] [T2.5 revise] Session-trajectory harness — `sextant eval-trajectory` over session JSONL;
  LEAD with hallucinated-path rate (baseline-free); demote surfaced-then-opened to a correlational
  stat. ~1d
- [ ] [Tier 3] test-to-code map — gated on the Review #4 shared `isTestPath` predicate; then filter
  neighbors().dependents through it; "no test files import this" note, NOT a coverage-gap label.
  (007 co-change lane likely supersedes this — tests co-change with impl 8x but rarely import it.)
- [ ] [Tier 3] Swift-only sextant_symbols MCP tool — JS/TS exports have no line column; scope to
  swift_declarations.start_line.
- [ ] [Tier 3] function-level localization eval tier — startLine plumbing graph-retrieve→merge→format
  is now DONE (shipped with the swift-decl label); remaining work is `recallDefLine@k`.
- [ ] [Tier 3 / Review #13 — needs policy] Loud staleness on `scripts/statusline-command.sh` (the
  bash script). Gate STRICTLY on git-derived `freshness.contentChanged`, NEVER version bumps
  (cried-wolf guard). During content-stale the statusline shows green while Claude's injection is
  blacked out — contradictory state.

## Active — signal expansion 007 (new target-codebase signals)

- [x] [007 T1.4] package.json `scripts` → Commands block (xs) — SHIPPED on branch
  `feat/manifest-commands-block` (`224f6c2`); `commandsFromPackageScripts`, `### Commands` after
  Signals, lifecycle-first, N-cap 8, fresh-body-only. Unit 720/720, self-eval byte-identical.
- [ ] [007 T1.4 cont.] AGENTS.md / CLAUDE.md / .cursorrules presence line (xs, inside detectSignals,
  high line-order) + `.env.example` required-env keys (small, keys-only regex, route through
  gitignoreFilter) — the rest of the declared-manifest continuation of T1.1.
- [ ] [007 tier-1] Makefile Commands block, schema-file anchors, resolution-by-kind breakdown,
  public-API outline (cheap surfacing of already-graph-resident data). See doc for per-item gates.
- [ ] [007 tier-1, SCHEMA_VERSION] Co-change "also changed with" lane in sextant_explain — supersedes
  idea-005 test-to-code; freshness-clean (ages on new commits only); pin a FROZEN commit range,
  assert relationship + MIN_SUPPORT not magnitude, cap mega-commit transaction size.
- [ ] [007 tier-1, monorepo] Workspace package map → cross-package fan-in — the T2.1 package altitude;
  count cross-package edges regardless of `kind` (relative cross-package edges must not be dropped);
  new monorepo fixture required.

## Completed

- [x] [Review cluster] Hook-display honesty (branch feat/hookpath-honesty-and-swift-labels):
  swift_decl `defines/declares (in Parent) L<n>` label (#1/#12), content-stale graph-provenance
  strip via textOnly (#2), STALE-marker dedupe-namespace fold (#3), bare comment-marker classifier
  suppression (#7), CLAUDE.md lowercase-claim correction (#8), db_load_failed contentChanged lock
  (#6a). 715/715 unit, self-eval byte-identical. | Done: 06/04/2026
- [x] [Signal research] docs/ideas/007 signal-expansion menu (15 researchers → 39 survivors) | Done: 06/04/2026
- [x] [Roadmap] Adversarially-ranked next-targets roadmap → docs/ideas/006 | Done: 06/04/2026
- [x] [T1.3] Hook retrieval telemetry (classified/injected/empty_fallback + aggregation) | Done: 06/04/2026
- [x] [T1.1] Authoritative entry-points from package.json bin / pyproject scripts | Done: 06/04/2026
- [x] [T1.2] Freshness-gate the hook retrieval lane (content-stale suppress + phantom-drop + STALE marker + stale_hit) | Done: 06/04/2026
- [x] [T1.2 follow-up] Freshness contentChanged — close the version-bump-masks-content-stale edge | Done: 06/04/2026
- [x] [Step 4] Per-case nDCG-lift floor guard (compare-vapor-eval.js Gate 3 + bounded codable allowlist) | Done: 06/04/2026
- [x] [Closed] merge-results lowercase consumer-line false-match — was ALREADY fixed in 522741f (case-sensitive); the stale CLAUDE.md claim is corrected by review #8. | Done: 06/04/2026
