"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const graph = require("../lib/graph");
const intel = require("../lib/intel");

// Import server internals for direct testing (not stdio protocol)
const { dispatch, TOOLS, toolHandlers } = require("../mcp/server");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;

async function setupTestRoot() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-mcp-test-"));
  fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });

  // Create a minimal source file so intel.init has something to work with
  fs.mkdirSync(path.join(tmpDir, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "lib", "foo.js"),
    'const bar = require("./bar");\nfunction greet() { return "hello"; }\nmodule.exports = { greet };\n'
  );
  fs.writeFileSync(
    path.join(tmpDir, "lib", "bar.js"),
    'const baz = require("./baz");\nfunction helper() { return 42; }\nmodule.exports = { helper };\n'
  );
  fs.writeFileSync(
    path.join(tmpDir, "lib", "baz.js"),
    'function core() { return true; }\nmodule.exports = { core };\n'
  );

  // Populate graph.db with known data
  const db = await graph.loadDb(tmpDir);

  graph.upsertFile(db, { relPath: "lib/foo.js", type: "js", sizeBytes: 100, mtimeMs: 1000 });
  graph.upsertFile(db, { relPath: "lib/bar.js", type: "js", sizeBytes: 80, mtimeMs: 1000 });
  graph.upsertFile(db, { relPath: "lib/baz.js", type: "js", sizeBytes: 60, mtimeMs: 1000 });

  graph.replaceImports(db, "lib/foo.js", [
    { specifier: "./bar", toPath: "lib/bar.js", kind: "relative" },
  ]);
  graph.replaceImports(db, "lib/bar.js", [
    { specifier: "./baz", toPath: "lib/baz.js", kind: "relative" },
  ]);

  graph.replaceExports(db, "lib/foo.js", [
    { name: "greet", kind: "named" },
  ]);
  graph.replaceExports(db, "lib/bar.js", [
    { name: "helper", kind: "named" },
  ]);
  graph.replaceExports(db, "lib/baz.js", [
    { name: "core", kind: "named" },
  ]);

  await graph.persistDb(tmpDir);
  return tmpDir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP server — tool definitions", () => {
  it("exposes exactly 4 tools", () => {
    assert.equal(TOOLS.length, 4);
  });

  it("every tool has name, description, and inputSchema", () => {
    for (const t of TOOLS) {
      assert.ok(t.name, "tool must have a name");
      assert.ok(t.description, "tool must have a description");
      assert.ok(t.inputSchema, "tool must have inputSchema");
      assert.equal(t.inputSchema.type, "object");
    }
  });

  it("sextant_search has assertive description mentioning PREFERRED and INSTEAD", () => {
    const search = TOOLS.find((t) => t.name === "sextant_search");
    assert.ok(search);
    assert.ok(search.description.includes("PREFERRED"));
    assert.ok(search.description.includes("INSTEAD"));
  });

  it("sextant_search requires query parameter", () => {
    const search = TOOLS.find((t) => t.name === "sextant_search");
    assert.deepEqual(search.inputSchema.required, ["query"]);
  });

  it("sextant_health has no required parameters", () => {
    const health = TOOLS.find((t) => t.name === "sextant_health");
    assert.ok(health);
    assert.equal(health.inputSchema.required, undefined);
  });
});

describe("MCP server — initialize", () => {
  let root;

  before(async () => {
    root = await setupTestRoot();
    // Override cwd for the server module
    const origCwd = process.cwd;
    process.cwd = () => root;
    // Reset server state by re-requiring (the module caches _initialized)
    // Instead, we call dispatch directly which calls ensureInit
    process.cwd = origCwd;
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("initialize returns serverInfo and capabilities", async () => {
    // Temporarily override cwd
    const origCwd = process.cwd;
    process.cwd = () => root;
    try {
      const result = await dispatch("initialize", {});
      assert.ok(result.protocolVersion);
      assert.ok(result.serverInfo);
      assert.equal(result.serverInfo.name, "sextant");
      assert.ok(result.capabilities);
      assert.ok(result.capabilities.tools !== undefined);
    } finally {
      process.cwd = origCwd;
    }
  });
});

describe("MCP server — tools/list", () => {
  it("returns the tool list", async () => {
    const result = await dispatch("tools/list", {});
    assert.ok(Array.isArray(result.tools));
    assert.equal(result.tools.length, 4);
    const names = result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "sextant_explain",
      "sextant_health",
      "sextant_related",
      "sextant_search",
    ]);
  });
});

