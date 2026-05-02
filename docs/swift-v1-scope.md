# Swift v1 — Scope and Limitations

Sextant's Swift extractor is **repo-local source orientation**, not SDK
or framework introspection. It produces a structural map of the Swift
source files in the indexed repository — top-level types, members one
nesting level deep, extensions, conformance and inheritance edges — and
nothing more. Querying "what conforms to `View`?" surfaces only repo-local
conformers; SwiftUI's `View` and Foundation's `Codable` are not
introspected because their definitions live outside the repo, in
`.swiftinterface` files Sextant does not read.

This framing is the same one the rest of Sextant operates under: orient,
don't claim semantic understanding. Swift v1 is a deliberately bounded
slice of that orientation.

## In scope

These work today and are exercised by `fixtures/swift-eval/` (synthetic, 13
cases) and `fixtures/vapor-eval-queries.json` (Vapor 4.121.4, 15 queries):

- **Top-level types**: `class`, `struct`, `enum`, `protocol`, `actor`,
  `typealias`. Each gets a row in `swift_declarations` keyed by
  `(path, start_byte, end_byte)`.
- **Members one nesting level deep**: methods, computed/stored properties,
  enum cases, init / deinit / subscript, associated types, nested typealiases.
  Recorded with `parent_name` set to the enclosing type.
- **Extensions**, including the same type extended in multiple files. Each
  extension is a distinct row, identified by its byte span. Multi-file
  extension identity is verified by `fixtures/swift-eval/Sources/UI/View.swift`
  and `fixtures/swift-eval/Sources/UI/Toolbar.swift`.
- **Conformance and inheritance edges** with explicit `confidence`:
  - `direct` — struct, enum, protocol, and extension heritage slots; class
    primary heritage slot when unambiguous.
  - `heuristic` — class heritage slots beyond the first (Swift parses
    these as a flat list; we cannot tell class-vs-protocol apart without
    the type checker).
- **Span-based identity for overloads**. `func update(id:)`,
  `func update(patient:)`, and `func update(notes:for:)` on the same type
  each get a distinct row. Verified by SQL invariant in
  `fixtures/swift-eval/eval-dataset.json` (case `swift-overload-001`).
- **Parser-failure surfacing in health**. When the tree-sitter parser
  cannot load (missing WASM, ABI mismatch, etc.) or fails on a file:
  - `sextant doctor` shows a Swift Health section with the failure mode
    and a recovery hint.
  - The statusline carries an `⚠ run: …` action slot.
  - The freshness gate emits a "swift parser unavailable" marker in the
    minimal `<codebase-intelligence>` body.
- **Two Swift-gated scoring signals**:
  - `+10%` enclosing-type boost when a query term equals the enclosing
    type name extracted from the hit's `before` context.
  - `+15%` extension-target boost when the query is multi-token, contains
    `+`, or contains the literal word `extension`.
  Constants in `lib/scoring-constants.js`; tuning requires re-running the
  +99% per-hit stack-ceiling math documented there.
- **Initialism queries** (`URLSession`, `JSONDecoder`, `XMLParser`)
  recognized by the classifier's identifier-shape regex in
  `lib/classifier.js`.

## Out of scope (deferred with rationale)

These are intentionally not implemented in v1. Each entry names what we'd
have to do to add it and why we didn't:

- **`.swiftinterface` ingestion**. Would require reading SDK / framework
  module interface files to know what SwiftUI's `View` requires, what
  Foundation's `Codable` provides, etc. Not done because the orientation
  goal is repo-local — Sextant deliberately does not claim SDK awareness.
- **Deep nested types (>1 level)**. `A.B.C` records `B` with
  `parent_name=A` but does not record `C`. The fix would be a recursive
  walker; the cost is a more complex `parent_name` model and indexing
  every nesting level for negligible orientation value.
- **Macros** (`@freestanding`, `@attached`) and macro-expanded
  declarations. Tree-sitter sees the macro call site but not the
  expansion. Would require running the Swift macro plugin, which means a
  Swift toolchain dependency.
- **`@_exported import`**. Treated as a plain import — we don't
  transitively re-export the imported module's symbols.
