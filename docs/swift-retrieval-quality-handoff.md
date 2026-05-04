# Swift Retrieval Quality — Handoff

> Written 2026-05-03 at session end. Pairs with the dogfooding feedback
> on the 2026-04-30 self-eval observations and the user's "I primarily
> use SwiftUI" framing. Read this before touching `lib/retrieve.js`,
> `lib/graph-retrieve.js`, `lib/zoekt.js`, `lib/merge-results.js`, or
> the Vapor benchmark.

## Status

**Real-Swift retrieval quality jumped meaningfully.** Vapor 4.121.4
(294 Swift files, 15 queries) MRR went from `0.591 → 0.811` over four
commits in this session. Everything that needed to land for "the URI
pathology and the multi-token-injection bug stop hitting production
hooks" landed. Two remaining limitations are documented below as
acceptable debt; both have non-trivial scope and were deferred
deliberately.

```
0b21076 feat(retrieval): close swift known-debt — hook fast-path swift-decl wiring + multi-token injection fix
089f986 feat(retrieval): swift-decl injection + regex escape closes Vapor URI/rank-0 cases
5b0daa1 feat(retrieval): align eval with production backend; quote multi-token zoekt queries
78e983a feat(retrieval): close 2026-04-30 dogfooding gaps in classifier + eval
```

All on `origin/main`. Vapor baseline regenerated and committed.

## Why this exists

The previous session's handoff (`docs/scope-v1-handoff.md`) was a closure
doc — no actionable items. But CLAUDE.md and the auto-memory entry
`project_self_eval_observations_2026_04_30.md` pointed at three live
gaps: (1) classifier was retrieving on conversational meta prompts,
(2) eval-fixture coverage was missing canonical non-JS files like the
bash statusline implementation, and (3) the user mentioned they primarily
write SwiftUI — so we measured the realistic Swift-codebase quality bar
on Vapor and discovered MRR was 0.591 because:

- The eval was forcing `backend: "rg"` while every production codepath
  uses `backend: "auto"` (zoekt when installed). Different backends, very
  different quality.
- zoekt's default query syntax is regex with whitespace-AND tokenization
  — so `extension EventLoopFuture` was parsed as `extension AND
  EventLoopFuture anywhere in the file`, never `the literal phrase
  extension EventLoopFuture`.
- `findDeclarationsBySymbol` existed in `lib/graph.js` with a comment
  claiming "the hook fast path calls BOTH this and findExportsBySymbol"
  — aspirational; nothing actually called it from anywhere.
- The Swift-decl injection (added mid-session in `089f986`) had a latent
  bug where the targeted rg re-search used the full multi-token query
  instead of the matched symbol, silently dropping canonical files when
  their content didn't contain the literal phrase.
- `merge-results.js:fileTypePenalty` had a long-standing bug where it
  checked `p.includes("/test/")` (singular) and missed Swift's `/Tests/`
  (plural) directories entirely.

Each layer of fix exposed the next; this handoff documents the resulting
state in one place.

## Headline numbers

| Surface | Before this session | After |
|---|---|---|
| Vapor 4.121.4 MRR | 0.591 | **0.811** (+0.220) |
| Vapor 4.121.4 nDCG | 0.604 | **0.800** (+0.196) |
| Vapor `vapor-app-001 'Application'` rank | 5 | **1** |
| Vapor `vapor-req-001 'Request'` rank | not in top-10 | **1** |
| Vapor `vapor-resp-001 'Response'` rank | not in top-10 | **1** |
| Vapor `vapor-ext-001 'extension Application'` rank | not in top-30 | **1** |
| Vapor `vapor-uri-001 'URI'` rank | not in top-10 | **1** |
| Vapor `vapor-elf-001 'extension EventLoopFuture'` rank | not in top-10 (after backend flip) | **2** |
| Sextant self-eval MRR | 0.925 (rg-only path) | 0.908 (auto+real measurement) |
| Sextant self-eval pass rate | 20/20 (smaller fixture) | **21/21** (added scope-004) |
| Synthetic Swift fixture | 13/13 | **13/13** (no regression) |
| Mixed-language fixture | 7/7 | **7/7** (no regression) |
| Unit tests | 591 / 583 pass / 8 skip | **612 / 604 pass / 8 skip** |
| Hook fast-path probe (`URI` on Vapor) | URI.swift not in graph-retrieve output | **URI.swift in top results** |

