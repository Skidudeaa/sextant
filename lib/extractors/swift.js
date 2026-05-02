/**
 * Swift v1 extractor — syntax-first via tree-sitter (web-tree-sitter WASM).
 *
 * WHY: Swift has overloaded methods, repeated extension blocks, and same-named
 * members across types — patterns that the JS regex/AST extractors don't have
 * to handle. The graph layer (lib/graph.js) stores Swift declarations in a
 * span-keyed table (swift_declarations) so each declaration site round-trips
 * faithfully. This module does the AST walk that produces those rows.
 *
 * Async-init contract: web-tree-sitter parser init is async (WASM load). The
 * extractor.js dispatcher calls our methods synchronously. We resolve this by
 * kicking off init at module-load time (fire-and-forget). Callers that can
 * await readiness should call `ensureReady()` before scanning. If a sync
 * extract call lands before init completes, we count it as a "pre-init miss"
 * (filesUnsupportedConstructs++) and return [] — the file gets indexed
 * structurally but Swift facts are skipped. Subsequent calls (after init
 * resolves, typically within 100ms) work normally.
 *
 * Health: getCounters() reports parserState plus per-counter file totals.
 * intel.js flushes these to the meta table via graph.setMetaValue() so
 * `sextant doctor` can surface parser status to the user.
 */

const path = require("path");

const SUPPORTED_EXTENSIONS = ["swift"];
const WTS_DIR = path.join(__dirname, "..", "..", "node_modules", "web-tree-sitter");
const SWIFT_WASM = path.join(__dirname, "..", "..", "vendor", "tree-sitter-swift.wasm");

// Module-level state. Kicked off at first require; consumed by sync calls.
let parserState = "uninitialized"; // -> initializing | ok | unavailable | init_failed
let parser = null;
let language = null;
let initPromise = null;
let initLoggedError = false;

// Per-scan counters (intel.js resets at scan start, flushes at scan end).
const counters = {
  filesSeen: 0,
  filesParsedOk: 0,
  filesParseErrors: 0,
  filesUnsupportedConstructs: 0,
};

function resetCounters() {
  counters.filesSeen = 0;
  counters.filesParsedOk = 0;
  counters.filesParseErrors = 0;
  counters.filesUnsupportedConstructs = 0;
}

function getCounters() {
  return { parserState, ...counters };
}

function isReady() {
  return parserState === "ok";
}

async function ensureReady() {
  if (parserState === "ok") return true;
  if (parserState === "init_failed" || parserState === "unavailable") return false;
  if (initPromise) return initPromise;

  parserState = "initializing";
  initPromise = (async () => {
    let wts;
    try {
      wts = require("web-tree-sitter");
    } catch (e) {
      parserState = "unavailable";
      if (!initLoggedError) {
        console.warn("[sextant] swift extractor disabled: web-tree-sitter not installed");
        initLoggedError = true;
      }
      return false;
    }
    try {
      const ParserCls = wts.Parser || wts.default || wts;
      const LanguageCls = wts.Language;
      await ParserCls.init({
        // tell Emscripten where to find tree-sitter's own runtime WASM
        locateFile: (name) => path.join(WTS_DIR, name),
      });
      language = await LanguageCls.load(SWIFT_WASM);
      parser = new ParserCls();
      parser.setLanguage(language);
      parserState = "ok";
      return true;
    } catch (e) {
      parserState = "init_failed";
      if (!initLoggedError) {
        console.warn(`[sextant] swift parser init failed: ${e.message}`);
        initLoggedError = true;
      }
      return false;
    }
  })();
  return initPromise;
}

// Kick off init eagerly so by the time the first .swift file lands we're
// ready. Fire-and-forget: bulk scans should still call ensureReady().
ensureReady().catch(() => {});

// --- AST walking helpers ---

function namedField(node, fieldName) {
  if (!node) return null;
  return node.childForFieldName(fieldName);
}

// Find first descendant matching one of the type names.
function findFirst(node, types) {
  if (!node) return null;
  if (types.includes(node.type)) return node;
  for (let i = 0; i < node.namedChildCount; i++) {
    const r = findFirst(node.namedChild(i), types);
    if (r) return r;
  }
  return null;
}

// Get the immediate first child by type (non-recursive).
function firstChildOfType(node, type) {
  if (!node) return null;
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c.type === type) return c;
  }
  return null;
}

