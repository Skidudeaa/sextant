"use strict";

// Fourth hardening contract for the runtime Jev core — the findings of the
// independent review of b2bcefd:
//   (a) the "requested model + dash suffix" allowance let a credential-shaped
//       suffix through (jev-1.13.0-<key>) and persisted it in telemetry. The
//       returned model must now EQUAL the requested model. Sextant always
//       requests a full version (jev.model / DEFAULT_MODEL); aliases are not
//       used by the runtime.
//   (b) after the post-open re-walk, the source bytes were read by PATH again,
//       so a second parent-directory swap between the re-walk and the read
//       still returned outside-root content. All bytes must come from the
//       handle that was verified (fstat identity), never from a second path
//       resolution.
//   (c) -0 inside the state serializes as 0: lossless validation must refuse it
//       (Object.is) like it refuses NaN.
// Fetch is injected; no provider is called.

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const KEY = "sk-test-CANARY-KEY-hardening4";
const NOUL_Q = { q1: { type: "noul", instructions: "?", criteria: { true: "y", false: "n" } } };
const okResponse = (body) => ({ ok: true, status: 200, body: { cancel: async () => {} }, json: async () => body });
const answer = (model) => ({ model, usage: { input_tokens: 1, output_tokens: 1 }, answers: { q1: { type: "noul", noul: 0.5 } } });

describe("jev hardening 4: returned model must equal the requested model", () => {
  let root, cfgHome, env;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-hard4-"));
    fs.mkdirSync(path.join(root, ".planning", "intel"), { recursive: true });
    cfgHome = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-cfg-"));
    env = { XDG_CONFIG_HOME: cfgHome, TYPESAFE_API_KEY: KEY };
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(cfgHome, { recursive: true, force: true }); });

  it("exact match accepted; any suffix (including a credential-shaped one) is invalid_contract and never recorded", async () => {
    const { ask } = require("../lib/jev");
    let r = await ask(root, { purpose: "unit", state: "s", questions: NOUL_Q, env, fetch: async () => okResponse(answer("jev-1.13.0")) });
    assert.equal(r.ok, true);
    for (const bad of [`jev-1.13.0-${KEY}`, "jev-1.13.0-rc.2", "jev-1.13.0.1", "jev-1.13.0 ", "JEV-1.13.0"]) {
      r = await ask(root, { purpose: "unit", state: "s", questions: NOUL_Q, env, fetch: async () => okResponse(answer(bad)) });
      assert.deepEqual([r.ok, r.reason], [false, "invalid_contract"], `model ${JSON.stringify(bad)} must be rejected`);
      assert.ok(!JSON.stringify(r).includes(KEY));
    }
    const raw = fs.readFileSync(path.join(root, ".planning", "intel", "telemetry.jsonl"), "utf8");
    assert.ok(!raw.includes(KEY), "a rejected model string must never be recorded");
    assert.ok(!raw.includes("rc.2"));
  });
});

describe("jev hardening 4: -0 in state is refused like NaN", () => {
  let root, cfgHome, env;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-hard4-"));
    fs.mkdirSync(path.join(root, ".planning", "intel"), { recursive: true });
    cfgHome = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-cfg-"));
    env = { XDG_CONFIG_HOME: cfgHome, TYPESAFE_API_KEY: KEY };
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(cfgHome, { recursive: true, force: true }); });

  it("refuses -0 anywhere in the state with no network call; keeps 0", async () => {
    const { ask } = require("../lib/jev");
    let calls = 0;
    const fetch = async () => { calls++; return okResponse(answer("jev-1.13.0")); };
    for (const state of [{ z: -0 }, { nested: [1, { z: -0 }] }, [-0]]) {
      const r = await ask(root, { purpose: "unit", state, questions: NOUL_Q, fetch, env });
      assert.deepEqual([r.ok, r.reason], [false, "invalid_contract"]);
    }
    assert.equal(calls, 0);
    const r = await ask(root, { purpose: "unit", state: { z: 0 }, questions: NOUL_Q, fetch, env });
    assert.equal(r.ok, true);
  });
});

