"use strict";

// SB-1 / SB-2 verification: storage layer for Swift declarations and relations.
// These tests use hand-constructed input (no extractor) so the schema, writers,
// and queries are validated independently of the parser.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const graph = require("../lib/graph");

describe("swift_declarations: span-based identity (SB-1)", () => {
  let tmpDir, db;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-swift-decls-"));
    fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
    db = await graph.loadDb(tmpDir);
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores three same-name overloads as three distinct rows", () => {
    // Three `func update(...)` overloads in the same `class PatientStore`.
    // (path,name,kind) PK would have collapsed these to one row;
    // (path,start_byte,end_byte) PK preserves all three.
    graph.replaceSwiftDeclarations(db, "Sources/PatientStore.swift", [
      { name: "update", kind: "func", parent_name: "PatientStore", parent_kind: "class",
        start_byte: 100, end_byte: 140, start_line: 5, start_col: 2, signature_hint: "id:" },
      { name: "update", kind: "func", parent_name: "PatientStore", parent_kind: "class",
        start_byte: 145, end_byte: 195, start_line: 6, start_col: 2, signature_hint: "patient:" },
      { name: "update", kind: "func", parent_name: "PatientStore", parent_kind: "class",
        start_byte: 200, end_byte: 245, start_line: 7, start_col: 2, signature_hint: "notes:" },
    ]);

    const rows = graph.findDeclarationsBySymbol(db, "update");
    assert.equal(rows.length, 3, "all three overloads must round-trip");
    const spans = rows.map(r => `${r.startByte}-${r.endByte}`).sort();
    assert.deepEqual(spans, ["100-140", "145-195", "200-245"]);
    const hints = rows.map(r => r.signatureHint).sort();
    assert.deepEqual(hints, ["id:", "notes:", "patient:"]);
  });

  it("findDeclarationsBySymbol is case-insensitive on name", () => {
    const rows = graph.findDeclarationsBySymbol(db, "UPDATE");
    assert.equal(rows.length, 3);
  });

  it("stores members of two extensions of the same type as distinct rows (SB-2 storage)", () => {
    // Two `extension PatientStore {}` blocks in the same file, each with a
    // member named the same.  parent_kind="extension" + distinct spans keep
    // them apart even though parent_name overlaps.
    graph.replaceSwiftDeclarations(db, "Sources/PatientStore+Sync.swift", [
      // Extension #1 (Codable): the extension declaration itself
      { name: "PatientStore", kind: "extension", parent_name: null, parent_kind: null,
        start_byte: 50, end_byte: 200, start_line: 3, start_col: 0 },
      { name: "encode", kind: "func", parent_name: "PatientStore", parent_kind: "extension",
        start_byte: 100, end_byte: 150, start_line: 5, start_col: 2 },
      // Extension #2 (Hashable): same parent_name, distinct spans
      { name: "PatientStore", kind: "extension", parent_name: null, parent_kind: null,
        start_byte: 220, end_byte: 360, start_line: 12, start_col: 0 },
      { name: "hash", kind: "func", parent_name: "PatientStore", parent_kind: "extension",
        start_byte: 280, end_byte: 340, start_line: 14, start_col: 2 },
    ]);

    const ext = graph.findDeclarationsBySymbol(db, "PatientStore");
    const exts = ext.filter(r => r.kind === "extension");
    assert.equal(exts.length, 2, "two extension declarations must exist as distinct rows");
    const extSpans = exts.map(r => `${r.startByte}-${r.endByte}`).sort();
    assert.deepEqual(extSpans, ["220-360", "50-200"].sort());
  });

  it("replaceSwiftDeclarations replaces all rows for the path on edit", () => {
    // Edit the file so it now defines only one of the three overloads.
    graph.replaceSwiftDeclarations(db, "Sources/PatientStore.swift", [
      { name: "update", kind: "func", parent_name: "PatientStore", parent_kind: "class",
        start_byte: 100, end_byte: 140, start_line: 5, start_col: 2, signature_hint: "id:" },
    ]);
    const rows = graph.findDeclarationsBySymbol(db, "update");
    // Now only 1 from PatientStore.swift; the 2 in PatientStore+Sync.swift fixture
    // weren't `update`, so the count should be 1.
    assert.equal(rows.filter(r => r.path === "Sources/PatientStore.swift").length, 1);
  });

  it("rejects rows with missing required fields", () => {
    graph.replaceSwiftDeclarations(db, "Sources/Bad.swift", [
      { name: "ok", kind: "func", start_byte: 1, end_byte: 5 },
      { name: "no_kind", start_byte: 10, end_byte: 15 },
      { kind: "func", start_byte: 20, end_byte: 25 },
      { name: "no_span", kind: "func" },
      { name: "negative_span", kind: "func", start_byte: 30 }, // missing end_byte
    ]);
    const ok = graph.findDeclarationsBySymbol(db, "ok");
    assert.equal(ok.length, 1);
    const noKind = graph.findDeclarationsBySymbol(db, "no_kind");
    assert.equal(noKind.length, 0);
    const noSpan = graph.findDeclarationsBySymbol(db, "no_span");
    assert.equal(noSpan.length, 0);
  });
});