describe("MCP server — tools/call handlers", () => {
  let root;

  before(async () => {
    root = await setupTestRoot();
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sextant_related returns imports and dependents", async () => {
    const origCwd = process.cwd;
    process.cwd = () => root;
    try {
      // Ensure init runs for this root
      await dispatch("initialize", {});

      const result = await dispatch("tools/call", {
        name: "sextant_related",
        arguments: { file: "lib/bar.js" },
      });
      assert.ok(result.content);
      assert.equal(result.content.length, 1);
      assert.equal(result.content[0].type, "text");

      const data = JSON.parse(result.content[0].text);
      assert.equal(data.file, "lib/bar.js");
      assert.ok(Array.isArray(data.imports));
      assert.ok(Array.isArray(data.dependents));
      // bar.js imports baz.js
      assert.ok(data.imports.includes("lib/baz.js"), "should list baz.js as import");
      // bar.js is imported by foo.js
      assert.ok(data.dependents.includes("lib/foo.js"), "should list foo.js as dependent");
    } finally {
      process.cwd = origCwd;
    }
  });

  it("sextant_explain returns fan-in, fan-out, exports, imports", async () => {
    const origCwd = process.cwd;
    process.cwd = () => root;
    try {
      await dispatch("initialize", {});

      const result = await dispatch("tools/call", {
        name: "sextant_explain",
        arguments: { file: "lib/bar.js" },
      });
      const data = JSON.parse(result.content[0].text);

      assert.equal(data.file, "lib/bar.js");
      assert.equal(typeof data.fanIn, "number");
      assert.equal(typeof data.fanOut, "number");
      assert.ok(Array.isArray(data.exports));
      assert.ok(Array.isArray(data.imports));
      assert.equal(data.type, "js");
      // bar.js exports 'helper'
      assert.ok(
        data.exports.some((e) => e.name === "helper"),
        "should include helper export"
      );
      // bar.js imports ./baz
      assert.ok(
        data.imports.some((i) => i.specifier === "./baz"),
        "should include ./baz import"
      );
    } finally {
      process.cwd = origCwd;
    }
  });

  it("sextant_health returns resolution stats", async () => {
    const origCwd = process.cwd;
    process.cwd = () => root;
    try {
      await dispatch("initialize", {});

      const result = await dispatch("tools/call", {
        name: "sextant_health",
        arguments: {},
      });
      const data = JSON.parse(result.content[0].text);

      assert.equal(typeof data.resolutionPct, "number");
      assert.equal(typeof data.files, "number");
      assert.ok(data.files >= 3, "should have at least 3 files");
      assert.ok(Array.isArray(data.warnings));
    } finally {
      process.cwd = origCwd;
    }
  });

  it("sextant_health includes vendored fields with zero count on a clean fixture", async () => {
    // WHY: vendoredExcluded/vendoredPaths must always be present (additive
    // contract for downstream consumers). A clean fixture with no vendored
    // subtrees should report 0 / [] — not absent fields.
    const origCwd = process.cwd;
    process.cwd = () => root;
    try {
      await dispatch("initialize", {});
      const result = await dispatch("tools/call", {
        name: "sextant_health",
        arguments: {},
      });
      const data = JSON.parse(result.content[0].text);
      assert.equal(typeof data.vendoredExcluded, "number");
      assert.equal(data.vendoredExcluded, 0);
      assert.ok(Array.isArray(data.vendoredPaths));
      assert.equal(data.vendoredPaths.length, 0);
    } finally {
      process.cwd = origCwd;
    }
  });

  it("sextant_health reports watcher state", async () => {
    // No watcher runs in the test fixture — health should explicitly report
    // running:false and surface a warning.  Callers (Claude) use this to
    // decide whether to trust the index freshness.
    const origCwd = process.cwd;
    process.cwd = () => root;
    try {
      await dispatch("initialize", {});
      const result = await dispatch("tools/call", {
        name: "sextant_health",
        arguments: {},
      });
      const data = JSON.parse(result.content[0].text);

      assert.ok(data.watcher, "health includes a watcher field");
      assert.equal(data.watcher.running, false, "no watcher in test fixture");
      assert.ok(
        data.warnings.some((w) => /watcher not running/.test(w)),
        "warnings include actionable 'watcher not running' hint"
      );
    } finally {
      process.cwd = origCwd;
    }
  });

  it("sextant_explain returns notIndexed for unknown files", async () => {
    // Before: a nonexistent path silently returned fanIn:0, fanOut:0, empty
    // arrays — indistinguishable from a real isolated file.  Now: an explicit
    // notIndexed flag so callers can distinguish "file is isolated" from
    // "file isn't tracked at all".
    const origCwd = process.cwd;
    process.cwd = () => root;
    try {
      await dispatch("initialize", {});
      const result = await dispatch("tools/call", {
        name: "sextant_explain",
        arguments: { file: "does/not/exist.js" },
      });
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.notIndexed, true);
      assert.ok(typeof data.hint === "string" && data.hint.length > 0);
    } finally {
      process.cwd = origCwd;
    }
  });

  it("unknown tool returns isError", async () => {
    const result = await dispatch("tools/call", {
      name: "nonexistent_tool",
      arguments: {},
    });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("Unknown tool"));
  });

  // WHY: MCP protocol requires tool-level failures to return isError in the
  // response body, NOT throw as JSON-RPC errors. These tests verify that.
  it("sextant_search with missing query returns isError", async () => {
    const origCwd = process.cwd;
    process.cwd = () => root;
    try {
      await dispatch("initialize", {});
      const result = await dispatch("tools/call", {
        name: "sextant_search",
        arguments: {},
      });
      assert.ok(result.isError, "should return isError: true");
      assert.ok(result.content[0].text.includes("query parameter is required"));
    } finally {
      process.cwd = origCwd;
    }
  });

  it("sextant_related with missing file returns isError", async () => {
    const origCwd = process.cwd;
    process.cwd = () => root;
    try {
      await dispatch("initialize", {});
      const result = await dispatch("tools/call", {
        name: "sextant_related",
        arguments: {},
      });
      assert.ok(result.isError, "should return isError: true");
      assert.ok(result.content[0].text.includes("file parameter is required"));
    } finally {
      process.cwd = origCwd;
    }
  });

  it("sextant_explain with missing file returns isError", async () => {
    const origCwd = process.cwd;
    process.cwd = () => root;
    try {
      await dispatch("initialize", {});
      const result = await dispatch("tools/call", {
        name: "sextant_explain",
        arguments: {},
      });
      assert.ok(result.isError, "should return isError: true");
      assert.ok(result.content[0].text.includes("file parameter is required"));
    } finally {
      process.cwd = origCwd;
    }
  });
});