describe("jev hardening 4: bytes come from the verified handle, never a second path read", () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-hard4-"));
    fs.mkdirSync(path.join(root, "lib"), { recursive: true });
    fs.writeFileSync(path.join(root, "lib", "a.js"), "function alpha() {\n  return 1;\n}\n");
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  // The adversary toggles `lib` between the real directory and a symlink to an
  // outside directory at EVERY observable point (each lstat/stat/fstat call).
  // Whatever order the implementation checks things in, the invariant is the
  // same: bytes from outside the root are never returned. A descriptor-pinned
  // traversal (open each component O_DIRECTORY|O_NOFOLLOW and resolve the next
  // one relative to that descriptor, e.g. via /proc/self/fd/<fd>/<name>) is
  // immune to the name swap and returns the ORIGINAL bytes; a string re-walk
  // must at least refuse.
  function withToggler(root, outsideDir, fn) {
    const libPath = path.join(root, "lib");
    const realLstat = fs.lstatSync, realStat = fs.statSync, realFstat = fs.fstatSync, realRead = fs.readFileSync;
    let flips = 0;
    const flip = () => {
      flips += 1;
      try {
        const st = realLstat.call(fs, libPath);
        fs.rmSync(libPath, { recursive: true, force: true });
        if (st.isSymbolicLink()) { fs.mkdirSync(libPath); fs.writeFileSync(path.join(libPath, "a.js"), "function alpha() {\n  return 1;\n}\n"); }
        else fs.symlinkSync(outsideDir, libPath);
      } catch {}
    };
    fs.lstatSync = function (...a) { const r = realLstat.apply(fs, a); flip(); return r; };
    fs.statSync = function (...a) { const r = realStat.apply(fs, a); flip(); return r; };
    fs.fstatSync = function (...a) { const r = realFstat.apply(fs, a); flip(); return r; };
    fs.readFileSync = function (target, ...rest) {
      if (typeof target === "string" || Buffer.isBuffer(target) || target instanceof URL) {
        throw new Error(`path-based read: ${String(target)}`);
      }
      return realRead.call(fs, target, ...rest);
    };
    try { return fn(() => flips); } finally { fs.lstatSync = realLstat; fs.statSync = realStat; fs.fstatSync = realFstat; fs.readFileSync = realRead; }
  }

  it("under continuous parent toggling, compileScope returns the in-root bytes or refuses — never outside-root bytes, never a path-based read", () => {
    const { compileScope, JevStateError } = require("../lib/jev-state");
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-outside-"));
    fs.writeFileSync(path.join(outsideDir, "a.js"), "function alpha() {\n  return 'OUTSIDE';\n}\n");
    try {
      for (let round = 0; round < 6; round++) {
        withToggler(root, outsideDir, (flips) => {
          let text = null, err = null;
          try { text = compileScope(root, { path: "lib/a.js", symbol: "alpha" }).text; } catch (e) { err = e; }
          if (err) {
            assert.doesNotMatch(String(err.message), /path-based read/, err.message);
            assert.ok(err instanceof JevStateError && err.code === "not_regular_file", `refusal must be not_regular_file, got ${err.code || err.message}`);
          } else {
            assert.equal(text, "function alpha() {\n  return 1;\n}", `round ${round}: outside-root bytes must never be returned (flips=${flips()})`);
          }
        });
        // Reset to the real directory between rounds.
        const libPath = path.join(root, "lib");
        try { if (fs.lstatSync(libPath).isSymbolicLink()) { fs.rmSync(libPath, { force: true }); fs.mkdirSync(libPath); fs.writeFileSync(path.join(libPath, "a.js"), "function alpha() {\n  return 1;\n}\n"); } } catch {}
      }
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe("jev hardening 4: codeLiteral refuses Proxies (toJSON after descriptor validation)", () => {
  it("a plain-prototype Proxy that supplies toJSON at stringify time is refused", () => {
    const { codeLiteral } = require("../lib/jev-state");
    const target = { a: 1 };
    const proxy = new Proxy(target, {
      get(t, k, r) { if (k === "toJSON") return () => "REPLACED"; return Reflect.get(t, k, r); },
    });
    assert.throws(() => codeLiteral(proxy));
    assert.throws(() => codeLiteral({ inner: proxy }));
    assert.throws(() => codeLiteral(new Proxy([1, 2], {})));
    assert.equal(codeLiteral({ a: 1 }), '{"a":1}');
  });
});
