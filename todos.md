# Project Todos

Roadmaps: `docs/ideas/006-next-targets-roadmap.md` (functional targets),
`docs/ideas/007-signal-expansion-menu.md` (new target-codebase signals),
`docs/ideas/008-iteration-review-findings.md` (review audit + ranked actions),
`docs/ideas/009-yield-synthesis.md` (re-ranked yield, benefit-proof first — supersedes the
priority ordering in 006/007 where they overlap). Merged-to-`main` clusters: T1.1/T1.2/T1.3 +
step-4 honest-hook-path, the 008 honesty-leak cluster, the 007 declared-manifest cluster, and the
009 #1 v1 outcome substrate. **✅ BENEFIT MEASURED (2026-06-06):** the 009 #1 holdback arm + #12
offline trajectory harness — **merged to `main` @ `5d1d709`** → query-aware retrieval has **2.52×
open-rate lift** on 110 real sessions (2026-06-09 suffix-matcher v2 re-measurement;
`docs/010-benefit-proof.md`; reproduce with
`sextant eval-trajectory`). The unlock is complete — every eval-invisible signal below is now
provable, and the 20% holdback dogfood accrues automatically. **Next: the cheap manifest-seam wins
(#6/#2/#7/#4)**; the precision lever is **DONE** (exported_symbol was 3.3% vs text_only 9.4% —
diagnosed AND fixed 2026-06-09, `docs/012-exported-symbol-gap.md`: term-quality gate + no
test-floor SHIPPED, predicted post-fix ~15%; confirm via `eval-trajectory` per-source as
post-ship sessions accrue). path_match diagnosed AND its two surgical moves SHIPPED
(`docs/013-path-match-pool.md`): loose-on-borderline drop (216:3) + dir-segment/stem-exact
promotion; aggressive gating rejected with data (lane is intrinsically fuzzy, ceiling ~5.5%).
Retrieval-precision arc now mined out; next lever is upstream (classifier conf-0.4 firing on
conversational prompts feeds every lane — evidence, landmines, and candidate fixes in the
handoff; instrument committed at `scripts/analyze-surfacings.js`). Current handoff:
`docs/015-handoff.md` (Codex integration shipped+verified + #6 public-API outline this session;
the classifier conf-0.4 mission in `docs/014` is unchanged and still the next dev lever).

## Active — 009 yield synthesis (re-ranked, benefit-proof first)

> Each item's load-bearing correction was re-verified against live code (file:line in 009).
> Composite scores from the 24-agent workflow; this ordering supersedes 006/007 priority where
> they overlap.

