---
title: "feat: Swift parser diagnostics — observability + partial-parse honesty"
type: feat
status: draft
date: 2026-05-30
origin: field report — dogfooding on mapSingleFile (iOS/SwiftUI repo), 7/42 Swift files reported parser errors
verified_against: vendor/tree-sitter-swift.wasm @ 0.7.1-pypi (the currently shipped grammar)
---

# feat: Swift parser diagnostics — observability + partial-parse honesty

> **Status: draft / decision aid.** This document was produced under a
> "validate the field report + write a plan, no code changes" instruction.
> Nothing here is implemented or approved. The tier ordering is a
> recommendation; each tier is independently shippable. The single
> highest-leverage move (Tier 0) is also the cheapest — read that first.

## Overview

A field report from running `sextant rescan --force` on a real iOS/SwiftUI
repo (`mapSingleFile`, 42 Swift files) flagged **7 files with tree-sitter
parse errors** while `xcrun swiftc -parse` accepted all 7. The report
concluded: sextant's index is structurally healthy, but its Swift parser
emits partial-failure signals that (a) are real tree-sitter limitations, not
source defects, and (b) are surfaced only as an opaque aggregate count, with
no way for a user or agent to tell parser-limitation from genuine syntax error.

This plan responds to the **verified subset** of that report. It does three
things: corrects two inaccuracies in the report, adds a grammar-upgrade path
the report missed, and scopes the observability work to fit sextant's
philosophy (orientation > intelligence, degrade don't guess, **drift must be
loud**) without adding the Swift-toolchain dependency the report's #4/#9
recommendations would require.

## What was verified (and what the report got wrong)

Every claim below was checked by directly loading the **vendored
`tree-sitter-swift.wasm` 0.7.1** and parsing minimal reproductions, plus
reading the extraction/persistence code. This is not an echo of the report.

| Report claim | Verdict | Evidence |
|---|---|---|
| tree-sitter fails on `#if`/`#elseif`/`#else`/`#endif` (not source-invalid) | **CONFIRMED — dominant cause (4/7 files)** | `#if RELEASE_REAL…#endif`, `#if canImport(UIKit)`, and `#if DEBUG` inside a func body all produce `ERROR` nodes at the directive lines. 100% reproducible. |
| `send(())` empty tuple fails | **CONFIRMED** | `subject.send(())` → `MISSING` node at the inner `()`. Exactly the "MISSING !" the report observed. |
| raw string / regex literal `#"…"#` fails | **CONFIRMED, but FLAKY — correction** | `#"hello \d world"#` → `ERROR` at the `#` delimiters, but `#"(?i)^topic\s*[:]\s*"#` parsed **clean**. Handling is inconsistent across raw-string forms, not a blanket failure. The report presented this as a uniform failure; it is not. |
| sextant surfaces only an aggregate count, no per-file detail | **CONFIRMED** | `doctor.js`/`health.js` print only `files with errors: N`. |
| no per-file diagnostics persisted | **CONFIRMED** | `swift.js:305-318` bumps `counters.filesParseErrors` then immediately `tree.delete()`s — path/line/col/error-node context is never captured. Only 4 aggregate counters reach `meta`. |
| these files are "errors" | **OVERSTATED — correction** | In every failing case the tree is still partially walkable (`root.namedChildCount > 0`); `walkTopLevel` still extracts declarations. The report itself noted decl rows exist for all 42 files. The honest label is **"partial parse — declarations still extracted; blast-radius inside the directive block degraded,"** not "error." |

**Two report recommendations rejected up front** (philosophy conflict,
confirmed with the user):
- #4 `sextant doctor --swift-validate` running `xcrun swiftc -parse`, and
- #9 adopting SwiftSyntax / compiler-backed fallback

both require a Swift toolchain, which `CLAUDE.md`'s "What NOT to add"
explicitly bans: *"Compiler-backed Swift semantics… would require a Swift
toolchain dependency."* Pure-JS classification (Tier A) recovers most of the
triage value without the dependency.

## The fact that reshapes the plan: a grammar upgrade is nearly free

The report framed this as "improve tree-sitter integration or accept the
limitation." It missed that **upstream already fixed part of it.**

