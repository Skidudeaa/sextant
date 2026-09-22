"use strict";

// Acceptance contract for the runtime Jev layer (lib/jev-client.js, lib/jev.js,
// lib/jev-state.js). Written BEFORE the implementation; every assertion here is
// a behavior the lab measured or a boundary the design requires:
//   - the credential never reaches telemetry, the ledger, results or errors
//   - a kill switch / missing credential / exhausted budget refuses WITHOUT a
//     network call
//   - source scopes are verbatim, hashed, bounded, and never from a
//     secret-bearing path (lib/zoekt-scope.js:isSensitivePath)
//   - the request state carries no local hashes or labels (docs/043 payload rule)
//   - value questions use executable code literals (docs/047: 32/32 vs 25/32)
// No test here makes a provider call; fetch is always injected.

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const KEY = "sk-test-CANARY-KEY-0123456789";
const PROVIDER_SECRET = "PROVIDER-BODY-CANARY-\"quoted\"\\backslash\nnewline";

function mkRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-core-"));
  fs.mkdirSync(path.join(root, ".planning", "intel"), { recursive: true });
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "lib", "a.js"),
    [
      "'use strict';",
      "",
      "function alpha(x) {",
      "  if (x == null) return 0;",
      "  return x + 1;",
      "}",
      "",
      "function beta(list) {",
      "  return list.filter((v) => v != null);",
      "}",
      "",
      "module.exports = { alpha, beta };",
      "",
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(root, "lib", "p.py"),
    ["def gamma(x):", "    return x * 2", "", "", "def delta(y):", "    return y", ""].join("\n")
  );
  fs.writeFileSync(path.join(root, ".env"), "DB_PASSWORD=hunter2\n");
  fs.writeFileSync(path.join(root, "README.md"), "# readme\n");
  return root;
}

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function okResponse(body) {
  return {
    ok: true,
    status: 200,
    body: { cancel: async () => {} },
    json: async () => body,
  };
}

function makeFetch(answerer) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return answerer(url, init, calls.length);
  };
  fetch.calls = calls;
  return fetch;
}

const NOUL_Q = {
  q1: { type: "noul", instructions: "Is the sky blue?", criteria: { true: "yes", false: "no" } },
};

function noulAnswer(model = "jev-1.13.0", usage = { input_tokens: 150, output_tokens: 3 }) {
  return { model, usage, answers: { q1: { type: "noul", noul: 0.91 } } };
}

describe("jev core: client lift", () => {
  it("lib/jev-client exports the contract client and experiments/jev/client re-exports it", () => {
    const lib = require("../lib/jev-client");
    assert.equal(typeof lib.JevClient, "function");
    assert.equal(typeof lib.JevError, "function");
    assert.equal(typeof lib.validateResponse, "function");
    const lab = require("../experiments/jev/client");
    assert.equal(lab.JevClient, lib.JevClient, "the lab must use the runtime client, not a copy");
    assert.equal(lab.validateResponse, lib.validateResponse);
  });
});

