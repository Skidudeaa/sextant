"use strict";

// NL -> EXPORT-TOKEN BRIDGE (docs/035 #4, Layer 5).
//
// findExportsBySymbol is LOWER(name) = LOWER(?) — pure exact match — so the
// dependency-graph half of retrieval is reachable only when the user types a
// symbol. Measured on 1,185 real prompts across 11 repos: the export lane is
// reached on 6.0% of classifier fires (sextant's own repo: 0 of 35), while
// driving the same lane with a repo's OWN exported symbols hits 95-100%. The
// lane works; users type prose.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const graph = require("../lib/graph");
const graphRetrieve = require("../lib/graph-retrieve");
const C = require("../lib/scoring-constants");

describe("tokenizeExportName", () => {
  const t = graph.tokenizeExportName;

  it("splits the naming conventions authors actually use", async () => {
    const { db } = await setup();
    assert.deepEqual(t("FLAG_REGISTRY").sort(), ["flag", "registry"]);
    assert.deepEqual(t("createElement").sort(), ["create", "element"]);
    assert.deepEqual(t("useState").sort(), ["state", "use"]);
    assert.deepEqual(t("HTTPServer").sort(), ["http", "server"]);
    assert.deepEqual(t("kebab-case-name").sort(), ["case", "kebab", "name"]);
  });

  it("drops sub-3-char tokens — they are noise a df cap would have to fight", async () => {
    const { db } = await setup();
    assert.deepEqual(t("getId"), ["get"]);
    assert.deepEqual(t("toURL").sort(), ["url"]);
  });

  it("is total on junk input", async () => {
    const { db } = await setup();
    for (const bad of [null, undefined, "", 42, {}, "___", "a"]) {
      assert.deepEqual(graph.tokenizeExportName(bad), []);
    }
  });
});

// Built once, awaited by every test. An async `before` hook races the sync
// describe body in node:test — subtests get cancelled before the db exists
// ("test did not finish before its parent"). Awaiting a shared promise inside
// each async test body is the shape that actually works here.
let setupPromise = null;
function setup() {
  if (!setupPromise) setupPromise = build();
  return setupPromise;
}
async function build() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-token-"));
  fs.mkdirSync(path.join(dir, ".planning", "intel"), { recursive: true });
  const db = await graph.loadDb(dir);
  graph.upsertFile(db, { relPath: "app/feature_gate.py", type: "py" });
  graph.upsertFile(db, { relPath: "app/__init__.py", type: "py" });
  graph.upsertFile(db, { relPath: "app/test_feature_gate.py", type: "py" });
  graph.upsertFile(db, { relPath: "app/builders.py", type: "py" });
  // The definition, the barrel that re-exports it (kind "explicit"), and a test
  // file whose function name also contains the token.
  graph.replaceExports(db, "app/feature_gate.py", [{ name: "FLAG_REGISTRY", kind: "const" }]);
  graph.replaceExports(db, "app/__init__.py", [{ name: "FLAG_REGISTRY", kind: "explicit" }]);
  graph.replaceExports(db, "app/test_feature_gate.py", [
    { name: "test_registry_contains_known_flags", kind: "function" },
  ]);
  graph.replaceExports(db, "app/builders.py", [{ name: "WidgetBuilder", kind: "class" }]);
  // Exact-match target for the term "Widget". app/builders.py above only
  // TOKEN-matches it, so if Layer 5 ever fires while Layer 1 has answered,
  // app/builders.py appears alongside it and the leak is visible.
  graph.upsertFile(db, { relPath: "app/widget_registry.py", type: "py" });
  // Case-distinctive on purpose: Layer 1 gates a non-code-shaped term behind
  // fan-in >= 5 OR an exact-case match on a distinctive name (docs/012). An
  // all-lowercase "widget" would be GATED OUT, leaving the map empty and Layer 5
  // legitimately free to fire — which made the first version of this test vacuous.
  graph.replaceExports(db, "app/widget_registry.py", [{ name: "Widget", kind: "class" }]);
  return { dir, db };
}

