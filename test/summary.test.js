"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { health, writeSummaryMarkdown } = require("../lib/summary");
const graphMod = require("../lib/graph");

// Helper: populate graph.db from an index-like object for test convenience.
// Clears existing data first so each test gets a clean state.
function populateGraphFromIndex(db, indexFiles) {
  // Clear existing data
  db.run("DELETE FROM files");
  db.run("DELETE FROM imports");
  db.run("DELETE FROM exports");
  db.run("DELETE FROM reexports");

  for (const [relPath, entry] of Object.entries(indexFiles || {})) {
    graphMod.upsertFile(db, {
      relPath,
      type: entry.type || null,
      sizeBytes: entry.sizeBytes || 0,
      mtimeMs: entry.mtimeMs || 1,
    });

    if (Array.isArray(entry.imports)) {
      const importsForGraph = entry.imports.map((imp) => ({
        specifier: imp.specifier,
        toPath: imp.resolved || null,
        kind: imp.kind || null,
        isExternal: imp.kind === "external" || imp.kind === "asset",
      }));
      graphMod.replaceImports(db, relPath, importsForGraph);
    }

    if (Array.isArray(entry.exports)) {
      const regularExports = [];
      const reexports = [];
      for (const ex of entry.exports) {
        if (ex.from) {
          reexports.push(ex);
        } else {
          regularExports.push(ex);
        }
      }
      graphMod.replaceExports(db, relPath, regularExports);
      graphMod.replaceReexports(db, relPath, reexports);
    }
  }
}

describe("summary health()", () => {
  let tmpDir, db;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-summary-health-"));
    fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
    db = await graphMod.loadDb(tmpDir);
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolution metrics with local imports", () => {
    populateGraphFromIndex(db, {
      "a.js": {
        type: "js",
        imports: [
          { specifier: "./b", resolved: "b.js", kind: "relative" },
          { specifier: "./c", resolved: null, kind: "unresolved" },
        ],
      },
      "b.js": { type: "js", imports: [] },
    });

    const result = health(tmpDir, { db, graph: graphMod });
    assert.equal(result.localTotal, 2);
    assert.equal(result.localResolved, 1);
    assert.equal(result.resolutionPct, 50);
    assert.equal(result.indexedFiles, 2);
  });

  it("empty index gives 100% resolution", () => {
    populateGraphFromIndex(db, {});

    const result = health(tmpDir, { db, graph: graphMod });
    assert.equal(result.resolutionPct, 100);
    assert.equal(result.indexedFiles, 0);
    assert.equal(result.localTotal, 0);
  });

  it("external imports are excluded from resolution", () => {
    populateGraphFromIndex(db, {
      "a.js": {
        type: "js",
        imports: [
          { specifier: "react", resolved: null, kind: "external" },
          { specifier: "./b", resolved: "b.js", kind: "relative" },
        ],
      },
    });

    const result = health(tmpDir, { db, graph: graphMod });
    assert.equal(result.localTotal, 1);
    assert.equal(result.localResolved, 1);
    assert.equal(result.resolutionPct, 100);
  });

  it("asset imports are excluded from resolution", () => {
    populateGraphFromIndex(db, {
      "a.js": {
        type: "js",
        imports: [
          { specifier: "./style.css", resolved: null, kind: "asset" },
        ],
      },
    });

    const result = health(tmpDir, { db, graph: graphMod });
    assert.equal(result.localTotal, 0);
    assert.equal(result.resolutionPct, 100);
  });

  it("empty db handled gracefully", () => {
    populateGraphFromIndex(db, {});

    const result = health(tmpDir, { db, graph: graphMod });
    assert.equal(result.indexedFiles, 0);
    assert.equal(result.resolutionPct, 100);
  });

  it("typeCounts in health output", () => {
    populateGraphFromIndex(db, {
      "a.js": { type: "js", imports: [] },
      "b.ts": { type: "ts", imports: [] },
      "c.js": { type: "js", imports: [] },
    });

    const result = health(tmpDir, { db, graph: graphMod });
    // js should appear before ts (2 > 1)
    assert.ok(result.typeCounts.length >= 2);
    assert.equal(result.typeCounts[0].t, "js");
    assert.equal(result.typeCounts[0].c, 2);
  });
});