describe("MCP server — sextant_health vendored telemetry", () => {
  // WHY: separate fixture with synthetic vendored subtrees. Reuses the
  // same shape as test/swift-vendored-integration.test.js but isolated
  // here so the existing tools/call fixture stays minimal.
  let vendoredRoot;

  before(async () => {
    vendoredRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-mcp-vendor-"));
    fs.mkdirSync(path.join(vendoredRoot, ".planning", "intel"), { recursive: true });

    // Real source file so health has something to count.
    fs.mkdirSync(path.join(vendoredRoot, "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(vendoredRoot, "lib", "main.js"),
      "module.exports = { run: () => 1 };\n"
    );

    // Three vendored subtrees, one per detection signal:
    //   - Pods/         → conventional dirname
    //   - mbadolato-iTerm2-Color-Schemes-abc1234 → tarball naming
    //   - sub-repo/.git → nested git repo
    fs.mkdirSync(path.join(vendoredRoot, "Pods"), { recursive: true });
    fs.mkdirSync(
      path.join(vendoredRoot, "mbadolato-iTerm2-Color-Schemes-abc1234"),
      { recursive: true }
    );
    fs.mkdirSync(path.join(vendoredRoot, "sub-repo", ".git"), { recursive: true });
    fs.writeFileSync(path.join(vendoredRoot, "sub-repo", ".git", "HEAD"), "ref: refs/heads/main\n");

    // Seed graph.db with the one real file so intel.health() succeeds.
    const db = await graph.loadDb(vendoredRoot);
    graph.upsertFile(db, { relPath: "lib/main.js", type: "js", sizeBytes: 30, mtimeMs: 1000 });
    await graph.persistDb(vendoredRoot);
  });

  after(() => {
    if (vendoredRoot) fs.rmSync(vendoredRoot, { recursive: true, force: true });
  });

  it("surfaces vendoredExcluded count and matched paths", async () => {
    const origCwd = process.cwd;
    process.cwd = () => vendoredRoot;
    try {
      await dispatch("initialize", {});
      const result = await dispatch("tools/call", {
        name: "sextant_health",
        arguments: {},
      });
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.vendoredExcluded, 3, "all three signals fire");
      assert.deepEqual(
        data.vendoredPaths.slice().sort(),
        ["Pods", "mbadolato-iTerm2-Color-Schemes-abc1234", "sub-repo"]
      );
    } finally {
      process.cwd = origCwd;
    }
  });

  it("honors vendoredDetection:false in .codebase-intel.json", async () => {
    fs.writeFileSync(
      path.join(vendoredRoot, ".codebase-intel.json"),
      JSON.stringify({ vendoredDetection: false })
    );
    const origCwd = process.cwd;
    process.cwd = () => vendoredRoot;
    try {
      await dispatch("initialize", {});
      const result = await dispatch("tools/call", {
        name: "sextant_health",
        arguments: {},
      });
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.vendoredExcluded, 0, "auto-detection disabled");
      assert.equal(data.vendoredPaths.length, 0);
    } finally {
      process.cwd = origCwd;
      fs.rmSync(path.join(vendoredRoot, ".codebase-intel.json"), { force: true });
    }
  });

  it("merges explicit vendored: [...] entries on top of auto-detection", async () => {
    fs.writeFileSync(
      path.join(vendoredRoot, ".codebase-intel.json"),
      JSON.stringify({ vendored: ["explicit-one", "Pods"] })  // 'Pods' dedupes against auto-detection
    );
    const origCwd = process.cwd;
    process.cwd = () => vendoredRoot;
    try {
      await dispatch("initialize", {});
      const result = await dispatch("tools/call", {
        name: "sextant_health",
        arguments: {},
      });
      const data = JSON.parse(result.content[0].text);
      // 3 auto-detected + 1 explicit-only ('Pods' deduped)
      assert.equal(data.vendoredExcluded, 4);
      assert.ok(data.vendoredPaths.includes("explicit-one"));
      assert.ok(data.vendoredPaths.includes("Pods"));
    } finally {
      process.cwd = origCwd;
      fs.rmSync(path.join(vendoredRoot, ".codebase-intel.json"), { force: true });
    }
  });
});