describe("jev core: credential + settings + availability", () => {
  let root;
  let cfgHome;
  beforeEach(() => {
    root = mkRepo();
    cfgHome = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-cfg-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(cfgHome, { recursive: true, force: true });
  });

  it("loadApiKey: env wins, then $XDG_CONFIG_HOME/typesafe/api_key (trimmed), else null; never throws", () => {
    const { loadApiKey } = require("../lib/jev");
    assert.equal(loadApiKey({ XDG_CONFIG_HOME: cfgHome }), null);
    fs.mkdirSync(path.join(cfgHome, "typesafe"), { recursive: true });
    fs.writeFileSync(path.join(cfgHome, "typesafe", "api_key"), "  file-key-123\n");
    assert.equal(loadApiKey({ XDG_CONFIG_HOME: cfgHome }), "file-key-123");
    assert.equal(loadApiKey({ XDG_CONFIG_HOME: cfgHome, TYPESAFE_API_KEY: KEY }), KEY);
    assert.equal(loadApiKey({ XDG_CONFIG_HOME: cfgHome, TYPESAFE_API_KEY: "   " }), "file-key-123");
    // Unreadable config home must not throw.
    assert.equal(loadApiKey({ XDG_CONFIG_HOME: path.join(cfgHome, "missing", "deeper") }), null);
  });

  it("jevSettings: defaults are off for ambient lanes, and config/env opt in", () => {
    const { jevSettings, DEFAULT_MODEL } = require("../lib/jev");
    assert.equal(DEFAULT_MODEL, "jev-1.13.0");
    const d = jevSettings(root, {});
    assert.equal(d.enabled, false);
    assert.equal(d.model, "jev-1.13.0");
    assert.equal(d.maxDailyInputTokens, 2_000_000);
    assert.equal(d.timeoutMs, 8000);
    assert.equal(d.hookTimeoutMs, 700);
    assert.deepEqual(d.lanes, { rerank: true, intent: true, editSieve: true });

    fs.writeFileSync(
      path.join(root, ".codebase-intel.json"),
      JSON.stringify({ jev: { enabled: true, model: "jev-9.9.9", maxDailyInputTokens: 500, lanes: { rerank: false } } })
    );
    const c = jevSettings(root, {});
    assert.equal(c.enabled, true);
    assert.equal(c.model, "jev-9.9.9");
    assert.equal(c.maxDailyInputTokens, 500);
    assert.deepEqual(c.lanes, { rerank: false, intent: true, editSieve: true });

    // Env overrides: SEXTANT_JEV=1 enables ambient lanes; =0 kills everything.
    fs.unlinkSync(path.join(root, ".codebase-intel.json"));
    assert.equal(jevSettings(root, { SEXTANT_JEV: "1" }).enabled, true);
    const killed = jevSettings(root, { SEXTANT_JEV: "0" });
    assert.equal(killed.enabled, false);
    assert.equal(killed.killed, true);
    assert.equal(jevSettings(root, { SEXTANT_JEV_MODEL: "jev-2.0.0" }).model, "jev-2.0.0");
  });

  it("availability: killed > no_credential > budget_exhausted > ok", () => {
    const { availability, writeLedger } = require("../lib/jev");
    assert.deepEqual(availability(root, { XDG_CONFIG_HOME: cfgHome, SEXTANT_JEV: "0", TYPESAFE_API_KEY: KEY }), { ok: false, reason: "killed" });
    assert.deepEqual(availability(root, { XDG_CONFIG_HOME: cfgHome }), { ok: false, reason: "no_credential" });
    assert.deepEqual(availability(root, { XDG_CONFIG_HOME: cfgHome, TYPESAFE_API_KEY: KEY }), { ok: true, reason: null });

    fs.writeFileSync(path.join(root, ".codebase-intel.json"), JSON.stringify({ jev: { maxDailyInputTokens: 100 } }));
    const today = new Date().toISOString().slice(0, 10);
    writeLedger(root, { day: today, calls: 1, inputTokens: 150 });
    assert.deepEqual(availability(root, { XDG_CONFIG_HOME: cfgHome, TYPESAFE_API_KEY: KEY }), { ok: false, reason: "budget_exhausted" });
    // A ledger from another day does not count against today.
    writeLedger(root, { day: "2000-01-01", calls: 9, inputTokens: 10 ** 9 });
    assert.deepEqual(availability(root, { XDG_CONFIG_HOME: cfgHome, TYPESAFE_API_KEY: KEY }), { ok: true, reason: null });
    // maxDailyInputTokens: 0 opts out of the cap entirely.
    fs.writeFileSync(path.join(root, ".codebase-intel.json"), JSON.stringify({ jev: { maxDailyInputTokens: 0 } }));
    writeLedger(root, { day: today, calls: 1, inputTokens: 10 ** 9 });
    assert.deepEqual(availability(root, { XDG_CONFIG_HOME: cfgHome, TYPESAFE_API_KEY: KEY }), { ok: true, reason: null });
  });
});