describe("swift_relations: span-linked structural edges (SB-2)", () => {
  let tmpDir, db;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-swift-rels-"));
    fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
    db = await graph.loadDb(tmpDir);
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("two extension blocks in same file produce distinct relation rows (SB-2)", () => {
    // The same file has `extension PatientStore: Codable {}` AND
    // `extension PatientStore: Hashable {}`.  Each emits an `extends` edge to
    // PatientStore plus a `conforms_to` edge to its respective protocol.
    // Without span linkage, the two `extends PatientStore` rows would collide
    // on PK.
    graph.replaceSwiftRelations(db, "Sources/PatientStore+Sync.swift", [
      { source_name: "PatientStore", source_start_byte: 50, source_end_byte: 200,
        kind: "extends", target_name: "PatientStore", confidence: "direct" },
      { source_name: "PatientStore", source_start_byte: 50, source_end_byte: 200,
        kind: "conforms_to", target_name: "Codable", confidence: "direct" },
      { source_name: "PatientStore", source_start_byte: 220, source_end_byte: 360,
        kind: "extends", target_name: "PatientStore", confidence: "direct" },
      { source_name: "PatientStore", source_start_byte: 220, source_end_byte: 360,
        kind: "conforms_to", target_name: "Hashable", confidence: "direct" },
    ]);

    const extends_ = graph.findRelationsByTarget(db, "PatientStore", { kind: "extends" });
    assert.equal(extends_.length, 2, "two extension blocks → two extends edges");
    const conformances = graph.findRelationsByTarget(db, "Codable", { kind: "conforms_to" });
    assert.equal(conformances.length, 1);
  });

  it("filters by confidence", () => {
    graph.replaceSwiftRelations(db, "Sources/Patient.swift", [
      { source_name: "Patient", source_start_byte: 0, source_end_byte: 100,
        kind: "inherits_from", target_name: "Person", confidence: "heuristic" },
      { source_name: "Patient", source_start_byte: 0, source_end_byte: 100,
        kind: "conforms_to", target_name: "Codable", confidence: "direct" },
    ]);
    // Scope by from_path because the prior subtest already inserted a Codable row.
    const direct = graph.findRelationsByTarget(db, "Codable", { confidence: "direct" })
      .filter(r => r.fromPath === "Sources/Patient.swift");
    assert.equal(direct.length, 1);
    const heuristic = graph.findRelationsByTarget(db, "Person", { confidence: "heuristic" });
    assert.equal(heuristic.length, 1);
    const directOnPerson = graph.findRelationsByTarget(db, "Person", { confidence: "direct" });
    assert.equal(directOnPerson.length, 0);
  });

  it("rejects rows with bad confidence value", () => {
    graph.replaceSwiftRelations(db, "Sources/Garbage.swift", [
      { source_name: "X", source_start_byte: 0, source_end_byte: 10,
        kind: "extends", target_name: "Y", confidence: "guessed" }, // invalid
      { source_name: "X", source_start_byte: 0, source_end_byte: 10,
        kind: "extends", target_name: "Z", confidence: "direct" },
    ]);
    const yMatches = graph.findRelationsByTarget(db, "Y");
    assert.equal(yMatches.length, 0, "bad-confidence row must be silently dropped");
    const zMatches = graph.findRelationsByTarget(db, "Z");
    assert.equal(zMatches.length, 1);
  });
});