function makeDecl(node, name, kind, parent_name, parent_kind, signature_hint) {
  return {
    name: String(name),
    kind: String(kind),
    parent_name: parent_name || null,
    parent_kind: parent_kind || null,
    start_byte: node.startIndex,
    end_byte: node.endIndex,
    start_line: node.startPosition.row + 1, // tree-sitter is 0-based; we use 1-based
    start_col: node.startPosition.column,
    signature_hint: signature_hint || null,
  };
}

function makeRelation(sourceNode, source_name, kind, target_name, confidence) {
  return {
    source_name: String(source_name),
    source_start_byte: sourceNode.startIndex,
    source_end_byte: sourceNode.endIndex,
    kind,
    target_name: String(target_name),
    confidence,
  };
}

// Heuristic: does this name look more like a protocol than a base class?
// Used only for the FIRST slot of a class heritage clause (where Swift syntax
// is genuinely ambiguous between superclass and leading protocol).
const KNOWN_PROTOCOL_NAMES = new Set([
  "Codable", "Encodable", "Decodable",
  "Hashable", "Equatable", "Comparable", "Identifiable",
  "Sendable", "AnyObject", "Any",
  "Error", "CustomStringConvertible", "CustomDebugStringConvertible",
  "Sequence", "Collection", "IteratorProtocol", "Iterable",
  "ObservableObject", "View", "Shape", "App", "Scene",
  "Codable", "RawRepresentable", "OptionSet", "CaseIterable",
  "Strideable", "AdditiveArithmetic", "Numeric", "BinaryInteger", "FloatingPoint",
]);

function looksLikeProtocolName(name) {
  if (KNOWN_PROTOCOL_NAMES.has(name)) return true;
  // Heuristic: ends in "able", "ing", "Protocol", "Type", "Delegate"
  return /^[A-Z].*(able|ing|Protocol|Type|Delegate|Source|Provider|Builder|Convertible|Representable)$/.test(name);
}

// Extract bare type identifier from a heritage entry (user_type → type_identifier).
function heritageTargetName(specNode) {
  // inheritance_specifier → user_type → type_identifier
  const userType = firstChildOfType(specNode, "user_type");
  if (!userType) return null;
  const typeId = firstChildOfType(userType, "type_identifier");
  return typeId ? typeId.text : null;
}

// For a class_declaration with declaration_kind="extension", extract the
// extended type name (the user_type before the inheritance specifiers).
function extensionTargetName(node) {
  // The first user_type child (NOT inside inheritance_specifier) is the target.
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c.type === "user_type") {
      const typeId = firstChildOfType(c, "type_identifier");
      return typeId ? typeId.text : null;
    }
    // Stop at inheritance_specifier — anything beyond is conformance, not target.
    if (c.type === "inheritance_specifier") break;
  }
  return null;
}

// For function_declaration / protocol_function_declaration: build a label-only
// signature hint like "id:patient:" or "to:" (Swift's parameter labels).
// Returns null when there are no parameters.
function functionSignatureHint(node) {
  const labels = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c.type !== "parameter") continue;
    const externalName = c.childForFieldName("external_name");
    const paramName = c.childForFieldName("name");
    // External name (the "to" in `func encode(to encoder:)`) takes precedence;
    // fall back to the internal name. "_" means no label.
    let label = null;
    if (externalName && externalName.text && externalName.text !== "_") {
      label = externalName.text;
    } else if (paramName && paramName.text && paramName.text !== "_") {
      label = paramName.text;
    }
    labels.push((label || "_") + ":");
  }
  return labels.length ? labels.join("") : null;
}

// --- Entry-point detection (filename-independent) ---

// WHY: A Swift app's actual entry point is a top-level type with the @main
// attribute (or `main.swift` files / a UIKit AppDelegate, both handled by
// filename heuristics in lib/utils.js).  We use a narrow regex over file
// content rather than walking the AST: @main is rare, the literal string is
// unambiguous, and a regex avoids the cost of making this an AST query for
// what is effectively a binary flag per file.
//
// The pattern requires @main to be preceded by a non-word character (so
// `@@main` and `xx@main` don't fire) and followed by a non-word character
// (so `@mainView`, `@mainTarget` don't fire).  This is the same precision
// the Swift compiler enforces — the `@main` attribute name is reserved and
// can't be a prefix of another identifier.
const AT_MAIN_RE = /(?:^|[^A-Za-z0-9_@])@main(?![A-Za-z0-9_])/m;