describe("jev core: ask()", () => {
  let root;
  let cfgHome;
  let env;
  beforeEach(() => {
    root = mkRepo();
    cfgHome = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-cfg-"));
    env = { XDG_CONFIG_HOME: cfgHome, TYPESAFE_API_KEY: KEY };
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(cfgHome, { recursive: true, force: true });
  });

  it("happy path: POSTs exactly {state,questions,model} with the bearer key; returns answers; records telemetry + ledger", async () => {
    const { ask, readLedger } = require("../lib/jev");
    const { readEvents } = require("../lib/telemetry");
    const fetch = makeFetch(() => okResponse(noulAnswer()));
    const state = { proposed_claim: "the sky is blue", note: "x\"y\\z\nw" };
    const res = await ask(root, { purpose: "unit", state, questions: NOUL_Q, fetch, env });
    assert.equal(res.ok, true);
    assert.equal(res.model, "jev-1.13.0");
    assert.equal(res.answers.q1.noul, 0.91);
    assert.deepEqual(res.usage, { input_tokens: 150, output_tokens: 3 });
    assert.equal(typeof res.latencyMs, "number");

    assert.equal(fetch.calls.length, 1);
    const [{ url, init }] = fetch.calls;
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
    const sent = JSON.parse(init.body);
    assert.deepEqual(Object.keys(sent).sort(), ["model", "questions", "state"]);
    assert.deepEqual(sent.state, state);
    assert.equal(sent.model, "jev-1.13.0");

    const events = readEvents(root).filter((e) => e.name === "jev.invoked");
    assert.equal(events.length, 1);
    assert.equal(events[0].purpose, "unit");
    assert.equal(events[0].ok, true);
    assert.equal(events[0].inputTokens, 150);
    assert.equal(events[0].outputTokens, 3);
    assert.equal(events[0].model, "jev-1.13.0");
    assert.equal(typeof events[0].durationMs, "number");

    const ledger = readLedger(root);
    assert.equal(ledger.day, new Date().toISOString().slice(0, 10));
    assert.equal(ledger.calls, 1);
    assert.equal(ledger.inputTokens, 150);

    // Second call accumulates.
    await ask(root, { purpose: "unit", state, questions: NOUL_Q, fetch, env });
    assert.equal(readLedger(root).inputTokens, 300);
    assert.equal(readLedger(root).calls, 2);
  });

  it("explicit model override reaches the wire", async () => {
    const { ask } = require("../lib/jev");
    const fetch = makeFetch(() => okResponse(noulAnswer("jev-9.9.9")));
    const res = await ask(root, { purpose: "unit", state: "s", questions: NOUL_Q, fetch, env, model: "jev-9.9.9" });
    assert.equal(res.ok, true);
    assert.equal(JSON.parse(fetch.calls[0].init.body).model, "jev-9.9.9");
  });

  it("refuses without a network call: killed, no_credential, budget_exhausted, state_too_large, invalid questions", async () => {
    const { ask, writeLedger, JEV_MAX_STATE_BYTES } = require("../lib/jev");
    const { readEvents } = require("../lib/telemetry");
    const fetch = makeFetch(() => okResponse(noulAnswer()));
    assert.equal(JEV_MAX_STATE_BYTES, 40000);

    let r = await ask(root, { purpose: "unit", state: "s", questions: NOUL_Q, fetch, env: { ...env, SEXTANT_JEV: "0" } });
    assert.deepEqual([r.ok, r.reason], [false, "killed"]);
    r = await ask(root, { purpose: "unit", state: "s", questions: NOUL_Q, fetch, env: { XDG_CONFIG_HOME: cfgHome } });
    assert.deepEqual([r.ok, r.reason], [false, "no_credential"]);

    fs.writeFileSync(path.join(root, ".codebase-intel.json"), JSON.stringify({ jev: { maxDailyInputTokens: 10 } }));
    writeLedger(root, { day: new Date().toISOString().slice(0, 10), calls: 1, inputTokens: 11 });
    r = await ask(root, { purpose: "unit", state: "s", questions: NOUL_Q, fetch, env });
    assert.deepEqual([r.ok, r.reason], [false, "budget_exhausted"]);
    fs.unlinkSync(path.join(root, ".codebase-intel.json"));
    writeLedger(root, { day: new Date().toISOString().slice(0, 10), calls: 0, inputTokens: 0 });

    r = await ask(root, { purpose: "unit", state: "x".repeat(JEV_MAX_STATE_BYTES + 1), questions: NOUL_Q, fetch, env });
    assert.deepEqual([r.ok, r.reason], [false, "state_too_large"]);

    r = await ask(root, { purpose: "unit", state: "s", questions: { q: { type: "bogus", instructions: "?" } }, fetch, env });
    assert.deepEqual([r.ok, r.reason], [false, "invalid_contract"]);

    assert.equal(fetch.calls.length, 0, "no refusal may reach the network");
    const events = readEvents(root).filter((e) => e.name === "jev.invoked");
    assert.equal(events.length, 5, "every refusal is a telemetry row with ok:false and a reason");
    assert.deepEqual(events.map((e) => e.ok), [false, false, false, false, false]);
    assert.deepEqual(
      events.map((e) => e.reason),
      ["killed", "no_credential", "budget_exhausted", "state_too_large", "invalid_contract"]
    );
  });

  it("provider failures never throw, never echo the provider body or the key", async () => {
    const { ask } = require("../lib/jev");
    const { readEvents } = require("../lib/telemetry");
    const raw = () => fs.readFileSync(path.join(root, ".planning", "intel", "telemetry.jsonl"), "utf8");

    const f500 = makeFetch(() => ({
      ok: false,
      status: 500,
      body: { cancel: async () => {} },
      json: async () => ({ error: PROVIDER_SECRET }),
    }));
    let r = await ask(root, { purpose: "unit", state: "s", questions: NOUL_Q, fetch: f500, env });
    assert.deepEqual([r.ok, r.reason, r.status], [false, "http_error", 500]);
    assert.ok(!JSON.stringify(r).includes("PROVIDER-BODY-CANARY"));
    assert.ok(!JSON.stringify(r).includes(KEY));

    const fbad = makeFetch(() => okResponse({ model: "jev-1.13.0", usage: { input_tokens: 1, output_tokens: 1 }, answers: { q1: { type: "noul", noul: 7 } }, leak: PROVIDER_SECRET }));
    r = await ask(root, { purpose: "unit", state: "s", questions: NOUL_Q, fetch: fbad, env });
    assert.deepEqual([r.ok, r.reason], [false, "invalid_contract"]);
    assert.ok(!JSON.stringify(r).includes("PROVIDER-BODY-CANARY"));

    const fthrow = makeFetch(() => { throw new Error(`boom ${PROVIDER_SECRET} ${KEY}`); });
    r = await ask(root, { purpose: "unit", state: "s", questions: NOUL_Q, fetch: fthrow, env });
    assert.deepEqual([r.ok, r.reason], [false, "connection_error"]);

    const fhang = makeFetch(() => new Promise(() => {}));
    r = await ask(root, { purpose: "unit", state: "s", questions: NOUL_Q, fetch: fhang, env, timeoutMs: 20 });
    assert.deepEqual([r.ok, r.reason], [false, "timeout"]);

    const events = readEvents(root).filter((e) => e.name === "jev.invoked");
    assert.deepEqual(events.map((e) => e.reason), ["http_error", "invalid_contract", "connection_error", "timeout"]);
    assert.ok(events.every((e) => e.ok === false));
    const text = raw();
    assert.ok(!text.includes("PROVIDER-BODY-CANARY"), "provider body must not reach telemetry");
    assert.ok(!text.includes(KEY), "credential must not reach telemetry");
    const ledgerPath = path.join(root, ".planning", "intel", "jev-ledger.json");
    if (fs.existsSync(ledgerPath)) {
      const l = fs.readFileSync(ledgerPath, "utf8");
      assert.ok(!l.includes(KEY) && !l.includes("PROVIDER-BODY-CANARY"));
    }
  });
});

