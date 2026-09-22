"use strict";

// Second hardening contract for the runtime Jev core — the four remaining
// findings of the independent review of 39dfe13 that test/jev-core-hardening
// does not pin:
//   (2) state was serialized twice (size check, then the client) so a getter /
//       toJSON could pass a 40,000-byte cap and still transmit more; the
//       transmitted body must be the exact single snapshot that was sized
//   (3) lstat-then-read TOCTOU on a symlink swap: reads must go through an
//       O_NOFOLLOW handle
//   (6) codeLiteral emitted an own `__proto__` key as a prototype-setting literal
//   (7) codeLiteral turned -0 into 0
// Fetch is injected; no provider is called.

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const KEY = "sk-test-CANARY-KEY-hardening2";
const NOUL_Q = { q1: { type: "noul", instructions: "?", criteria: { true: "y", false: "n" } } };

function okResponse(body) {
  return { ok: true, status: 200, body: { cancel: async () => {} }, json: async () => body };
}

describe("jev hardening 2: single-snapshot state", () => {
  let root, cfgHome, env;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-hard2-"));
    fs.mkdirSync(path.join(root, ".planning", "intel"), { recursive: true });
    cfgHome = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-cfg-"));
    env = { XDG_CONFIG_HOME: cfgHome, TYPESAFE_API_KEY: KEY };
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(cfgHome, { recursive: true, force: true }); });

  it("a state whose serialization changes between reads cannot exceed the cap on the wire: the body sent equals the sized snapshot", async () => {
    const { ask, JEV_MAX_STATE_BYTES } = require("../lib/jev");
    let n = 0;
    const shifty = { get text() { n += 1; return n === 1 ? "small" : "x".repeat(JEV_MAX_STATE_BYTES + 2); } };
    const bodies = [];
    const fetch = async (url, init) => { bodies.push(init.body); return okResponse({ model: "jev-1.13.0", usage: { input_tokens: 1, output_tokens: 1 }, answers: { q1: { type: "noul", noul: 0.5 } } }); };
    const r = await ask(root, { purpose: "unit", state: shifty, questions: NOUL_Q, fetch, env });
    if (r.ok) {
      assert.equal(bodies.length, 1);
      assert.ok(Buffer.byteLength(bodies[0]) <= JEV_MAX_STATE_BYTES + 512, "transmitted body must be the sized snapshot, not a re-serialization");
      assert.equal(JSON.parse(bodies[0]).state.text, "small");
    } else {
      // Refusing a non-plain state outright is also acceptable — but then nothing may be sent.
      assert.equal(bodies.length, 0);
      assert.ok(["invalid_contract", "state_too_large"].includes(r.reason), r.reason);
    }
  });
});

describe("jev hardening 2: no-follow source reads", () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-hard2-"));
    fs.mkdirSync(path.join(root, "lib"), { recursive: true });
    fs.writeFileSync(path.join(root, "lib", "a.js"), "function alpha() {\n  return 1;\n}\n");
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it("compileScope reads through a handle opened with O_NOFOLLOW (a symlink at open time is refused even if lstat was raced)", () => {
    const { compileScope, JevStateError } = require("../lib/jev-state");
    const realLstat = fs.lstatSync;
    // Simulate the race: lstat reports a regular file, but by open time the path is a symlink to an outside file.
    const outside = path.join(os.tmpdir(), `sextant-outside-${process.pid}.js`);
    fs.writeFileSync(outside, "function alpha() {\n  return 'OUTSIDE';\n}\n");
    const target = path.join(root, "lib", "a.js");
    const realStat = fs.lstatSync(target);
    fs.lstatSync = function (p, ...rest) {
      const st = realLstat.call(fs, p, ...rest);
      if (path.resolve(String(p)) === target && st.isSymbolicLink()) return realStat; // lie: still a regular file
      return st;
    };
    try {
      fs.unlinkSync(target);
      fs.symlinkSync(outside, target);
      let code = null;
      try { compileScope(root, { path: "lib/a.js", symbol: "alpha" }); } catch (e) { code = e instanceof JevStateError ? e.code : e.message; }
      assert.equal(code, "not_regular_file", "a swapped-in symlink must be refused by the open, not trusted from a prior lstat");
    } finally {
      fs.lstatSync = realLstat;
      try { fs.unlinkSync(outside); } catch {}
    }
  });
});

describe("jev hardening 2: codeLiteral edge values", () => {
  it("refuses an own __proto__ key and negative zero; keeps ordinary values", () => {
    const { codeLiteral } = require("../lib/jev-state");
    const proto = JSON.parse('{"__proto__": {"polluted": 1}, "a": 1}');
    assert.throws(() => codeLiteral(proto));
    assert.throws(() => codeLiteral(-0));
    assert.throws(() => codeLiteral([1, -0]));
    assert.equal(codeLiteral(0), "0");
    assert.equal(codeLiteral({ a: 1 }), '{"a":1}');
  });
});