function hasAtMain(code) {
  if (!code || typeof code !== "string") return false;
  return AT_MAIN_RE.test(code);
}

// --- Extractor entry points ---

function extractImports(code, _filePath) {
  if (!isReady() || !code) return [];
  let tree;
  try {
    tree = parser.parse(code);
  } catch {
    return [];
  }
  const out = [];
  const root = tree.rootNode;
  for (let i = 0; i < root.namedChildCount; i++) {
    const c = root.namedChild(i);
    if (c.type !== "import_declaration") continue;
    // Find the `identifier` child; its first simple_identifier is the module.
    const id = firstChildOfType(c, "identifier");
    if (!id) continue;
    const sid = firstChildOfType(id, "simple_identifier");
    if (!sid) continue;
    out.push({ specifier: sid.text, kind: "import" });
  }
  tree.delete && tree.delete();
  return out;
}

// Swift uses extractDeclarations + extractRelations for graph storage.
// extractExports returns [] so Swift declarations don't pollute the JS/Python
// `exports` table (whose (path,name,kind) PK can't represent overloads).
function extractExports(_code, _filePath) {
  return [];
}

function extractDeclarations(code, filePath) {
  // Note: increment filesSeen at the dispatcher entry so we count attempts
  // even when init isn't ready yet (those become filesUnsupportedConstructs).
  counters.filesSeen += 1;

  if (!code) {
    counters.filesParsedOk += 1; // empty file is "successful parse, zero decls"
    return [];
  }
  if (!isReady()) {
    counters.filesUnsupportedConstructs += 1;
    return [];
  }

  let tree;
  try {
    tree = parser.parse(code);
  } catch (e) {
    counters.filesParseErrors += 1;
    return [];
  }

  const out = [];
  const root = tree.rootNode;
  if (root.hasError) {
    // Partial-parse: tree-sitter still produces a tree but flags errors.
    // Continue extracting what we can; count as partial error.
    counters.filesParseErrors += 1;
  } else {
    counters.filesParsedOk += 1;
  }

  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    walkTopLevel(child, out);
  }

  tree.delete && tree.delete();
  return out;
}

function extractRelations(code, _filePath) {
  if (!isReady() || !code) return [];
  let tree;
  try {
    tree = parser.parse(code);
  } catch {
    return [];
  }
  const out = [];
  const root = tree.rootNode;
  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    walkTopLevelRelations(child, out);
  }
  tree.delete && tree.delete();
  return out;
}

// --- Top-level walkers ---

function walkTopLevel(node, out) {
  if (node.type === "class_declaration") {
    walkClassLike(node, out);
  } else if (node.type === "protocol_declaration") {
    walkProtocol(node, out);
  } else if (node.type === "function_declaration") {
    // Free function at file scope (no enclosing type).
    const name = namedField(node, "name");
    if (name) {
      out.push(makeDecl(node, name.text, "func", null, null, functionSignatureHint(node)));
    }
  } else if (node.type === "property_declaration") {
    // Free var/let at file scope.
    pushPropertyDecl(node, out, null, null);
  } else if (node.type === "typealias_declaration") {
    const name = namedField(node, "name");
    if (name) out.push(makeDecl(node, name.text, "typealias", null, null));
  }
  // Other top-level forms (operator decls, etc.) deferred to v1.1.
}

function walkClassLike(node, out) {
  // class_declaration covers class, struct, actor, enum, AND extension.
  // declaration_kind field returns the keyword node ("class", "struct", "actor",
  // "enum", "extension").
  const kindNode = namedField(node, "declaration_kind");
  const kindText = kindNode ? kindNode.text : "class";

  if (kindText === "extension") {
    const targetName = extensionTargetName(node);
    if (!targetName) return;
    // Push the extension declaration itself.
    out.push(makeDecl(node, targetName, "extension", null, null));
    // Walk body; members get parent_kind="extension".
    walkBody(node, out, targetName, "extension");
    return;
  }

  // class / struct / actor / enum: name is in the `name` field.
  const nameNode = namedField(node, "name");
  if (!nameNode) return;
  const typeName = nameNode.text;
  out.push(makeDecl(node, typeName, kindText, null, null));
  walkBody(node, out, typeName, kindText);
}

