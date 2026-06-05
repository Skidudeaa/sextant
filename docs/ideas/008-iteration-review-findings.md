---
title: Iteration review — shipped-cluster audit + ranked next actions
status: reviewed
priority: high
source: deep-review workflow (11 audit agents → 36 findings, each independently reproduced → adversarial verify → ranked)
reviewed: 2026-06-04
companion: docs/ideas/006-next-targets-roadmap.md, docs/ideas/007-signal-expansion-menu.md
---

# Iteration Review — Shipped-Cluster Audit + Ranked Actions

> All-opus review of the merged 006 Tier-1 cluster (T1.1/T1.2/T1.3 + step-4). 11 audit agents
> (4 verifying shipped targets, 7 project-wide lenses) → **36 findings, 36 survived independent
> reproduction** → adversarial verify → ranked. Every action carries a concrete
> FAIL-pre/PASS-post gate. Items marked **✅ SHIPPED** landed on branch
> `feat/hookpath-honesty-and-swift-labels`; the rest are tracked in `todos.md`.

## Iteration verdict

The shipped Tier-1 + step-4 cluster **holds up well**: all four targets match the roadmap, each
carries a genuine fail-pre/pass-post lock (spot-verified), and the byte-identical eval claims are
credible. The honest gap: **T1.2 shipped with its core honesty guarantee defeatable in a narrow
same-session path** — two real residual leaks neither caught because every integration test uses a
fresh single-run fixture. So "solid" is right for T1.1/T1.3/step-4; T1.2 was minor-gaps until the
two leaks (ranks 2+3 below) were fixed.

## Shipped-target audit

| Target | Verdict | Conf | Lock | Residual issues |
|--------|---------|------|------|-----------------|
| **T1.1** entry-points (`e0dc325`) | solid | 0.9 | `test/entry-points.test.js` | index.* demotion fires whenever ANY `pkg.bin` exists but only reads `bin` (ignores `main`/`exports`) — a lib whose real entry is `src/index.js` via `main` is dropped (roadmap-accepted scope cut, `summary.js:428`); pyproject parser handles only canonical `[project.scripts]` (`summary.js:141`) |
| **T1.2** freshness-gate retrieval (`451d48f`+`7f29689`) | minor-gaps → **fixed** | 0.85 | `hook-refresh-freshness.test.js` + `merge-results.test.js` + `freshness.test.js` | **(2) content-stale lines rendered `exports X`/`fan-in: N` under the suppression marker**; **(3) STALE marker droppable by the pre-marker dedupe hash** — both ✅ SHIPPED |
| **T1.3** telemetry (`39af991`) | solid | 0.9 | `hook-refresh-telemetry.test.js` | text_only source label never exercised by a live hook run (synthetic unit only); source-label comment omits `HIT_SWIFT_DECL_OTHER` |
| **Step 4** lift-floor guard (`6b03f0b`) | solid | 0.9 | `eval-lift-guard.test.js` | `fixtures/vapor-baseline.json` not regenerated for the new per-case `liftNDCG` field (cosmetic); Gate 3 doesn't filter `isNegative` (unlike the eval-retrieve aggregate); Gate 3 uses raw unrounded lift vs the 2dp-rounded display |

## Ranked actions

1. **✅ SHIPPED — Swift decl `defines/declares <term>` label** (`674a0cb`). The flagship graph win
   (injecting `URI.swift` to rank 1) reached Claude as a labelless path. `format-retrieval.js`,
   eval byte-identical (one caller: the hook). + the `(in Parent) L<n>` enrichment (rank 12).
2. **✅ SHIPPED — strip graph provenance on content-stale** (`674a0cb`). `textOnly` flag threaded
   from the hook; the marker no longer lies about suppression. Pairs with 3.
3. **✅ SHIPPED — fold contentStale into the dedupe hash** (`674a0cb`). `"fresh:"/"stale:"` namespace
   so a stale turn can't dedupe against a prior fresh turn and silently drop the marker.
4. **[deferred] Extract `isTestPath`/`isVendorPath`/`isDocPath` into a shared `lib/path-classify.js`**;
   converge `merge-results.js:fileTypePenalty` onto the broader CLI predicates. CLI and hook silently
   disagree what a file IS. MEDIUM RISK — changes hook ranking; the parametrized cross-module
   agreement test is the only guard (committed corpora lack these shapes). Prereq for the Tier-3
   test-to-code map.
5. **[deferred — NEEDS DECISION] Swift partial-parse signal in the summary.** A bare-count
   `ALERT: SWIFT FACTS INCOMPLETE` on any `filesParseErrors>0` would cry wolf on EVERY real Swift
   repo — 7/42 Vapor files partial-parse routinely from tree-sitter grammar limits, not defects
   (`project_swift_parser_diagnostics` field report). Needs a high-rate threshold or a quiet
   non-ALERT coverage line. `summary.js:300-313`.
