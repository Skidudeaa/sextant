# Swift v1 — Polish Phase Handoff

> Pairs with `docs/swift-v1-handoff.md` (predecessor session's handoff
> into this one). Written 2026-05-02 at session end.

## Status

**Swift v1 is shipped.** Polish phase ran on 2026-05-01 and 2026-05-02
across 13 commits on `main` ahead of where the prior session left off.
All on `origin/main` as of `458982e`.

## Commits this session

```
458982e docs(swift): post-ship wire-airtight audit summary
4eb9ed8 chore(swift): close airtight-wiring gaps from v1 polish audit
c27ac8f docs(swift): swift v1 scope doc + README/CLAUDE updates
02376da feat(swift): external Vapor benchmark — pinned 4.121.4, 15-query battery
083d520 feat(swift): synthetic eval corpus — fixtures/swift-eval/ (13/13, MRR 0.958)
```

The earlier 8 (`a39480c` and prior) belong to the predecessor session
and were already in the working tree, unpushed, when this session
started — they're now pushed alongside the polish work.

## Durable doc set

Five docs collectively define and record Swift v1. None are redundant:

- `docs/swift-v1-scope.md` — what Swift v1 is, in/out of scope, recovery, external validation. **The user-facing scope contract.**
- `docs/swift-v1-wire-audit.md` — post-ship audit methodology, findings, verdicts. **The audit-pattern reference.**
- `EVAL_FINDINGS.md` (new section) — synthetic + Vapor results, signal evidence, SB-1 SQL invariant.
- `CHANGELOG.md` (2026-05-01 entry) — ship narrative.
- `CLAUDE.md` + `README.md` + `DESIGN_PHILOSOPHY.md` — Swift mentioned consistently across all three; "repo-local source orientation" framing locked in.

## Headline numbers

| Surface | Result |
|---|---|
| Synthetic Swift fixture (`fixtures/swift-eval/`, 13 cases) | **13/13** pass, MRR 0.958, nDCG 0.977 |
| Vapor 4.121.4 (`fixtures/vapor-baseline.json`, 15 queries) | **15/15** pass, MRR 0.591, nDCG 0.604 |
| Self-eval (sextant repo) | **20/20** pass, MRR 0.929 (vs 0.920 baseline) |
| Unit tests | **526/534** pass (8 skipped, 0 fail) |
| Mixed-eval (`fixtures/mixed-eval/`) | **7/7** pass on both `eval-retrieve.js` and `eval-hook.js` |

## Open issues filed

- **`Skidudeaa/sextant#1`** — Broaden `TEST_PENALTY` beyond `Tests/`
  path heuristic. Test-tagged sources outside `Tests/` (e.g.
  `Sources/XCTVapor/`, `Sources/VaporTesting/`) outrank canonical defs
  on common-name queries. Repro: `vapor-app-001` in
  `fixtures/vapor-baseline.json`. Acceptance: `Application.swift` in
  top-3.
- **`Skidudeaa/sextant#2`** — Investigate why graph lift is neutral
  on Vapor (and find a corpus where it isn't). The three pathological-
  lift queries (`URI`, `init`, `Service`) show 0.000 nDCG delta on
  Vapor 4.121.4. Three exit paths: scoring change → measurable lift,
  second corpus where lift is positive, or documented "this corpus
  shape doesn't benefit" finding.

## Two non-obvious facts the next session should not relearn

These were discovered the painful way during this session and are
captured in the wire-audit but worth surfacing here:

1. **`rg` runs with `-F` (fixed-string mode).** Multi-token queries
   like `"View protocol"` literal-match `View protocol` only — they do
   not AND-of-terms across tokens. Multi-token query design must
   either (a) match a contiguous substring of a code line (e.g.
   `protocol View` not `View protocol`), or (b) include an in-file
   anchor comment containing the literal multi-token phrase.
2. **Eval-case-id comments outrank def lines.** Comments containing
   `"swift-proto-001 expects this Swift protocol definition to rank #1"`
   become the top hit on the corresponding query because they contain
   the query phrase verbatim. Fixture comments must be neutral
   (Swift-style doc comments) — never reference the eval case ID or
   query string.

## False-positive worth recording

The audit flagged `lib/cli.js:151` as a missing `await` on
`buildStaleBody`, claiming `[object Promise]` would be injected into
stale-body output. **It is not a bug.** `applyFreshnessGate` is itself
`async`; `return promise` from an async function flattens
transparently when callers `await applyFreshnessGate(...)`. The unit
suite would have caught a real coercion. Don't re-litigate this in
future audits unless behavior changes.

## What this handoff doesn't claim

- It doesn't claim the graph layer adds measurable value on Vapor —
  it doesn't, currently. That's `#2`.
- It doesn't claim the synthetic fixture's `+10%` / `+15%` boost
  numbers are tuned — they're starting priors per the comment in
  `lib/scoring-constants.js:38`. Tuning requires re-running the +99%
  per-hit stack-ceiling math.
- It doesn't claim the 11-item v1 deferral list will stay deferred
  forever — each item has its own rationale in `docs/swift-v1-scope.md`
  and any can be revisited if a clear use case shows up.

## When you're ready to ship more Swift work

Run the same pre-flight as this session's plan:

```bash
npm run test:unit
npm run test:eval
node scripts/eval-retrieve.js --dataset fixtures/mixed-eval/eval-dataset.json --root fixtures/mixed-eval
node scripts/eval-hook.js     --dataset fixtures/mixed-eval/eval-dataset.json --root fixtures/mixed-eval
node scripts/eval-retrieve.js --dataset fixtures/swift-eval/eval-dataset.json --root fixtures/swift-eval
node scripts/eval-hook.js     --dataset fixtures/swift-eval/eval-dataset.json --root fixtures/swift-eval
bash scripts/eval-swift-external.sh   # diff-mode against committed Vapor baseline
```

If a scoring change is part of the work, also rerun
`bash scripts/eval-swift-external.sh regen-baseline` to refresh the
Vapor baseline once the change is intentional.
