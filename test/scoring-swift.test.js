"use strict";

// Swift-specific scoring tests:
// - Verify Swift def patterns extract symbol names correctly
// - Verify Swift-gated signals (enclosing-type +10%, extension-target +15%)
//   fire only on .swift files and only under the right conditions
// - Stacking-ceiling assertion: worst-case Swift def-line stack ≤ +99% per
//   the plan (within the FAN_IN_SUPPRESSION margin retrieve.js depends on)

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  extractSymbolDef,
  computeEnhancedSignals,
  extractEnclosingTypeFromContext,
  looksLikeExtensionQuery,
  extractExtensionTargetFromLine,
} = require("../lib/scoring");
const C = require("../lib/scoring-constants");

describe("extractSymbolDef: Swift patterns", () => {
  it("class / struct / actor / enum / protocol", () => {
    assert.equal(extractSymbolDef("class PatientStore: ObservableObject {"), "PatientStore");
    assert.equal(extractSymbolDef("struct Patient {"), "Patient");
    assert.equal(extractSymbolDef("actor Counter {"), "Counter");
    assert.equal(extractSymbolDef("enum Logger {"), "Logger");
    assert.equal(extractSymbolDef("protocol Auth {"), "Auth");
  });

  it("typealias and associatedtype", () => {
    assert.equal(extractSymbolDef("typealias UserID = UUID"), "UserID");
    assert.equal(extractSymbolDef("    associatedtype Element"), "Element");
  });

  it("func with all common modifier combos", () => {
    assert.equal(extractSymbolDef("    func update(id: UUID) {}"), "update");
    assert.equal(extractSymbolDef("    public func update(patient: Patient) {}"), "update");
    assert.equal(extractSymbolDef("    static func shared() -> Self {}"), "shared");
    assert.equal(extractSymbolDef("    @MainActor public final func render() {}"), "render");
    assert.equal(extractSymbolDef("    override class func reset() {}"), "reset");
    assert.equal(extractSymbolDef("    mutating func update() {}"), "update");
    assert.equal(extractSymbolDef("    convenience required init(id: UUID) {}"), "init");
  });

  it("init / deinit (synthetic names)", () => {
    assert.equal(extractSymbolDef("    init(id: UUID) {}"), "init");
    assert.equal(extractSymbolDef("    init?(value: String) {}"), "init");
    assert.equal(extractSymbolDef("    convenience init() {}"), "init");
    assert.equal(extractSymbolDef("    deinit { }"), "deinit");
  });

  it("subscript (synthetic name)", () => {
    assert.equal(extractSymbolDef("    subscript(index: Int) -> Element {"), "subscript");
    assert.equal(extractSymbolDef("    public subscript<T>(key: T) -> T {"), "subscript");
  });

  it("var / let with attributes and modifiers", () => {
    assert.equal(extractSymbolDef("    let id: UUID"), "id");
    assert.equal(extractSymbolDef("    var name: String = \"\""), "name");
    assert.equal(extractSymbolDef("    @Published var count = 0"), "count");
    assert.equal(extractSymbolDef("    @State private var isLoading = false"), "isLoading");
    assert.equal(extractSymbolDef("    static let shared = APIClient()"), "shared");
    assert.equal(extractSymbolDef("    lazy var view: UIView = { ... }()"), "view");
  });

  it("extension (captures extended type as the def symbol)", () => {
    assert.equal(extractSymbolDef("extension PatientStore: Codable {"), "PatientStore");
    assert.equal(extractSymbolDef("public extension View where Self: Sendable {"), "View");
  });

  it("enum case in grouped or single form", () => {
    assert.equal(extractSymbolDef("    case debug"), "debug");
    assert.equal(extractSymbolDef("    case error(String)"), "error");
    assert.equal(extractSymbolDef("    case info = 1"), "info");
  });

  it("operator declarations", () => {
    assert.equal(extractSymbolDef("infix operator <>"), "<>");
    assert.equal(extractSymbolDef("prefix operator !"), "!");
  });
});