## What this work actually does

### 1. Classifier — drain conversational status inquiries (`78e983a`)

Extended `SKIP_TERMS` in `lib/classifier.js` with conversational
workspace referents (`project`, `projects`, `codebase`, `status`) and
common English contractions (`what's`, `how's`, `where's`, etc.).
Probed cases that now correctly skip retrieval:
- `"how is this project coming along?"` → terms drain to `[]` → static
  summary fallback
- `"what's the status"` → same
- `"how's it going"` → same
- `"how is the project going"` → same

Code-relevant queries that mention `project`/`status` still retrieve via
their stronger signals (path / identifier / tech-question + concrete
target). New eval fixture `scope-004 statusline` locks in that
non-JS canonical files like `scripts/statusline-command.sh` surface in
the top-5 for the bare term query.

### 2. Eval-vs-production alignment (`5b0daa1`)

Changed `scripts/eval-retrieve.js:baseOpts.backend` from `"rg"` to
`"auto"`. The eval harness now measures the same code path production
hooks and the MCP server actually take. Pinning to `"rg"` was measuring
an inferior code path — common-name def lookups in multi-thousand-file
Swift repos came out at MRR 0.20 because rg's text-frequency ranking
buries the canonical class def behind higher-fan-in consumer files.

Added `lib/zoekt.js:quoteIfPhrase` to handle two zoekt-specific
divergences from rg's `-F` literal-substring semantics:
- **Multi-token queries** wrapped in double quotes so `"protocol
  Middleware"` matches the literal substring instead of AND'ing the
  words as independent clauses.
- **Regex metacharacters escaped** so `View+Toolbar` doesn't get parsed
  as `View(+Toolbar)` regex (one-or-more) — caught silently regressing
  the synthetic Swift fixture's `swift-ext-001` to 0 hits.

### 3. Swift-decl injection wired into both code paths (`089f986`, `0b21076`)

The dead function `lib/graph.js:findDeclarationsBySymbol` got two
callers:

- **CLI / MCP path** (`lib/retrieve.js`): A new shared `injectGraphMatches`
  helper drives both export-graph injection (JS/TS/Python via `exports`
  table) and swift-decl injection (Swift via `swift_declarations`). The
  helper re-searches each injected file using the *matched symbol* (the
  term that triggered the row), not the full original query. Earlier
  code passed the full multi-token query (e.g. `extension Application`)
  which silently dropped canonical files when their content didn't
  contain the literal phrase (`Application.swift` has `class
  Application`, not `extension Application`).

  Authoritative Swift type kinds (struct/class/protocol/enum/actor/
  typealias) get a hit-score floor of `SWIFT_DECL_TYPE_INJECT_SCORE = 600`
  so they compete with zoekt-sourced hits at base ~500. Without the
  floor, injected `Application.swift` enters the result set but ranks
  30th of 31 because rg.searchInFiles returns score=null hits that base
  out at 1 in `computeAdjustedHitScore`.

- **Hook fast path** (`lib/graph-retrieve.js`): Layer 2 calls
  `findDeclarationsBySymbol` per term. Pure in-memory graph query, no
  rg subprocess — fits the <50ms hook budget. Type kinds get score 100
  (`GR_SWIFT_DECL_TYPE`, == `GR_EXPORTED_SYMBOL`); other kinds get 80
  (`GR_SWIFT_DECL_OTHER`, == `GR_REEXPORT_CHAIN`). `swift_decl_type`
  joins the existing definition-site suppression set so test-file fan-in
  doesn't outrank the canonical type def.

### 4. Test-path penalty extended to Swift conventions (`0b21076`)

Both `lib/merge-results.js:fileTypePenalty` (hook merge) and
`lib/retrieve.js:isTestPath` (CLI/MCP) now catch:
- `(^|/)XCT\w+/` — Apple's XCTest framework convention (`XCTVapor`,
  `XCTAssertions`).
