---
title: The exported_symbol precision gap — diagnosis from real-session instance data
date: 2026-06-09
status: diagnosed (fixes proposed, not yet shipped)
method: instance-level replay of all 214 exported_symbol surfacings in the 110-session corpus (suffix matcher v2)
companion: docs/010-benefit-proof.md (per-source table), lib/graph-retrieve.js, lib/merge-results.js, lib/classifier.js
---

# Why exported_symbol earns opens at 3.3% vs text_only's 9.4%

docs/010 flagged the gap and asked: *defs the agent doesn't need, or a ranking issue?*
Answer: **neither**. The lane's matches are fine when they're real — the problem is that
**95% of its firings are junk term-matches**, and the def-floor authority then promotes the
junk to rank 1.

## Method

Replayed every retrieval injection in the 110-session corpus (same transcripts as the 010
anchor), keeping per-instance detail the harness aggregates away: the matched symbol
(from the injected `exports X` label), block rank, the prompt that triggered the turn, opens
before/after, and what was opened instead. 214 exported_symbol instances across 117 distinct
files; 468 text_only instances as contrast.

## Findings (each cut is measured, not inferred)

| Cut | Open rate | n |
|-----|-----------|---|
| All exported_symbol | 3.3% | 214 |
| … matched on a **code-shaped term** (snake_case/camelCase/≥10 chars) | **20.0%** | 10 |
| … matched on a **generic word** (`session`, `plan`, `main`, `out`, `user`, `pass`, `repo`…) | 2.5% | 204 |
| … surfaced file is a **test file** | **0.0%** | 89 |
| … code-shaped **and** non-test | **22.2%** | 9 |
| text_only (contrast) | 9.2% | 468 |

- **The lane at its best is sextant's strongest signal** — 20–22%, ~2.3× text_only. The
  7 hits matched `accept_note`, `ground_paste_back`, `init`, `scan`, `commands` — real
  identifiers in code-targeted prompts — plus two lucky `user`→`User`-model matches
  rescued by fan-in (88 and 11).
- **Not a "window" artifact**: counting files already open *before* the injection
  ("agent had it, didn't re-open") still leaves exported_symbol at 6.5% either-direction
  vs text_only's 16.9% — the gap survives.
- **Rank-1 displacement**: 43% of exported_symbol instances take rank 1 (91/214) — junk
  doesn't just miss, it spends the best slot.

## The failure chain (all four links verified in code + data)

1. **Borderline prompts fire retrieval with conversational terms.** 60% of exported_symbol
   surfacings (128/214, 2.3% open rate) come from confidence-0.4 turns. Verified live:
   `"proceed the way you have laid out please"` → `retrieve:true`, terms
   `["proceed","laid","out"]`. SKIP_TERMS is action-verb-focused; generic *nouns* sail
   through (`session` ×35, `plan` ×17, `main` ×16, `out` ×14, `repo`, `user`, `client`…).
2. **`findExportsBySymbol` is case-insensitive exact-match with no distinctiveness gate**
   (`graph.js:450`, `LOWER(name)=LOWER(?)`). The English word `pass` matches a test-file
   constant `PASS`; `out` matches `OUT`; `user` matches a `USER` const *and* the `User`
   model class. One SQL row = one injection.
3. **Test files are dense exporters of generic names.** Python's AST extractor records
   every top-level def as an export — so pytest fixtures become injection magnets.
   Verified in somaNotes' graph.db: `client` is an exported fixture in **15 test files**;
   `PASS`/`OUT`/`USER` are test-file constants; every one-off script exports `main`.
   Result: 42% of exported_symbol surfacings are test files (vs 21% for text_only), 0/89 opened.
4. **The def-floor out-muscles the test penalty.** `merge-results.js:309`:
   `(600 + graphScore) × 0.75 ≈ 525+` — above zoekt's ~500 base. And borderline prompts
   usually get zero zoekt hits, so the block is graph-only and the fixture file sits at
   rank 1 unopposed.

## Proposed fixes (ranked; ship behind eval gates)

1. **Term-quality gate on the export-injection lane** (`graph-retrieve.js` Layer 2 +
   `retrieve.js:injectGraphMatches`): a *generic* term (not code-shaped: no `_`, no
   internal capitals, short) only earns injection when corroborated — target file has
   meaningful fan-in (the `user`→`User` hits had fan-in 88/11; the junk had 0–2) or the
   file also has a live text hit. Kills ~95% of junk while keeping both generic-term hits.
2. **No def-floor for test-path files** (`merge-results.js`): a pytest fixture export is
   not a canonical definition. Route test-file export matches like `reexport_chain`
   (present, but no floor). Evidence: 0/89.
3. **Skip the export lane on confidence-0.4 turns** (hook already shrinks result count on
   borderline turns; extend to the graph-authority lane). 60% of junk volume, 2.3% open rate.
4. (Lighter variant of 1) Case-strictness: lowercase English-word terms shouldn't match
   `SCREAMING_CASE` constants case-insensitively.

**Measurement**: per-source coverage in `sextant eval-trajectory` is the scoreboard —
exported_symbol should move toward ~20% as junk volume drops ~10×. No-regression gates:
self-eval 21/21 byte-identical-or-better, Vapor `eval-swift-external.sh diff` (the floor
exists to win `URI`-class cases — fix 2 must not regress them; Vapor's canonical defs are
non-test paths, so it shouldn't), python-eval `py-penalty-001`/`py-reexport-001`
(def-over-barrel must keep the floor for *source* files).

## Caveat

n is small in the good cells (10 code-shaped instances, 7 hits) — the 20% is directional,
not a precise estimate. The conclusion that's solid at n=204/89: generic-term and
test-file surfacings are noise at scale. Re-run the instance analysis after any fix; the
script pattern lives in this doc's history (replay + per-instance dump).