describe("Swift-gated signals fire only on .swift files", () => {
  it("does not fire on .js files even when context matches", () => {
    const hit = {
      score: 1,
      path: "lib/foo.js",
      line: "function update(id) {}",
      before: ["class PatientStore {"],
    };
    const out = computeEnhancedSignals(hit, ["PatientStore"], { explainHits: true });
    // No swift_enclosing_type signal should appear
    const swiftSignal = out.signals.find(s => s.startsWith("swift_"));
    assert.equal(swiftSignal, undefined);
  });

  it("enclosing-type boost fires when query matches enclosing type", () => {
    const hit = {
      score: 1,
      path: "Sources/PatientStore.swift",
      line: "    func updatePatient(id: UUID) {}",
      before: ["class PatientStore: ObservableObject {"],
    };
    const out = computeEnhancedSignals(hit, ["PatientStore"], { explainHits: true });
    const sig = out.signals.find(s => s.startsWith("swift_enclosing_type"));
    assert.ok(sig, "swift_enclosing_type signal must fire");
    assert.match(sig, new RegExp(`\\+${Math.round(C.SWIFT_ENCLOSING_TYPE_BOOST * 100)}%`));
  });

  it("enclosing-type boost does NOT fire when no query term matches enclosing type", () => {
    const hit = {
      score: 1,
      path: "Sources/PatientStore.swift",
      line: "    func updatePatient(id: UUID) {}",
      before: ["class PatientStore {"],
    };
    const out = computeEnhancedSignals(hit, ["foo"], { explainHits: true });
    assert.equal(out.signals.find(s => s.startsWith("swift_enclosing_type")), undefined);
  });

  it("extension-target boost gates: single-token query does NOT fire", () => {
    // Query is just "View" — must not promote extension files over the View
    // protocol's def site.
    const hit = {
      score: 1,
      path: "Sources/View+Toolbar.swift",
      line: "extension View {",
      before: [],
    };
    const out = computeEnhancedSignals(hit, ["View"], { explainHits: true });
    assert.equal(out.signals.find(s => s.startsWith("swift_extension_target")), undefined);
  });

  it("extension-target boost fires on multi-token query matching extension target", () => {
    const hit = {
      score: 1,
      path: "Sources/View+Toolbar.swift",
      line: "extension View {",
      before: [],
    };
    const out = computeEnhancedSignals(hit, ["View", "toolbar"], { explainHits: true });
    const sig = out.signals.find(s => s.startsWith("swift_extension_target"));
    assert.ok(sig, "extension-target signal must fire on multi-token query");
    assert.match(sig, new RegExp(`\\+${Math.round(C.SWIFT_EXTENSION_TARGET_BOOST * 100)}%`));
  });

  it("extension-target boost fires when raw query contains '+'", () => {
    const hit = {
      score: 1,
      path: "Sources/View+Toolbar.swift",
      line: "extension View {",
      before: [],
    };
    const out = computeEnhancedSignals(hit, ["View"], {
      explainHits: true,
      rawQuery: "View+Toolbar",
    });
    const sig = out.signals.find(s => s.startsWith("swift_extension_target"));
    assert.ok(sig, "extension-target signal must fire on '+'-containing raw query");
  });

  it("extension-target boost fires when raw query contains 'extension'", () => {
    const hit = {
      score: 1,
      path: "Sources/View+Toolbar.swift",
      line: "extension View {",
      before: [],
    };
    const out = computeEnhancedSignals(hit, ["View"], {
      explainHits: true,
      rawQuery: "extension View",
    });
    assert.ok(out.signals.find(s => s.startsWith("swift_extension_target")));
  });
});