`alex-pinkus/tree-sitter-swift` **0.7.2-pypi** (released 2026-05-04) ships a
`.wasm` artifact, is **ABI version 15 — identical to the vendored 0.7.1** —
and loads cleanly with sextant's `web-tree-sitter` 0.26.8 via the exact
`Parser.init()` + `Language.load()` path `swift.js` already uses (directly
verified). It is a drop-in replacement.

What 0.7.2 fixes vs. what it leaves (all verified by parsing both WASMs):

| Pattern | 0.7.1 (vendored) | 0.7.2 (available) | HEAD `main` (no WASM released) |
|---|---|---|---|
| raw strings `#"…\d…"#` | FAIL | **FIXED** | FIXED |
| `#if canImport(UIKit)` top-level | FAIL | **FIXED** | FIXED |
| `#if DEBUG` in function body | FAIL | **FIXED** | FIXED |
| `#if` between enum cases / class members | FAIL | still FAIL | FIXED via PR #583 (merged 2026-05-26, **22 days after 0.7.2**) — needs a self-built WASM (tree-sitter CLI + Emscripten) |
| `send(())` empty tuple | FAIL | still FAIL | still FAIL (no issue filed) |
| `nonisolated(unsafe)` modifier | FAIL | still FAIL | FIXED via PR #582 (also post-0.7.2, no WASM) |

So an upgrade to 0.7.2 likely clears the 2 raw-string files and the
top-level/function-body conditional-compilation cases outright, leaving only
the enum/class-member `#if` nesting and the niche `send(())` for Tier B. The
grammar upgrade and Tier B are **complementary, not substitutes** — PR #583
itself notes residual zero-width `ERROR` nodes inside enum bodies even after
its fix.

## Recommended sequencing

```
Tier 0  Bump vendored WASM 0.7.1 → 0.7.2        cheapest, clears raw-strings + simple #if
Tier A  Observability (sidecar, no schema)      makes the *remaining* partials honest & loud
Tier B  Blank-pad #if pre-strip (fixture-gated) clears the enum/class-member residual
```