6. **[partial] Missing test-coverage locks.** ✅ `db_load_failed → contentChanged:true` (`6563a7d`)
   — guards T1.2's corrupt-db path. Remaining (deferred): Python package-only `__init__.py`
   `— declared` tag, pyproject TOML robustness, text_only source label via a live run, eval-retrieve
   `liftFloorBreaches` `!isNegative` (print-only).
7. **✅ SHIPPED — suppress bare comment markers from the classifier** (`5861b4a`). `TODO`/`FIXME`/…
   scored `retrieve:true` via the initialism rule.
8. **✅ SHIPPED — correct the stale CLAUDE.md lowercase claim** (`c2705ba`). Bug fixed a month ago
   in `522741f`; the doc still asserted it.
9. **[deferred] Tighten Gate 2 + add an order-sensitive per-case rank gate** to the Vapor hook diff
   (`compare-vapor-eval.js`). Gate 2 set-retention cements WRONG baseline answers (4/15 hook cases),
   so a genuine fix that promotes the canonical file is reported as a FAIL.
10. **[deferred] Widen Gate 3 accepted-debt bound to −0.34** (or a frozen-rank assertion on
    `URI.swift`); the bound sits 0.0049 from the cliff — a near-tied conformer reorder inside the
    cold-zoekt noise envelope trips it (cry-wolf). Fix the misnamed displaced-file comment.
11. **[deferred] Add a default-on top-k floor to the CLI eval pass criterion** (mirror eval-hook.js
    `maxPrimaryRank`) — `usefulness>=0.5` tolerates the primary file at rank 8-9 today.
12. **✅ SHIPPED — swift_decl `(in parentName) L<startLine>` enrichment** (`674a0cb`, with rank 1).
13. **[deferred — needs policy] Wire content-stale staleness into `scripts/statusline-command.sh`,**
    gated STRICTLY on git-derived `freshness.contentChanged`, NEVER version bumps (cried-wolf guard).
    The statusline shows green while Claude's injection is blacked out — contradictory state.
14. **[deferred — roadmap T2.1] Symbol-level blast radius.** Fixture on `python-eval` (a from-import
    edge), carries a `SCHEMA_VERSION` bump. NOT on this CommonJS repo (its own example is provably
    wrong — namespace `require`).
15. **[deferred — roadmap T2.2] Classifier calcification guard** — a no-regression lock on the ~85
    existing verdict assertions; quarantine `merge results scoring` as an `xfail` product decision.

## Open risks (real, but maintainer decisions — not auto-executable)

- **Definition-site suppression among co-equal def-type exporters** (`graph-retrieve.js:182-198`):
  fan-in picks the "canonical" file when multiple files genuinely export the same symbol. Real, but
  the fix collides with two committed tests that encode current behavior as correct → design decision.
  The re-export-barrel flavor is already fixed (B3); the live flavor is same-name polymorphic defs.
- **`termCoverageBonus` substring matching** (`merge-results.js:329-339`): case-insensitive substring
  co-occurrence inflates prose/comment lines on multi-token queries; the word-boundary fix only
  partially closes it. Eval-invisible (CLI never calls mergeResults) but live on the hook.
- **Version-only-stale asymmetry between lanes** (`hook-refresh.js` vs `cli.js`): the retrieval hook
  injects full graph authority on a version bump while the static-summary lane blacks it out. Each
  lane documents+tests its own choice; the gap is the absence of a JOINT policy. Lower priority than
  the content-stale leaks.
- **T1.1 index.* demotion overbreadth** (`summary.js:428`): a documented scope cut, flagged for
  awareness if a future user hits the `main`-declared-entry case.

## Kill list (inert on every existing corpus — do not ship on faith)

- **T2.4 two-token NL recall** — re-ran the probe on warm Vapor + swift-eval + python-eval: 25/27
  realistic 2-token queries already resolve via phrase/AND; the only AND-zero cases float a test file
  to rank 1. Reverting the gate drops NO canonical file — FAIL-pre and PASS-post are byte-identical.
  Re-open only on a real dogfooded 2-token miss on a NEW repo.
- **Self-eval per-case negative-lift floor enforcement** — this CommonJS repo has 0 reexports-table
  rows and every probed symbol's def is at rank 1 in the noGraph arm, so worst-possible self-eval lift
  is 0.000; a trip-wire would never fire. That need is already met by python-eval + Vapor Gate 3.
- **`findRelationsByTarget` dead-code deletion** — no behavioral FAIL-pre/PASS-post (self-eval+Vapor
  byte-identical either way); 3 of its test call-sites assert OTHER load-bearing behavior. NOTE: T2.3
  would give it a live consumer, so deletion is moot if T2.3 is taken up.
- **graphRetrieve schema-skew per-layer try/catch** — the swift_declarations-missing throw is LATENT
  not live (every production db runs additive `ensureSchema` first; all 5 fixtures have the table).
  Worth a cheap defense-in-depth unit, not an existing-corpus fixture.