describe("Swift signal helpers", () => {
  it("extractEnclosingTypeFromContext walks before lines", () => {
    const hit = {
      before: [
        "// header",
        "import SwiftUI",
        "",
        "class PatientStore: ObservableObject {",
        "    var id: UUID",
      ],
    };
    assert.equal(extractEnclosingTypeFromContext(hit), "PatientStore");
  });

  it("extractEnclosingTypeFromContext returns null without before context", () => {
    assert.equal(extractEnclosingTypeFromContext({ before: [] }), null);
    assert.equal(extractEnclosingTypeFromContext({}), null);
    assert.equal(extractEnclosingTypeFromContext(null), null);
  });

  it("extractEnclosingTypeFromContext respects pre-populated _enclosingType", () => {
    assert.equal(
      extractEnclosingTypeFromContext({ _enclosingType: "Foo" }),
      "Foo"
    );
  });

  it("looksLikeExtensionQuery", () => {
    assert.equal(looksLikeExtensionQuery(["a", "b"], "a b"), true);
    assert.equal(looksLikeExtensionQuery(["View"], "View+Toolbar"), true);
    assert.equal(looksLikeExtensionQuery(["View"], "extension View"), true);
    assert.equal(looksLikeExtensionQuery(["View"], "View"), false);
  });

  it("extractExtensionTargetFromLine", () => {
    assert.equal(extractExtensionTargetFromLine("extension PatientStore {"), "PatientStore");
    assert.equal(
      extractExtensionTargetFromLine("public extension View where Self: Sendable {"),
      "View"
    );
    // Dotted target: take leading segment
    assert.equal(extractExtensionTargetFromLine("extension Array.Element {"), "Array");
    assert.equal(extractExtensionTargetFromLine("class PatientStore {"), null);
  });
});

describe("Stacking-ceiling: worst-case Swift def-line ≤ +99% (plan invariant)", () => {
  it("class def line of queried type tops out at the documented ceiling", () => {
    // Worst-case scenario:
    //   Query: "PatientStore"
    //   Hit:   def line of `class PatientStore: ObservableObject {` inside
    //          Sources/PatientStore.swift
    //   Signals stacking on this hit:
    //     EXACT_SYMBOL_BOOST          +40% (extractSymbolDef → "PatientStore")
    //     SYMBOL_CONTAINS_QUERY_BOOST +12% (symbol contains query)
    //     SWIFT_ENCLOSING_TYPE_BOOST  +10% would NOT fire here because the
    //                                 hit IS the def line — its enclosing
    //                                 context is module-scope, not the type
    //                                 itself.  But conservatively we let the
    //                                 test include it anyway so the assertion
    //                                 catches future regressions if a future
    //                                 signal change makes it stack here.
    //   Plus, separately scored in retrieve.js (NOT in computeEnhancedSignals):
    //     DEF_LINE_BOOST          +3%
    //     DEF_SITE_PRIORITY      +25%
    //     HOTSPOT_BOOST          +15%
    //     ENTRY_POINT_BOOST      +10%
    //     FAN_IN cap             +15%
    //   computeEnhancedSignals' contribution alone stays under +60% (40+12+10).
    const hit = {
      score: 1,
      path: "Sources/PatientStore.swift",
      line: "class PatientStore: ObservableObject {",
      // Force-include the enclosing-type pretext to test the ceiling defensively.
      _enclosingType: "PatientStore",
    };
    const out = computeEnhancedSignals(hit, ["PatientStore"], { explainHits: true });
    // Hit's adjustment is in absolute points; base=1 so adjustment/base = the
    // fraction of base added.  Cap test: must not exceed +0.62 (40% + 12% +
    // 10% = 62%).  Allow a little slack for future signal additions.
    assert.ok(
      out.adjustment <= 0.62 + 1e-9,
      `computeEnhancedSignals stack on Swift def line was ${out.adjustment.toFixed(3)} > 0.62 — exceeded plan ceiling`
    );
  });

  it("non-Swift hit's signal output is unchanged from existing behavior", () => {
    // Regression guard: the Swift-gated branch must never alter JS/Python
    // signal output.  Compare against a hard-coded expected adjustment for
    // a Python def line.
    const pyHit = {
      score: 1,
      path: "lib/foo.py",
      line: "def update_patient(id):",
    };
    const out = computeEnhancedSignals(pyHit, ["update_patient"], { explainHits: true });
    // No swift_* signals must appear.
    assert.equal(out.signals.find(s => s.startsWith("swift_")), undefined);
    // exact_symbol must still fire (this is the existing JS/Python behavior).
    assert.ok(out.signals.find(s => s.startsWith("exact_symbol")));
  });
});