describe("deleteFile cascades through Swift tables", () => {
  let tmpDir, db;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-swift-delete-"));
    fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
    db = await graph.loadDb(tmpDir);
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("deleteFile removes swift_declarations and swift_relations rows for the path", () => {
    graph.upsertFile(db, { relPath: "Sources/Foo.swift", type: "swift", sizeBytes: 100, mtimeMs: 1 });
    graph.replaceSwiftDeclarations(db, "Sources/Foo.swift", [
      { name: "Foo", kind: "class", start_byte: 0, end_byte: 50 },
      { name: "bar", kind: "func", parent_name: "Foo", parent_kind: "class",
        start_byte: 10, end_byte: 40 },
    ]);
    graph.replaceSwiftRelations(db, "Sources/Foo.swift", [
      { source_name: "Foo", source_start_byte: 0, source_end_byte: 50,
        kind: "conforms_to", target_name: "Codable", confidence: "direct" },
    ]);
    assert.equal(graph.findDeclarationsBySymbol(db, "Foo").length, 1);
    assert.equal(graph.findRelationsByTarget(db, "Codable").length, 1);

    graph.deleteFile(db, "Sources/Foo.swift");

    assert.equal(graph.findDeclarationsBySymbol(db, "Foo").length, 0,
      "swift_declarations row for deleted file must be removed");
    assert.equal(graph.findDeclarationsBySymbol(db, "bar").length, 0,
      "member rows must also be removed");
    assert.equal(graph.findRelationsByTarget(db, "Codable").length, 0,
      "swift_relations rows for deleted file must be removed");
  });
});

describe("getSwiftHealthCounters", () => {
  let tmpDir, db;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-swift-health-"));
    fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
    db = await graph.loadDb(tmpDir);
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns zeroed counters when no data + no meta", () => {
    const h = graph.getSwiftHealthCounters(db);
    assert.equal(h.parserState, null);
    assert.equal(h.filesSeen, 0);
    assert.equal(h.filesParsedOk, 0);
    assert.equal(h.filesParseErrors, 0);
    assert.equal(h.filesUnsupportedConstructs, 0);
    assert.equal(h.declarationsIndexed, 0);
    assert.equal(h.relationsIndexedDirect, 0);
    assert.equal(h.relationsIndexedHeuristic, 0);
    assert.equal(h.relationsIndexedTotal, 0);
  });

  it("reads parserState and counters from meta + derives table counts", () => {
    graph.setMetaValue(db, "swift.parserState", "ok");
    graph.setMetaValue(db, "swift.filesSeen", "42");
    graph.setMetaValue(db, "swift.filesParsedOk", "40");
    graph.setMetaValue(db, "swift.filesParseErrors", "1");
    graph.setMetaValue(db, "swift.filesUnsupportedConstructs", "1");

    graph.replaceSwiftDeclarations(db, "Sources/A.swift", [
      { name: "A", kind: "class", start_byte: 0, end_byte: 50 },
      { name: "B", kind: "struct", start_byte: 60, end_byte: 100 },
    ]);
    graph.replaceSwiftRelations(db, "Sources/A.swift", [
      { source_name: "A", source_start_byte: 0, source_end_byte: 50,
        kind: "conforms_to", target_name: "Codable", confidence: "direct" },
      { source_name: "A", source_start_byte: 0, source_end_byte: 50,
        kind: "inherits_from", target_name: "Person", confidence: "heuristic" },
    ]);

    const h = graph.getSwiftHealthCounters(db);
    assert.equal(h.parserState, "ok");
    assert.equal(h.filesSeen, 42);
    assert.equal(h.filesParsedOk, 40);
    assert.equal(h.filesParseErrors, 1);
    assert.equal(h.filesUnsupportedConstructs, 1);
    assert.equal(h.declarationsIndexed, 2);
    assert.equal(h.relationsIndexedDirect, 1);
    assert.equal(h.relationsIndexedHeuristic, 1);
    assert.equal(h.relationsIndexedTotal, 2);
  });
});
