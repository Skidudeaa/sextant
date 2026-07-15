"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const binding = require("../lib/summary-binding");
const graph = require("../lib/graph");

const BIN = path.resolve(__dirname, "..", "bin", "intel.js");

function baseEnv(extra = {}) {
  return {
    ...process.env,
    NODE_OPTIONS: "",
    SEXTANT_CAPSULE: "0",
    SEXTANT_COHERENCE: "0",
    SEXTANT_HOLDBACK_PCT: "0",
    SEXTANT_HOLDBACK_FORCE: "",
    SEXTANT_SYNC_RESCAN: "0",
    ...extra,
  };
}

function git(root, args) {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

async function fixture(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sx-static-binding-${label}-`));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(root, "index.js"), "module.exports = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "initial"]);
  execFileSync(process.execPath, [BIN, "scan", "--root", root, "--force"], {
    cwd: root,
    env: baseEnv(),
    stdio: "ignore",
  });
  const bound = binding.readBoundSummary(root);
  assert.ok(bound, "scan must publish a bound static summary");
  return root;
}

function runHook(root, extraEnv = {}, sessionId = "static-binding") {
  return spawnSync(process.execPath, [BIN, "hook", "refresh"], {
    cwd: root,
    input: JSON.stringify({ prompt: "hello there", session_id: sessionId }),
    encoding: "utf8",
    timeout: 30000,
    env: baseEnv(extraEnv),
  });
}

describe("static summary graph-generation binding", () => {
  it("preserves legacy trimmed output/dedupe bytes on a stable generation", async () => {
    const root = await fixture("stable");
    try {
      const bound = binding.readBoundSummary(root);
      assert.ok(bound.rawSummary.endsWith("\n"), "generated fixture should exercise trailing trim");
      const first = runHook(root, {}, "stable-session");
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, /<codebase-intelligence>/);
      assert.doesNotMatch(first.stdout, /\n\n<\/codebase-intelligence>/);
      const second = runHook(root, {}, "stable-session");
      assert.equal(second.status, 0, second.stderr);
      assert.equal(second.stdout, "", "unchanged legacy body hash must dedupe");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the two-phase publication fence to one full gate and one final capture", async () => {
    const root = await fixture("call-budget");
    const cli = require("../lib/cli");
    const freshness = require("../lib/freshness");
    const originalCheck = freshness.checkFreshness;
    const originalCapture = freshness.captureCurrentState;
    let checks = 0;
    let captures = 0;
    freshness.checkFreshness = async (...args) => {
      checks++;
      return originalCheck(...args);
    };
    freshness.captureCurrentState = (...args) => {
      captures++;
      return originalCapture(...args);
    };
    try {
      const raw = fs.readFileSync(path.join(root, ".planning", "intel", "summary.md"), "utf8");
      const gated = await cli.applyBoundFreshnessGateDetailed(raw.trim(), root);
      assert.ok(gated.validation);
      assert.equal(await cli.boundSummaryStillValid(root, gated.validation), true);
      assert.equal(checks, 1, "manifest checks must not rerun the full git freshness gate");
      assert.equal(captures, 1, "only the final publication fence needs a second repo capture");
    } finally {
      freshness.checkFreshness = originalCheck;
      freshness.captureCurrentState = originalCapture;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("self-heals a missing/corrupt binding by regenerating from the fresh graph", async () => {
    const root = await fixture("repair");
    try {
      const summaryPath = path.join(root, ".planning", "intel", "summary.md");
      fs.writeFileSync(summaryPath, "OLD-UNBOUND-SENTINEL\n");
      fs.writeFileSync(binding.manifestPath(root), "{corrupt");
      const result = runHook(root, {}, "repair-session");
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /<codebase-intelligence>/);
      assert.doesNotMatch(result.stdout, /OLD-UNBOUND-SENTINEL/);
      const repaired = binding.readBoundSummary(root);
      assert.ok(repaired);
      assert.doesNotMatch(repaired.rawSummary, /OLD-UNBOUND-SENTINEL/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("binds package scripts from one immutable capture across a temporary edit/restore", async () => {
    const root = await fixture("package-aba");
    const packagePath = path.join(root, "package.json");
    const stablePackage = JSON.stringify({
      name: "summary-input-fixture",
      scripts: { test: "node stable-suite.js" },
    }, null, 2) + "\n";
    const transientPackage = JSON.stringify({
      name: "summary-input-fixture",
      scripts: { test: "node transient-suite.js" },
    }, null, 2) + "\n";
    fs.writeFileSync(packagePath, stablePackage);
    git(root, ["add", "package.json"]);
    git(root, ["commit", "-qm", "add package scripts"]);
    execFileSync(process.execPath, [BIN, "scan", "--root", root, "--force"], {
      cwd: root,
      env: baseEnv(),
      stdio: "ignore",
    });

    const summary = require("../lib/summary");
    const intel = require("../lib/intel");
    const originalRender = summary.writeSummaryMarkdown;
    let renderCalls = 0;
    summary.writeSummaryMarkdown = (rootAbs, options) => {
      if (path.resolve(rootAbs) !== path.resolve(root)) {
        return originalRender(rootAbs, options);
      }
      renderCalls++;
      // Deterministic ABA: the repository fingerprint is stable before and
      // after rendering, but a renderer that consults package.json live sees
      // these temporary bytes. A snapshot-only renderer sees the stable input.
      fs.writeFileSync(packagePath, transientPackage);
      try {
        return originalRender(rootAbs, options);
      } finally {
        fs.writeFileSync(packagePath, stablePackage);
      }
    };

    try {
      await intel.writeSummary(root, { force: true });
      let bound = binding.readBoundSummary(root);
      assert.ok(bound, "normal summary writes must remain bound");
      assert.match(bound.rawSummary, /node stable-suite\.js/);
      assert.doesNotMatch(bound.rawSummary, /node transient-suite\.js/);

      fs.writeFileSync(binding.manifestPath(root), "{corrupt");
      assert.equal(await binding.repairBoundSummary(root), true);
      bound = binding.readBoundSummary(root);
      assert.ok(bound, "repair writes must remain bound");
      assert.match(bound.rawSummary, /node stable-suite\.js/);
      assert.doesNotMatch(bound.rawSummary, /node transient-suite\.js/);
      assert.equal(renderCalls, 2, "exercise both normal publication and repair");
    } finally {
      summary.writeSummaryMarkdown = originalRender;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not reread a transient graph.db mtime from an immutable render", async () => {
    const root = await fixture("graph-mtime-aba");
    const summary = require("../lib/summary");
    const db = await graph.loadDb(root);
    const graphPath = path.resolve(graph.graphDbPath(root));
    // Force health() down its pre-migration mtime fallback. The captured value
    // must be the only one the renderer can observe after this point.
    graph.setMetaValue(db, "generated_at", "");
    const inputs = summary.captureSummaryInputs(root, { db, graph });
    assert.equal(typeof inputs.graphDbMtimeMs, "number");

    const originalStat = fs.statSync;
    let liveGraphStats = 0;
    fs.statSync = (target, ...args) => {
      if (path.resolve(String(target)) === graphPath) {
        liveGraphStats++;
        const stat = originalStat(target, ...args);
        // A live-read renderer would observe this temporary timestamp. The
        // snapshot renderer must not call us for graph.db at all.
        return { ...stat, mtimeMs: stat.mtimeMs + 86_400_000 };
      }
      return originalStat(target, ...args);
    };
    try {
      assert.doesNotThrow(() => summary.writeSummaryMarkdown(root, { db, graph, inputs }));
      assert.equal(liveGraphStats, 0);
    } finally {
      fs.statSync = originalStat;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("repairs from persisted H1 after an external rename restores graph.db mtime", async () => {
    const root = await fixture("restored-graph-mtime");
    try {
      const h0Bound = binding.readBoundSummary(root);
      assert.ok(h0Bound);
      await graph.loadDb(root); // Seed this process's H0 general + binding caches.
      const graphPath = graph.graphDbPath(root);
      const h0Stat = fs.statSync(graphPath);

      fs.writeFileSync(path.join(root, "index.js"), "module.exports = 2;\n");
      git(root, ["add", "index.js"]);
      git(root, ["commit", "-qm", "publish h1 graph"]);
      // A separate process publishes H1 by atomic graph.db rename.
      execFileSync(process.execPath, [BIN, "scan", "--root", root, "--force"], {
        cwd: root,
        env: baseEnv(),
        stdio: "ignore",
      });
      const h1Published = binding.readBoundSummary(root);
      assert.ok(h1Published);
      assert.notEqual(
        h1Published.manifest.graphGeneration,
        h0Bound.manifest.graphGeneration
      );

      const restored = new Date(Math.floor(h0Stat.mtimeMs));
      fs.utimesSync(graphPath, restored, restored);
      assert.ok(fs.statSync(graphPath).mtimeMs <= h0Stat.mtimeMs);
      fs.writeFileSync(binding.manifestPath(root), "{corrupt");

      assert.equal(await binding.repairBoundSummary(root), true);
      const repaired = binding.readBoundSummary(root);
      assert.ok(repaired);
      assert.equal(
        repaired.manifest.graphGeneration,
        h1Published.manifest.graphGeneration,
        "repair must bind persisted H1, never the cached H0 generation"
      );
      assert.notEqual(repaired.manifest.graphGeneration, h0Bound.manifest.graphGeneration);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails persisted binding and repair closed when graph.db is missing", async () => {
    const root = await fixture("missing-graph");
    try {
      const cached = await graph.loadDb(root);
      assert.ok(graph.countFiles(cached) > 0);
      fs.rmSync(graph.graphDbPath(root), { force: true });

      assert.equal(await binding.readGraphBinding(root), null);
      assert.equal(
        await binding.repairBoundSummary(root),
        false,
        "the general cached working copy must not prove persisted publication"
      );
      // Historical general-cache behavior remains available to a writer.
      assert.strictEqual(await graph.loadDb(root), cached);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("withholds structural bytes when the repo moves after the gate", async () => {
    const root = await fixture("repo-move");
    const preloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "sx-static-preload-"));
    const preload = path.join(preloadDir, "move-after-gate.js");
    const cliPath = path.resolve(__dirname, "..", "lib", "cli.js");
    fs.writeFileSync(
      preload,
      [
        `const fs = require("fs");`,
        `const cli = require(${JSON.stringify(cliPath)});`,
        `const original = cli.applyBoundFreshnessGateDetailed;`,
        `let moved = false;`,
        `cli.applyBoundFreshnessGateDetailed = async (...args) => {`,
        `  const result = await original(...args);`,
        `  if (!moved) {`,
        `    moved = true;`,
        `    fs.writeFileSync(process.env.SEXTANT_MOVE_TARGET, "module.exports = 2;\\n");`,
        `  }`,
        `  return result;`,
        `};`,
      ].join("\n")
    );
    try {
      const result = runHook(root, {
        NODE_OPTIONS: `--require=${preload}`,
        SEXTANT_MOVE_TARGET: path.join(root, "index.js"),
      }, "move-session");
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
    } finally {
      fs.rmSync(preloadDir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("never validates H0 summary bytes against a concurrently published H1 graph", async () => {
    const root = await fixture("mixed-generation");
    const summaryPath = path.join(root, ".planning", "intel", "summary.md");
    const db = await graph.loadDb(root);
    const oldRaw = fs.readFileSync(summaryPath, "utf8") + "OLD-GENERATION-SENTINEL\n";
    fs.writeFileSync(summaryPath, oldRaw);
    assert.equal(await binding.writeManifest(root, oldRaw, { db, graph }), true);

    const preloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "sx-static-swap-"));
    const preload = path.join(preloadDir, "publish-h1-before-gate.js");
    const cliPath = path.resolve(__dirname, "..", "lib", "cli.js");
    fs.writeFileSync(
      preload,
      [
        `const fs = require("fs");`,
        `const cp = require("child_process");`,
        `const cli = require(${JSON.stringify(cliPath)});`,
        `const original = cli.applyBoundFreshnessGateDetailed;`,
        `let swapped = false;`,
        `cli.applyBoundFreshnessGateDetailed = async (...args) => {`,
        `  if (!swapped) {`,
        `    swapped = true;`,
        `    fs.writeFileSync(process.env.SEXTANT_SWAP_TARGET, "module.exports = 3;\\n");`,
        `    cp.execFileSync("git", ["add", "."], { cwd: process.cwd() });`,
        `    cp.execFileSync("git", ["commit", "-qm", "publish h1"], { cwd: process.cwd() });`,
        `    cp.execFileSync(process.execPath, [process.env.SEXTANT_BIN, "scan", "--root", process.cwd(), "--force"], {`,
        `      cwd: process.cwd(), stdio: "ignore", env: { ...process.env, NODE_OPTIONS: "" },`,
        `    });`,
        `  }`,
        `  return original(...args);`,
        `};`,
      ].join("\n")
    );
    try {
      const result = runHook(root, {
        NODE_OPTIONS: `--require=${preload}`,
        SEXTANT_SWAP_TARGET: path.join(root, "index.js"),
        SEXTANT_BIN: BIN,
      }, "swap-session");
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /<codebase-intelligence>/);
      assert.doesNotMatch(result.stdout, /OLD-GENERATION-SENTINEL/);
      assert.ok(binding.readBoundSummary(root));
    } finally {
      fs.rmSync(preloadDir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