Tier 0 is the highest ROI/effort. Tier A is the philosophy-core fix ("drift
must be loud") and is valuable regardless of Tier 0 because `send(())`,
enum-member `#if`, and future Swift syntax will always leave *some* residual.
Tier B is the largest and should not ship without the committed fixture
(below). None depends on the others.

---

## Tier 0 — Upgrade the vendored grammar to 0.7.2

**Change:** replace `vendor/tree-sitter-swift.wasm` with the 0.7.2-pypi
artifact; update `vendor/README.md` version line; bump `SCANNER_VERSION`
in `lib/freshness.js` (per the vendor README's own update procedure, because
extractor output changes between grammar versions).

**Cost — state honestly:** bumping `SCANNER_VERSION` ("2" → "3") marks every
existing repo's graph stale via the freshness gate, triggering **one
forced async rescan per repo** — including pure-JS repos, since
`SCANNER_VERSION` is global, not per-language. This is a one-time cost the
freshness gate is designed to absorb (atomic single-flight, `--allow-concurrent`),
but it is real and should land deliberately, not by accident.

**Verification (mandatory before shipping):**
1. `npm run test:eval` — self-eval must stay 21/21, `graphLiftNDCG` must not
   regress.
2. `bash scripts/eval-swift-external.sh diff` (warm the index first — cold
   zoekt flakes the first run, per `project_eval_swift_external_cold_zoekt_flake`)
   — the committed Vapor positive-lift target (+0.086 nDCG) must hold.
3. Re-run the new conditional-compilation fixture (below) and confirm the
   raw-string + top-level-`#if` cases flip from `hasError=true` to clean.

**Kill criterion:** if 0.7.2 regresses any existing decl/relation extraction
on the self-eval or Vapor corpora (e.g., a grammar node renamed and the walker
in `swift.js` keyed on the old name), do **not** ship the bump — pin to 0.7.1
and rely on Tier A + Tier B instead. The walker reads named fields
(`declaration_kind`, `name`, `inheritance_specifier`); a same-ABI minor bump
is low-risk but not zero-risk.

---

## Tier A — Per-file diagnostics, surfaced and honestly labeled

This is the philosophy-core response to the report. Today degradation is
**silent at file granularity** — a file with half its declarations inside
`#if canImport(UIKit)` drops those symbols with no signal a user can act on.

### A1. Capture, don't discard (the one no-risk prerequisite)

In `swift.js:extractDeclarations`, when `root.hasError` fires, walk the tree
for `ERROR`/`MISSING` nodes and collect `{ startLine, startCol, text-prefix }`
**before** `tree.delete()`. Accumulate per-file into a module-level structure
flushed by `intel.js` alongside the existing counters (same lifecycle as
`resetCounters`/`getCounters`). Zero schema impact, zero user-visible change,
no behavior change — it just stops throwing away information sextant already
has. Every downstream option depends on this; it is independently safe to land.

### A2. Persist as a scan-time sidecar, NOT a new table

The original plan proposed a `swift_parse_diagnostics` table. **Rejected** on
independent review, for a reason that holds up: per-file parse diagnostics are
**scan-time ephemeral** — true as of the last scan, stale the moment a file is
edited. They are never joined relationally against declarations. A new table
would bump `SCHEMA_VERSION` and force a rescan on all users (including pure-JS
repos) to carry Swift-only ephemeral data.

Instead: write `.planning/intel/swift_parse_issues.json`, overwritten each
scan, read by `doctor` if present. This matches sextant's existing sidecar
pattern (`.watcher_last_file`, `.scan_in_progress`, `.rescan_pending`),
costs **zero schema version**, and is equally informative for the only
consumer (`doctor`). If a future feature genuinely needs relational queries
over diagnostics, promote to a table then — not speculatively now (YAGNI).

> Note: if Tier 0 ships, a rescan is already forced once. Tier A's sidecar
> still avoids an *additional* schema-driven rescan and avoids coupling Swift
> diagnostics to the freshness gate.

### A3. Whitelist classification with an explicit fallthrough — the safety-critical part

**This is the highest-risk part of the whole proposal and must be designed
defensively.** The danger: a developer introduces a *genuine* syntax error;
the file now has `ERROR` nodes; if sextant blanket-labels it "partial parse —
known tree-sitter limitation, declarations still extracted," the user learns
to ignore parse warnings and the real bug goes invisible. That would invert
"drift must be loud" into "drift is silently excused."

The classifier must be a **whitelist with a labeled remainder**, never an
exhaustive "everything is a known limitation":

- `ERROR` node text starts with `#if`/`#elseif`/`#else`/`#endif` →
  **`conditional_compilation`** — 100% reliable; these tokens have no other
  meaning in Swift.
- `ERROR` node sits at a raw-string delimiter (`#"` / `"#`) →
  **`raw_string_literal`** — classify on the **error-node text, not file
  content**, because clean raw strings exist and must never be labeled
  (the flakiness correction above). A file with raw strings that parses fine
  gets no label.
- `MISSING` node adjacent to `(())` → **`empty_tuple`** — harmless, low ROI,
  include only if cheap.
- **anything else → `unrecognized` →** surfaced with distinct, louder wording:
  *"parse error (unrecognized — may indicate a real syntax error; verify the
  file compiles)."* This bucket is the safety net.

**Secondary guard:** a file with `ERROR` nodes **and zero extracted
declarations** is a strong signal of a real error (partial parses normally
still yield declarations). Flag such files as probable-real regardless of
pattern match.

### A4. Surface in `doctor` (fold in; no new command)

Extend the existing "Swift health" block in `commands/doctor.js`. The report's
#5 (`sextant diagnose swift`) is **rejected** — a separate command is
unnecessary surface area; `doctor` is already the triage home and prints an
exhaustive Actions block. Show, per file:

```
Swift health
  parser              ok
  files seen          42
  files parsed ok     35 (83%)
  partial parses      7   (declarations still extracted)
    Data/Models/NewsAndFIRMSModels.swift:69     raw_string_literal
    Data/Providers/ProviderModePolicy.swift:10  conditional_compilation
    …
    SomeFile.swift:120                          unrecognized — may be a real syntax error
```

Wording is load-bearing: **"partial parses"** for the matched/benign set,
the explicit **"may be a real syntax error"** string only on the
`unrecognized` bucket.

### A5. Honest note in the injected summary

The injected `<codebase-intelligence>` summary is consumed by the agent. When
partial parses exist, add one line so the agent doesn't assume full Swift
semantic confidence: *"Swift extraction partial: N/42 files hit parser limits
(declarations still indexed); see `sextant doctor`."* This is the report's #8
and it is well-aligned — cheap, honest, "drift must be loud."