- `(^|/)\w+Testing/` — Swift Testing framework convention
  (`VaporTesting`).

`merge-results.js` previously checked only `/test/` (singular) — silently
missed Swift's `/Tests/` (plural) directories entirely. Replaced the
hand-written `.includes()` check with the same regex
`/(^|\/)(__tests__|__test__|tests?|specs?)\//i` that `retrieve.js`
already used.

`merge-results.js:lineLevelAdjustment` def_site_priority match made
case-sensitive. Consumer lines like Swift's `let uri = URI(...)` were
extracting `uri` (the variable being declared) as a def symbol and
matching it against query `URI` via lowercased comparison — treating
the variable declaration as a type-def site. Case-sensitive correctly
distinguishes `uri` (variable) from `URI` (type). The cost is users who
type a query in mismatched case ("rerankfiles" instead of "rerankFiles")
miss the def-site bonus — small in practice since identifier shape
detection already nudges users toward correct casing.

## Ship blockers — NONE

Everything that needed to land for the headline numbers landed.

## Acceptable debt (deliberate scope cuts)

Read these before extending — they're known gaps, not bugs.

### 1. `vapor-init-001 'public init'` still rank 0

`init` matches 182 declarations across Vapor; the query carries no
signal to disambiguate. The expected canonical file (Application.swift)
is one of dozens of `public init` candidates. Fixing this needs either
keyword-aware semantics (interpret `public init` as "show me the most
prominent type's constructor") or a richer query DSL.

**Why we punted**: Out of measurement-supported scope. Would need a
new fixture class — currently no eval case exercises a fix that doesn't
also regress something else.

### 2. ~~Hook merge layer false-promotes consumer files via lowercase queryTerms~~ — CLOSED 2026-05-04

**Resolved by the lowercase-pathway fix** that drops the upstream
`.toLowerCase()` at `lib/merge-results.js:120` and adds an opt-in
`{ caseSensitive: true }` flag on `scoring.computeEnhancedSignals` that
the hook merge layer passes through. CLI/MCP path keeps the default
case-insensitive behavior unchanged.

**What was actually fixed**: The bug was structurally worse than the
original entry described — `merge-results.js:99`'s case-sensitive
def-site guard was DEAD CODE because line 120 already lowercased the
input. So `String("uri") === "URI"` was always false: the +25% def-site
boost actually fired on consumer files (where extractSymbolDef returns
the local var "uri") and never on canonical type defs (where it returns
"URI"). The Swift consumer line `let uri = URI(...)` inherited a +25%
def-site + +40% exact-symbol + +12% contains = +77% boost it didn't
deserve.

**Measured impact**: On Vapor 4.121.4 query "URI", `URITests.swift`'s
fused score dropped from ~872 to 526 (a 40% reduction in the bug's
inflation). Pinned by new tests in `test/merge-results.test.js`
("mergeResults — case-sensitive symbol matching (Swift bug-2)") and
`test/scoring.test.js` ("computeEnhancedSignals — caseSensitive option").

**Residual gap surfaced by closing this**: `Sources/Vapor/Utilities/URI.swift`
is now at rank 2 (up from "top 7" in the prior handoff). The rank-1
flip is blocked by a separate issue, NOT the lowercase bug — zoekt's
30-hit budget is consumed entirely by URITests.swift's text-frequency
matches on "URI", so URI.swift never enters the zoekt result set and
gets only its graph score (140) with no zoekt fusion. See acceptable
debt #4 below for the path forward.

**Hook regression now gated**: Before this fix, `bash scripts/eval-swift-external.sh diff`
only exercised the CLI path. A `vapor-hook-baseline.json` is now
committed and `diff` mode runs both CLI and hook comparators. Future
case-sensitivity drift fails the gate.

### 3. Hook output and CLI/MCP output differ for Swift queries

By design — `lib/graph-retrieve.js` (hook) and `lib/retrieve.js`
(CLI/MCP) are different code paths with different rerank pipelines. The
hook can't afford rg.searchInFiles subprocesses (<50ms budget); the
CLI/MCP can. The Swift-decl injection in CLI/MCP gives canonical files
a 600-point hit-score floor; the hook gives them a 100-point graph
score that's then merged with zoekt's ~500 baseline. After merge with
fan-in suppression, the hook output favors high-text-frequency files
more than the CLI does.

**Why we punted**: Aligning them requires either (a) giving the hook
its own subprocess budget (architectural change, breaks 200ms guarantee)
or (b) a much higher hook-side base score for Swift-decl matches that
risks crowding out other useful results. Either is a larger commit.

### 4. URI.swift at hook rank 2, blocked by zoekt text-frequency myopia

Surfaced by closing acceptable debt #2 (above). Even with the
false-firing pathway eliminated, `Sources/Vapor/Utilities/URI.swift`
ranks below `Tests/VaporTests/URITests.swift` in production hook output
because zoekt's per-line top-30 hits for query "URI" are entirely
consumed by URITests.swift (URI appears dozens of times in that test
file: `URITests`, `URI.Scheme`, `URI.Host`, etc.). URI.swift never
enters the zoekt result set, so the merge layer can only score it
from the graph (`swift_decl_type` → 100 * 1.4 = 140 points). After
test-penalty math, URITests fused = 526 vs URI.swift fused = 140.

**Possible fixes (own commits, not bundled)**:

1. **Graph-canonical authority bump**: when a file has
   `graphSignal in {swift_decl_type, exported_symbol}` AND no zoekt
   hit, treat the graph match as a phantom def-line zoekt hit. The
   graph KNOWS it's the canonical def; the merge layer can synthesize
   a competitive zoekt score so `Sources/.../URI.swift` outranks a
   zoekt-saturated test file. ~10 lines in `lib/merge-results.js`.
   Risk: needs eval validation that the bump doesn't crowd out
   high-quality zoekt hits in JS/Python paths.

2. **Hook-side rg injection** (related to acceptable debt #3 above —
   hook subprocess budget). Mirrors the CLI path's `injectGraphMatches`
   helper that uses rg to find the canonical def line when zoekt
   misses. Gives the hook the same 600-point hit-score floor. Trade-off:
   every prompt pays the rg subprocess cost (~50-150ms), challenging
   the 200ms hook budget.

Option 1 is smaller and stays within budget; option 2 fully aligns
hook with CLI quality. Defer until a user reports the rank-2 placement
is causing real misorientation — eval gate catches regressions either
way.

### 5. The Vapor baseline numbers depend on zoekt being installed

`scripts/eval-swift-external.sh` runs `node bin/intel.js scan` which
auto-builds the zoekt index when the binary is on PATH. In environments
without zoekt installed, the eval falls back to the `pickBackend()` rg
path, regenerating different (lower) numbers. The committed
`fixtures/vapor-baseline.json` was captured with zoekt installed — if
CI ever runs without zoekt, the diff comparator will flag a regression
that isn't a regression.

**Mitigation**: Document the dependency. Long-term, consider gating
the Vapor benchmark on `zoekt.isInstalled()` returning true, with a
clear skip message.

## Verification commands

For a successor to confirm clean state in 60 seconds:

```bash
cd /root/sextant
git log --oneline -5                                                                                       # 0b21076 at top, plus retrieval + bug-2 commits
npm run test:unit                                                                                          # 614 pass, 8 skipped, 0 fail
npm run test:eval                                                                                          # 21/21 self-eval, MRR 0.908, nDCG 0.916
node scripts/eval-retrieve.js --dataset fixtures/swift-eval/eval-dataset.json --root fixtures/swift-eval   # 13/13 synthetic Swift
node scripts/eval-retrieve.js --dataset fixtures/mixed-eval/eval-dataset.json --root fixtures/mixed-eval   # 7/7 mixed-language
bash scripts/eval-swift-external.sh diff                                                                   # CLI 15/15 (MRR 0.811) + hook 13/15 (MRR 0.689)
```

`bash scripts/eval-swift-external.sh diff` now runs BOTH the CLI path
(`fixtures/vapor-baseline.json`) and the hook fast path
(`fixtures/vapor-hook-baseline.json`) comparators. Each prints PASS/FAIL
independently and the script exits non-zero if either fails.

End-to-end hook fast-path probe (proves the swift-decl wiring works in
production, not just in eval):

```bash
printf '{"prompt":"URI","cwd":"/tmp/vapor-eval","session_id":"probe"}' | (cd /tmp/vapor-eval && node /root/sextant/bin/intel.js hook refresh)
# Should emit a <codebase-retrieval> block with Sources/Vapor/Utilities/URI.swift
# in the top results.
```

Direct probe of the new graph-retrieve Swift-decl layer:

```bash
node -e "
(async () => {
  const graph = require('./lib/graph');
  const { graphRetrieve } = require('./lib/graph-retrieve');
  const db = await graph.loadDb('/tmp/vapor-eval');
  for (const t of [['URI'], ['Application'], ['Middleware']]) {
    const r = graphRetrieve(db, t, { maxResults: 3 });
    console.log(t, '→', r.files.map(f => f.path + ' [' + f.hitType + ']'));
  }
})();
"
# Each should have the canonical .swift file at rank 1 with hitType swift_decl_type.
```

## Risk surfaces (where it could break)

1. **Swift-decl hit-score floor of 600**. Picked to compete with
   zoekt-sourced hits at base ~500. If zoekt internals change and base
   scores shift to e.g. 1000, the floor stops winning. Tracked
   loosely — the eval will surface regressions if it happens. Located
   at `lib/retrieve.js:SWIFT_DECL_TYPE_INJECT_SCORE`.

2. **`injectGraphMatches` shared helper** now serves both export-graph
   (JS/TS/Python) and swift-decl injection. A bug in the helper hits
   both paths. The helper has no direct unit tests (it's exercised
   integration-style via the eval harness). If the path-grouping logic
   gets touched, re-run all four eval suites.

3. **Vapor baseline is now backend-sensitive**. `auto+quoted+swift-decl`
   numbers are committed; if the next agent disables any of those
   features (e.g. for an experimental run) without a corresponding
   baseline regen, `bash scripts/eval-swift-external.sh diff` will
   report regressions that aren't regressions. The compare gate's
   "top-3 retention" check is especially fragile — strictly-better
   top-3s where test files drop OUT also fail the gate (we hit this in
   the session, hence the regen-after-each-improvement workflow).

4. **`hasIdentifierShape` lowercase contractions** in
   `lib/classifier.js` (`what's`, `how's`, etc.) intentionally don't
   handle apostrophe variants like `whats` (no apostrophe) or
   `What's` (capitalized). The SKIP_TERMS lookup is case-insensitive
   for the LHS but the contractions list is canonical-form-only. A user
   typing `Whats the status` would see different classification behavior
   than `what's the status`. Edge case; not observed in practice.

5. **Test-path regex extension is path-content-only**. A directory named
   `XCTSomething/` is treated as test infrastructure even if it's a
   legitimate library. Conservative — looking at known Swift codebases
   (Vapor, Hummingbird, swift-nio), this convention is universal for
   test-only code. If a user's repo violates the convention, they can
   override via... actually they can't right now. There's no escape
   hatch. Worth noting but probably fine.

## Test coverage map

| Test file | What it locks in |
|---|---|
| `test/zoekt-query.test.js` | quoteIfPhrase: multi-token quoting + regex metacharacter escape (9 cases) |
| `test/graph-retrieve.test.js` | Swift-decl Layer 2: type-vs-extension scoring, suppression integration, MIN_TERM_LENGTH respect (5 new cases on top of existing 28) |
| `test/classifier.test.js` | Conversational status inquiries skip; legitimate code questions still retrieve (7 new cases on top of existing 80) |
| `scripts/eval-dataset.json:scope-004` | Non-JS canonical file (statusline.sh) surfaces in top-5 for bare term query |
| `fixtures/vapor-baseline.json` | Vapor 4.121.4 ground truth: MRR 0.811, nDCG 0.800 with `auto+quoted+swift-decl` backend |

## Files touched (4 commits across this session)

```
lib/classifier.js            — SKIP_TERMS expansion (78e983a)
lib/zoekt.js                 — quoteIfPhrase + regex escape (5b0daa1, 089f986)
lib/retrieve.js              — backend "auto" + multi-token injection bugfix + helper extraction (5b0daa1, 089f986, 0b21076)
lib/graph-retrieve.js        — Layer 2 swift-decl wiring + suppression set extension (0b21076)
lib/merge-results.js         — XCT/Tests test-path patterns + case-sensitive def_site (0b21076)
lib/scoring-constants.js     — GR_SWIFT_DECL_TYPE/_OTHER, HIT_SWIFT_DECL_TYPE/_OTHER (0b21076)
scripts/eval-dataset.json    — scope-004 fixture (78e983a)
scripts/eval-retrieve.js     — backend "rg" → "auto" (5b0daa1)
fixtures/vapor-baseline.json — regenerated three times (5b0daa1, 089f986, 0b21076)
test/zoekt-query.test.js     — new file, 9 cases (5b0daa1, extended in 089f986)
test/classifier.test.js      — 7 new conversational-status cases (78e983a)
test/graph-retrieve.test.js  — 5 new swift-decl Layer 2 cases (0b21076)
CLAUDE.md, README.md         — eval numbers + scoring rationale (every commit)
README.dev.md                — eval count drift (5b0daa1)
```

Plus one independent commit on `main` from another session:
`da1fbaa test(watcher): make stale heartbeat test portable`.

## Things not done that you might think are done

- **No README.dev.md update for the helper extraction.** README.dev.md
  doesn't enumerate internal helpers; the new `injectGraphMatches` is
  an internal refactor. CLAUDE.md captures the rationale.
- **No reflect skill invocation.** PostToolUse hook reminds about
  `/reflect` after each commit; not run because the user didn't ask.
  Worth running once to capture session-level learnings into
  docs/solutions/ if you want them indexed.
- **No CHANGELOG entry.** Convention in this repo is sparse on
  changelog updates per-feature; matched what was here. Still skipped.
- **No removal of `compound-engineering.local.md` or
  `docs/swift-v1-handoff.md` (untracked).** Both pre-existed this
  session and aren't mine to touch.

## Open questions for the next agent

1. **Should the merge-layer false-promotion (acceptable debt #2) get
   priority?** Symptom is hook output ranks `URITests.swift` above
   `URI.swift` for the bare query `URI`. CLI/MCP output is fine. The
   user primarily uses SwiftUI and the hook is what they see most often
   — so this is the next-most-impactful fix. Estimated effort: medium
   (need to thread case-aware queryTerms through merge-results +
   computeEnhancedSignals without breaking JS lookups).

2. **Does `vapor-init-001 'public init'` deserve a fixture-level
   solution?** Could rewrite the eval case to expect the top-N most
   prominent type's init rather than a single canonical answer.
   Doesn't fix the underlying ambiguity but stops it from being a
   permanent 0 in the baseline. Or accept it as a permanent
   limitation and document.

3. **Should the hook get its own subprocess budget?** Acceptable debt
   #3 — the architectural reason hook output diverges from CLI is the
   <50ms budget. If we can find an additional 100ms (e.g. by running
   the swift-decl rg.searchInFiles in parallel with zoekt), the hook
   could match CLI quality. Trade-off: every prompt pays the cost.

4. **Vapor baseline's zoekt dependency** (acceptable debt #4) — gate
   `bash scripts/eval-swift-external.sh diff` on `zoekt.isInstalled()`
   so it doesn't false-fail when zoekt is missing? Not blocking, but
   defensive.

---

**Last verification before this doc was written**: live `bash
scripts/eval-swift-external.sh diff` on `/root/sextant` reports
`PASS: no regressions vs baseline` with `meanMRR=0.8111
meanNDCG=0.7997`. Synthetic + mixed evals 13/13 + 7/7. Sextant
self-eval 21/21. 604/612 unit tests. Hook fast-path probe verified:
`URI.swift` appears in `<codebase-retrieval>` output for query "URI"
on Vapor. Next session can pick up clean.
