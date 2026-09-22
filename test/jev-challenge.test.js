"use strict";

// Acceptance contract for refutation-first source challenge (lib/challenge.js,
// commands/challenge.js, commands/jev.js, MCP sextant_challenge). Measured basis:
// docs/044–045 — 32/32 verdicts, 31/32 refutation-scope selections on verbatim
// hashed Sextant source. The lab prototype is experiments/jev/assumption.js; this
// lifts it into the runtime with automatic scope selection and the same
// mutually-checked presentation (a refutation suggestion requires the verdict,
// the answerability head and the selected scope to agree, and unchanged source).
// No provider call is made anywhere in this file.

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execSync } = require("child_process");

const BIN = path.resolve(__dirname, "..", "bin", "intel.js");
const KEY = "sk-test-CANARY-KEY-challenge";

function mkRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-challenge-"));
  fs.mkdirSync(path.join(root, ".planning", "intel"), { recursive: true });
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "lib", "render.js"),
    [
      "'use strict';",
      "const MAX = 3;",
      "",
      "function renderAll(files) {",
      "  return files.slice(0, MAX).map((f) => f.path).join('\\n');",
      "}",
      "",
      "function renderOne(file) {",
      "  return file.path;",
      "}",
      "",
      "function helper() {",
      "  return 1;",
      "}",
      "",
      "module.exports = { renderAll, renderOne, helper, MAX };",
      "",
    ].join("\n")
  );
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1\n");
  execSync("git init -q && git config user.email t@e.com && git config user.name T && git config commit.gpgsign false && git add -A && git commit -q -m init", { cwd: root });
  return root;
}

function mkCfgHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-cfg-"));
}

function okResponse(body) {
  return { ok: true, status: 200, body: { cancel: async () => {} }, json: async () => body };
}

// Build a valid response for the three challenge questions.
function answer(req, { verdict, refutation, answerable }) {
  const vKeys = Object.keys(req.questions.verdict.criteria);
  const rKeys = Object.keys(req.questions.best_refutation.criteria);
  const dist = (keys, sel) => Object.fromEntries(keys.map((k) => [k, k === sel ? 0.8 : 0.2 / (keys.length - 1)]));
  return {
    model: req.model,
    usage: { input_tokens: 120, output_tokens: 3 },
    answers: {
      verdict: { type: "choice", choice: verdict, probabilities: dist(vKeys, verdict), confidence: 0.8 },
      best_refutation: { type: "choice", choice: refutation, probabilities: dist(rKeys, refutation), confidence: 0.8 },
      answerable: { type: "noul", noul: answerable },
    },
  };
}

function fakeFetch(plan, onRequest) {
  const calls = [];
  const fetch = async (url, init) => {
    const req = JSON.parse(init.body);
    calls.push({ url, req });
    if (onRequest) await onRequest(req);
    return okResponse(answer(req, plan));
  };
  fetch.calls = calls;
  return fetch;
}