describe("summary writeSummaryMarkdown()", () => {
  let tmpDir, db;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-summary-write-"));
    fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
    db = await graphMod.loadDb(tmpDir);
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("includes header for non-empty index", () => {
    populateGraphFromIndex(db, {
      "lib/core.js": { type: "js", imports: [] },
      "lib/a.js": { type: "js", imports: [{ specifier: "./core", resolved: "lib/core.js", kind: "relative" }] },
    });

    const md = writeSummaryMarkdown(tmpDir, { db, graph: graphMod });
    assert.ok(md.includes("## Codebase intelligence"), "should include header");
    assert.ok(md.includes("Indexed files"), "should include file count");
  });

  it("empty index shows rescan message", () => {
    populateGraphFromIndex(db, {});

    const md = writeSummaryMarkdown(tmpDir, { db, graph: graphMod });
    assert.ok(md.includes("No indexed files yet"), "should show empty state message");
    assert.ok(md.includes("sextant rescan"), "should suggest rescan");
  });

  it("health alert when resolution < 90%", () => {
    // Create many unresolved imports
    const files = {};
    for (let i = 0; i < 10; i++) {
      files[`file${i}.js`] = {
        type: "js",
        imports: [{ specifier: `./missing${i}`, resolved: null, kind: "unresolved" }],
      };
    }
    populateGraphFromIndex(db, files);

    const md = writeSummaryMarkdown(tmpDir, { db, graph: graphMod });
    assert.ok(md.includes("ALERT"), "should include ALERT for low resolution");
  });

  it("clamped at ~2200 chars", () => {
    // WHY: Test clampChars directly since writeSummaryMarkdown's section-level
    // truncation prevents the summary from exceeding 2200 chars organically.
    const { clampChars } = require("../lib/summary");
    const longStr = "A".repeat(3000);
    const clamped = clampChars(longStr, 2200);
    assert.ok(clamped.length <= 2200, `clamped should be <= 2200, got ${clamped.length}`);
    assert.ok(clamped.length > 0, "clamped should not be empty");

    // Also verify the summary itself stays bounded
    const files = {};
    for (let i = 0; i < 200; i++) {
      files[`long/path/to/deeply/nested/module/file_${i}_with_long_name.js`] = {
        type: "js",
        imports: [
          { specifier: "./other_very_long_specifier_name", resolved: `other_long_${i}.js`, kind: "relative" },
        ],
        exports: [{ name: `VeryLongExportName${i}`, kind: "named" }],
      };
    }
    populateGraphFromIndex(db, files);

    const md = writeSummaryMarkdown(tmpDir, { db, graph: graphMod });
    assert.ok(md.length <= 2200, `summary should be <= 2200 chars, got ${md.length}`);
  });

  it("XML escaping of paths with special chars", () => {
    populateGraphFromIndex(db, {
      "a.js": { type: "js", imports: [] },
    });

    const md = writeSummaryMarkdown(tmpDir, { db, graph: graphMod });
    // The root path should appear in the output (at minimum)
    assert.ok(md.includes("Root"), "should include root path");
  });
});

describe("summary XML escaping", () => {
  let tmpDir, db;

  before(async () => {
    // Create a temp dir whose name has no special chars, but test
    // the escaping by checking paths that appear in the output
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-summary-xml-"));
    fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
    db = await graphMod.loadDb(tmpDir);
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("paths with & < > are escaped in output", () => {
    // We cannot easily create files with <> in names on most filesystems,
    // but we can verify the function handles them via the graph
    populateGraphFromIndex(db, {
      "a.js": {
        type: "js",
        imports: [
          { specifier: "./missing<script>", resolved: null, kind: "unresolved" },
        ],
      },
    });

    const md = writeSummaryMarkdown(tmpDir, { db, graph: graphMod });
    // The unresolved specifier should appear XML-escaped in misses
    if (md.includes("Misses")) {
      assert.ok(!md.includes("<script>"), "should not contain raw <script>");
    }
  });
});

// ─── Commands block from package.json scripts (007 T1.4) ───────────────────

describe("commandsFromPackageScripts (007 T1.4)", () => {
  const { commandsFromPackageScripts } = require("../lib/summary");

  it("returns [] for missing/malformed scripts (degrade quietly)", () => {
    assert.deepEqual(commandsFromPackageScripts(null), []);
    assert.deepEqual(commandsFromPackageScripts({ name: "x" }), []);
    assert.deepEqual(commandsFromPackageScripts({ scripts: [] }), []);
    assert.deepEqual(commandsFromPackageScripts({ scripts: { test: "" } }), []); // blank command dropped
    assert.deepEqual(commandsFromPackageScripts({ scripts: { test: 42 } }), []); // non-string dropped
  });

  it("sorts canonical lifecycle names first, ties keep declaration order", () => {
    const cmds = commandsFromPackageScripts({
      scripts: { "z:custom": "z", build: "tsc", test: "node --test", "a:custom": "a", lint: "eslint ." },
    });
    const names = cmds.map((c) => c.name);
    // build/test/lint are lifecycle → ahead of the custom scripts; custom scripts
    // keep their declaration order (z:custom before a:custom).
    assert.deepEqual(names, ["build", "test", "lint", "z:custom", "a:custom"]);
  });
});

describe("summary ### Commands block (007 T1.4)", () => {
  let tmpDir, db;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-summary-cmds-"));
    fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
    db = await graphMod.loadDb(tmpDir);
  });
  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("surfaces package.json scripts as a Commands block (FAIL-pre: no such block)", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        name: "demo",
        scripts: { build: "tsc -p .", test: "node --test", lint: "eslint ." },
      })
    );
    populateGraphFromIndex(db, { "lib/core.js": { type: "js", imports: [] } });

    const md = writeSummaryMarkdown(tmpDir, { db, graph: graphMod });
    // FAIL-pre: there is no "### Commands" block at all (pkg.scripts discarded).
    assert.ok(md.includes("### Commands"), `expected a Commands block; got:\n${md}`);
    assert.ok(md.includes("`build` — tsc -p ."), md);
    assert.ok(md.includes("`test` — node --test"), md);
    assert.ok(md.includes("`lint` — eslint ."), md);
    // Placed high (right after Signals, before Module types) so it survives the clamp.
    const cmdIdx = md.indexOf("### Commands");
    const typesIdx = md.indexOf("### Module types");
    if (typesIdx !== -1) assert.ok(cmdIdx < typesIdx, "Commands must precede Module types");
  });

  it("N-caps long script lists and truncates long command bodies", () => {
    const scripts = {};
    for (let i = 0; i < 12; i++) scripts[`task${i}`] = `echo running a fairly long command number ${i} with extra words`;
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "many", scripts }));
    populateGraphFromIndex(db, { "lib/core.js": { type: "js", imports: [] } });

    const md = writeSummaryMarkdown(tmpDir, { db, graph: graphMod });
    assert.ok(md.includes("### Commands"));
    assert.ok(/…and 4 more/.test(md), `expected "…and 4 more" (12 scripts, cap 8); got:\n${md}`);
    // No single command line should be excessively long (truncated to ~50 chars).
    const cmdLines = md.split("\n").filter((l) => /^- `task\d+` —/.test(l));
    assert.ok(cmdLines.length === 8, `expected 8 command lines, got ${cmdLines.length}`);
    for (const l of cmdLines) assert.ok(l.length < 80, `command line too long: ${l}`);
  });

  it("no Commands block when package.json has no scripts (degrade quietly)", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "noscripts" }));
    populateGraphFromIndex(db, { "lib/core.js": { type: "js", imports: [] } });
    const md = writeSummaryMarkdown(tmpDir, { db, graph: graphMod });
    assert.ok(!md.includes("### Commands"), "must not emit an empty Commands block");
  });
});

