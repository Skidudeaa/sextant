"use strict";

// Integration regression: Swift app with vendored Python subtrees.
//
// Mirrors the dogfooding feedback case (2026-05-02) where sextant on a Swift
// iOS project surfaced confidently-wrong hotspots and entry points because
// vendored Python subtrees (cloned MCP servers, an unpacked GitHub tarball)
// got indexed alongside real Swift sources.
//
// This test locks in the three orthogonal fixes:
//   1. Vendored detection — nested-.git, conventional vendor dirnames,
//      tarball-extract naming patterns.
//   2. Swift entry-point detection — @main attribute scan + filename
//      heuristics merged into the entry-point list.
//   3. Summary header transparency — vendored exclusions surfaced so users
//      can audit and override.
//
// If this test breaks, the user-visible regression is "sextant lies about
// what's in the project" — refuse to ship until it's green.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const intel = require("../lib/intel");
const graph = require("../lib/graph");
const summaryMod = require("../lib/summary");
const { loadRepoConfig } = require("../lib/config");
const swiftExt = require("../lib/extractors/swift");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sextant-swift-vendored-"));
}

function writeFile(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function buildDogfoodingFixture(root) {
  // Real project: SwiftUI app under Sources/.
  writeFile(root, "Package.swift",
    "// swift-tools-version:5.5\nimport PackageDescription\n");

  writeFile(root, "Sources/MyApp/main/MyApp.swift",
    `import SwiftUI
@main
struct MyApp: App {
  var body: some Scene { WindowGroup {} }
}`);

  writeFile(root, "Sources/MyApp/ContentView.swift",
    `import SwiftUI
struct ContentView: View {
  var body: some View { Text("hi") }
}`);

  writeFile(root, "Sources/MyApp/Logic/Helpers.swift",
    `import Foundation
struct Helpers {}`);

  // ── Vendored subtree 1: nested-git-repo signal ────────────────
  writeFile(root, "mcp-servers-repo/.git/HEAD", "ref: refs/heads/main\n");
  fs.mkdirSync(path.join(root, "mcp-servers-repo/.git/refs"), { recursive: true });
  writeFile(root, "mcp-servers-repo/pyproject.toml", "[project]\nname = 'mcp-server'\n");
  writeFile(root, "mcp-servers-repo/src/server.py",
    "def main():\n  pass\ndef handler(req):\n  pass\n");
  writeFile(root, "mcp-servers-repo/src/client.py",
    "from .server import main\n");

  // ── Vendored subtree 2: tarball-name signal ───────────────────
  writeFile(root, "mbadolato-iTerm2-Color-Schemes-f279991/tools/__init__.py", "");
  writeFile(root, "mbadolato-iTerm2-Color-Schemes-f279991/tools/screenshot_gen.py",
    "def render(scheme):\n  pass\n");

  // ── Vendored subtree 3: conventional vendor-dirname (Pods/) ───
  writeFile(root, "Pods/SomeFramework/Sources/Framework.swift",
    "public class SomePodFramework {}\n");
}

describe("Swift app + vendored Python subtrees (regression: 2026-05-02 dogfooding)", () => {
  let root;
  let cfg;

  before(async () => {
    root = mkTmp();
    fs.mkdirSync(path.join(root, ".planning", "intel"), { recursive: true });
    buildDogfoodingFixture(root);

    // Pre-warm the Swift parser so the @main attribute scan runs.
    await swiftExt.ensureReady();

    cfg = loadRepoConfig(root);
    await intel.scan(root, cfg.globs, { ignore: cfg.ignore, force: true });
  });

  after(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("loadRepoConfig auto-detects all three vendored subtrees", () => {
    const paths = cfg.vendoredSignals.map((s) => s.path);
    assert.ok(paths.includes("mcp-servers-repo"), "nested-git-repo");
    assert.ok(paths.includes("mbadolato-iTerm2-Color-Schemes-f279991"), "tarball-name");
    assert.ok(paths.includes("Pods"), "vendor-dirname");
    assert.equal(paths.length, 3);

    const reasonsByPath = Object.fromEntries(cfg.vendoredSignals.map((s) => [s.path, s.reason]));
    assert.equal(reasonsByPath["mcp-servers-repo"], "nested-git-repo");
    assert.equal(reasonsByPath["mbadolato-iTerm2-Color-Schemes-f279991"], "tarball-name");
    assert.equal(reasonsByPath["Pods"], "vendor-dirname");
  });

  it("scan indexes only project Swift files — no vendored Python or vendored Swift", async () => {
    const db = await graph.loadDb(root);
    const indexed = graph.allFilePaths(db).sort();

    // What we expect: the 3 source-tree Swift files (Package.swift only matches
    // **/*.swift if present at root, but lib/config.js's Swift glob is
    // **/*.swift so it matches all). The exact count is exactly 4 Swift files
    // (Package.swift, MyApp.swift, ContentView.swift, Helpers.swift).
    assert.deepEqual(indexed, [
      "Package.swift",
      "Sources/MyApp/ContentView.swift",
      "Sources/MyApp/Logic/Helpers.swift",
      "Sources/MyApp/main/MyApp.swift",
    ]);

    // Critically: NO Python files indexed (all were under vendored subtrees).
    assert.equal(indexed.filter((p) => p.endsWith(".py")).length, 0,
      "no vendored Python should be indexed");

    // No vendored Swift either (Pods/ is excluded).
    assert.equal(indexed.filter((p) => p.startsWith("Pods/")).length, 0,
      "no vendored Swift under Pods/ should be indexed");
  });

  it("Swift @main attribute marks MyApp.swift as a Swift entry file", async () => {
    const db = await graph.loadDb(root);
    const entries = graph.getSwiftEntryFiles(db).map((r) => r.path);
    assert.ok(entries.includes("Sources/MyApp/main/MyApp.swift"),
      "MyApp.swift contains @main and must be marked");
    // Other Swift files don't have @main → must not be marked.
    assert.equal(entries.includes("Sources/MyApp/ContentView.swift"), false);
    assert.equal(entries.includes("Package.swift"), false);
  });

  it("summary surfaces Swift entry point + vendored-excluded line", async () => {
    const db = await graph.loadDb(root);
    const md = summaryMod.writeSummaryMarkdown(root, { db, graph });

    // Vendored-excluded transparency: all three subtrees enumerated.
    assert.match(md, /\*\*Vendored excluded\*\*:\s*3/);
    assert.match(md, /mcp-servers-repo/);
    assert.match(md, /mbadolato-iTerm2-Color-Schemes-f279991/);
    assert.match(md, /Pods/);

    // Entry point: MyApp.swift surfaces (matched both filename heuristic and
    // @main attribute scan; either signal alone would be sufficient).
    assert.match(md, /Likely entry points/);
    assert.match(md, /Sources\/MyApp\/main\/MyApp\.swift/);

    // Module-types skew: only Swift counted (no spurious Python).
    assert.match(md, /\*\*swift\*\*:\s*4/);
    assert.equal(/\*\*py\*\*:/.test(md), false,
      "no Python module-type count when all Python files were vendored");
  });

  it("summary's Dependency hotspots section is not polluted by vendored fan-in", async () => {
    const db = await graph.loadDb(root);
    const md = summaryMod.writeSummaryMarkdown(root, { db, graph });

    // The user's broken summary listed mcp_server/server.py as a hotspot.
    // After this fix, no path under any vendored subtree may appear anywhere.
    assert.equal(/mcp-servers/.test(md.replace(/Vendored excluded.*\n/, "")), false,
      "no vendored path may appear outside the Vendored-excluded line");
  });
});