describe("challenge(): request shape and mutually-checked presentation", () => {
  let root, cfgHome, env;
  beforeEach(() => { root = mkRepo(); cfgHome = mkCfgHome(); env = { XDG_CONFIG_HOME: cfgHome, TYPESAFE_API_KEY: KEY }; });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(cfgHome, { recursive: true, force: true }); });

  const CLAIM = "renderAll includes every file regardless of the MAX cap.";
  const SCOPES = [
    { path: "lib/render.js", symbol: "renderOne" },
    { path: "lib/render.js", symbol: "renderAll" },
    { path: "lib/render.js", symbol: "helper" },
  ];

  it("sends only the claim + verbatim scopes (no hashes) with the three lab questions; contradicts → refutation_candidate", async () => {
    const { challenge } = require("../lib/challenge");
    const fetch = fakeFetch({ verdict: "contradicts", refutation: "scope_1", answerable: 0.92 });
    const r = await challenge(root, { claim: CLAIM, scopes: SCOPES, fetch, env });

    assert.equal(fetch.calls.length, 1);
    const { req } = fetch.calls[0];
    assert.deepEqual(Object.keys(req).sort(), ["model", "questions", "state"]);
    assert.equal(req.state.proposed_claim, CLAIM);
    assert.deepEqual(req.state.scopes.map((s) => s.id), ["scope_0", "scope_1", "scope_2"]);
    for (const s of req.state.scopes) {
      assert.deepEqual(Object.keys(s).sort(), ["endLine", "id", "path", "source", "startLine", "symbol"]);
    }
    assert.ok(req.state.scopes[1].source.startsWith("function renderAll(files) {"));
    assert.ok(!JSON.stringify(req).includes("Sha256"), "hashes stay local");
    assert.deepEqual(Object.keys(req.questions).sort(), ["answerable", "best_refutation", "verdict"]);
    assert.equal(req.questions.verdict.type, "choice");
    assert.deepEqual(Object.keys(req.questions.verdict.criteria).sort(), ["contradicts", "insufficient", "supports"]);
    assert.equal(req.questions.best_refutation.type, "choice");
    assert.deepEqual(Object.keys(req.questions.best_refutation.criteria).sort(), ["none", "scope_0", "scope_1", "scope_2"]);
    assert.equal(req.questions.answerable.type, "noul");

    assert.equal(r.status, "refutation_candidate");
    assert.equal(r.verdict, "contradicts");
    assert.equal(r.answerable, 0.92);
    assert.deepEqual(r.reviewReasons, []);
    assert.equal(r.suggestedRefutation.scopeId, "scope_1");
    assert.equal(r.suggestedRefutation.path, "lib/render.js");
    assert.equal(r.suggestedRefutation.symbol, "renderAll");
    assert.equal(r.suggestedRefutation.startLine, 4);
    assert.equal(r.suggestedRefutation.endLine, 6);
    assert.match(r.suggestedRefutation.scopeSha256, /^[0-9a-f]{64}$/);
    assert.match(r.suggestedRefutation.fileSha256, /^[0-9a-f]{64}$/);
    assert.equal(r.scopes.length, 3);
    assert.ok(r.scopes.every((s) => /^[0-9a-f]{64}$/.test(s.scopeSha256)));
    assert.equal(r.freshness.unchanged, true);
    assert.equal(r.model, "jev-1.13.0");
    assert.match(r.interpretation, /model assessment/i);
    assert.ok(!JSON.stringify(r).includes(KEY));
  });

  it("supports/none → model_supports; insufficient/none/low answerable → insufficient_evidence", async () => {
    const { challenge } = require("../lib/challenge");
    let r = await challenge(root, { claim: CLAIM, scopes: SCOPES, env, fetch: fakeFetch({ verdict: "supports", refutation: "none", answerable: 0.9 }) });
    assert.equal(r.status, "model_supports");
    assert.equal(r.suggestedRefutation, null);
    r = await challenge(root, { claim: CLAIM, scopes: SCOPES, env, fetch: fakeFetch({ verdict: "insufficient", refutation: "none", answerable: 0.2 }) });
    assert.equal(r.status, "insufficient_evidence");
    assert.equal(r.suggestedRefutation, null);
  });

  it("head disagreement → needs_review with the exact lab reasons; no refutation is suggested", async () => {
    const { challenge } = require("../lib/challenge");
    let r = await challenge(root, { claim: CLAIM, scopes: SCOPES, env, fetch: fakeFetch({ verdict: "supports", refutation: "scope_0", answerable: 0.9 }) });
    assert.equal(r.status, "needs_review");
    assert.ok(r.reviewReasons.includes("refutation_scope_disagrees_with_verdict"));
    assert.equal(r.suggestedRefutation, null);

    r = await challenge(root, { claim: CLAIM, scopes: SCOPES, env, fetch: fakeFetch({ verdict: "contradicts", refutation: "none", answerable: 0.9 }) });
    assert.equal(r.status, "needs_review");
    assert.ok(r.reviewReasons.includes("contradiction_without_refutation_scope"));

    r = await challenge(root, { claim: CLAIM, scopes: SCOPES, env, fetch: fakeFetch({ verdict: "insufficient", refutation: "none", answerable: 0.9 }) });
    assert.equal(r.status, "needs_review");
    assert.ok(r.reviewReasons.includes("verdict_answerability_disagreement"));
  });

  it("source that changes while the request is in flight → needs_review source_changed_after_request", async () => {
    const { challenge } = require("../lib/challenge");
    const fetch = fakeFetch({ verdict: "contradicts", refutation: "scope_1", answerable: 0.9 }, () => {
      fs.appendFileSync(path.join(root, "lib", "render.js"), "\n// drift\n");
    });
    const r = await challenge(root, { claim: CLAIM, scopes: SCOPES, fetch, env });
    assert.equal(r.status, "needs_review");
    assert.ok(r.reviewReasons.includes("source_changed_after_request"));
    assert.equal(r.suggestedRefutation, null);
    assert.equal(r.freshness.unchanged, false);
  });

  it("unavailable without a network call: no credential, killed; provider failure → unavailable with the reason", async () => {
    const { challenge } = require("../lib/challenge");
    const fetch = fakeFetch({ verdict: "supports", refutation: "none", answerable: 0.9 });
    let r = await challenge(root, { claim: CLAIM, scopes: SCOPES, fetch, env: { XDG_CONFIG_HOME: cfgHome } });
    assert.deepEqual([r.status, r.reason], ["unavailable", "no_credential"]);
    r = await challenge(root, { claim: CLAIM, scopes: SCOPES, fetch, env: { ...env, SEXTANT_JEV: "0" } });
    assert.deepEqual([r.status, r.reason], ["unavailable", "killed"]);
    assert.equal(fetch.calls.length, 0);

    const f500 = async () => ({ ok: false, status: 500, body: { cancel: async () => {} }, json: async () => ({ error: "PROVIDER-BODY-CANARY" }) });
    r = await challenge(root, { claim: CLAIM, scopes: SCOPES, fetch: f500, env });
    assert.deepEqual([r.status, r.reason], ["unavailable", "http_error"]);
    assert.ok(!JSON.stringify(r).includes("PROVIDER-BODY-CANARY"));
  });

  it("scope errors are reported, not thrown: sensitive path / missing symbol → unavailable invalid_scope with details", async () => {
    const { challenge } = require("../lib/challenge");
    const fetch = fakeFetch({ verdict: "supports", refutation: "none", answerable: 0.9 });
    let r = await challenge(root, { claim: CLAIM, scopes: [{ path: ".env", line: 1 }], fetch, env });
    assert.deepEqual([r.status, r.reason], ["unavailable", "invalid_scope"]);
    assert.ok(Array.isArray(r.scopeErrors) && r.scopeErrors[0].code === "sensitive_path");
    r = await challenge(root, { claim: CLAIM, scopes: [{ path: "lib/render.js", symbol: "nope" }], fetch, env });
    assert.deepEqual([r.status, r.reason], ["unavailable", "invalid_scope"]);
    assert.equal(r.scopeErrors[0].code, "symbol_not_found");
    assert.equal(fetch.calls.length, 0);
    assert.equal(typeof require("../lib/challenge").MAX_SCOPES, "number");
    assert.equal(require("../lib/challenge").MAX_SCOPES, 6);
  });

  it("automatic scope selection: retrieval hits → enclosing scopes, deduped, sensitive paths skipped, capped at MAX_SCOPES", async () => {
    const { challenge } = require("../lib/challenge");
    const fetch = fakeFetch({ verdict: "contradicts", refutation: "scope_0", answerable: 0.9 });
    const retrieveFn = async (r, claim) => {
      assert.equal(r, root);
      assert.equal(claim, CLAIM);
      return [
        { path: "lib/render.js", line: 5 },  // renderAll
        { path: "lib/render.js", line: 4 },  // renderAll again → dedupe
        { path: ".env", line: 1 },           // sensitive → skipped
        { path: "lib/render.js", line: 9 },  // renderOne
        { path: "lib/render.js", line: 13 }, // helper
        { path: "lib/missing.js", line: 1 }, // unreadable → skipped
      ];
    };
    const r = await challenge(root, { claim: CLAIM, fetch, env, retrieveFn });
    assert.equal(r.status, "refutation_candidate");
    assert.deepEqual(r.scopes.map((s) => s.symbol), ["renderAll", "renderOne", "helper"]);
    assert.equal(r.suggestedRefutation.symbol, "renderAll");
    assert.equal(fetch.calls[0].req.state.scopes.length, 3);

    // Cap: more distinct scopes than MAX_SCOPES → first MAX_SCOPES by retrieval order.
    const many = Array.from({ length: 10 }, (_, i) => `function f${i}() {\n  return ${i};\n}\n`).join("\n");
    fs.writeFileSync(path.join(root, "lib", "many.js"), many);
    const lines = Array.from({ length: 10 }, (_, i) => ({ path: "lib/many.js", line: i * 4 + 2 }));
    const r2 = await challenge(root, { claim: CLAIM, fetch, env, retrieveFn: async () => lines });
    assert.equal(r2.scopes.length, 6);
    assert.deepEqual(r2.scopes.map((s) => s.symbol), ["f0", "f1", "f2", "f3", "f4", "f5"]);

    // Nothing usable → unavailable/no_scopes, no network.
    const before = fetch.calls.length;
    const r3 = await challenge(root, { claim: CLAIM, fetch, env, retrieveFn: async () => [{ path: ".env", line: 1 }] });
    assert.deepEqual([r3.status, r3.reason], ["unavailable", "no_scopes"]);
    assert.equal(fetch.calls.length, before);
  });
});

