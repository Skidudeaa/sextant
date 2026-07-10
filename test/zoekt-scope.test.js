"use strict";

// Zoekt scope + hygiene layer (lib/zoekt-scope.js) — regression suite for the
// 2026-07-10 101 GB home-dir index incident. Covers the corpus pre-check, the
// index-size circuit breaker (delete + disabled marker), tmp-shard cleanup,
// the disabled-marker plumbing through shouldReindex/triggerReindex/buildIndex,
// and the -ignore_dirs scoping of the spawned indexer.

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const scope = require("../lib/zoekt-scope");
const reindex = require("../lib/zoekt-reindex");

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

describe("zoekt-scope — estimateCorpusBytes", () => {
  let root;
  before(() => {
    root = tmp("sextant-zscope-est-");
    write(root, "lib/a.js", "x".repeat(1000));
    write(root, "lib/b.js", "y".repeat(2000));
    // Every one of these must be pruned by ZOEKT_IGNORE_DIRS:
    write(root, "node_modules/dep/big.js", "z".repeat(500000));
    write(root, ".planning/intel/zoekt/index/shard.zoekt", "q".repeat(500000));
    write(root, "dist/bundle.js", "w".repeat(500000));
    write(root, "Library/Caches/blob.bin", "v".repeat(500000));
    // Over zoekt's 2 MiB file limit → zoekt skips it → must not be counted:
    write(root, "lib/huge.dat", "h".repeat(3 * 1024 * 1024));
  });
  after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  it("counts only indexable files, pruning ignore dirs and >2MiB files", () => {
    const est = scope.estimateCorpusBytes(root, { capBytes: 10 * 1024 * 1024 });
    assert.equal(est.exceeded, false);
    assert.equal(est.bytes, 3000, "only lib/a.js + lib/b.js should count");
  });

  it("early-exits with exceeded=true past the byte cap", () => {
    const est = scope.estimateCorpusBytes(root, { capBytes: 1500 });
    assert.equal(est.exceeded, true);
    assert.equal(est.reason, "byte-cap");
  });

  it("treats a pathological entry count as exceeded", () => {
    const est = scope.estimateCorpusBytes(root, { capBytes: 10 * 1024 * 1024, maxEntries: 2 });
    assert.equal(est.exceeded, true);
    assert.equal(est.reason, "entry-count");
  });

  it("ZOEKT_IGNORE_DIRS covers the incident's growth vectors", () => {
    for (const d of ["node_modules", ".planning", "Library", "vendor", "dist", ".venv", "__pycache__"]) {
      assert.ok(scope.ZOEKT_IGNORE_DIRS.includes(d), `missing ${d}`);
    }
  });
});

