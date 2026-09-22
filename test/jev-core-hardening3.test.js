"use strict";

// Third hardening contract for the runtime Jev core — the two HIGH findings of
// the independent review of 064f690:
//   (a) a returned `model` that merely matches the charset regex can still be
//       a credential-shaped string; the model must be the REQUESTED model or a
//       dash-suffixed refinement of it (alias resolution), never anything else
//   (b) O_NOFOLLOW protects only the final path component; a parent directory
//       swapped for a symlink between validation and open still escapes the
//       root. After opening, the handle's identity must be re-verified against
//       a no-follow walk of the ORIGINAL path, and any symlink component or
//       identity mismatch refuses the read.
// Fetch is injected; no provider is called.

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const KEY = "sk-test-CANARY-KEY-hardening3";
const NOUL_Q = { q1: { type: "noul", instructions: "?", criteria: { true: "y", false: "n" } } };
const okResponse = (body) => ({ ok: true, status: 200, body: { cancel: async () => {} }, json: async () => body });
const answer = (model) => ({ model, usage: { input_tokens: 1, output_tokens: 1 }, answers: { q1: { type: "noul", noul: 0.5 } } });

describe("jev hardening 3: returned model must be the requested model (or a dash-suffixed refinement)", () => {
  let root, cfgHome, env;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-hard3-"));
    fs.mkdirSync(path.join(root, ".planning", "intel"), { recursive: true });
    cfgHome = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-cfg-"));
    env = { XDG_CONFIG_HOME: cfgHome, TYPESAFE_API_KEY: KEY };
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(cfgHome, { recursive: true, force: true }); });

  it("accepts only the exact requested model; rejects any other charset-valid string, including a credential-shaped one", async () => {
    // (Review 3 closed the earlier dash-suffix allowance: a suffix is an
    // unbounded channel. See test/jev-core-hardening4.test.js.)
    const { ask } = require("../lib/jev");
    for (const good of ["jev-1.13.0"]) {
      const r = await ask(root, { purpose: "unit", state: "s", questions: NOUL_Q, env, fetch: async () => okResponse(answer(good)) });
      assert.equal(r.ok, true, good);
      assert.equal(r.model, good);
    }
    for (const bad of [KEY, "jev-1.13.1", "jev-1.13", "jev-1.13.0rc2", "jev-1.13.0-rc.2", "jev", "jev-2.0.0"]) {
      const r = await ask(root, { purpose: "unit", state: "s", questions: NOUL_Q, env, fetch: async () => okResponse(answer(bad)) });
      assert.deepEqual([r.ok, r.reason], [false, "invalid_contract"], `model ${bad} must be rejected for requested jev-1.13.0`);
      assert.ok(!JSON.stringify(r).includes(KEY));
    }
    // An explicitly requested model is the reference, not the default.
    const r = await ask(root, { purpose: "unit", state: "s", questions: NOUL_Q, env, model: "jev-2.0.0", fetch: async () => okResponse(answer("jev-2.0.0")) });
    assert.equal(r.ok, true);
    const raw = fs.readFileSync(path.join(root, ".planning", "intel", "telemetry.jsonl"), "utf8");
    assert.ok(!raw.includes(KEY), "a rejected model string must never be recorded");
  });
});

describe("jev hardening 3: lossless state and plain-array literals (review MEDIUMs)", () => {
  let root, cfgHome, env;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-hard3-"));
    fs.mkdirSync(path.join(root, ".planning", "intel"), { recursive: true });
    cfgHome = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-cfg-"));
    env = { XDG_CONFIG_HOME: cfgHome, TYPESAFE_API_KEY: KEY };
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(cfgHome, { recursive: true, force: true }); });

  it("state with undefined / NaN / Map / Date / function values is refused as invalid_contract before any serialization reaches the wire", async () => {
    const { ask } = require("../lib/jev");
    let calls = 0;
    const fetch = async () => { calls++; return okResponse(answer("jev-1.13.0")); };
    for (const state of [{ missing: undefined }, { n: NaN }, { m: new Map([["a", 1]]) }, { d: new Date(0) }, { f() {} }, { nested: [1, { inf: Infinity }] }, { big: 1n }]) {
      const r = await ask(root, { purpose: "unit", state, questions: NOUL_Q, fetch, env });
      assert.deepEqual([r.ok, r.reason], [false, "invalid_contract"], `state ${Object.keys(state)} must be refused`);
    }
    assert.equal(calls, 0);
    const r = await ask(root, { purpose: "unit", state: { ok: [1, "a", null, { b: true }] }, questions: NOUL_Q, fetch, env });
    assert.equal(r.ok, true);
  });

  it("codeLiteral refuses arrays that are not plain Array.prototype instances (subclass / custom prototype toJSON)", () => {
    const { codeLiteral } = require("../lib/jev-state");
    class Spoof extends Array { toJSON() { return "spoof"; } }
    assert.throws(() => codeLiteral(Spoof.from([1, 2])));
    const custom = [1, 2];
    Object.setPrototypeOf(custom, Object.assign(Object.create(Array.prototype), { toJSON() { return "spoof"; } }));
    assert.throws(() => codeLiteral(custom));
    assert.equal(codeLiteral([1, 2]), "[1,2]");
  });
});

describe("jev hardening 3: parent-directory symlink swap is refused after open", () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-hard3-"));
    fs.mkdirSync(path.join(root, "lib"), { recursive: true });
    fs.writeFileSync(path.join(root, "lib", "a.js"), "function alpha() {\n  return 1;\n}\n");
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it("a parent component that is a symlink at open time is refused even when the pre-open walk saw a directory", () => {
    const { compileScope, JevStateError } = require("../lib/jev-state");
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-outside-"));
    fs.writeFileSync(path.join(outsideDir, "a.js"), "function alpha() {\n  return 'OUTSIDE';\n}\n");
    const realLstat = fs.lstatSync;
    const libPath = path.join(root, "lib");
    const libStat = realLstat(libPath);
    let swapped = false;
    // Race simulation: the pre-open walk sees `lib` as a real directory; the
    // swap happens the first time the walk asks about it, before open.
    fs.lstatSync = function (p, ...rest) {
      if (!swapped && path.resolve(String(p)) === libPath) {
        swapped = true;
        fs.rmSync(libPath, { recursive: true, force: true });
        fs.symlinkSync(outsideDir, libPath);
        return libStat; // lie: still a directory
      }
      return realLstat.call(fs, p, ...rest);
    };
    try {
      let code = null;
      let text = null;
      try { text = compileScope(root, { path: "lib/a.js", symbol: "alpha" }).text; } catch (e) { code = e instanceof JevStateError ? e.code : e.message; }
      // Invariant: bytes from outside the root are never returned. Either the
      // read is refused (not_regular_file) or — with a descriptor-pinned
      // traversal that never re-resolves the path string — the ORIGINAL in-root
      // bytes are returned regardless of the name swap.
      if (code !== null) assert.equal(code, "not_regular_file", `unexpected refusal ${code}`);
      else assert.equal(text, "function alpha() {\n  return 1;\n}", `outside-root bytes must never be returned; got ${text}`);
    } finally {
      fs.lstatSync = realLstat;
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