- [x] [009 #1 v1 — THE UNLOCK · composite 48] **Outcome-telemetry substrate (loop wired).**
  SHIPPED: PostToolUse hook (`commands/hook-posttooluse.js`) matches `tool_input.file_path` against
  the per-session injected set (`.last_injected_paths.retrieval.<session>`, written by hook-refresh
  via `formatRetrievalDetailed`) → `retrieval.path_hit{source}`/`path_miss` to the T1.3 JSONL sink;
  `sextant telemetry` reports open-precision + per-source breakdown. `{path, source}` recorded
  (source = surfacing signal, attribution holds). Out-of-band (no stdout), never throws,
  self-deploying via `intel.init` (idempotent merge, anti-clobber). Unit 739/739, self-eval
  byte-identical (off the CLI path), 5/5 integration.
- [x] [009 #1 FOLLOW-UP — makes it a benefit number] **Injection-OFF holdback arm.** SHIPPED:
  `decideArm` in `hook-refresh.js` (default-off via `SEXTANT_HOLDBACK_PCT`; force via
  `SEXTANT_HOLDBACK_FORCE`/stdin `_holdbackForce`); holdback turn withholds the block + persists the
  set tagged `arm:holdback` + fires `retrieval.holdback` + falls back to the static summary;
  PostToolUse stamps `arm` on path_hit/miss; `sextant telemetry` splits open-precision by arm →
  `benefitDelta` (armed − holdback). Never holds back on content-stale turns. Unit + spawn
  integration tests (`test/hook-holdback.test.js`, 12 cases). NEXT (Amo's call): enable on a
  dogfooding repo (`SEXTANT_HOLDBACK_PCT=20`) to accumulate the causal baseline.
- [x] [009 #12 — offline complement, the proof-TODAY half] **Trajectory benefit harness.** SHIPPED:
  `lib/trajectory.js` + `sextant eval-trajectory` replays real session JSONL → retrieval **2.52×
  open-rate lift** over a permutation-null (110 sessions, 9 repos, 5628 opens, suffix-matcher v2;
  1.98× on the original 74-session v1 anchor); static summary only 1.38× (the recency correlation
  trap); median first-touch rank 2. Verified by a 6-agent adversarial
  reproduction — both "refuted" verdicts overturned on reproduction. Full writeup + caveats:
  `docs/010-benefit-proof.md`. Reframed off the degenerate hallucinated-path metric (009 correction)
  toward orientation-latency + permutation-null lift.
- [ ] [009 #2 · composite 45] **Schema/contract anchors** — `schema.prisma`/`*.graphql`/`*.proto`/
  `openapi`/`schema.sql` `### Schema` block. NEW fast-glob pass (these exts aren't in `isIndexable`)
  — the most expensive of the cheap tier; migration-dir anchors are a SEPARATE readdir op (adjacent
  follow-up, NOT "one pass two signals"). Placement ABOVE Recent-changes (clamp guard). ~S
- [ ] [009 #4 · composite 43] **Resolution-by-kind breakdown** — new `GROUP BY imports.kind`
  (`computeResolutionStats` returns no per-kind data today). NOT lockable on any existing fixture
  (all are single-kind/100%) — needs a NEW fixture with an unhonored tsconfig-paths import. Kind set
  `relative|local|tsconfig|workspace|root|unresolved` (drop asset/external — `is_external=1`). ~S
- [ ] [009 #5 · composite 43 — needs policy] **Loud statusline staleness** — gate STRICTLY on
  `freshness.contentChanged` (never version bumps). Kills only the content-stale SLICE (version/
  check_failed blackouts stay green — that's honest). Write the sentinel at BOTH injection sites
  (retrieval hook AND static-summary `applyFreshnessGate`), or SessionStart blackout never flips the
  glyph. (Refines the old "[Tier 3 / Review #13]" item below.) ~S
- [x] [009 #6 · composite 42] **Public-API outline** — SHIPPED 2026-06-22. `### Public API (hotspots)`
  block in `writeSummaryMarkdown` (`summary.js`), sourced from `graph.queryExports`; anchored on the
  hotspot set (entry point `bin/intel.js` has zero exports), capped 4 files × 6 syms, `default`
  dropped, fresh-body-only. Locked by `test/summary.test.js` (renders-on-hotspot + zero-export-omit +
  default-drop). Unit 809, self-eval byte-identical. Benefit-proof via `eval-trajectory` as sessions accrue.
- [ ] [009 #7 · composite 42] **Makefile → Commands block** — second producer into the shipped
  `### Commands` renderer. Specify the dual-source merge contract (polyglot repos have both
  package.json scripts AND a Makefile; dedupe/prefix, N-cap-8 contention) — that, not phantom
  targets, is the real decision. Prefer a `build|test|lint|run` allowlist over a blocklist. ~S
- [ ] [009 #9 · composite 42 — new axis] **Ownership "who-to-ask"** — CODEOWNERS (verbatim) +
  git-recency fallback in `sextant_explain`. NOT a philosophy-blessed axis (must earn its place).
  Label MUST read `recent-author`, NEVER `owner` (proxy ≠ authority — degrade-don't-guess). ~S
- [ ] [009 #10 · composite 41] **Extend freshness gate to CLI/MCP `retrieve()`** — `retrieve.js` +
  MCP `sextant_search` have ZERO freshness refs (CLAUDE.md claims "every injection point" — false).
  NOT a `textOnly` flag-reuse job: `retrieve()` returns structured JSON, needs new field-suppression
  on the JSON shape in TWO places (API-shape decision). Reclassify small → small-to-medium. ~S-M

## Active — review-found (008 deferred items; branch `feat/hookpath-honesty-and-swift-labels` merged)

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
- [ ] [T2.1 · 009 #11 — sequence AFTER swift_relations pathfinder] Symbol-level blast radius —
  capture imported-symbol names. CORRECTION (009, verified): JS side is NOT parse-then-discard —
  `js_ast_imports.js` reads only `node.source.value`, NEVER `node.specifiers`; the names must be
  ADDED to the Babel walk, not threaded through. Only the PYTHON half is genuinely parse-then-discard
  (`python_ast.py:237-244` → `python.js:normalizeImports` folds it). INDEXED import_symbols table
  (SCHEMA_VERSION bump); findSymbolImporters; surface in sextant_explain + 1-line hook note. Fixture
  on a Python from-import edge; make `*` namespace fallback LOUD; symbol-coverage health metric in
  doctor (gate acceptance on it). "Sharpens def-vs-consumer scoring" = unproven hypothesis, not a
  shipped benefit. De-risk via T2.3/009-#8 FIRST (cheap relation-altitude pathfinder). ~L (2-3d+)
- [ ] [T2.3 revise · 009 #8 · composite 42 — CHEAP PATHFINDER, do before T2.1] Wire swift_relations
  into an MCP conformance consumer — MCP/deliberate path ONLY (10s budget), NOT the <50ms hook lane
  (conformer injection displaces canonical def). `findRelationsByTarget` (`graph.js:908`) has ZERO
  production callers (verified — all in test/graph-swift.test.js). CORRECTION (009): NOT "empty
  results pre" (text path already returns ~49 Middleware-named files) — the win is the STRUCTURED
  answer (kind+confidence, keyed by conforming TYPE) + recall of non-name-matching conformers
  (Authenticator.swift). Prove via MCP-handler unit test (FAIL-pre: tool absent), NOT graphLiftNDCG
  (tool isn't eval-scored). symbol-keyed branch / new `sextant_relations` tool is a contract change
  (sextant_related is file-keyed). Validates the relation-altitude pattern BEFORE the heavy T2.1
  schema bump — no benefit here = kill signal for the trilogy. ~1-2d
- [ ] [T2.4 kill-on-no-fixture] Two-token NL recall — REVIEW VERDICT: inert on every existing
  corpus (25/27 realistic 2-token queries already resolve via phrase/AND; the AND-zero cases float
  a test file). Drop unless a real dogfooded 2-token miss appears on a NEW repo.
- [ ] [T2.5 revise · 009 #12 · composite 36 — DOWNGRADED, metric reframed] Session-trajectory
  harness — `sextant eval-trajectory` over session JSONL. CORRECTION (009): hallucinated-path rate
  is DEGENERATE (~0 in real sessions — the agent Globs/LS before Reading; reads 0.000 before AND
  after sextant, same blindness as issue #2). Do NOT lead with it — reframe around ORIENTATION
  LATENCY / first-touch precision (did the agent open the injected file first vs after N exploratory
  reads — a populated distribution); keep hallucinated-path as a tripwire (alert if >0). Offline
  complement to the live #1 substrate (replay = before-merge proof; live = in-field). ~M
- [ ] [Tier 3] test-to-code map — gated on the Review #4 shared `isTestPath` predicate; then filter
  neighbors().dependents through it; "no test files import this" note, NOT a coverage-gap label.
  (007 co-change lane likely supersedes this — tests co-change with impl 8x but rarely import it.)
- [ ] [Tier 3] Swift-only sextant_symbols MCP tool — JS/TS exports have no line column; scope to
  swift_declarations.start_line.
- [ ] [Tier 3] function-level localization eval tier — startLine plumbing graph-retrieve→merge→format
  is now DONE (shipped with the swift-decl label); remaining work is `recallDefLine@k`.
- [ ] [Tier 3 / Review #13 — SUPERSEDED by 009 #5 above] Loud staleness on
  `scripts/statusline-command.sh`. See the 009-#5 item (top section) for the verified scope: kills
  only the content-stale SLICE; sentinel must be written at BOTH the retrieval hook AND the
  static-summary `applyFreshnessGate` site (the SessionStart blackout — the most common one — lives
  there, not in the refresh hook).

## Active — signal expansion 007 (new target-codebase signals)

- [x] [007 T1.4] package.json `scripts` → Commands block (xs) — SHIPPED on branch
  `feat/manifest-commands-block` (`224f6c2`); `commandsFromPackageScripts`, `### Commands` after
  Signals, lifecycle-first, N-cap 8, fresh-body-only. Unit 720/720, self-eval byte-identical.
- [x] [007 T1.4 cont.] AGENTS.md/CLAUDE.md/.cursorrules presence (`Conventions:` in Signals) +
  `.env.example` required-env keys (keys-only, git-ls-files tracked-gated for freshness honesty) —
  SHIPPED (`7dfde15`) on `feat/manifest-commands-block`. Declared-manifest cluster COMPLETE. Unit
  724/724, self-eval byte-identical, secret-value-never-leaks locked.
- [ ] [007 tier-1] Makefile Commands / schema anchors / resolution-by-kind / public-API outline —
  now broken out individually with verified corrections in the **009 section above** (#7/#2/#4/#6).
  NOTE: "cheap surfacing of already-graph-resident data" is only true for public-API
  (`queryExports` exists); schema anchors = NEW glob pass, resolution-by-kind = NEW `GROUP BY` not
  lockable on any existing fixture. See `docs/ideas/009` for per-item gates.
- [ ] [007 tier-1 · 009 #3 · composite 45 — NEW FACT-CLASS] Co-change "also changed with" lane in
  sextant_explain — behavioral blast radius the import graph structurally cannot see (route+test,
  schema+migration, config+cross-lang consumer). Supersedes idea-005 test-to-code. CORRECTION (009,
  verified): SCHEMA_VERSION bump is NOT mandatory — `getRecentGitFiles` is render-time/git-only
  (`summary.js:380`, `cli.js:237`, never persists), so a live-computed lane is freshness-clean with
  NO bump. Bump required ONLY if you materialize pairs into graph.db for the <50ms hook path —
  decide storage first (live-compute = simplest/HEAD-fresh; materialized = hook-fast-path). Hard half
  is the discipline, not the recovery: pin a FROZEN commit range, assert relationship + MIN_SUPPORT
  + count==1-vs-absent (NEVER magnitude — counts drift), cap mega-commit transaction size. ~M
- [ ] [007 tier-1, monorepo] Workspace package map → cross-package fan-in — the T2.1 package altitude;
  count cross-package edges regardless of `kind` (relative cross-package edges must not be dropped);
  new monorepo fixture required.

## Active — Codex integration (shipped 2026-06-22)

- [x] `sextant init --codex` — wires `.codex/hooks.json` + `AGENTS.md` + global
  `~/.codex/config.toml [mcp_servers.sextant]` (merge-not-clobber, idempotent; `commands/init.js`,
  9 tests). Hook-stdout ingestion VERIFIED live (Codex 0.141.0): both hooks fire, model answered
  `INJECTED`. Shipped @ `1f96979`/`9def3ec`/`aad4039`.
- [ ] **USER ACTION — restart Codex to trust new hooks** in the 6 repos wired this session:
  `jan25`, `manus-api-mcp`, `amoSportsCenter`, `sinter`, `somaNotes`, `open-interpreter-fork`.
  (glasshud already trusted.) Until restarted+trusted, those repos get the MCP tools but NOT
  auto-injection — Codex skips an untrusted `.codex/hooks.json` silently.
- [ ] [enhancement, optional] `sextant init` could auto-detect a Codex install (`~/.codex/`) and
  suggest `--codex`, so the gap doesn't recur silently on new repos.

## Tech debt / flakes

(none currently)

## Completed

- [x] [flaky test] `test/hook-refresh-freshness.test.js` rotating-case flake — root cause was NOT
  timing: the dogfooding `SEXTANT_HOLDBACK_PCT=20` (.claude/settings.json env) leaked into spawned
  hooks, giving each un-pinned spawn a 20% chance of a holdback turn that withholds the block the
  test asserts on. Fixed by pinning the arm per-spawn (PCT=0, FORCE cleared) in all hook-spawning
  tests + test-refresh.sh; also shimmed `sextant` on PATH in hook-refresh-telemetry/hook-posttooluse
  (their no_scan_record fixtures spawned the REAL detached rescan → ENOTEMPTY teardown race).
  30/30 loop + 3× full unit suite green under ambient PCT=20. | Done: 06/09/2026

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