describe("challenge surfaces: CLI, `sextant jev status`, MCP tool", () => {
  let root, cfgHome;
  beforeEach(() => { root = mkRepo(); cfgHome = mkCfgHome(); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(cfgHome, { recursive: true, force: true }); });

  // Every spawned process pins XDG_CONFIG_HOME to an empty dir and strips the
  // env key: this suite must never read the machine's real credential.
  function run(args) {
    const env = { ...process.env, XDG_CONFIG_HOME: cfgHome };
    delete env.TYPESAFE_API_KEY;
    delete env.SEXTANT_JEV;
    return spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: "utf8", env, timeout: 30000 });
  }

  it("sextant challenge --json reports unavailable/no_credential without a network call and exits 0", () => {
    const res = run(["challenge", "renderAll caps at MAX", "--scope", "lib/render.js:renderAll", "--scope", "lib/render.js:renderOne", "--root", root, "--json"]);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.status, "unavailable");
    assert.equal(out.reason, "no_credential");
    assert.equal(out.claim, "renderAll caps at MAX");
  });

  it("sextant challenge without --json prints a human line naming the status", () => {
    const res = run(["challenge", "renderAll caps at MAX", "--scope", "lib/render.js:renderAll", "--root", root]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /unavailable/);
    assert.match(res.stdout, /no_credential/);
  });

  it("sextant challenge with no claim exits 1 with usage", () => {
    const res = run(["challenge", "--root", root]);
    assert.equal(res.status, 1);
    assert.match(res.stderr + res.stdout, /Usage: sextant challenge/);
  });

  it("sextant jev status --json reports availability, settings and ledger; usage lists challenge and jev", () => {
    const res = run(["jev", "status", "--root", root, "--json"]);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.available, false);
    assert.equal(out.reason, "no_credential");
    assert.equal(out.settings.enabled, false);
    assert.equal(out.settings.model, "jev-1.13.0");
    assert.deepEqual(Object.keys(out.ledger).sort(), ["calls", "day", "inputTokens"]);
    const usage = run(["--help"]);
    assert.match(usage.stdout, /sextant challenge "<claim>"/);
    assert.match(usage.stdout, /sextant jev status/);
  });

  it("MCP: sextant_challenge is registered with a claim schema and answers unavailable/no_credential cleanly", async () => {
    const { TOOLS, toolHandlers } = require("../mcp/server");
    const tool = TOOLS.find((t) => t.name === "sextant_challenge");
    assert.ok(tool, "sextant_challenge must be registered");
    assert.deepEqual(tool.inputSchema.required, ["claim"]);
    assert.equal(tool.inputSchema.properties.claim.type, "string");
    assert.equal(tool.inputSchema.properties.scopes.type, "array");
    assert.match(tool.description, /refut|contradict/i);

    const origCwd = process.cwd;
    const origXdg = process.env.XDG_CONFIG_HOME;
    const origKey = process.env.TYPESAFE_API_KEY;
    process.cwd = () => root;
    process.env.XDG_CONFIG_HOME = cfgHome;
    delete process.env.TYPESAFE_API_KEY;
    try {
      const res = await toolHandlers.sextant_challenge({ claim: "renderAll caps at MAX", scopes: ["lib/render.js:renderAll", "lib/render.js:9"] });
      assert.ok(!res.isError, JSON.stringify(res));
      const out = JSON.parse(res.content[0].text);
      assert.equal(out.status, "unavailable");
      assert.equal(out.reason, "no_credential");
    } finally {
      process.cwd = origCwd;
      if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = origXdg;
      if (origKey !== undefined) process.env.TYPESAFE_API_KEY = origKey;
    }
  });
});
