"use strict";

// ANTI-SPRAWL CONTROLLER (docs/030 Phase E). Locks new-file detection, existing-
// match finding, the nudge text, and the offline create-then-abandon baseline.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

const graph = require("../lib/graph");
const AS = require("../lib/anti-sprawl");

describe("anti-sprawl — stemTokens", () => {
  it("splits camelCase and separators, keeps >=3-char alpha tokens", () => {
    assert.deepEqual(AS.stemTokens("lib/user-validator-helper.js"), ["user", "validator", "helper"]);
    assert.deepEqual(AS.stemTokens("commands/hookRefresh.js").sort(), ["hook", "refresh"]);
    // 2-char / numeric noise dropped
    assert.deepEqual(AS.stemTokens("a2.js"), []);
  });
});

describe("anti-sprawl — isNewSourceFile / findExistingMatches", () => {
  it("detects a not-yet-indexed indexable file as new, and surfaces matches", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sx-sprawl-"));
    try {
      const db = await graph.loadDb(dir);
      // an existing file that exports `validate`
      graph.upsertFile(db, { relPath: "lib/validator.js", type: "js", sizeBytes: 50, mtimeMs: 1 });
      graph.replaceExports(db, "lib/validator.js", [{ name: "validate", kind: "named" }]);

      // existing file → not new
      assert.equal(AS.isNewSourceFile(graph, db, "lib/validator.js"), false);
      // unindexed indexable → new
      assert.equal(AS.isNewSourceFile(graph, db, "lib/user-validator.js"), true);
      // non-indexable → not new (ignored)
      assert.equal(AS.isNewSourceFile(graph, db, "README.md"), false);

      // a new file whose name/symbol matches the existing validator
      const matches = AS.findExistingMatches(graph, db, "lib/user-validator.js", "export function validate(){}\n");
      assert.ok(matches.some((m) => m.path === "lib/validator.js"), "surfaces the existing validator");
      // never surfaces itself
      assert.ok(!matches.some((m) => m.path === "lib/user-validator.js"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("excludes test files from matches", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sx-sprawl2-"));
    try {
      const db = await graph.loadDb(dir);
      graph.upsertFile(db, { relPath: "test/widget.test.js", type: "js", sizeBytes: 50, mtimeMs: 1 });
      graph.replaceExports(db, "test/widget.test.js", [{ name: "widget", kind: "named" }]);
      const matches = AS.findExistingMatches(graph, db, "lib/widget.js", "export function widget(){}\n");
      assert.ok(!matches.some((m) => m.path === "test/widget.test.js"), "test files never suggested");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("composeSprawlNote lists matches factually", () => {
    const note = AS.composeSprawlNote("lib/new.js", [{ path: "lib/old.js" }, { path: "lib/other.js" }]);
    assert.ok(note.includes("lib/new.js"));
    assert.ok(note.includes("lib/old.js, lib/other.js"));
    assert.ok(/parallel implementation/.test(note));
  });
});

describe("anti-sprawl — analyzeSprawlHistory (git baseline)", () => {
  it("counts source files added then deleted within N commits", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sx-sprawlgit-"));
    const git = (args) => execSync(`git ${args}`, { cwd: dir, stdio: "pipe" });
    try {
      git("init -q");
      git('config user.email t@e.com');
      git('config user.name T');
      git("config commit.gpgsign false");
      // commit 0: add keep.js + throwaway.js
      fs.writeFileSync(path.join(dir, "keep.js"), "export const a=1;\n");
      fs.writeFileSync(path.join(dir, "throwaway.js"), "export const b=2;\n");
      git("add -A"); git('commit -q -m c0');
      // commit 1: delete throwaway.js (abandoned within 1 commit)
      fs.rmSync(path.join(dir, "throwaway.js"));
      git("add -A"); git('commit -q -m c1');

      const r = AS.analyzeSprawlHistory(dir, { withinCommits: 10 });
      assert.equal(r.addedSourceFiles, 2, "keep + throwaway added");
      assert.equal(r.abandonedWithin, 1, "throwaway abandoned");
      assert.ok(r.examples.some((e) => e.path === "throwaway.js"));
      assert.equal(r.abandonRate, 0.5);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty baseline outside a git repo (never throws)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sx-nogit-"));
    try {
      const r = AS.analyzeSprawlHistory(dir, {});
      assert.equal(r.addedSourceFiles, 0);
      assert.equal(r.abandonRate, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