describe("zoekt-scope — caps, marker, tmp cleanup, circuit breaker", () => {
  let root;
  beforeEach(() => {
    root = tmp("sextant-zscope-cap-");
  });
  after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  it("readZoektCaps: defaults and .codebase-intel.json overrides", () => {
    const d = scope.readZoektCaps(root);
    assert.equal(d.maxCorpusBytes, scope.DEFAULT_MAX_CORPUS_BYTES);
    assert.equal(d.maxIndexBytes, scope.DEFAULT_MAX_INDEX_BYTES);
    write(root, ".codebase-intel.json", JSON.stringify({ zoektMaxCorpusBytes: 1234, zoektMaxIndexBytes: 5678 }));
    const c = scope.readZoektCaps(root);
    assert.equal(c.maxCorpusBytes, 1234);
    assert.equal(c.maxIndexBytes, 5678);
  });

  it("disabled marker: write → read → clear round-trip", () => {
    assert.equal(scope.isDisabled(root), false);
    scope.writeDisabled(root, { reason: "corpus-too-large", detail: "test" });
    assert.equal(scope.isDisabled(root), true);
    const d = scope.readDisabled(root);
    assert.equal(d.reason, "corpus-too-large");
    assert.ok(d.at, "marker carries a timestamp");
    scope.clearDisabled(root);
    assert.equal(scope.isDisabled(root), false);
  });

  it("writeDisabled records a zoekt.disabled telemetry event", () => {
    scope.writeDisabled(root, { reason: "index-size-cap", detail: "test" });
    const telem = fs.readFileSync(path.join(root, ".planning", "intel", "telemetry.jsonl"), "utf8");
    assert.match(telem, /zoekt\.disabled/);
    assert.match(telem, /index-size-cap/);
  });

  it("cleanupTmpShards removes only old *.tmp files", () => {
    const indexDir = scope.zoektIndexDirOf(root);
    fs.mkdirSync(indexDir, { recursive: true });
    write(root, ".planning/intel/zoekt/index/repo_v16.00000.zoekt", "live shard");
    write(root, ".planning/intel/zoekt/index/repo_v16.00000.zoekt.123.tmp", "orphan");
    write(root, ".planning/intel/zoekt/index/repo_v16.00001.zoekt.456.tmp", "fresh in-flight");
    const old = Date.now() - 2 * 60 * 60 * 1000;
    fs.utimesSync(path.join(indexDir, "repo_v16.00000.zoekt.123.tmp"), old / 1000, old / 1000);
    const removed = scope.cleanupTmpShards(indexDir);
    assert.equal(removed, 1, "only the >1h-old tmp file");
    assert.equal(fs.existsSync(path.join(indexDir, "repo_v16.00000.zoekt")), true);
    assert.equal(fs.existsSync(path.join(indexDir, "repo_v16.00000.zoekt.123.tmp")), false);
    assert.equal(fs.existsSync(path.join(indexDir, "repo_v16.00001.zoekt.456.tmp")), true);
  });

  it("checkIndexSizeCap under cap: no-op", () => {
    const indexDir = scope.zoektIndexDirOf(root);
    fs.mkdirSync(indexDir, { recursive: true });
    write(root, ".planning/intel/zoekt/index/small.zoekt", "x".repeat(100));
    const res = scope.checkIndexSizeCap(root, { maxIndexBytes: 1000 });
    assert.equal(res.disabled, false);
    assert.equal(fs.existsSync(indexDir), true);
  });

  it("checkIndexSizeCap over cap: deletes shards, writes marker, disables the lane", () => {
    const indexDir = scope.zoektIndexDirOf(root);
    fs.mkdirSync(indexDir, { recursive: true });
    write(root, ".planning/intel/zoekt/index/big.zoekt", "x".repeat(5000));
    const res = scope.checkIndexSizeCap(root, { maxIndexBytes: 1000 });
    assert.equal(res.disabled, true);
    assert.equal(fs.existsSync(indexDir), false, "runaway index must be deleted");
    const d = scope.readDisabled(root);
    assert.equal(d.reason, "index-size-cap");
    // and the lane stays off:
    assert.equal(
      reindex.shouldReindex(root, { filesChanged: 5, nowMs: Date.now() + 10 * 60 * 1000 }),
      false,
      "shouldReindex must respect the disabled marker"
    );
  });
});

