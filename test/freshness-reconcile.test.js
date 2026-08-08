"use strict";

// The incremental reconcile across git-state moves + bounded membership
// repair — the stale-problem fix (2026-08-08). These lock the three behaviors
// that turned a 45% fleet stale rate into in-process recovery:
//   1. A COMMIT (HEAD move, dirty set empties) re-anchors incrementally.
//   2. A CHECKOUT whose files are clean on both sides re-anchors AND the
//      graph reflects the new tree — the head-diff union is the only thing
//      standing between this case and a fresh anchor over a stale graph.
//   3. A file APPEARING/DISAPPEARING repairs cross-file resolution in-process
//      (previously: sticky full-scan flag, stale until a bulk rescan landed).
//   4. The repair REFUSES over its importer cap and preserves the stale
//      anchor (repair is an optimization, never a correctness downgrade).
//   5. syncRescan passes --force only when asked (version staleness);
//      content staleness keeps the per-file cache.
// The not-file (symlink) refusal is locked by intel-scan.test.js.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const intel = require("../lib/intel");
const graph = require("../lib/graph");
const freshness = require("../lib/freshness");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sextant-reconcile-"));
}

function writeFile(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function g(root, cmd) {
  return execSync(cmd, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

function initGit(root) {
  g(root, "git init -q");
  g(root, "git add -A && git commit -qm base");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The incremental persist runs on a 750ms debounce; poll rather than guess.
async function waitFresh(root, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let checked = null;
  while (Date.now() < deadline) {
    checked = await freshness.checkFreshness(root);
    if (checked.fresh) return checked;
    await sleep(100);
  }
  return checked;
}

async function importKind(root, fromRel, specifier) {
  const db = await graph.loadDb(root);
  return graph.queryImports(db, fromRel).find((r) => r.specifier === specifier)?.kind ?? "(none)";
}

describe("incremental reconcile — git-state moves", () => {
  it("re-anchors across a commit without a bulk scan", async () => {
    const root = mkTmp();
    try {
      writeFile(root, "a.js", "const b = require('./b');\n");
      writeFile(root, "b.js", "module.exports = 1;\n");
      initGit(root);
      await intel.scan(root, ["**/*.js"], { ignore: [] });

      writeFile(root, "b.js", "module.exports = 2;\n");
      await intel.updateFile(root, "b.js");
      assert.equal((await waitFresh(root)).fresh, true, "edit should reconcile");

      g(root, "git add -A && git commit -qm edit");
      let checked = await freshness.checkFreshness(root);
      assert.equal(checked.fresh, false, "commit moves HEAD; anchor is momentarily stale");
      assert.equal(checked.reason, "head_changed");

      intel.notifyRepoStateChanged(root);
      checked = await waitFresh(root);
      assert.equal(checked.fresh, true, "commit must re-anchor via incremental reconcile");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("checkout with clean-on-both-sides files re-anchors AND updates the graph (head-diff union)", async () => {
    const root = mkTmp();
    try {
      writeFile(root, "f.js", "export const era = 'A';\n");
      initGit(root);
      g(root, "git checkout -qb other");
      writeFile(root, "f.js", "export const era = 'B';\nexport const onlyInB = true;\n");
      g(root, "git add -A && git commit -qm eraB");
      g(root, "git checkout -q master 2>/dev/null || git checkout -q main");

      // Scan on the A side; f.js is clean here and clean on the other branch,
      // so NO dirty entry and NO watcher event will ever name it. Only the
      // head-diff union can carry it into the reconcile.
      await intel.scan(root, ["**/*.js"], { ignore: [] });
      g(root, "git checkout -q other");

      intel.notifyRepoStateChanged(root);
      const checked = await waitFresh(root);
      assert.equal(checked.fresh, true, "checkout must re-anchor incrementally");

      const db = await graph.loadDb(root);
      const names = graph.queryExports(db, "f.js").map((e) => e.name);
      // If the head-diff union is dropped, the anchor above can still be
      // re-recorded — but over a graph that has never seen era B. This is the
      // assertion that makes that mutation fatal instead of silent.
      assert.ok(
        names.includes("onlyInB"),
        `fresh anchor must describe the checked-out tree; exports were [${names}]`
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("incremental reconcile — membership repair", () => {
  it("a new file re-anchors and resolves the imports it satisfies", async () => {
    const root = mkTmp();
    try {
      writeFile(root, "a.js", "const b = require('./b');\n");
      initGit(root);
      await intel.scan(root, ["**/*.js"], { ignore: [] });
      assert.equal(await importKind(root, "a.js", "./b"), "unresolved");

      writeFile(root, "b.js", "module.exports = 2;\n");
      await intel.updateFile(root, "b.js");
      const checked = await waitFresh(root);
      assert.equal(checked.fresh, true, "new file must not require a bulk scan");
      assert.equal(await importKind(root, "a.js", "./b"), "relative", "repair must re-resolve a.js");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a deleted file re-anchors and dangles the imports that pointed at it", async () => {
    const root = mkTmp();
    try {
      writeFile(root, "a.js", "const b = require('./b');\n");
      writeFile(root, "b.js", "module.exports = 2;\n");
      initGit(root);
      await intel.scan(root, ["**/*.js"], { ignore: [] });
      assert.equal(await importKind(root, "a.js", "./b"), "relative");

      fs.unlinkSync(path.join(root, "b.js"));
      await intel.updateFile(root, "b.js");
      const checked = await waitFresh(root);
      assert.equal(checked.fresh, true, "deletion must not require a bulk scan");
      assert.equal(await importKind(root, "a.js", "./b"), "unresolved", "repair must dangle a.js");
      const db = await graph.loadDb(root);
      assert.equal(graph.getFileMeta(db, "b.js"), null, "deleted file's row must be pruned");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses repair over the importer cap and keeps the anchor stale", async () => {
    const root = mkTmp();
    try {
      // 201 importers of a missing './target' — one over
      // MEMBERSHIP_REPAIR_MAX_IMPORTERS (200). Creating target.js makes every
      // one of them an affected importer, so the repair must refuse and the
      // reconcile must publish an invalidated anchor (bulk-scan territory).
      for (let i = 0; i < 201; i++) {
        writeFile(root, `imp${i}.js`, "const t = require('./target');\n");
      }
      initGit(root);
      await intel.scan(root, ["**/*.js"], { ignore: [] });

      writeFile(root, "target.js", "module.exports = 1;\n");
      await intel.updateFile(root, "target.js");
      await sleep(1500); // let the debounced persist run
      const checked = await freshness.checkFreshness(root);
      assert.equal(checked.fresh, false, "over-cap membership change must stay stale");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("syncRescan — conditional --force", () => {
  // A stub binary records its argv; SEXTANT_BIN points syncRescan at it.
  function runWithStub(forceOpt) {
    const root = mkTmp();
    try {
      fs.mkdirSync(path.join(root, ".planning", "intel"), { recursive: true });
      const argvFile = path.join(root, "argv.json");
      const stub = path.join(root, "stub.js");
      fs.writeFileSync(
        stub,
        `require("fs").writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\n`
      );
      const prev = process.env.SEXTANT_BIN;
      process.env.SEXTANT_BIN = stub;
      try {
        const res = freshness.syncRescan(root, 5000, forceOpt);
        assert.equal(res.state, "completed");
      } finally {
        if (prev === undefined) delete process.env.SEXTANT_BIN;
        else process.env.SEXTANT_BIN = prev;
      }
      return JSON.parse(fs.readFileSync(argvFile, "utf8"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  it("omits --force for content staleness and keeps it for version staleness", () => {
    const nonForce = runWithStub({ forceReindex: false });
    assert.ok(!nonForce.includes("--force"), `expected no --force, got ${nonForce}`);
    const forced = runWithStub({ forceReindex: true });
    assert.ok(forced.includes("--force"), `expected --force, got ${forced}`);
    const legacy = runWithStub(undefined);
    assert.ok(legacy.includes("--force"), "default must stay forced (conservative)");
  });
});