describe("jev-state: verbatim hashed scopes, sensitive-path refusal, freshness recheck", () => {
  let root;
  beforeEach(() => { root = mkRepo(); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it("compileScope by symbol returns the verbatim declaration with hashes and 1-indexed lines (JS)", () => {
    const { compileScope } = require("../lib/jev-state");
    const s = compileScope(root, { path: "lib/a.js", symbol: "beta" });
    assert.equal(s.path, "lib/a.js");
    assert.equal(s.symbol, "beta");
    assert.equal(s.startLine, 8);
    assert.equal(s.endLine, 10);
    assert.equal(s.text, "function beta(list) {\n  return list.filter((v) => v != null);\n}");
    assert.equal(s.scopeSha256, sha256(s.text));
    assert.equal(s.fileSha256, sha256(fs.readFileSync(path.join(root, "lib", "a.js"))));
    assert.equal(typeof s.kind, "string");
  });

  it("compileScope by line returns the enclosing scope (JS and Python)", () => {
    const { compileScope } = require("../lib/jev-state");
    const js = compileScope(root, { path: "lib/a.js", line: 4 });
    assert.equal(js.symbol, "alpha");
    assert.equal(js.startLine, 3);
    assert.equal(js.endLine, 6);
    const py = compileScope(root, { path: "lib/p.py", line: 6 });
    assert.equal(py.symbol, "delta");
    assert.equal(py.startLine, 5);
    assert.ok(py.text.startsWith("def delta(y):"));
  });

  it("compileScope refuses sensitive paths, escapes, symlinks, unsupported languages, missing symbols, oversized scopes", () => {
    const { compileScope, JevStateError } = require("../lib/jev-state");
    const code = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof JevStateError, `expected JevStateError, got ${e && e.message}`); return e.code; } assert.fail("expected a throw"); };
    assert.equal(code(() => compileScope(root, { path: ".env", line: 1 })), "sensitive_path");
    assert.equal(code(() => compileScope(root, { path: "../outside.js", line: 1 })), "outside_root");
    assert.equal(code(() => compileScope(root, { path: path.join(root, "lib", "a.js"), line: 4 })), "outside_root");
    fs.symlinkSync(path.join(root, "lib", "a.js"), path.join(root, "lib", "link.js"));
    assert.equal(code(() => compileScope(root, { path: "lib/link.js", line: 4 })), "not_regular_file");
    assert.equal(code(() => compileScope(root, { path: "lib/missing.js", line: 1 })), "not_regular_file");
    assert.equal(code(() => compileScope(root, { path: "README.md", line: 1 })), "unsupported_language");
    assert.equal(code(() => compileScope(root, { path: "lib/a.js", symbol: "nope" })), "symbol_not_found");
    const big = "function huge() {\n" + "  x();\n".repeat(2000) + "}\n";
    fs.writeFileSync(path.join(root, "lib", "big.js"), big);
    assert.equal(code(() => compileScope(root, { path: "lib/big.js", symbol: "huge" })), "scope_too_large");
    assert.equal(require("../lib/jev-state").JEV_MAX_SCOPE_BYTES, 6500);
  });

  it("recheckScopes detects unchanged / changed / unavailable sources", () => {
    const { compileScope, recheckScopes } = require("../lib/jev-state");
    const a = compileScope(root, { path: "lib/a.js", symbol: "alpha" });
    const b = compileScope(root, { path: "lib/a.js", symbol: "beta" });
    const g = compileScope(root, { path: "lib/p.py", symbol: "gamma" });
    let r = recheckScopes(root, [a, b, g]);
    assert.equal(r.unchanged, true);
    assert.deepEqual(r.checks.map((c) => c.reason), ["same_source_bytes", "same_source_bytes", "same_source_bytes"]);

    fs.appendFileSync(path.join(root, "lib", "a.js"), "\n// trailing edit\n");
    fs.unlinkSync(path.join(root, "lib", "p.py"));
    r = recheckScopes(root, [a, b, g]);
    assert.equal(r.unchanged, false);
    assert.deepEqual(r.checks.map((c) => [c.path, c.symbol, c.unchanged, c.reason]), [
      ["lib/a.js", "alpha", false, "source_changed"],
      ["lib/a.js", "beta", false, "source_changed"],
      ["lib/p.py", "gamma", false, "source_unavailable"],
    ]);
  });

  it("scopesState carries only what the model needs: ids, path, symbol, lines, source — never hashes", () => {
    const { compileScope, scopesState } = require("../lib/jev-state");
    const a = compileScope(root, { path: "lib/a.js", symbol: "alpha" });
    const b = compileScope(root, { path: "lib/a.js", symbol: "beta" });
    const st = scopesState([a, b]);
    assert.equal(st.length, 2);
    assert.deepEqual(st.map((s) => s.id), ["scope_0", "scope_1"]);
    for (const s of st) {
      assert.deepEqual(Object.keys(s).sort(), ["endLine", "id", "path", "source", "startLine", "symbol"]);
    }
    assert.equal(st[1].source, b.text);
    assert.ok(!JSON.stringify(st).includes(b.scopeSha256));
  });

  it("codeLiteral / functionBody produce executable JavaScript (docs/047 representation)", () => {
    const { codeLiteral, functionBody } = require("../lib/jev-state");
    assert.equal(codeLiteral("1"), '"1"');
    assert.equal(codeLiteral(1), "1");
    assert.equal(codeLiteral([0]), "[0]");
    assert.equal(codeLiteral(null), "null");
    assert.equal(codeLiteral({ a: "b" }), '{"a":"b"}');
    assert.throws(() => codeLiteral(undefined));
    assert.throws(() => codeLiteral(() => 1));
    assert.throws(() => codeLiteral(NaN));
    assert.equal(functionBody({ x: "7" }, "x == 7"), 'const x = "7";\nreturn (x == 7);');
    assert.equal(functionBody({ x: [7], y: 0 }, "x === y"), "const x = [7];\nconst y = 0;\nreturn (x === y);");
    assert.throws(() => functionBody({ "not an identifier": 1 }, "1"));
  });
});