- **Generic `where`-clause constraints as graph edges**. The constraint
  is parsed as part of the signature but is not lifted into
  `swift_relations` as a relation kind.
- **SwiftPM / Xcode module resolution**. Swift `import Foo` always flows
  as `external` in the import-resolver kind tag. We don't attempt to
  resolve the module to a Package.swift target or a `.xcodeproj` build
  setting.
- **Compiler-backed semantics**: overload selection, USRs, cross-module
  references, type inference. Would require integrating sourcekit-lsp or
  `swift-symbolgraph-extract`, which means a Swift toolchain dependency
  and (for sourcekit-lsp) a long-lived index server.
- **Precise overload disambiguation in retrieval presentation**. The
  pipeline surfaces every matching overload; it does not pick the "right"
  one. Disambiguation is the user's job once retrieval has shown the
  candidates.
- **Property wrappers as relations**. `@State var x` indexes as a plain
  property; we don't emit a wrapper-type edge to the `State` type. The
  fix would be straightforward but adds noise to `swift_relations` for
  modest orientation value.
- **Tuple-destructuring `let (x, y) = pair`**. Not extracted. The
  declaration kinds we emit assume a single name per declaration.
- **Multi-line attribute markers**. The extractor only handles
  single-line attributes (e.g. `@MainActor` on the same line as the
  declaration). Multi-line attribute blocks are skipped over with the
  declaration still recorded.

## Recovery — when the parser fails

The Swift extractor depends on a vendored WASM file at
`vendor/tree-sitter-swift.wasm`. Failure modes Sextant surfaces:

- **Missing WASM**: `sextant doctor` reports "Swift parser: not loaded —
  vendor/tree-sitter-swift.wasm missing"; statusline shows
  `⚠ run: vendor WASM`; freshness-gate body marks Swift unavailable.
- **ABI mismatch**: same surfaces, with the failure mode "loaded but
  parser init failed".
- **Per-file parse error**: the file is skipped, a counter is incremented
  in the meta table, and `sextant doctor` shows the count.

To update the WASM, follow `vendor/README.md`. The short version: pull
the latest release artifact from
[`alex-pinkus/tree-sitter-swift`](https://github.com/alex-pinkus/tree-sitter-swift/releases),
**not** from the `tree-sitter-wasms` npm package — its bundled artifact
uses an incompatible tree-sitter ABI for `web-tree-sitter` 0.26.x.

## External validation

Two evaluation surfaces ship with v1:

- **Synthetic** (`fixtures/swift-eval/`): 13 cases exercising every Swift
  scoring path. Run with
  `node scripts/eval-retrieve.js --dataset fixtures/swift-eval/eval-dataset.json --root fixtures/swift-eval`.
  Self-eval acceptance is 13/13 pass, MRR ≥ 0.85 — the working baseline
  is MRR 0.958, nDCG 0.977.
- **External** (`fixtures/vapor-eval-queries.json` + `scripts/eval-swift-external.sh`):
  Vapor pinned at tag 4.121.4. Manual-trigger only (~1-3 min runtime,
  NOT in `npm test`). Regenerate baseline with
  `bash scripts/eval-swift-external.sh regen-baseline`.

The external benchmark is honest about a finding worth keeping visible:
the graph layer's lift on Vapor is currently **neutral** (0.000 nDCG
delta, identical Graph ON / Graph OFF rankings on the three starred
"pathological-lift" queries `URI`, `init`, `Service`). The plan's
expectation that Vapor would be where graph-machinery value showed up is
not supported by the data on this corpus. Future scoring tuning should
re-run this benchmark on the same pinned dataset and quantify the delta.

A second real-corpus finding: test-tagged sources living outside `Tests/`
directories (`Sources/XCTVapor/`, `Sources/VaporTesting/`) are not caught
by `TEST_PENALTY`'s path heuristic and outrank canonical defs on
common-name queries (`Application`, `Request`, `Response`). This is in
the corpus, in the baseline, and visible in `fixtures/vapor-baseline.json`
— a starting point for future tuning, not a regression of v1.
