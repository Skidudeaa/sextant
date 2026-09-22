"use strict";

// Acceptance contract for the last Jev surface step: the MCP `judge` option on
// sextant_search (Choice reranking, docs/044), a `jev` block in sextant_health,
// and the documentation carve-out. Depends on lib/jev.js (core), lib/jev-rerank.js
// (rerank) and lib/challenge.js (challenge tool) already being present.
// No provider is called.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

const graph = require("../lib/graph");
const freshness = require("../lib/freshness");

async function buildRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-surface-"));
  fs.mkdirSync(path.join(dir, ".planning", "intel"), { recursive: true });
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  execSync("git init -q && git config user.email t@e.com && git config user.name T && git config commit.gpgsign false", { cwd: dir });
  fs.writeFileSync(path.join(dir, "lib", "resolveImportPath.js"), "function resolveImportPath(spec) {\n  return spec;\n}\nmodule.exports = { resolveImportPath };\n");
  fs.writeFileSync(path.join(dir, "lib", "resolveImportPathCache.js"), "const cache = new Map();\nfunction remember(k, v) {\n  cache.set(k, v);\n}\nmodule.exports = { remember };\n");
  execSync("git add -A && git commit -q -m x", { cwd: dir });
  const db = await graph.loadDb(dir);
  graph.upsertFile(db, { relPath: "lib/resolveImportPath.js", type: "js", sizeBytes: 80, mtimeMs: 1 });
  graph.upsertFile(db, { relPath: "lib/resolveImportPathCache.js", type: "js", sizeBytes: 90, mtimeMs: 1 });
  graph.replaceExports(db, "lib/resolveImportPath.js", [{ name: "resolveImportPath", kind: "named" }]);
  graph.replaceExports(db, "lib/resolveImportPathCache.js", [{ name: "remember", kind: "named" }]);
  freshness.recordScanState(db, dir);
  await graph.persistDb(dir);
  return dir;
}

describe("MCP surface: sextant_search judge + sextant_health jev", () => {
  let root, cfgHome, origCwd, origXdg, origKey, origJev;
  before(async () => {
    root = await buildRoot();
    cfgHome = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-cfg-"));
    origCwd = process.cwd;
    origXdg = process.env.XDG_CONFIG_HOME;
    origKey = process.env.TYPESAFE_API_KEY;
    origJev = process.env.SEXTANT_JEV;
    process.cwd = () => root;
    process.env.XDG_CONFIG_HOME = cfgHome;
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.SEXTANT_JEV;
  });
  after(() => {
    process.cwd = origCwd;
    if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = origXdg;
    if (origKey !== undefined) process.env.TYPESAFE_API_KEY = origKey;
    if (origJev !== undefined) process.env.SEXTANT_JEV = origJev;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(cfgHome, { recursive: true, force: true });
  });

  it("sextant_search declares `judge`; judge:true attaches jev {ok:false, reason:'no_credential'} without a network call; default output has no jev key", async () => {
    const { TOOLS, toolHandlers } = require("../mcp/server");
    const tool = TOOLS.find((t) => t.name === "sextant_search");
    assert.equal(tool.inputSchema.properties.judge.type, "boolean");
    assert.match(tool.inputSchema.properties.judge.description, /Jev|rerank/i);

    const plain = JSON.parse((await toolHandlers.sextant_search({ query: "resolveImportPath" })).content[0].text);
    assert.equal(plain.jev, undefined);
    assert.ok(Array.isArray(plain.files));

    const judged = JSON.parse((await toolHandlers.sextant_search({ query: "resolveImportPath", judge: true })).content[0].text);
    assert.ok(judged.jev, "judge:true must report the judgment");
    assert.equal(judged.jev.ok, false);
    assert.equal(judged.jev.reason, "no_credential");
    assert.deepEqual(judged.files.map((f) => f.path), plain.files.map((f) => f.path), "an unavailable judgment leaves the order untouched");
  });

  it("sextant_health reports the jev block: available/reason/enabled/model/ledger", async () => {
    const { toolHandlers } = require("../mcp/server");
    const out = JSON.parse((await toolHandlers.sextant_health({})).content[0].text);
    assert.ok(out.jev, "health must carry a jev block");
    assert.equal(out.jev.available, false);
    assert.equal(out.jev.reason, "no_credential");
    assert.equal(out.jev.enabled, false);
    assert.equal(out.jev.model, "jev-1.13.0");
    assert.deepEqual(Object.keys(out.jev.ledger).sort(), ["calls", "day", "inputTokens"]);
  });

  it("the tool list carries exactly the ten tools (nine + sextant_challenge) and sextant_challenge describes itself as advisory", () => {
    const { TOOLS } = require("../mcp/server");
    const names = TOOLS.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "sextant_challenge", "sextant_closure", "sextant_explain", "sextant_focus", "sextant_health",
      "sextant_orient", "sextant_related", "sextant_scope", "sextant_search", "sextant_task_status",
    ]);
    const ch = TOOLS.find((t) => t.name === "sextant_challenge");
    assert.match(ch.description, /model assessment|advisory|never (a )?fact/i);
  });
});

describe("documentation carve-out", () => {
  const readRepo = (f) => fs.readFileSync(path.resolve(__dirname, "..", f), "utf8");

  it("CLAUDE.md documents the Jev layer, its switches, and amends the LLM-call prohibition", () => {
    const md = readRepo("CLAUDE.md");
    assert.match(md, /^#{2,4} .*Jev/m, "a heading naming Jev");
    assert.match(md, /SEXTANT_JEV=0/);
    assert.match(md, /jev-ledger\.json/);
    assert.match(md, /sextant_challenge/);
    assert.match(md, /sextant challenge/);
    assert.match(md, /lib\/jev\.js/);
    assert.match(md, /lib\/jev-rerank\.js/);
    assert.match(md, /lib\/jev-sieve\.js/);
    assert.match(md, /lib\/challenge\.js/);
    // The old blanket rule must be amended, not silently contradicted.
    const whatNot = md.slice(md.indexOf("## What NOT to add"));
    assert.match(whatNot, /Jev/, "the What NOT to add section must carve out the Jev layer explicitly");
    assert.match(whatNot, /never (a |an )?(fact|authorit)/i);
  });

  it("README.md mentions the challenge command and the opt-in nature", () => {
    const md = readRepo("README.md");
    assert.match(md, /sextant challenge/);
    assert.match(md, /SEXTANT_JEV|jev\.enabled|opt-in/i);
  });
});
