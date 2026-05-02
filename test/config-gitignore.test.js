"use strict";

// WHY: lib/config.js's gitignore-honoring extension is load-bearing for
// the file walk -- a wrong filter either silently indexes vendored crud
// (regression of the dogfooding bug) or silently excludes real source
// files. These tests pin the contract: when .gitignore is present and
// honoring is enabled, the filter matches gitignore semantics; when
// honoring is disabled or the file is absent, the filter is null.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { loadRepoConfig } = require("../lib/config");

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sextant-cfg-gi-"));
}

function rmrf(p) {
  if (p) fs.rmSync(p, { recursive: true, force: true });
}

describe("loadRepoConfig — .gitignore honoring", () => {
  it("returns null filter when no .gitignore exists", () => {
    const root = tmpRoot();
    try {
      const cfg = loadRepoConfig(root);
      assert.equal(cfg.gitignoreHonoring, true, "default-on");
      assert.equal(cfg.gitignorePresent, false);
      assert.equal(cfg.gitignoreFilter, null);
    } finally {
      rmrf(root);
    }
  });

  it("builds a working filter from a present .gitignore", () => {
    const root = tmpRoot();
    try {
      fs.writeFileSync(
        path.join(root, ".gitignore"),
        ["build/", "*.log", "secrets.json"].join("\n")
      );
      const cfg = loadRepoConfig(root);
      assert.equal(cfg.gitignorePresent, true);
      assert.equal(typeof cfg.gitignoreFilter, "function");
      assert.equal(cfg.gitignoreFilter("build/main.js"), true, "dir-glob excluded");
      assert.equal(cfg.gitignoreFilter("debug.log"), true, "extension excluded");
      assert.equal(cfg.gitignoreFilter("secrets.json"), true, "exact match excluded");
      assert.equal(cfg.gitignoreFilter("src/index.js"), false, "real source kept");
      assert.equal(cfg.gitignoreFilter("README.md"), false, "unrelated file kept");
    } finally {
      rmrf(root);
    }
  });

  it("honors gitignore negations (! re-include) for file patterns", () => {
    // WHY: gitignore semantics — re-include works only when the parent
    // directory is NOT excluded. `*.log` excludes log files but
    // `!important.log` re-includes the named one. (`build/` then
    // `!build/keep-me.txt` would NOT work because the parent dir is
    // excluded — this is documented gitignore behavior, mirrored by the
    // `ignore` package.)
    const root = tmpRoot();
    try {
      fs.writeFileSync(
        path.join(root, ".gitignore"),
        ["*.log", "!important.log"].join("\n")
      );
      const cfg = loadRepoConfig(root);
      assert.equal(cfg.gitignoreFilter("debug.log"), true, "*.log excludes");
      assert.equal(cfg.gitignoreFilter("important.log"), false, "negation re-includes");
    } finally {
      rmrf(root);
    }
  });

  it("honors gitignoreHonoring:false in .codebase-intel.json", () => {
    const root = tmpRoot();
    try {
      fs.writeFileSync(path.join(root, ".gitignore"), "build/\n");
      fs.writeFileSync(
        path.join(root, ".codebase-intel.json"),
        JSON.stringify({ gitignoreHonoring: false })
      );
      const cfg = loadRepoConfig(root);
      assert.equal(cfg.gitignoreHonoring, false);
      assert.equal(cfg.gitignoreFilter, null, "filter not built when disabled");
    } finally {
      rmrf(root);
    }
  });

  it("filter normalizes ./prefix and backslashes", () => {
    const root = tmpRoot();
    try {
      fs.writeFileSync(path.join(root, ".gitignore"), "build/\n");
      const cfg = loadRepoConfig(root);
      assert.equal(cfg.gitignoreFilter("./build/x.js"), true);
      // Backslashes (Windows-style) should be normalized to forward slashes.
      assert.equal(cfg.gitignoreFilter("build\\x.js"), true);
    } finally {
      rmrf(root);
    }
  });

  it("filter rejects empty / parent paths defensively (returns false)", () => {
    const root = tmpRoot();
    try {
      fs.writeFileSync(path.join(root, ".gitignore"), "build/\n");
      const cfg = loadRepoConfig(root);
      assert.equal(cfg.gitignoreFilter(""), false);
      assert.equal(cfg.gitignoreFilter(null), false);
      assert.equal(cfg.gitignoreFilter("../escape.js"), false);
    } finally {
      rmrf(root);
    }
  });

  it("fails soft on a malformed .gitignore", () => {
    const root = tmpRoot();
    try {
      // The `ignore` package accepts almost anything (it's lenient by
      // design), but we still wrap in try/catch. Write a binary blob to
      // confirm we never throw.
      fs.writeFileSync(path.join(root, ".gitignore"), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
      const cfg = loadRepoConfig(root);
      // Either a working filter or null is acceptable -- the contract is
      // "must not throw and must not block scanning".
      assert.ok(cfg.gitignoreFilter === null || typeof cfg.gitignoreFilter === "function");
    } finally {
      rmrf(root);
    }
  });
});

describe("intel.scan — .gitignore filter integration", () => {
  it("excludes files matching .gitignore from the scan", async () => {
    const root = tmpRoot();
    try {
      fs.mkdirSync(path.join(root, ".planning", "intel"), { recursive: true });
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.mkdirSync(path.join(root, "generated"), { recursive: true });
      fs.writeFileSync(path.join(root, "src", "real.js"), "module.exports = {};\n");
      fs.writeFileSync(path.join(root, "generated", "fake.js"), "module.exports = {};\n");
      fs.writeFileSync(path.join(root, ".gitignore"), "generated/\n");

      const cfg = loadRepoConfig(root);
      assert.equal(typeof cfg.gitignoreFilter, "function");

      const intel = require("../lib/intel");
      await intel.scan(root, ["**/*.js"], {
        ignore: cfg.ignore,
        gitignoreFilter: cfg.gitignoreFilter,
      });

      const graph = require("../lib/graph");
      const db = await graph.loadDb(root);
      const indexed = graph.allFilePaths(db);
      assert.ok(indexed.includes("src/real.js"), "real source indexed");
      assert.ok(!indexed.includes("generated/fake.js"), "gitignored file skipped");
    } finally {
      rmrf(root);
    }
  });

  it("indexes everything when gitignoreHonoring is disabled", async () => {
    const root = tmpRoot();
    try {
      fs.mkdirSync(path.join(root, ".planning", "intel"), { recursive: true });
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.mkdirSync(path.join(root, "generated"), { recursive: true });
      fs.writeFileSync(path.join(root, "src", "real.js"), "module.exports = {};\n");
      fs.writeFileSync(path.join(root, "generated", "fake.js"), "module.exports = {};\n");
      fs.writeFileSync(path.join(root, ".gitignore"), "generated/\n");
      fs.writeFileSync(
        path.join(root, ".codebase-intel.json"),
        JSON.stringify({ gitignoreHonoring: false })
      );

      const cfg = loadRepoConfig(root);
      assert.equal(cfg.gitignoreFilter, null);

      const intel = require("../lib/intel");
      await intel.scan(root, ["**/*.js"], {
        ignore: cfg.ignore,
        gitignoreFilter: cfg.gitignoreFilter,
      });

      const graph = require("../lib/graph");
      const db = await graph.loadDb(root);
      const indexed = graph.allFilePaths(db);
      assert.ok(indexed.includes("src/real.js"));
      assert.ok(indexed.includes("generated/fake.js"), "gitignore disabled — file indexed");
    } finally {
      rmrf(root);
    }
  });
});