function walkProtocol(node, out) {
  const nameNode = namedField(node, "name");
  if (!nameNode) return;
  const typeName = nameNode.text;
  out.push(makeDecl(node, typeName, "protocol", null, null));
  // Find protocol_body and walk its members.
  const body = firstChildOfType(node, "protocol_body");
  if (!body) return;
  for (let i = 0; i < body.namedChildCount; i++) {
    const member = body.namedChild(i);
    walkProtocolMember(member, out, typeName);
  }
}

function walkBody(node, out, parent_name, parent_kind) {
  // Body container varies: class/struct/actor → class_body; enum → enum_class_body.
  const body = firstChildOfType(node, "class_body") || firstChildOfType(node, "enum_class_body");
  if (!body) return;
  for (let i = 0; i < body.namedChildCount; i++) {
    const member = body.namedChild(i);
    walkMember(member, out, parent_name, parent_kind);
  }
}

function walkMember(node, out, parent_name, parent_kind) {
  switch (node.type) {
    case "function_declaration": {
      const name = namedField(node, "name");
      if (name) {
        out.push(makeDecl(node, name.text, "func", parent_name, parent_kind, functionSignatureHint(node)));
      }
      break;
    }
    case "init_declaration": {
      // Synthetic name "init" so a query for "init" surfaces all initializers.
      out.push(makeDecl(node, "init", "init", parent_name, parent_kind, functionSignatureHint(node)));
      break;
    }
    case "deinit_declaration": {
      out.push(makeDecl(node, "deinit", "deinit", parent_name, parent_kind));
      break;
    }
    case "subscript_declaration": {
      out.push(makeDecl(node, "subscript", "subscript", parent_name, parent_kind, functionSignatureHint(node)));
      break;
    }
    case "property_declaration": {
      pushPropertyDecl(node, out, parent_name, parent_kind);
      break;
    }
    case "enum_entry": {
      // `case foo, bar` produces multiple simple_identifiers under one entry.
      // Each is its own case declaration in the surface syntax.
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c.type === "simple_identifier") {
          out.push(makeDecl(c, c.text, "case", parent_name, parent_kind));
        }
      }
      break;
    }
    case "typealias_declaration": {
      const name = namedField(node, "name");
      if (name) out.push(makeDecl(node, name.text, "typealias", parent_name, parent_kind));
      break;
    }
    case "associatedtype_declaration": {
      const name = namedField(node, "name");
      if (name) out.push(makeDecl(node, name.text, "associatedtype", parent_name, parent_kind));
      break;
    }
    // Nested types — surface the type but DO NOT recurse one more level
    // (v1 caps nesting at 1).
    case "class_declaration": {
      const kindNode = namedField(node, "declaration_kind");
      const kindText = kindNode ? kindNode.text : "class";
      if (kindText === "extension") {
        // Nested extensions are weird; skip in v1.
        break;
      }
      const nameNode = namedField(node, "name");
      if (nameNode) {
        out.push(makeDecl(node, nameNode.text, kindText, parent_name, parent_kind));
      }
      // Don't recurse — v1 caps depth at 1.
      break;
    }
    case "protocol_declaration": {
      const nameNode = namedField(node, "name");
      if (nameNode) {
        out.push(makeDecl(node, nameNode.text, "protocol", parent_name, parent_kind));
      }
      break;
    }
    // Anything else (statements, computed-property accessors, comments, ...)
    // is ignored.
  }
}

function walkProtocolMember(node, out, parent_name) {
  switch (node.type) {
    case "protocol_function_declaration":
    case "function_declaration": {
      const name = namedField(node, "name");
      if (name) {
        out.push(makeDecl(node, name.text, "func", parent_name, "protocol", functionSignatureHint(node)));
      }
      break;
    }
    case "protocol_property_declaration":
    case "property_declaration": {
      pushPropertyDecl(node, out, parent_name, "protocol");
      break;
    }
    case "init_declaration":
    case "protocol_init_declaration": {
      out.push(makeDecl(node, "init", "init", parent_name, "protocol", functionSignatureHint(node)));
      break;
    }
    case "subscript_declaration":
    case "protocol_subscript_declaration": {
      out.push(makeDecl(node, "subscript", "subscript", parent_name, "protocol", functionSignatureHint(node)));
      break;
    }
    case "associatedtype_declaration": {
      const name = namedField(node, "name");
      if (name) out.push(makeDecl(node, name.text, "associatedtype", parent_name, "protocol"));
      break;
    }
    case "typealias_declaration": {
      const name = namedField(node, "name");
      if (name) out.push(makeDecl(node, name.text, "typealias", parent_name, "protocol"));
      break;
    }
  }
}