describe("MCP server — unknown method", () => {
  it("returns null for unknown methods", async () => {
    const result = await dispatch("nonexistent/method", {});
    assert.equal(result, null);
  });
});

describe("MCP server — search with real files", () => {
  let root;

  before(async () => {
    root = await setupTestRoot();
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sextant_search returns files and hits arrays", async () => {
    const origCwd = process.cwd;
    process.cwd = () => root;
    try {
      await dispatch("initialize", {});

      const result = await dispatch("tools/call", {
        name: "sextant_search",
        arguments: { query: "greet", limit: 5 },
      });

      assert.ok(result.content);
      assert.equal(result.content[0].type, "text");

      const data = JSON.parse(result.content[0].text);
      assert.equal(data.query, "greet");
      assert.ok(Array.isArray(data.files));
      assert.ok(Array.isArray(data.hits));
      assert.ok(Array.isArray(data.warnings));
      // greet is defined in lib/foo.js — should appear somewhere in results
      if (data.files.length > 0) {
        const fooFile = data.files.find((f) => f.path === "lib/foo.js");
        if (fooFile) {
          assert.equal(typeof fooFile.score, "number");
          assert.equal(typeof fooFile.fanIn, "number");
        }
      }
    } finally {
      process.cwd = origCwd;
    }
  });
});
