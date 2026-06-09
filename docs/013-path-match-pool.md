---
title: The path_match pool — diagnosis, and why the 012 playbook does NOT transfer
date: 2026-06-09
status: diagnosed (verdict — mostly intrinsic, two small fixes proposed, aggressive gating rejected with data)
method: instance-level replay of all 1,270 path_match surfacings in the 110-session corpus (same harness as docs/012)
companion: docs/012-exported-symbol-gap.md, lib/graph-retrieve.js (Layer 4), lib/graph.js:filePathsMatching
---

# path_match: 4.7% open rate on 65% of surfaced volume

After 012 shipped, path_match became the biggest precision target by volume: 1,270 of 1,951
surfaced files, 60 opened (4.7%). Same instance-level method as 012. **The verdict is
different: this lane's low rate is mostly intrinsic to fuzzy filename matching, not a junk
infestation, and the 012 fix shape (find the 0% class, gate it) does not apply.**

## Mechanism

`graph.js:filePathsMatching` — case-insensitive `LIKE '%term%'` over the **full path**, up to
10 files per term (`MAX_PATH_MATCHES` skips terms matching >10). Any substring anywhere
qualifies: `up.` matches `setup.py`, `Run` matches `runner/`. Layer 4 of the hook fast path;
score 60 (lowest lane), so it tops blocks only when nothing else matched — which is exactly
the borderline-prompt regime. Volume is real: median 3, max 26 path_match files per block;
**90 blocks had ≥6 of their 8 slots filled by filename guesses**.

## Findings

Match-location taxonomy (term vs the path it surfaced):

| Bucket | Meaning | Open rate | n |
|--------|---------|-----------|---|
| `dir-segment` | term == a directory segment (`transfer` → `static/js/transfer/…`) | **22.9%** | 48 |
| `stem-exact` | term == filename stem | 7.6% | 92 |
| `near` (affix ≤2 chars) | plural/truncation (`command`→`commands`, `render`→`renderer`) | 6.0% | 151 |
| `stem-token` | term is a `_`/`-`-delimited token of the stem | 3.9% | 558 |
| `loose` (mid-word) | substring inside a word (`up.`→`setup.py`) | 2.6% | 421 |

- **No 0% mega-bucket.** 012's test-fixture class was 0/89; here even test paths earn opens
  (10/287 on stem-token — path queries legitimately target test files). Every aggressive cut
  loses real hits in proportion: token-aligned-only gating keeps 40/60 hits for 5.7%;
  aligned+cap-3 keeps 29/60 for 5.3%. **Nothing simulated clears 6%.**
- **The "junk" is partly typo-rescue.** Mid-word/affix hits include `rendere`→`renderer`,
  `hness`→`freshness`, `ery`→`query`, `past`→`paste` — misspelled or truncated user terms
  that the substring match correctly recovered. This is WHY hit mass is diffuse: fuzzy
  matching is the lane's job.
- **The one dead-ish mass**: `loose` matches on borderline-confidence turns (conf ≤0.4) —
  **1.4% (3/216)**. Mid-word guesses on conversational prompts. Loose on confident turns is
  3.9% and carries the typo rescues; aligned-on-borderline is fine (6.2%).
- Non-human boilerplate prompts (`#`-prefixed autonomous-loop ticks) contribute 57 instances
  / 2 opens — small, but pure noise (`Run` ×20 from one recurring loop prompt).

## Verdict and the two moves worth making

The realistic ceiling for this lane is ~5.5–6%, not 15% — **recommend AGAINST 012-style
gating** (every simulated aggressive gate trades a third of real opens for ~1pt of rate).
Two surgical moves survive the data:

1. **Drop `loose` (mid-word, non-near) path matches on borderline-confidence turns only.**
   Kills 216 instances (17% of lane volume) for 3 lost hits; lane rate 4.7% → ~5.4%. Needs
   the hook to pass its existing borderline flag into `graphRetrieve` (the "fewer results on
   borderline" conduit already exists in hook-refresh). Keeps every typo rescue (those live
   on confident turns) and shrinks the 8-slot filename-guess filler blocks, which is its own
   UX win — a short honest block beats eight guesses.
2. **Promote `dir-segment` and `stem-exact` within the lane** (score tier above other path
   matches). No recall loss — pure reordering so the 23% class sits highest among path
   matches in the block. Cheap: the classification is computable at match time from the
   path + term.

Explicitly NOT recommended: token-boundary-required matching (kills typo rescue),
test-path exclusion (test files earn opens here), per-block caps by rank (loses 17/60 hits
for +0.7pt).

## Caveats

Same as 012: correlational, opens-as-proxy, and the good cells are small (dir-segment n=48).
The borderline-loose cut is the only one with a defensible kill ratio (216:3). If shipped,
confirm via `eval-trajectory` per-source on post-ship sessions — expect path_match volume to
drop ~17% with rate drifting toward ~5.5%, and watch dir-segment's share of path_match opens.
