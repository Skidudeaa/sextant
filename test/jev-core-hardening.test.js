"use strict";

// Hardening contract for lib/jev.js / lib/jev-client.js / lib/jev-state.js,
// written from the independent review of commit 39dfe13 (rejected). Each case
// is a defect the reviewer reproduced offline:
//   1. a SUCCESSFUL provider response can smuggle arbitrary extra fields
//      (e.g. an echoed credential under answers.q1.debug) into results and
//      telemetry — validation checked required fields but never stripped
//   2. the returned `model` string was accepted unbounded
//   3. a corrupt ledger file made availability()/ask() THROW — on the hook hot
//      path, and after a paid call
//   4. codeLiteral accepted values whose JSON form is not their runtime form
//      (own toJSON, getters, sparse arrays, arrays with extra properties)
// Fetch is always injected; no provider is called.

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const KEY = "sk-test-CANARY-KEY-hardening";

function okResponse(body) {
  return { ok: true, status: 200, body: { cancel: async () => {} }, json: async () => body };
}

const QUESTIONS = {
  q1: { type: "noul", instructions: "?", criteria: { true: "y", false: "n" } },
  q2: { type: "choice", instructions: "?", criteria: { a: "A", b: "B" } },
  q3: { type: "score", instructions: "?", criteria: ["low", "high"] },
};

function fullAnswer(extra = {}) {
  return {
    model: "jev-1.13.0",
    usage: { input_tokens: 10, output_tokens: 3 },
    answers: {
      q1: { type: "noul", noul: 0.7, ...extra },
      q2: { type: "choice", choice: "a", probabilities: { a: 0.6, b: 0.4 }, confidence: 0.6, ...extra },
      q3: { type: "score", score: 0.5, probabilities: { 0: 0.5, 1: 0.5 }, confidence: 0.5, legend: { 0: "low", 1: "high" }, ...extra },
    },
    ...extra,
  };
}

describe("jev hardening: successful responses are projected onto the contract shape", () => {
  let root, cfgHome, env;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-hard-"));
    fs.mkdirSync(path.join(root, ".planning", "intel"), { recursive: true });
    cfgHome = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-cfg-"));
    env = { XDG_CONFIG_HOME: cfgHome, TYPESAFE_API_KEY: KEY };
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(cfgHome, { recursive: true, force: true }); });

  it("extra fields on answers / top level never reach the result, telemetry or ledger", async () => {
    const { ask } = require("../lib/jev");
    const fetch = async () => okResponse(fullAnswer({ debug: `echo ${KEY}`, nested: { deeper: KEY } }));
    const r = await ask(root, { purpose: "unit", state: "s", questions: QUESTIONS, fetch, env });
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(r.answers.q1).sort(), ["noul", "type"]);
    assert.deepEqual(Object.keys(r.answers.q2).sort(), ["choice", "confidence", "probabilities", "type"]);
    assert.deepEqual(Object.keys(r.answers.q3).sort(), ["confidence", "legend", "probabilities", "score", "type"]);
    assert.deepEqual(Object.keys(r).sort(), ["answers", "latencyMs", "model", "ok", "usage"]);
    assert.deepEqual(Object.keys(r.usage).sort(), ["input_tokens", "output_tokens"]);
    assert.ok(!JSON.stringify(r).includes(KEY));
    const raw = fs.readFileSync(path.join(root, ".planning", "intel", "telemetry.jsonl"), "utf8");
    assert.ok(!raw.includes(KEY));
    assert.ok(!fs.readFileSync(path.join(root, ".planning", "intel", "jev-ledger.json"), "utf8").includes(KEY));
  });

  it("validateResponse returns the projected shape too (the client is the single choke point)", () => {
    const { validateResponse } = require("../lib/jev-client");
    const out = validateResponse(fullAnswer({ debug: KEY }), QUESTIONS);
    assert.ok(!JSON.stringify(out).includes(KEY));
    assert.deepEqual(Object.keys(out).sort(), ["answers", "model", "usage"]);
  });

  it("a returned model string is bounded: 1..64 chars of [A-Za-z0-9._-], otherwise invalid_contract", async () => {
    const { ask } = require("../lib/jev");
    for (const bad of [`jev ${KEY}`, "x".repeat(65), "jev/1.13", " jev-1.13.0", ""]) {
      const fetch = async () => okResponse({ ...fullAnswer(), model: bad });
      const r = await ask(root, { purpose: "unit", state: "s", questions: QUESTIONS, fetch, env });
      assert.deepEqual([r.ok, r.reason], [false, "invalid_contract"], `model ${JSON.stringify(bad)} must be rejected`);
      assert.ok(!JSON.stringify(r).includes(KEY));
    }
    // Review 3: no suffix allowance at all — only the exact requested model is accepted.
    const fetch = async () => okResponse({ ...fullAnswer(), model: "jev-1.13.0-rc.2" });
    const r = await ask(root, { purpose: "unit", state: "s", questions: QUESTIONS, fetch, env });
    assert.deepEqual([r.ok, r.reason], [false, "invalid_contract"]);
    const raw = fs.readFileSync(path.join(root, ".planning", "intel", "telemetry.jsonl"), "utf8");
    assert.ok(!raw.includes(KEY), "a rejected model string must not be recorded");
  });
});