describe("zoekt-scope — triggerReindex integration (shimmed indexer)", () => {
  let root, shimDir, argsFile, prevPath;
  beforeEach(() => {
    root = tmp("sextant-ztrig-");
    write(root, "lib/a.js", "module.exports = 1;\n");
    shimDir = tmp("sextant-ztrig-shim-");
    argsFile = path.join(shimDir, "args.txt");
    // Fake zoekt-index that records its argv. NOT a git repo → non-git path.
    fs.writeFileSync(path.join(shimDir, "zoekt-index"), `#!/bin/sh\necho "$@" > "${argsFile}"\nexit 0\n`);
    fs.chmodSync(path.join(shimDir, "zoekt-index"), 0o755);
    prevPath = process.env.PATH;
    process.env.PATH = shimDir + path.delimiter + prevPath;
  });
  const cleanup = () => {
    process.env.PATH = prevPath;
    for (const d of [root, shimDir]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
  };
  after(cleanup);

  async function waitFor(pred, ms = 5000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (pred()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  it("non-git root: spawns the indexer with -ignore_dirs covering node_modules/.planning", async () => {
    reindex.triggerReindex(root);
    assert.ok(await waitFor(() => fs.existsSync(argsFile)), "shim should have been invoked");
    const args = fs.readFileSync(argsFile, "utf8");
    assert.match(args, /-ignore_dirs/);
    assert.match(args, /node_modules/);
    assert.match(args, /\.planning/);
    // exit handler recorded success + cleared the pid
    assert.ok(await waitFor(() => {
      const st = reindex.readReindexState(root);
      return st.inProgress === false && st.lastReindexOk === true;
    }), "exit handler should mark the run finished");
    assert.equal(reindex.readReindexState(root).inProgressPid, undefined);
    cleanup();
  });

  it("disabled marker: triggerReindex is a no-op (indexer never spawned)", async () => {
    scope.writeDisabled(root, { reason: "corpus-too-large", detail: "test" });
    reindex.triggerReindex(root);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(fs.existsSync(argsFile), false, "shim must not run while disabled");
    cleanup();
  });

  it("corpus over cap: writes the disabled marker instead of spawning", async () => {
    write(root, ".codebase-intel.json", JSON.stringify({ zoektMaxCorpusBytes: 10 }));
    write(root, "lib/big.js", "x".repeat(1000));
    reindex.triggerReindex(root);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(fs.existsSync(argsFile), false, "indexer must not start on an over-cap corpus");
    const d = scope.readDisabled(root);
    assert.equal(d?.reason, "corpus-too-large");
    cleanup();
  });
});

describe("zoekt-reindex — stuck-indexer kill", () => {
  it("readReindexState surfaces stuckPid; killStuckIndexer kills only verified zoekt pids", async () => {
    const root = tmp("sextant-zstuck-");
    const binDir = tmp("sextant-zstuck-bin-");
    // writeReindexState is fail-soft — the state dir must exist for it to land.
    fs.mkdirSync(path.join(root, ".planning", "intel"), { recursive: true });
    try {
      // A long-running process whose ps command contains "zoekt".
      const fake = path.join(binDir, "zoekt-index");
      fs.writeFileSync(fake, "#!/bin/sh\nsleep 60\n");
      fs.chmodSync(fake, 0o755);
      const { spawn } = require("child_process");
      const child = spawn(fake, [], { stdio: "ignore" });
      await new Promise((r) => setTimeout(r, 100));

      reindex.writeReindexState(root, {
        lastReindexMs: 0,
        inProgress: true,
        inProgressSince: Date.now() - reindex.STUCK_TIMEOUT_MS - 1000,
        inProgressPid: child.pid,
      });
      const st = reindex.readReindexState(root);
      assert.equal(st.inProgress, false, "stuck flag cleared");
      assert.equal(st.stuckPid, child.pid, "pid preserved for the kill path");

      assert.equal(reindex.pidLooksLikeZoekt(child.pid), true);
      assert.equal(reindex.killStuckIndexer(st), true);
      await new Promise((r) => setTimeout(r, 200));
      let alive = true;
      try { process.kill(child.pid, 0); } catch { alive = false; }
      assert.equal(alive, false, "stuck indexer should be dead");

      // Identity check: a pid whose command has no "zoekt" is never killed.
      const innocent = spawn("sleep", ["60"], { stdio: "ignore" });
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(reindex.pidLooksLikeZoekt(innocent.pid), false);
      assert.equal(reindex.killStuckIndexer({ stuckPid: innocent.pid }), false);
      let innocentAlive = true;
      try { process.kill(innocent.pid, 0); } catch { innocentAlive = false; }
      assert.equal(innocentAlive, true, "non-zoekt process must survive");
      innocent.kill("SIGKILL");
    } finally {
      for (const d of [root, binDir]) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
      }
    }
  });
});