**Tier A kill criterion:** if real-world `doctor` output shows the
`unrecognized` bucket firing frequently on healthy files (i.e., the whitelist
is too narrow and most ERROR shapes fall through), the taxonomy is wrong —
widen the whitelist from observed shapes rather than relabeling `unrecognized`
as benign. Never make `unrecognized` quiet to reduce noise.

---

## Tier B — Blank-pad `#if` pre-strip (reduce the residual count)

Goal: make conditional-compilation files that even 0.7.2/HEAD can't fully
parse (enum-case / class-member `#if`) parse clean, by neutralizing directive
lines before handing source to tree-sitter.

### Feasibility verdict: SAFE-WITH-MITIGATION

Independent feasibility analysis against the span-keyed model returned a clear
verdict with one **non-negotiable** constraint.

**Mandatory mitigation — blank-pad, never truncate.** Replace each directive
line (`#if`/`#elseif`/`#else`/`#endif`) with an **equal-length run of spaces**
before `parser.parse()`. tree-sitter then sees valid Swift with extra
whitespace, and — critically — every declaration's `node.startIndex/endIndex`
**still matches the original on-disk file byte-for-byte.**

> Why truncation is a hard NO: `swift_declarations` is span-keyed
> `(path, start_byte, end_byte)`, and `swift_relations` stores
> `source_start_byte/end_byte`. Removing directive lines shifts every offset
> below the first directive, corrupting the PK and the byte offsets
> `mcp/server.js:sextant_explain` returns to clients. Retrieval *ranking*
> survives (the pipeline keys on `path`/`kind`, not offsets), but the stored
> data becomes semantically wrong and any future excerpt-extraction feature
> would silently slice the wrong bytes. Blank-pad avoids all of this.

**Consistency requirement:** apply the blank-pad on **every** parse entry
point — `extractDeclarations`, `extractRelations`, `extractImports` — so
stored spans agree across tables and across scan vs. watcher-incremental runs.

### Accepted, documented tradeoffs (not blockers)

- **Duplicate declarations across branches.** `#if`/`#else` declaring the same
  symbol twice yields two rows with *different* spans → no PK collision, and
  **fan-in is unaffected** (fan-in comes from the `imports` table, not decl
  row counts). Symptom is cosmetic: a marginally inflated declaration count and
  two entries in `sextant explain`. For orientation this is a safe
  over-approximation ("this file touches both `UIView` and `NSView`"). Accept;
  optionally dedup in the display path only.
- **Nested `#if`** is handled automatically — line-level stripping is naturally
  recursive (strip directive lines, keep body lines, regardless of depth).
- **`#if` inside string literals / comments** is neutralized by blank-pad
  (tree-sitter sees same-length opaque tokens; AST and offsets unaffected).
- **Single-line `#if DEBUG; struct X {}; #endif`** (semicolon form) would
  silently drop that declaration. Low-frequency; document as known v1 debt and
  optionally note in the `doctor` parse context.

### Tier B prerequisite: a committed fixture (currently zero exist)

**The single most important test-surface fact:** grep confirms **zero
committed Swift fixtures contain `#if`.** Sextant's entire eval/test harness
(self-eval JS + Vapor Swift) has *never* exercised conditional compilation —
which is exactly why this whole failure mode shipped invisibly. Of the 15
Vapor baseline targets, only `URI.swift` contains a `#if`, and it's a
method-body `#if canImport(Darwin)` 99 lines *after* the `struct URI`
declaration — so the declaration itself is not gated and the failure never
surfaces in a ranking. (The genuinely declaration-gated Vapor files —
`BasicCodingKey.swift`, `VaporSendableMetadataType.swift` — are not query
targets.)

Tier B must not ship without a committed fixture that locks both directions.
Proposed minimal fixture under `fixtures/swift-eval/Sources/Conditional/`:

```swift
// PlatformTypes.swift — conditional-compilation fixture.
// 0.7.1: root.hasError == true.  Tier-A: PlatformConfig must still index +
// be classified conditional_compilation.  Tier-B: after blank-pad strip,
// hasError == false and BOTH PlatformString variants index.
#if os(Linux)
public typealias PlatformString = String
#else
public typealias PlatformString = NSString
#endif

public struct PlatformConfig {
    public var debug: Bool
}
```

