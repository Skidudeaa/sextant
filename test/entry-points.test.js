"use strict";

// T1.1 — Authoritative entry-point map from manifests.
//
// Two separable scored deltas, both covered here:
//   (1) lib/utils.js isEntryPoint JS branch gains a basename anchor so a
//       file like `lib/zoekt-reindex.js` no longer matches `index.js` as a
//       substring (false positive that also leaked a +10% retrieval boost).
//   (2) lib/summary.js threads the already-loaded package.json `bin` field and
//       hand-parses pyproject `[project.scripts]` to surface MANIFEST-declared
//       entry points AHEAD of filename heuristics, source-tagging every row.
//
// The regex anchor alone does NOT remove the `lib/extractors/index.js` barrel
// (a legitimate `index.js` filename match) — only manifest-authoritative
// ordering/filtering demotes it.  Both halves are asserted independently.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { isEntryPoint } = require("../lib/utils");
const { writeSummaryMarkdown } = require("../lib/summary");
const graphMod = require("../lib/graph");

// ─── Delta 1: utils.js basename anchor on the JS branch ───────────────────

describe("isEntryPoint: JS branch basename anchor (T1.1 delta 1)", () => {
  it("does NOT match a name that merely ENDS in a canonical entry word", () => {
    // `zoekt-reindex.js` ends with `index.js` only as a substring.  Pre-fix
    // this returned true (false positive) and granted a phantom +10% boost.
    assert.equal(isEntryPoint("lib/zoekt-reindex.js"), false);
    assert.equal(isEntryPoint("zoekt-reindex.js"), false);
    // Adjacent shapes that share the substring trap.
    assert.equal(isEntryPoint("lib/preindex.js"), false);
    assert.equal(isEntryPoint("src/subapp.js"), false);
    assert.equal(isEntryPoint("lib/myrouter.js"), false);
  });

  it("STILL matches a genuine canonical basename", () => {
    assert.equal(isEntryPoint("lib/extractors/index.js"), true);
    assert.equal(isEntryPoint("src/index.ts"), true);
    assert.equal(isEntryPoint("src/main.tsx"), true);
    assert.equal(isEntryPoint("app/router.js"), true);
    assert.equal(isEntryPoint("lib/routes.mjs"), true);
    assert.equal(isEntryPoint("app.js"), true);
  });
});

// ─── Delta 2: manifest-authoritative entry-point list in the summary ──────

// Build a minimal graph the same way summary.test.js does.
function populateFiles(db, relPaths) {
  db.run("DELETE FROM files");
  db.run("DELETE FROM imports");
  db.run("DELETE FROM exports");
  db.run("DELETE FROM reexports");
  for (const relPath of relPaths) {
    graphMod.upsertFile(db, { relPath, type: "js", sizeBytes: 1, mtimeMs: 1 });
  }
}

// Extract just the "Likely entry points" section's bullet lines.
function entryLines(md) {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.includes("Likely entry points"));
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("### ")) break;
    if (l.startsWith("- ")) out.push(l);
  }
  return out;
}

describe("summary entry points: package.json bin authoritative (T1.1 delta 2)", () => {
  let tmpDir, db;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-entry-bin-"));
    fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
    db = await graphMod.loadDb(tmpDir);
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("surfaces bin target ahead of heuristics; demotes barrel + substring false positives; source-tags rows", () => {
    // Mirror the real sextant repo: a `bin` dispatcher the heuristic misses,
    // a barrel `index.js` the heuristic falsely promotes, and a substring
    // false positive (`zoekt-reindex.js`).
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        name: "demo",
        bin: { sextant: "bin/intel.js", "codebase-intel": "bin/intel.js" },
      })
    );
    populateFiles(db, [
      "bin/intel.js",
      "lib/extractors/index.js",
      "lib/zoekt-reindex.js",
      "src/main.js",
    ]);

    const md = writeSummaryMarkdown(tmpDir, { db, graph: graphMod });
    const elines = entryLines(md);
    const block = elines.join("\n");

    // PASS-POST expectations (the FAIL-PRE inverse is documented inline):

    // (a) bin/intel.js — the manifest dispatcher — IS present and declared.
    //     FAIL-PRE: absent (matched no heuristic pattern).
    assert.ok(
      elines.some((l) => l.includes("bin/intel.js")),
      `bin/intel.js must appear; got:\n${block}`
    );
    assert.ok(
      elines.some((l) => l.includes("bin/intel.js") && l.includes("— declared")),
      `bin/intel.js must be source-tagged "— declared"; got:\n${block}`
    );

    // (b) The substring false positive is gone (delta 1 anchor).
    //     FAIL-PRE: present (matched `index.js` substring).
    assert.ok(
      !elines.some((l) => l.includes("zoekt-reindex.js")),
      `zoekt-reindex.js must NOT appear; got:\n${block}`
    );

    // (c) The barrel `lib/extractors/index.js` is demoted/excluded.  The regex
    //     anchor alone does NOT do this — only manifest-authoritative ranking.
    //     FAIL-PRE: present.
    assert.ok(
      !elines.some((l) => l.includes("lib/extractors/index.js")),
      `barrel lib/extractors/index.js must be demoted/excluded; got:\n${block}`
    );

    // (d) A heuristic-only entry that is NOT a manifest target keeps the
    //     "(heuristic)" source tag.
    assert.ok(
      elines.some((l) => l.includes("src/main.js") && l.includes("(heuristic)")),
      `src/main.js must be tagged "(heuristic)"; got:\n${block}`
    );

    // (e) Manifest entry sorts AHEAD of heuristic entries.
    const binIdx = elines.findIndex((l) => l.includes("bin/intel.js"));
    const mainIdx = elines.findIndex((l) => l.includes("src/main.js"));
    assert.ok(binIdx !== -1 && mainIdx !== -1 && binIdx < mainIdx,
      `manifest entry must precede heuristic entry; got:\n${block}`);
  });

  it("parses bin as a plain string (single-binary package)", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "single", bin: "cli/run.js" })
    );
    populateFiles(db, ["cli/run.js", "lib/helper.js"]);

    const md = writeSummaryMarkdown(tmpDir, { db, graph: graphMod });
    const elines = entryLines(md);
    assert.ok(
      elines.some((l) => l.includes("cli/run.js") && l.includes("— declared")),
      `string bin "cli/run.js" must be declared; got:\n${elines.join("\n")}`
    );
  });
});

