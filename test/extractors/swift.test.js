"use strict";

// Swift extractor unit tests.
// All tests require web-tree-sitter init to complete, which is async — we
// await ensureReady() in `before()` and skip the suite if init failed (e.g.,
// missing WASM artifact in a stripped install).

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

const swift = require("../../lib/extractors/swift");

let parserReady = false;

describe("swift extractor", () => {
  before(async () => {
    parserReady = await swift.ensureReady();
  });

  // --- Imports ---
  describe("extractImports", () => {
    it("basic import", () => {
      const result = swift.extractImports("import SwiftUI\n", "App.swift");
      assert.deepEqual(result, [{ specifier: "SwiftUI", kind: "import" }]);
    });

    it("multiple imports", () => {
      const code = "import Foundation\nimport SwiftUI\nimport Combine\n";
      const result = swift.extractImports(code, "App.swift");
      assert.equal(result.length, 3);
      assert.deepEqual(result.map(r => r.specifier).sort(), ["Combine", "Foundation", "SwiftUI"]);
    });

    it("attributed import (@_exported)", () => {
      const result = swift.extractImports("@_exported import Combine\n", "App.swift");
      assert.deepEqual(result.map(r => r.specifier), ["Combine"]);
    });

    it("structured import: import struct Foundation.Date", () => {
      // The grammar puts both "Foundation" and "Date" as simple_identifiers
      // under the identifier child; we capture the first (the module).
      const result = swift.extractImports("import struct Foundation.Date\n", "App.swift");
      assert.equal(result.length, 1);
      assert.equal(result[0].specifier, "Foundation");
    });

    it("empty code returns []", () => {
      assert.deepEqual(swift.extractImports("", "App.swift"), []);
    });
  });

  // --- Declarations: top-level types ---
  describe("extractDeclarations: top-level types", () => {
    it("class", () => {
      const decls = swift.extractDeclarations("class PatientStore {}\n", "PatientStore.swift");
      assert.equal(decls.length, 1);
      assert.equal(decls[0].name, "PatientStore");
      assert.equal(decls[0].kind, "class");
      assert.equal(decls[0].parent_name, null);
      assert.ok(decls[0].start_byte >= 0);
      assert.ok(decls[0].end_byte > decls[0].start_byte);
      assert.equal(decls[0].start_line, 1);
    });

    it("struct, actor, enum, protocol, typealias", () => {
      const code = `
struct Patient {}
actor Counter {}
enum Logger {}
protocol Auth {}
typealias UserID = UUID
`;
      const decls = swift.extractDeclarations(code, "Misc.swift");
      const top = decls.filter(d => d.parent_name === null);
      const byKind = Object.fromEntries(top.map(d => [d.kind, d.name]));
      assert.equal(byKind.struct, "Patient");
      assert.equal(byKind.actor, "Counter");
      assert.equal(byKind.enum, "Logger");
      assert.equal(byKind.protocol, "Auth");
      assert.equal(byKind.typealias, "UserID");
    });
  });

  // --- Declarations: members ---
  describe("extractDeclarations: members", () => {
    it("methods, properties, init in class", () => {
      const code = `
class Patient {
  let id: UUID
  var name: String
  init(id: UUID, name: String) {
    self.id = id
    self.name = name
  }
  func greet() -> String { return "Hi" }
}
`;
      const decls = swift.extractDeclarations(code, "Patient.swift");
      const members = decls.filter(d => d.parent_name === "Patient");
      const names = members.map(d => `${d.kind}:${d.name}`).sort();
      assert.deepEqual(names, ["func:greet", "init:init", "let:id", "var:name"]);
      // All members should carry parent_kind="class"
      assert.ok(members.every(d => d.parent_kind === "class"));
    });

    it("enum cases with grouped form", () => {
      const code = `
enum Logger {
  case debug, info
  case error(String)
}
`;
      const decls = swift.extractDeclarations(code, "Logger.swift");
      const cases = decls.filter(d => d.kind === "case");
      const names = cases.map(c => c.name).sort();
      assert.deepEqual(names, ["debug", "error", "info"]);
      assert.ok(cases.every(c => c.parent_name === "Logger"));
    });

    it("protocol requirements", () => {
      const code = `
protocol Auth {
  func authenticate() async throws
  var userId: String { get }
}
`;
      const decls = swift.extractDeclarations(code, "Auth.swift");
      const members = decls.filter(d => d.parent_name === "Auth");
      const fns = members.filter(d => d.kind === "func").map(d => d.name);
      const props = members.filter(d => d.kind === "var" || d.kind === "let").map(d => d.name);
      assert.deepEqual(fns.sort(), ["authenticate"]);
      assert.deepEqual(props.sort(), ["userId"]);
      assert.ok(members.every(d => d.parent_kind === "protocol"));
    });
  });

  // --- SB-1: overloads ---
  describe("extractDeclarations: overloads (SB-1)", () => {
    it("three same-name funcs in one type produce three distinct rows", () => {
      const code = `
class PatientStore {
  func update(id: UUID) {}
  func update(patient: Patient) {}
  func update(notes: String) {}
}
`;
      const decls = swift.extractDeclarations(code, "PatientStore.swift");
      const updates = decls.filter(d => d.name === "update" && d.parent_name === "PatientStore");
      assert.equal(updates.length, 3, "all three overloads must be extracted");
      // Each must have a distinct (start_byte, end_byte).
      const spans = new Set(updates.map(d => `${d.start_byte}-${d.end_byte}`));
      assert.equal(spans.size, 3, "all three overloads must have distinct spans");
      // signature_hint should disambiguate via param labels.
      const hints = updates.map(d => d.signature_hint).sort();
      assert.deepEqual(hints, ["id:", "notes:", "patient:"]);
    });
  });

  // --- SB-2: extension instance identity ---
  describe("extractDeclarations + extractRelations: multiple extensions of same type (SB-2)", () => {
    it("two extension blocks → two distinct extension decls + per-block relations", () => {
      const code = `
extension PatientStore: Codable {
  func encode(to encoder: Encoder) throws {}
}

extension PatientStore: Hashable {
  func hash(into hasher: inout Hasher) {}
}
`;
      const decls = swift.extractDeclarations(code, "PatientStore+Sync.swift");
      const exts = decls.filter(d => d.kind === "extension" && d.name === "PatientStore");
      assert.equal(exts.length, 2, "two extension blocks → two distinct extension declarations");
      const spans = new Set(exts.map(d => `${d.start_byte}-${d.end_byte}`));
      assert.equal(spans.size, 2);

      const rels = swift.extractRelations(code, "PatientStore+Sync.swift");
      // Each block emits: 1 extends + 1 conforms_to (Codable or Hashable).
      const conformances = rels.filter(r => r.kind === "conforms_to").map(r => r.target_name).sort();
      assert.deepEqual(conformances, ["Codable", "Hashable"]);
      // Two `extends PatientStore` rows with distinct source spans.
      const extendsRels = rels.filter(r => r.kind === "extends" && r.target_name === "PatientStore");
      assert.equal(extendsRels.length, 2);
      const sourceSpans = new Set(extendsRels.map(r => `${r.source_start_byte}-${r.source_end_byte}`));
      assert.equal(sourceSpans.size, 2, "extends edges link to distinct source spans");
    });
  });

  // --- Relations: heritage ---
  describe("extractRelations: heritage clauses", () => {
    it("class inherits_from leading non-protocol-looking name (heuristic)", () => {
      const code = `class Child: Parent, Codable {}`;
      const rels = swift.extractRelations(code, "Child.swift");
      const inh = rels.find(r => r.kind === "inherits_from");
      assert.ok(inh, "first slot of class heritage should produce inherits_from");
      assert.equal(inh.target_name, "Parent");
      assert.equal(inh.confidence, "heuristic");
      const conf = rels.find(r => r.kind === "conforms_to" && r.target_name === "Codable");
      assert.ok(conf, "subsequent slots must be conforms_to");
      assert.equal(conf.confidence, "heuristic");
    });

    it("class with leading protocol-looking name → conforms_to (heuristic)", () => {
      const code = `class Patient: ObservableObject {}`;
      const rels = swift.extractRelations(code, "Patient.swift");
      const conf = rels.find(r => r.kind === "conforms_to");
      assert.ok(conf, "ObservableObject should be detected as protocol");
      assert.equal(conf.target_name, "ObservableObject");
      assert.equal(conf.confidence, "heuristic");
      const inh = rels.find(r => r.kind === "inherits_from");
      assert.ok(!inh, "no inherits_from when first slot looks like a protocol");
    });

    it("struct heritage is direct conforms_to", () => {
      const code = `struct Patient: Codable, Identifiable {}`;
      const rels = swift.extractRelations(code, "Patient.swift");
      const confs = rels.filter(r => r.kind === "conforms_to");
      assert.equal(confs.length, 2);
      assert.ok(confs.every(c => c.confidence === "direct"));
      assert.deepEqual(confs.map(c => c.target_name).sort(), ["Codable", "Identifiable"]);
    });

    it("protocol heritage is direct conforms_to", () => {
      const code = `protocol View: Sendable {}`;
      const rels = swift.extractRelations(code, "View.swift");
      const conf = rels.find(r => r.kind === "conforms_to" && r.target_name === "Sendable");
      assert.ok(conf);
      assert.equal(conf.confidence, "direct");
    });

    it("extension extends + conforms_to are direct", () => {
      const code = `extension View: Codable {}`;
      const rels = swift.extractRelations(code, "View+Codable.swift");
      const ext = rels.find(r => r.kind === "extends");
      assert.ok(ext);
      assert.equal(ext.target_name, "View");
      assert.equal(ext.confidence, "direct");
      const conf = rels.find(r => r.kind === "conforms_to");
      assert.ok(conf);
      assert.equal(conf.target_name, "Codable");
      assert.equal(conf.confidence, "direct");
    });
  });

  // --- Failure modes ---
  describe("graceful degradation", () => {
    it("malformed Swift returns partial results without crashing", () => {
      const code = "class Foo { func bar( {  // missing close paren\n}\n";
      // Should not throw.
      const decls = swift.extractDeclarations(code, "Bad.swift");
      // We don't assert on specific contents — only on no-crash.
      assert.ok(Array.isArray(decls));
    });

    it("counters track filesSeen / filesParsedOk / filesParseErrors", () => {
      swift.resetCounters();
      swift.extractDeclarations("class A {}", "A.swift");
      swift.extractDeclarations("class B {}", "B.swift");
      const c = swift.getCounters();
      assert.equal(c.filesSeen, 2);
      assert.equal(c.filesParsedOk, 2);
      assert.equal(c.filesParseErrors, 0);
      assert.equal(c.parserState, "ok");
    });
  });
});