describe("Layer 5 — the export-token bridge", () => {
  it("reaches a definition the exact-match lane cannot", async () => {
    const { db } = await setup();
    // FAIL-pre: the term is a natural word, so exact match returns nothing.
    assert.deepEqual(graph.findExportsBySymbol(db, "registry"), []);
    const cap = graph.exportTokenDfCap(db);
    const hits = graph.findExportsByToken(db, "registry", cap).map((h) => h.path);
    assert.ok(hits.includes("app/feature_gate.py"));
  });

  it("routes the barrel to reexport_chain so the DEFINITION wins", async () => {
    const { db } = await setup();
    // The B3 pathology py-penalty-001 exists to catch: app/__init__.py also
    // matches the token, and without kind==="explicit" routing it lands above
    // the module that actually defines the symbol.
    const r = graphRetrieve.graphRetrieve(db, ["registry"], {});
    const byPath = new Map(r.files.map((f) => [f.path, f]));
    const def = byPath.get("app/feature_gate.py");
    const barrel = byPath.get("app/__init__.py");
    assert.ok(def, "the definition must be surfaced");
    assert.equal(def.hitType, C.HIT_EXPORT_TOKEN);
    if (barrel) {
      assert.equal(barrel.hitType, C.HIT_REEXPORT_CHAIN);
      assert.ok(def.score > barrel.score, `def ${def.score} must outrank barrel ${barrel.score}`);
    }
    assert.equal(r.files[0].path, "app/feature_gate.py", "def at rank 1");
  });

  it("excludes test paths (0 opens in 89 real surfacings, docs/012)", async () => {
    const { db } = await setup();
    const r = graphRetrieve.graphRetrieve(db, ["registry"], {});
    assert.ok(
      !r.files.some((f) => f.path === "app/test_feature_gate.py"),
      "a test-file export must never be surfaced by this lane"
    );
    // …even though the token genuinely matches it.
    const cap = graph.exportTokenDfCap(db);
    assert.ok(
      graph.findExportsByToken(db, "registry", cap).some((h) => h.path === "app/test_feature_gate.py"),
      "the raw lookup DOES match it — the exclusion is the guard, not the query"
    );
  });

  it("scores strictly between path-match-strong and exported-symbol", async () => {
    const { db } = await setup();
    // A token match is stronger than a fuzzy filename match (it is a real export
    // name the author wrote) but weaker than an exact symbol match. It must
    // never be treated as a definition claim.
    assert.ok(C.GR_EXPORT_TOKEN > C.GR_PATH_MATCH_STRONG);
    assert.ok(C.GR_EXPORT_TOKEN < C.GR_EXPORTED_SYMBOL);
    const merge = fs.readFileSync(path.join(__dirname, "..", "lib", "merge-results.js"), "utf8");
    const defTypes = merge.match(/const DEF_SIGNAL_TYPES = new Set\(\[([^\]]*)\]/)[1];
    assert.ok(
      !defTypes.includes("EXPORT_TOKEN"),
      "export_token must NOT receive DEF_SCORE_FLOOR — it is a candidate, not an answer"
    );
  });

  it("does NOT fire when an earlier layer already answered", async () => {
    const { db } = await setup();
    // The whole no-regression argument rests on this: any query that already
    // reached the graph is byte-identical, which is why self-eval and the Vapor
    // baselines cannot move. Asserted with a COLLIDING pair — "widget" exact-
    // "Widget" exact-matches app/widget_registry.py (Layer 1, via the
    // exact-distinctive-case branch) and token-matches app/builders.py (Layer 5)
    // (Layer 5) — because an assertion that only checks the exact-match file
    // is vacuous: addOrUpgrade keeps the higher score, so the leak hides.
    const exact = graphRetrieve.graphRetrieve(db, ["Widget"], {});
    const paths = exact.files.map((f) => f.path);
    assert.ok(paths.includes("app/widget_registry.py"), "Layer 1 answered");
    assert.ok(
      !paths.includes("app/builders.py"),
      "Layer 5 must stay silent when Layers 1-3 produced results (token-only match leaked in). " +
        "app/builders.py is named so it cannot be reached by Layer 4 path-match — if it appears, " +
        "it came from the token lane."
    );
    assert.ok(exact.files.every((f) => f.hitType !== C.HIT_EXPORT_TOKEN));
  });

  it("suppresses a token too generic to discriminate", async () => {
    const { db } = await setup();
    const cap = graph.exportTokenDfCap(db);
    // Force the cap below the token's own df: the lookup must refuse rather
    // than surface a `test`/`default`-class match.
    const df = graph.exportTokenDocFrequency(db, "registry");
    assert.ok(df >= 1);
    assert.deepEqual(graph.findExportsByToken(db, "registry", df - 1), []);
    assert.ok(cap >= 3, "the cap has a floor so a tiny repo does not gate everything out");
  });
});