function pushPropertyDecl(node, out, parent_name, parent_kind) {
  // property_declaration → pattern → (bound_identifier field) simple_identifier
  // OR: var name: Type { ... } where the simple_identifier is reachable via the pattern field.
  const patternNode = namedField(node, "name");
  if (!patternNode) {
    // Fallback: walk children for the first pattern with a simple_identifier.
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c.type === "pattern") {
        const sid = findFirst(c, ["simple_identifier"]);
        if (sid) {
          // Determine var vs let from the value_binding_pattern child.
          const binding = firstChildOfType(node, "value_binding_pattern");
          const isLet = binding && binding.text === "let";
          out.push(makeDecl(node, sid.text, isLet ? "let" : "var", parent_name, parent_kind));
          return;
        }
      }
    }
    return;
  }
  // patternNode IS a pattern node (Swift grammar uses `name` field on
  // property_declaration to point at the pattern).
  const sid = findFirst(patternNode, ["simple_identifier"]);
  if (!sid) return;
  const binding = firstChildOfType(node, "value_binding_pattern");
  const isLet = binding && binding.text === "let";
  out.push(makeDecl(node, sid.text, isLet ? "let" : "var", parent_name, parent_kind));
}

// --- Relations walker ---

function walkTopLevelRelations(node, out) {
  if (node.type === "class_declaration") {
    emitClassLikeRelations(node, out);
  } else if (node.type === "protocol_declaration") {
    emitTypeHeritageRelations(node, "protocol", out);
  }
}

function emitClassLikeRelations(node, out) {
  const kindNode = namedField(node, "declaration_kind");
  const kindText = kindNode ? kindNode.text : "class";

  if (kindText === "extension") {
    const target = extensionTargetName(node);
    if (!target) return;
    // The extension itself extends the target type — direct syntactic fact.
    out.push(makeRelation(node, target, "extends", target, "direct"));
    // Heritage entries on the extension are conformances — direct (Swift only
    // allows protocols in extension conformance lists).
    emitHeritageEntries(node, target, kindText, out, /*classFirstSlot=*/false);
    return;
  }

  const nameNode = namedField(node, "name");
  if (!nameNode) return;
  emitTypeHeritageRelations(node, kindText, out);
}

function emitTypeHeritageRelations(node, kindText, out) {
  const nameNode = namedField(node, "name");
  if (!nameNode) return;
  const sourceName = nameNode.text;
  // For class: first heritage slot is heuristic (could be base class or protocol).
  // For struct/enum/protocol/actor: all heritage entries are protocols (direct).
  // Enum first slot can be a raw-value type; mark heuristic.
  emitHeritageEntries(node, sourceName, kindText, out, /*classFirstSlot=*/true);
}

function emitHeritageEntries(node, sourceName, kindText, out, classFirstSlot) {
  let slotIndex = 0;
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c.type !== "inheritance_specifier") continue;
    const target = heritageTargetName(c);
    if (!target) { slotIndex++; continue; }

    if (kindText === "class" && classFirstSlot && slotIndex === 0) {
      // Heuristic split: does the first slot look like a protocol or a base class?
      if (looksLikeProtocolName(target)) {
        out.push(makeRelation(node, sourceName, "conforms_to", target, "heuristic"));
      } else {
        out.push(makeRelation(node, sourceName, "inherits_from", target, "heuristic"));
      }
    } else if (kindText === "enum" && slotIndex === 0) {
      // Enum first slot may be a raw-value type (Int, String) OR a protocol.
      // Mark as conforms_to heuristic — calling code can filter.
      out.push(makeRelation(node, sourceName, "conforms_to", target, "heuristic"));
    } else {
      // class slots 1+ → conforms_to heuristic (still uncertain but Swift
      // syntax pins them to protocols since base class must be first).
      // struct/protocol/actor any slot, extension any slot → direct (Swift
      // syntax permits only protocols there).
      const conf = (kindText === "class") ? "heuristic" : "direct";
      out.push(makeRelation(node, sourceName, "conforms_to", target, conf));
    }
    slotIndex++;
  }
}

module.exports = {
  extensions: SUPPORTED_EXTENSIONS,
  extractImports,
  extractExports,
  extractDeclarations,
  extractRelations,
  hasAtMain,
  AT_MAIN_RE,
  // Lifecycle (called by intel.js)
  ensureReady,
  isReady,
  getCounters,
  resetCounters,
};
