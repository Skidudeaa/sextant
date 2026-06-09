const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  diagnoseScanCoverage,
  detectUnsupportedLanguageSignals,
  hasBroadJsTsGlob,
} = require("../lib/coverage-diagnostics");

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sextant-cov-"));
}
function rmrf(p) {
  if (p) fs.rmSync(p, { recursive: true, force: true });
}
function write(root, rel, content = "// x\n") {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const IGNORE = ["**/node_modules/**", "**/.git/**"];

describe("coverage-diagnostics — unsupported-language detection", () => {
  it("flags Go, Rust, Ruby build signals", () => {
    const root = tmpRoot();
    try {
      write(root, "go.mod", "module x\n");
      write(root, "Cargo.toml", "[package]\n");
      const hits = detectUnsupportedLanguageSignals(root);
      assert.ok(hits.some((h) => /Go/.test(h)), "Go detected");
      assert.ok(hits.some((h) => /Rust/.test(h)), "Rust detected");
    } finally {
      rmrf(root);
    }
  });

  it("does NOT flag Package.swift — Swift is supported (regression)", () => {
    const root = tmpRoot();
    try {
      write(root, "Package.swift", "// swift package\n");
      const hits = detectUnsupportedLanguageSignals(root);
      assert.deepEqual(hits, [], "Swift must not be reported as unsupported");
    } finally {
      rmrf(root);
    }
  });

  it("flags .csproj via wildcard signal", () => {
    const root = tmpRoot();
    try {
      write(root, "App.csproj", "<Project/>\n");
      const hits = detectUnsupportedLanguageSignals(root);
      assert.ok(hits.some((h) => /C#/.test(h)), "C# detected via wildcard");
    } finally {
      rmrf(root);
    }
  });
});

describe("coverage-diagnostics — hasBroadJsTsGlob", () => {
  it("true for tree-wide JS/TS glob", () => {
    assert.equal(hasBroadJsTsGlob(["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"]), true);
  });
  it("false for directory-scoped globs", () => {
    assert.equal(hasBroadJsTsGlob(["src/**/*.{ts,js}", "lib/**/*.{ts,js}"]), false);
  });
  it("false for python/swift-only globs", () => {
    assert.equal(hasBroadJsTsGlob(["**/*.py", "**/*.swift"]), false);
  });
  it("false for deep-constrained globs that merely start with **/ (B3)", () => {
    // `**/templates/*.ts` is narrow — counting it broad would silently skip
    // the partial-coverage probe for exactly the configs that need it.
    assert.equal(hasBroadJsTsGlob(["**/templates/*.ts"]), false);
    assert.equal(hasBroadJsTsGlob(["**/src/**/*.js"]), false);
  });
  it("true for simple tree-wide single-extension globs", () => {
    assert.equal(hasBroadJsTsGlob(["**/*.ts"]), true);
    assert.equal(hasBroadJsTsGlob(["**/*.js"]), true);
  });
});

describe("coverage-diagnostics — coverageDiagnostics config knob", () => {
  const { loadRepoConfig } = require("../lib/config");
  const intel = require("../lib/intel");
  const graph = require("../lib/graph");

  it("defaults to true; .codebase-intel.json false is honored", () => {
    const root = tmpRoot();
    try {
      assert.equal(loadRepoConfig(root).coverageDiagnostics, true);
      fs.writeFileSync(
        path.join(root, ".codebase-intel.json"),
        JSON.stringify({ coverageDiagnostics: false })
      );
      assert.equal(loadRepoConfig(root).coverageDiagnostics, false);
    } finally {
      rmrf(root);
    }
  });

  it("intel.scan with coverageDiagnostics:false skips the probe and clears the note", async () => {
    const root = tmpRoot();
    try {
      // Supported source OUTSIDE the configured globs → normally globs-too-narrow.
      fs.mkdirSync(path.join(root, "app"), { recursive: true });
      fs.writeFileSync(path.join(root, "app", "x.py"), "X = 1\n");

      await intel.scan(root, ["src/**/*.js"]);
      let db = await graph.loadDb(root);
      let note = graph.getMetaValue(db, "coverage_note");
      assert.ok(note && JSON.parse(note).kind === "globs-too-narrow",
        "control: diagnosis enabled persists the note");

      await intel.scan(root, ["src/**/*.js"], { coverageDiagnostics: false });
      db = await graph.loadDb(root);
      note = graph.getMetaValue(db, "coverage_note");
      assert.ok(!note, "knob off must clear the previously-persisted note");
    } finally {
      rmrf(root);
    }
  });
});

describe("coverage-diagnostics — diagnoseScanCoverage", () => {
  it("globs-too-narrow: 0 indexed but supported sources exist", async () => {
    const root = tmpRoot();
    try {
      // Sources live where a directory-scoped glob would miss them.
      write(root, "packages/app/foo.ts");
      write(root, "scripts/build.js");
      const d = await diagnoseScanCoverage({
        rootAbs: root,
        globs: ["src/**/*.{ts,js}"],
        ignore: IGNORE,
        gitignoreFilter: null,
        indexedTotal: 0,
      });
      assert.equal(d.kind, "globs-too-narrow");
      assert.ok(d.supportedAvailable >= 2, "probe found the out-of-glob files");
      assert.ok(d.fix && d.fix.includes(".codebase-intel.json"), "fix points at config");
    } finally {
      rmrf(root);
    }
  });

  it("unsupported-language: 0 indexed, only a Go module present", async () => {
    const root = tmpRoot();
    try {
      write(root, "go.mod", "module x\n");
      write(root, "main.go", "package main\n"); // not a supported ext
      const d = await diagnoseScanCoverage({
        rootAbs: root,
        globs: ["**/*.{ts,js}"],
        ignore: IGNORE,
        gitignoreFilter: null,
        indexedTotal: 0,
      });
      assert.equal(d.kind, "unsupported-language");
      assert.ok(/Go/.test(d.message));
      assert.equal(d.fix, null);
    } finally {
      rmrf(root);
    }
  });

  it("empty-repo: 0 indexed, no sources, no build signals", async () => {
    const root = tmpRoot();
    try {
      write(root, "README.md", "# hi\n");
      const d = await diagnoseScanCoverage({
        rootAbs: root,
        globs: ["**/*.{ts,js}"],
        ignore: IGNORE,
        gitignoreFilter: null,
        indexedTotal: 0,
      });
      assert.equal(d.kind, "empty-repo");
    } finally {
      rmrf(root);
    }
  });

  it("ok: broad JS/TS glob with files indexed skips the partial probe", async () => {
    const root = tmpRoot();
    try {
      write(root, "a.ts");
      const d = await diagnoseScanCoverage({
        rootAbs: root,
        globs: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
        ignore: IGNORE,
        gitignoreFilter: null,
        indexedTotal: 1,
      });
      assert.equal(d.kind, "ok");
      assert.equal(d.supportedAvailable, null, "no probe ran (broad glob)");
    } finally {
      rmrf(root);
    }
  });

  it("globs-too-narrow (partial): narrow glob leaves a large indexable gap", async () => {
    const root = tmpRoot();
    try {
      // 1 indexed under src/, 30 supported elsewhere → big gap, <50% covered.
      write(root, "src/entry.ts");
      for (let i = 0; i < 30; i++) write(root, `packages/p${i}/index.js`);
      const d = await diagnoseScanCoverage({
        rootAbs: root,
        globs: ["src/**/*.{ts,js}"],
        ignore: IGNORE,
        gitignoreFilter: null,
        indexedTotal: 1,
      });
      assert.equal(d.kind, "globs-too-narrow");
      assert.ok(d.supportedAvailable >= 31);
    } finally {
      rmrf(root);
    }
  });
});