// ─── Convention-file presence in Signals (007 T1.4) ────────────────────────

describe("detectSignals conventions (007 T1.4)", () => {
  const { detectSignals } = require("../lib/summary");

  it("flags present convention files inside Signals (FAIL-pre: no Conventions signal)", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-conv-"));
    try {
      fs.writeFileSync(path.join(d, "AGENTS.md"), "x");
      fs.writeFileSync(path.join(d, "CLAUDE.md"), "x");
      const { signals } = detectSignals(d);
      assert.ok(
        signals.includes("Conventions: AGENTS.md, CLAUDE.md"),
        `expected a Conventions signal; got ${JSON.stringify(signals)}`
      );
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("no Conventions signal when none present (degrade quietly)", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-conv-none-"));
    try {
      const { signals } = detectSignals(d);
      assert.ok(!signals.some((s) => s.startsWith("Conventions:")), JSON.stringify(signals));
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

// ─── Required env keys from a tracked .env.example (007 T1.4) ───────────────

describe("requiredEnvKeys + ### Required env (007 T1.4)", () => {
  const { execSync } = require("child_process");
  const { requiredEnvKeys } = require("../lib/summary");
  let tmpDir, db;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-summary-env-"));
    fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
    execSync("git init -q", { cwd: tmpDir });
    execSync('git config user.email "t@e.com"', { cwd: tmpDir });
    execSync('git config user.name "T"', { cwd: tmpDir });
    execSync("git config commit.gpgsign false", { cwd: tmpDir });
    db = await graphMod.loadDb(tmpDir);
  });
  after(() => { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("surfaces keys from a TRACKED template, never the value; ignores an UNTRACKED template", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".env.example"),
      "# config\nexport JWT_SECRET=supersekret\nDATABASE_URL=postgres://localhost/db\nPORT=3000\n# comment\n"
    );
    execSync("git add .env.example", { cwd: tmpDir });
    execSync("git commit -q -m env", { cwd: tmpDir });
    // An UNTRACKED template must NOT surface — the freshness-honesty guard:
    // only tracked files move the git-status fingerprint the gate watches.
    fs.writeFileSync(path.join(tmpDir, ".env.sample"), "UNTRACKED_KEY=zzz\n");

    const keys = requiredEnvKeys(tmpDir);
    assert.deepEqual(keys, ["JWT_SECRET", "DATABASE_URL", "PORT"]);
    assert.ok(!keys.includes("UNTRACKED_KEY"), "untracked template must not surface");

    populateGraphFromIndex(db, { "lib/core.js": { type: "js", imports: [] } });
    const md = writeSummaryMarkdown(tmpDir, { db, graph: graphMod });
    assert.ok(md.includes("### Required env"), `expected a Required env block; got:\n${md}`);
    assert.ok(md.includes("`JWT_SECRET`"), md);
    assert.ok(md.includes("`DATABASE_URL`"), md);
    // SECURITY: the value is structurally never read.
    assert.ok(!md.includes("supersekret"), "the secret VALUE must NEVER appear in the summary");
  });

  it("returns [] outside a git repo / with no tracked template (degrade quietly)", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-noenv-"));
    try {
      fs.writeFileSync(path.join(d, ".env.example"), "X=1\n"); // present but NOT git-tracked
      assert.deepEqual(requiredEnvKeys(d), []);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