describe("jev hardening: a corrupt ledger never throws and is repaired", () => {
  let root, cfgHome, env;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-hard-"));
    fs.mkdirSync(path.join(root, ".planning", "intel"), { recursive: true });
    cfgHome = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-cfg-"));
    env = { XDG_CONFIG_HOME: cfgHome, TYPESAFE_API_KEY: KEY };
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(cfgHome, { recursive: true, force: true }); });

  const ledgerPath = () => path.join(root, ".planning", "intel", "jev-ledger.json");

  it("garbage / wrong-typed / directory ledger → readLedger returns the empty day, availability ok, ask succeeds and rewrites a valid ledger", async () => {
    const { readLedger, availability, ask } = require("../lib/jev");
    const fetch = async () => okResponse(fullAnswer());
    const today = new Date().toISOString().slice(0, 10);
    for (const garbage of ["{not json", JSON.stringify({ day: today, calls: -1, inputTokens: "x" }), "null", ""]) {
      fs.writeFileSync(ledgerPath(), garbage);
      assert.deepEqual(readLedger(root), { day: today, calls: 0, inputTokens: 0 });
      assert.deepEqual(availability(root, env), { ok: true, reason: null });
      const r = await ask(root, { purpose: "unit", state: "s", questions: QUESTIONS, fetch, env });
      assert.equal(r.ok, true, `ask must not throw on ledger ${JSON.stringify(garbage)}`);
      const fixed = JSON.parse(fs.readFileSync(ledgerPath(), "utf8"));
      assert.deepEqual(fixed, { day: today, calls: 1, inputTokens: 10 });
    }
    // A directory in the ledger's place: read is empty, write fails, ask STILL returns the provider result
    // and records the ledger failure instead of throwing.
    fs.unlinkSync(ledgerPath());
    fs.mkdirSync(ledgerPath());
    assert.deepEqual(readLedger(root), { day: today, calls: 0, inputTokens: 0 });
    const r = await ask(root, { purpose: "unit", state: "s", questions: QUESTIONS, fetch, env });
    assert.equal(r.ok, true);
    assert.equal(r.ledgerError, true);
  });

  it("writeLedger rejects invalid input by returning false, never throwing", () => {
    const { writeLedger } = require("../lib/jev");
    assert.equal(writeLedger(root, { day: "nope", calls: 1, inputTokens: 1 }), false);
    assert.equal(writeLedger(root, { day: "2026-01-01", calls: 1.5, inputTokens: 1 }), false);
    assert.equal(writeLedger(root, { day: "2026-01-01", calls: 1, inputTokens: 1 }), true);
  });
});

describe("jev hardening: codeLiteral only accepts values whose JSON is their runtime form", () => {
  it("rejects own toJSON (enumerable or not), getters, sparse arrays, arrays with extra properties, symbol keys", () => {
    const { codeLiteral } = require("../lib/jev-state");
    const withToJSON = { a: 1, toJSON() { return "spoof"; } };
    assert.throws(() => codeLiteral(withToJSON));
    const hidden = { a: 1 };
    Object.defineProperty(hidden, "toJSON", { value: () => "spoof", enumerable: false });
    assert.throws(() => codeLiteral(hidden));
    const getter = { get a() { return Math.random(); } };
    assert.throws(() => codeLiteral(getter));
    const sparse = [1, , 3]; // eslint-disable-line no-sparse-arrays
    assert.throws(() => codeLiteral(sparse));
    const extra = [1, 2];
    extra.tag = "x";
    assert.throws(() => codeLiteral(extra));
    const sym = { [Symbol("s")]: 1, a: 2 };
    assert.throws(() => codeLiteral(sym));
    // Plain data still round-trips.
    assert.equal(codeLiteral({ a: [1, "2", null, { b: false }] }), '{"a":[1,"2",null,{"b":false}]}');
    assert.equal(codeLiteral(Object.create(null, { a: { value: 1, enumerable: true } })), '{"a":1}');
  });
});