describe("summary entry points: pyproject [project.scripts] (T1.1 delta 2)", () => {
  let tmpDir, db;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-entry-py-"));
    fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
    db = await graphMod.loadDb(tmpDir);
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("surfaces a [project.scripts] module:func target as a declared entry", () => {
    // NOTE: package dir is `webapp/` (not `demo/`) — `demo/` collides with the
    // pre-existing test-path exclusion (`demos?` matches a `demo/` segment),
    // which would correctly drop it. Real package dirs avoid that collision.
    fs.writeFileSync(
      path.join(tmpDir, "pyproject.toml"),
      [
        "[project]",
        'name = "webapp"',
        "",
        "[project.scripts]",
        'webapp-cli = "webapp.cli:main"',
        "",
      ].join("\n")
    );
    // `webapp.cli:main` → module `webapp.cli` → file `webapp/cli.py`.
    graphMod.upsertFile(db, { relPath: "webapp/cli.py", type: "py", sizeBytes: 1, mtimeMs: 1 });
    graphMod.upsertFile(db, { relPath: "webapp/util.py", type: "py", sizeBytes: 1, mtimeMs: 1 });

    const md = writeSummaryMarkdown(tmpDir, { db, graph: graphMod });
    const elines = entryLines(md);
    assert.ok(
      elines.some((l) => l.includes("webapp/cli.py") && l.includes("— declared")),
      `[project.scripts] target webapp/cli.py must be declared; got:\n${elines.join("\n")}`
    );
  });

  it("surfaces the python-eval fixture's [project.scripts] entry as declared", async () => {
    // Lock the fixture wiring: fixtures/python-eval/pyproject.toml gains a
    // [project.scripts] entry that must resolve to a real fixture module.
    const fixtureRoot = path.resolve(__dirname, "..", "fixtures", "python-eval");
    const toml = fs.readFileSync(path.join(fixtureRoot, "pyproject.toml"), "utf8");
    assert.ok(/\[project\.scripts\]/.test(toml), "fixture must declare [project.scripts]");

    // Build a graph from the fixture's actual .py files so the declared
    // target resolves to an indexed file.
    const fixDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-entry-fixture-"));
    fs.mkdirSync(path.join(fixDir, ".planning", "intel"), { recursive: true });
    const fixDb = await graphMod.loadDb(fixDir);
    // Copy the manifest so summary reads it from the same root.
    fs.copyFileSync(path.join(fixtureRoot, "pyproject.toml"), path.join(fixDir, "pyproject.toml"));

    // Index every .py under the fixture (relative paths).
    const walk = (dir, base) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        const rel = path.relative(base, abs);
        if (e.isDirectory()) walk(abs, base);
        else if (e.name.endsWith(".py"))
          graphMod.upsertFile(fixDb, { relPath: rel.split(path.sep).join("/"), type: "py", sizeBytes: 1, mtimeMs: 1 });
      }
    };
    walk(fixtureRoot, fixtureRoot);

    const md = writeSummaryMarkdown(fixDir, { db: fixDb, graph: graphMod });
    const elines = entryLines(md);
    assert.ok(
      elines.some((l) => l.includes("— declared")),
      `fixture pyproject [project.scripts] must surface a declared entry; got:\n${elines.join("\n")}`
    );

    fs.rmSync(fixDir, { recursive: true, force: true });
  });
});
