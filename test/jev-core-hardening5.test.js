"use strict";

// Fifth hardening contract for the runtime Jev core — the findings of the
// independent review of 9718f8ab:
//   (1) HIGH   the non-Linux fallback of the source reader was still a string
//              re-walk and a double parent swap returned outside-root bytes.
//              There is no safe fallback without a descriptor-pinned traversal,
//              so on a platform without /proc/self/fd the reader REFUSES
//              (unsupported_platform) instead of guessing.
//   (2) MEDIUM the state validator did not refuse Proxies, so a Proxy could
//              supply toJSON at stringify time and transmit replaced state while
//              ask() reported ok. Proxies anywhere in state or questions are
//              invalid_contract with no network call.
//   (3) MEDIUM a question whose `instructions` getter throws a nullish value
//              made ask() itself throw a TypeError while handling the error.
//              ask() never throws: any thrown value becomes invalid_contract.
// Fetch is injected; no provider is called.

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const KEY = "sk-test-CANARY-KEY-hardening5";
const NOUL_Q = { q1: { type: "noul", instructions: "?", criteria: { true: "y", false: "n" } } };
const okResponse = (body) => ({ ok: true, status: 200, body: { cancel: async () => {} }, json: async () => body });
const answer = () => ({ model: "jev-1.13.0", usage: { input_tokens: 1, output_tokens: 1 }, answers: { q1: { type: "noul", noul: 0.5 } } });

function withPlatform(platform, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try { return fn(); } finally { Object.defineProperty(process, "platform", desc); }
}

describe("jev hardening 5: no unpinned fallback reader on other platforms", () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-hard5-"));
    fs.mkdirSync(path.join(root, "lib"), { recursive: true });
    fs.writeFileSync(path.join(root, "lib", "a.js"), "function alpha() {\n  return 1;\n}\n");
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it("on darwin/win32 compileScope refuses with unsupported_platform and recheckScopes reports source_unavailable; linux still reads", () => {
    const { compileScope, recheckScopes, JevStateError } = require("../lib/jev-state");
    const scope = compileScope(root, { path: "lib/a.js", symbol: "alpha" });
    assert.equal(scope.text, "function alpha() {\n  return 1;\n}");
    for (const platform of ["darwin", "win32"]) {
      withPlatform(platform, () => {
        let code = null;
        try { compileScope(root, { path: "lib/a.js", symbol: "alpha" }); } catch (e) { code = e instanceof JevStateError ? e.code : e.message; }
        assert.equal(code, "unsupported_platform", `${platform} must refuse, got ${code}`);
        const r = recheckScopes(root, [scope]);
        assert.equal(r.unchanged, false);
        assert.equal(r.checks[0].reason, "source_unavailable");
      });
    }
    assert.equal(compileScope(root, { path: "lib/a.js", symbol: "alpha" }).scopeSha256, scope.scopeSha256, "linux path unaffected afterwards");
  });
});

describe("jev hardening 5: Proxies in state or questions are refused before any serialization", () => {
  let root, cfgHome, env;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-hard5-"));
    fs.mkdirSync(path.join(root, ".planning", "intel"), { recursive: true });
    cfgHome = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-cfg-"));
    env = { XDG_CONFIG_HOME: cfgHome, TYPESAFE_API_KEY: KEY };
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(cfgHome, { recursive: true, force: true }); });

  it("top-level / nested state proxies and question proxies → invalid_contract with zero fetch calls", async () => {
    const { ask } = require("../lib/jev");
    let calls = 0;
    const fetch = async () => { calls++; return okResponse(answer()); };
    const spoof = new Proxy({ text: "real" }, { get(t, k, r) { if (k === "toJSON") return () => ({ text: "REPLACED" }); return Reflect.get(t, k, r); } });
    for (const state of [spoof, { inner: spoof }, [1, { deep: [spoof] }]]) {
      const r = await ask(root, { purpose: "unit", state, questions: NOUL_Q, fetch, env });
      assert.deepEqual([r.ok, r.reason], [false, "invalid_contract"]);
    }
    const qProxy = new Proxy({ type: "noul", instructions: "?" }, { get(t, k, r) { if (k === "toJSON") return () => ({ type: "unsupported", instructions: "x" }); return Reflect.get(t, k, r); } });
    let r = await ask(root, { purpose: "unit", state: "s", questions: { q1: qProxy }, fetch, env });
    assert.deepEqual([r.ok, r.reason], [false, "invalid_contract"]);
    r = await ask(root, { purpose: "unit", state: "s", questions: new Proxy(NOUL_Q, {}), fetch, env });
    assert.deepEqual([r.ok, r.reason], [false, "invalid_contract"]);
    assert.equal(calls, 0);
    r = await ask(root, { purpose: "unit", state: { text: "real" }, questions: NOUL_Q, fetch, env });
    assert.equal(r.ok, true);
  });
});

describe("jev hardening 5: ask() never throws, whatever the caller's objects throw", () => {
  let root, cfgHome, env;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-hard5-"));
    fs.mkdirSync(path.join(root, ".planning", "intel"), { recursive: true });
    cfgHome = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-cfg-"));
    env = { XDG_CONFIG_HOME: cfgHome, TYPESAFE_API_KEY: KEY };
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(cfgHome, { recursive: true, force: true }); });

  it("a question getter that throws null / undefined / a string / an object yields {ok:false, reason:'invalid_contract'} with no fetch", async () => {
    const { ask } = require("../lib/jev");
    let calls = 0;
    const fetch = async () => { calls++; return okResponse(answer()); };
    for (const thrown of [null, undefined, "boom", { status: 500, message: KEY }, 42]) {
      const q = { type: "noul", get instructions() { throw thrown; }, criteria: { true: "y", false: "n" } };
      let r;
      try { r = await ask(root, { purpose: "unit", state: "s", questions: { q1: q }, fetch, env }); }
      catch (e) { assert.fail(`ask threw for thrown=${String(thrown)}: ${e && e.message}`); }
      assert.deepEqual([r.ok, r.reason], [false, "invalid_contract"]);
      assert.ok(!JSON.stringify(r).includes(KEY));
    }
    assert.equal(calls, 0);
    const raw = fs.readFileSync(path.join(root, ".planning", "intel", "telemetry.jsonl"), "utf8");
    assert.ok(!raw.includes(KEY));
  });
});
