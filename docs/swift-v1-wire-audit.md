# Swift v1 — Post-ship Wire-airtight Audit

After the Swift v1 polish phase landed (commits `083d520`, `02376da`,
`c27ac8f`), three parallel `Explore` agents ran a coverage audit
against the full surface area: install path, CLI commands, startup
hooks, watcher, freshness gate, summary, statusline, and the doc
bundle. The audits surfaced eight findings. Five were real and were
fixed in `4eb9ed8`. Two were not real. One was a design choice already
made.

This doc records the audit methodology, the verdicts, and the
verifications. It exists so the next person who runs a
post-ship audit can model it on this one.

## Audit scope

Three agents, each given disjoint surfaces:

- **Install + commands** — `package.json`, `bin/intel.js`,
  `commands/init.js`, `commands/scan.js`, `commands/doctor.js`,
  `commands/health.js`, `commands/retrieve.js`, default file globs,
  MCP server tool list, `vendor/README.md`.
- **Startup + statusline** — `commands/hook-sessionstart.js`,
  `commands/hook-refresh.js`, `watch.js`, `lib/freshness.js`,
  `lib/summary.js`, `scripts/statusline-command.sh`, `lib/cli.js`
  (statusline + freshness helpers), schema/scanner versions,
  `commands/init.js` auto-init behavior.
- **Documentation** — `README.md`, `CLAUDE.md`,
  `DESIGN_PHILOSOPHY.md`, `CHANGELOG.md`, `EVAL_FINDINGS.md`,
  `docs/`, `docs/ideas/`, `docs/solutions/`, `vendor/README.md`,
  `.gitignore`, untracked-files disposition, slash commands.

Each agent was instructed to report **only gaps**, not what was
already correct, with a verdict line of the form `gaps-found: N`.

## Findings

| # | Surface | Finding | Verdict | Action |
|---|---|---|---|---|
| 1 | `lib/intel.js` | `sextant health` JSON output had no `swift` block — `getSwiftHealthCounters()` existed in `lib/graph.js` but only `sextant doctor` consumed it. JSON-consuming automation was blind to whether the parser loaded and what got indexed. | real | Added `swift: graph.getSwiftHealthCounters(db)` to the returned `state` object in `intel.health()`. Verified on `fixtures/swift-eval/`: `parserState=ok`, `declarationsIndexed=38`, `relationsIndexedTotal=6`. On the sextant repo itself (no `.swift` files): zeros across the board. |
| 2 | `README.md` | "Cross-project validated" line listed Express / Flask / React only; Eval Results section quoted self-eval numbers without the Swift fixtures. | real | Added Vapor 4.121.4 (294 files) to the cross-project line and the synthetic Swift corpus numbers (MRR 0.958, nDCG 0.977, 13/13) to Eval Results. |
| 3 | `DESIGN_PHILOSOPHY.md` | Anti-goals listed semantic engine, language server, vector DB, IDE replacement — but not compiler-backed Swift semantics, even though `CLAUDE.md`'s "What NOT to add" already covers it. | real | Added explicit anti-goal entry: "a compiler-backed Swift toolchain (no USRs, no cross-module refs, no `.swiftinterface` ingestion — see `docs/swift-v1-scope.md`)". Keeps framing consistent across all three docs. |
| 4 | `CHANGELOG.md` | No entry for the Swift v1 ship. Last entry was 2026-04-30; commits dated 2026-05-01 had no narrative summary. | real | Added 2026-05-01 entry covering all four ship blockers, the polish phase (synthetic + Vapor + scope doc), self-eval clean (19/19, MRR 0.929 vs 0.920 baseline), and the two filed follow-up issues (#1, #2). |
| 5 | `EVAL_FINDINGS.md` | No Swift v1 results section. The doc described the self-eval and historical scoring evolution but had no record of the synthetic fixture or Vapor benchmark. | real | Added "Swift v1 Eval Results" section before "Next Steps", with synthetic numbers, Vapor numbers, signal evidence (`+10%`/`+15%` boosts visible in verbose output), the SB-1 SQL invariant, and explicit pointers to issues #1 and #2. Next Steps list now includes those issues as items 5 and 6. |
| 6 | `package.json` | No `files` array — when published to npm, `vendor/tree-sitter-swift.wasm` would not ship. | not a gap | Package has `"private": true`. Install path is `npm link`, which symlinks the whole package directory regardless of `files`. WASM ships fine. Adding `files` now is preemptive complexity. Revisit if/when `private` is removed. |
| 7 | `lib/cli.js:151` | `applyFreshnessGate` returns `buildStaleBody(...)` without `await`; reported as injecting `[object Promise]` into stale-body output. | false positive | `applyFreshnessGate` is itself `async`. Inside an `async` function, `return promise` is functionally equivalent to `return await promise` — JavaScript's Promise resolution flattens nested Promises at the boundary where `await applyFreshnessGate(...)` runs in the caller. No string coercion happens. The unit suite (526/534, 8 skipped, 0 fail) and the freshness / inject / summary integration tests would have caught a real `[object Promise]` injection — they don't, because there isn't one. |
| 8 | `mcp/server.js` | No Swift-specific MCP tool (e.g. `sextant_swift_declarations`). | design choice | Already settled: Swift facts are queryable through `sextant_search` and `sextant_explain` (which read the same graph.db tables). Adding a Swift-specific tool would add surface area for marginal value when the existing tools already work over the Swift content. Documented this stance in the audit; not a gap to close. |

## Verifications

After landing the five real fixes in `4eb9ed8`:

- `npm run test:unit` — **526/534 pass** (8 skipped, 0 fail), unchanged from pre-audit.
- `node bin/intel.js health --root fixtures/swift-eval` — JSON output
  includes a `swift` block with `parserState=ok` and the expected
  declaration / relation counts.
- `node bin/intel.js health` (sextant repo) — JSON output includes a
  `swift` block of zeros (correct: no `.swift` files in this repo's
  scan).
- `git push origin main` — clean push of `4eb9ed8`.

## What this audit doesn't catch

The audits are coverage-oriented ("does each surface know about
Swift?"), not behavior-oriented ("does each surface produce the right
output for every Swift edge case?"). Behavioral gaps live under the
filed follow-ups:

- `Skidudeaa/sextant#1` — `TEST_PENALTY` heuristic misses
  `Sources/XCTVapor/` and `Sources/VaporTesting/`-style test targets
  that don't live under a `Tests/` directory.
- `Skidudeaa/sextant#2` — graph lift is neutral on the three
  pathological-lift queries (`URI`, `init`, `Service`) on Vapor 4.121.4
  — investigate corpus shapes that benefit from the structural lane.

A future scoring change should re-run the same four eval gates
(`npm run test:eval`, `eval-retrieve.js` and `eval-hook.js` against
both `fixtures/mixed-eval/` and `fixtures/swift-eval/`, plus
`scripts/eval-swift-external.sh` for the Vapor regression) and
re-verify the JSON-health surfaces still expose what
automation expects.

## Methodology notes for future audits

- Three disjoint agents in parallel beat one sequential. Each agent
  reads its surface in isolation and surfaces gaps without priming
  from the others' findings.
- Telling agents to **report only gaps** and end with a verdict line
  keeps reports tight and decision-ready. Free-form "what I found"
  reports tend to bury blockers in the middle.
- Verify each finding before fixing. The `lib/cli.js` "missing
  await" looked like a P0 bug but was a false positive on async
  semantics. A 30-second test run confirms or denies before the
  edit.
- Document non-gaps too. Recording why `package.json files` and the
  MCP-tool design were intentionally left alone prevents the next
  auditor from re-raising the same questions.