- **Tier-A guard** (eval case, e.g. `swift-cond-001`, query `PlatformConfig`):
  asserts the outside-the-directive declaration is still indexed and a
  diagnostic row/sidecar entry classifies the failure as
  `conditional_compilation`.
- **Tier-B guard** (unit test in `test/extractors/swift.test.js`): asserts the
  blank-padded source parses with `hasError === false` and indexes both
  `PlatformString` and `PlatformConfig`.

Keep `send(())` and the known-bad raw-string form as **unit tests only**
(assert `hasError` + classification), not fixture files — the raw-string
flakiness is WASM-version-dependent and would flake the eval after a Tier 0
bump.

**Tier B kill criterion:** if the blank-pad pass changes self-eval or Vapor
nDCG at all (it should be a no-op there — those corpora have no `#if`), the
strip is firing where it shouldn't (false match on `#if` in a string/comment
that wasn't blank-padded correctly). Halt and fix the matcher before shipping.

---

## Rejected approaches (and why)

| Approach | Decision | Reason |
|---|---|---|
| `xcrun swiftc -parse` cross-check (report #4) | **Reject** | Requires a Swift toolchain — banned by `CLAUDE.md` "What NOT to add." Pure-JS classification recovers most triage value. |
| SwiftSyntax / SourceKit fallback (report #9) | **Reject** | Same toolchain dependency; also crosses into compiler-backed semantics, explicitly out of Swift v1 scope (`docs/swift-v1-scope.md`). |
| New `swift_parse_diagnostics` table (original Tier A) | **Reject** | Diagnostics are scan-time ephemeral, never joined relationally; a table bumps `SCHEMA_VERSION` and forces a rescan on all users. Sidecar JSON is equivalent at zero schema cost. |
| Dedicated `sextant diagnose swift` command (report #5) | **Reject** | Unnecessary surface area; `doctor` is the established triage home. Fold in. |
| Truncating directive lines (Tier B) | **Reject** | Corrupts span-keyed PK and `sextant_explain` byte offsets for every decl below the first directive. Blank-pad is the only safe strategy. |
| Universal "reframe N errors as partial parses" | **Reject** | Would silently excuse genuine syntax errors. Must be whitelist-gated with a loud `unrecognized` fallthrough. |

## Open verification items (before any implementation)

```bash
# Confirm the 0.7.2 WASM loads + flips the failing cases (re-run the probe in /tmp).
curl -L -o /tmp/tss-0.7.2.wasm \
  https://github.com/alex-pinkus/tree-sitter-swift/releases/download/0.7.2-pypi/tree-sitter-swift.wasm

# Confirm whether the existing Vapor baseline silently touches a #if file
# (it does — URI.swift — but the declaration is not gated):
VAPOR_DIR=/tmp/vapor-eval VAPOR_SHA=4.121.4
git -C "$VAPOR_DIR" grep -n '#if' -- 'Sources/Vapor/Utilities/URI.swift'
# Survey files where a declaration is actually inside a directive block:
for f in $(grep -rl '^#if' "$VAPOR_DIR/Sources/Vapor/" 2>/dev/null); do
  fi=$(grep -n '^#if' "$f" | head -1 | cut -d: -f1)
  fp=$(grep -n '^public ' "$f" | head -1 | cut -d: -f1)
  [[ -n "$fp" && "$fi" -lt "$fp" ]] && echo "GATED: $f (#if $fi < public $fp)"
done
```

## Provenance & methodology

- Field report: `sextant rescan --force` on `mapSingleFile` (iOS/SwiftUI, 42
  Swift files), branch `codex/redevelopment-phase0-kickoff`. 7/42 partial
  parses; `swiftc -parse` accepted all 7.
- Verification: direct parse of the **vendored 0.7.1 WASM** against minimal
  reproductions of each reported pattern (conditional compilation in 3
  positions, raw strings ×2, empty tuple ×2, baseline sanity) — confirmed
  claim #1, corrected the raw-string-uniformity and "error vs partial"
  framings.
- Grammar-upgrade research: upstream releases/issues/PRs (0.7.2-pypi, #298,
  #300, #582, #583), ABI compatibility load-tested against web-tree-sitter
  0.26.8.
- Tier B feasibility + the under-reporting risk were derived by independent
  adversarial review against the span-keyed storage model, not taken from the
  field report.
