"use strict";

// Acceptance contract for the action-time Jev lane and its observability:
//   lib/jev-sieve.js      editSieve() — docs/043 #5 "behavior-preserving edit
//                         sieve": deterministic diff nominates the changed
//                         scope; Jev flags ordering / nullability / units /
//                         timing / error-type for focused tests. docs/047+048:
//                         a negative flag never proves equivalence, so the note
//                         is ADVISORY text, never a verdict.
//   commands/hook-posttooluse.js wiring (opt-in, appended to the blast-radius
//                         additionalContext envelope)
//   commands/telemetry.js summarize()/printSummary() `jev` section
//   commands/doctor.js    Jev status line / credential action
// No provider is called; the hook case preloads test/helpers/jev-mock-fetch.js.

const { describe, it, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execSync } = require("child_process");

const graph = require("../lib/graph");
const freshness = require("../lib/freshness");
const telemetry = require("../lib/telemetry");

const BIN = path.resolve(__dirname, "..", "bin", "intel.js");
const MOCK = path.resolve(__dirname, "helpers", "jev-mock-fetch.js");
const KEY = "sk-test-CANARY-KEY-sieve";

const BEFORE = [
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
].join("\n");
const AFTER = BEFORE.replace("  if (x == null) return 0;\n", "  if (!x) return 0;\n");

function okResponse(body) {
  return { ok: true, status: 200, body: { cancel: async () => {} }, json: async () => body };
}

function answerSieve(req, probs) {
  const answers = {};
  for (const [qid, q] of Object.entries(req.questions)) {
    assert.equal(q.type, "noul", `sieve questions are all Noul (${qid})`);
    answers[qid] = { type: "noul", noul: probs[qid] ?? 0.05 };
  }
  return { model: req.model, usage: { input_tokens: 90, output_tokens: Object.keys(answers).length }, answers };
}

describe("editSieve: changed-scope nomination, narrow Noul flags, advisory note", () => {
  let root, cfgHome, env;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-sieve-"));
    fs.mkdirSync(path.join(root, ".planning", "intel"), { recursive: true });
    fs.mkdirSync(path.join(root, "lib"), { recursive: true });
    fs.writeFileSync(path.join(root, "lib", "a.js"), AFTER);
    cfgHome = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-cfg-"));
    env = { XDG_CONFIG_HOME: cfgHome, TYPESAFE_API_KEY: KEY };
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(cfgHome, { recursive: true, force: true }); });

  it("sends {path, symbol, before_source, after_source} for the changed scope and asks six narrow Nouls", async () => {
    const { editSieve, SIEVE_FLAGS } = require("../lib/jev-sieve");
    assert.deepEqual(SIEVE_FLAGS, ["ordering", "nullability", "units", "timing", "error_type"]);
    let sent = null;
    const fetch = async (url, init) => { sent = JSON.parse(init.body); return okResponse(answerSieve(sent, { behavior_changed: 0.83, nullability: 0.71, ordering: 0.12 })); };
    const r = await editSieve(root, { relPath: "lib/a.js", before: BEFORE, after: AFTER, fetch, env });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(Object.keys(sent.state).sort(), ["after_source", "before_source", "path", "symbol"]);
    assert.equal(sent.state.path, "lib/a.js");
    assert.equal(sent.state.symbol, "alpha");
    assert.equal(sent.state.before_source, "function alpha(x) {\n  if (x == null) return 0;\n  return x + 1;\n}");
    assert.equal(sent.state.after_source, "function alpha(x) {\n  if (!x) return 0;\n  return x + 1;\n}");
    assert.deepEqual(Object.keys(sent.questions).sort(), ["behavior_changed", "error_type", "nullability", "ordering", "timing", "units"]);
    assert.ok(!JSON.stringify(sent).includes("Sha256"));

    assert.deepEqual(r.region, { symbol: "alpha", startLine: 3, endLine: 6 });
    assert.equal(r.flags.behaviorChanged, 0.83);
    assert.equal(r.flags.nullability, 0.71);
    assert.equal(r.flags.ordering, 0.12);
    assert.equal(typeof r.flags.units, "number");
    assert.equal(typeof r.flags.timing, "number");
    assert.equal(typeof r.flags.errorType, "number");
    assert.equal(typeof r.note, "string");
    assert.match(r.note, /advisory/i);
    assert.match(r.note, /lib\/a\.js#alpha/);
    assert.match(r.note, /behavior change 0\.83/);
    assert.match(r.note, /nullability 0\.71/);
    assert.doesNotMatch(r.note, /ordering/, "flags below 0.5 are not rendered");
    assert.doesNotMatch(r.note, /\b(safe|correct|equivalent|verified)\b/i, "the note never asserts safety");
    assert.equal(r.model, "jev-1.13.0");
    assert.ok(!JSON.stringify(r).includes(KEY));
  });

  it("all-low probabilities → ok with note:null (silent); flags are still returned for telemetry", async () => {
    const { editSieve } = require("../lib/jev-sieve");
    const fetch = async (url, init) => okResponse(answerSieve(JSON.parse(init.body), { behavior_changed: 0.2 }));
    const r = await editSieve(root, { relPath: "lib/a.js", before: BEFORE, after: AFTER, fetch, env });
    assert.equal(r.ok, true);
    assert.equal(r.note, null);
    assert.equal(r.flags.behaviorChanged, 0.2);
  });

  it("refuses without a call: no_baseline (new file), no_change, no_region (edit outside any scope), unavailable, sensitive path", async () => {
    const { editSieve } = require("../lib/jev-sieve");
    let calls = 0;
    const fetch = async () => { calls++; throw new Error("must not be called"); };
    let r = await editSieve(root, { relPath: "lib/a.js", before: null, after: AFTER, fetch, env });
    assert.deepEqual([r.ok, r.reason], [false, "no_baseline"]);
    r = await editSieve(root, { relPath: "lib/a.js", before: AFTER, after: AFTER, fetch, env });
    assert.deepEqual([r.ok, r.reason], [false, "no_change"]);
    r = await editSieve(root, { relPath: "lib/a.js", before: BEFORE, after: BEFORE.replace("'use strict';", "'use strict'; // top-level comment"), fetch, env });
    assert.deepEqual([r.ok, r.reason], [false, "no_region"]);
    r = await editSieve(root, { relPath: "lib/a.js", before: BEFORE, after: AFTER, fetch, env: { XDG_CONFIG_HOME: cfgHome } });
    assert.deepEqual([r.ok, r.reason], [false, "no_credential"]);
    r = await editSieve(root, { relPath: ".env", before: "A=1\n", after: "A=2\n", fetch, env });
    assert.deepEqual([r.ok, r.reason], [false, "sensitive_path"]);
    r = await editSieve(root, { relPath: "notes.md", before: "# a\n", after: "# b\n", fetch, env });
    assert.deepEqual([r.ok, r.reason], [false, "unsupported_language"]);
    assert.equal(calls, 0);
  });
});

// ─── hook-posttooluse end-to-end ────────────────────────────────────────────

function installSextantShim() {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-shim-sieve-"));
  fs.writeFileSync(path.join(shimDir, "sextant"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(shimDir, "sextant"), 0o755);
  const prev = process.env.PATH;
  process.env.PATH = shimDir + path.delimiter + prev;
  return () => { process.env.PATH = prev; try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch {} };
}

async function buildRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sextant-jevsieve-${prefix}-`));
  fs.mkdirSync(path.join(dir, ".planning", "intel"), { recursive: true });
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  execSync("git init -q && git config user.email t@e.com && git config user.name T && git config commit.gpgsign false", { cwd: dir });
  fs.writeFileSync(path.join(dir, "lib", "a.js"), BEFORE);
  execSync("git add -A && git commit -q -m x", { cwd: dir });
  const db = await graph.loadDb(dir);
  graph.upsertFile(db, { relPath: "lib/a.js", type: "js", sizeBytes: BEFORE.length, mtimeMs: 1 });
  graph.replaceExports(db, "lib/a.js", [{ name: "alpha", kind: "named" }, { name: "beta", kind: "named" }]);
  freshness.recordScanState(db, dir);
  await graph.persistDb(dir);
  return dir;
}

function runPost(dir, payload, { jev, mock, cfgHome }) {
  const logFile = path.join(dir, ".planning", "jev-mock.log");
  const env = { ...process.env, XDG_CONFIG_HOME: cfgHome, SEXTANT_JEV_MOCK_LOG: logFile };
  delete env.TYPESAFE_API_KEY;
  delete env.SEXTANT_JEV;
  if (jev) {
    env.SEXTANT_JEV = "1";
    env.TYPESAFE_API_KEY = KEY;
    env.NODE_OPTIONS = `--require ${MOCK}`;
    env.SEXTANT_JEV_MOCK = JSON.stringify(mock || {});
  }
  const res = spawnSync(process.execPath, [BIN, "hook", "posttooluse"], { cwd: dir, input: JSON.stringify(payload), encoding: "utf8", timeout: 30000, env });
  let requests = [];
  try { requests = fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  return { stdout: res.stdout || "", stderr: res.stderr || "", status: res.status, requests, events: telemetry.readEvents(dir) };
}

describe("hook-posttooluse: opt-in edit sieve appended to the additionalContext envelope", () => {
  let restoreShim, cfgHome;
  before(() => { restoreShim = installSextantShim(); cfgHome = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-cfg-")); });
  after(() => { if (restoreShim) restoreShim(); fs.rmSync(cfgHome, { recursive: true, force: true }); });

  const editPayload = (dir) => ({
    tool_name: "Edit",
    tool_input: { file_path: path.join(dir, "lib", "a.js"), old_string: "if (x == null) return 0;", new_string: "if (!x) return 0;" },
    tool_response: { content: AFTER, structuredPatch: [{ newStart: 4, newLines: 1 }] },
    session_id: "sieve-session",
  });

  it("OFF by default: a leaf-file edit stays byte-silent and makes no provider request", async () => {
    const dir = await buildRepo("off");
    try {
      fs.writeFileSync(path.join(dir, "lib", "a.js"), AFTER);
      const r = runPost(dir, editPayload(dir), { jev: false, cfgHome });
      assert.equal(r.stdout, "", "no note when Jev is off");
      assert.equal(r.requests.length, 0);
      assert.ok(!r.events.some((e) => String(e.name).startsWith("jev.")));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("ON: the sieve note reaches additionalContext; state carries HEAD vs disk for the edited scope; jev.sieve recorded", async () => {
    const dir = await buildRepo("on");
    try {
      fs.writeFileSync(path.join(dir, "lib", "a.js"), AFTER);
      const r = runPost(dir, editPayload(dir), { jev: true, cfgHome, mock: { noul: { behavior_changed: 0.9, nullability: 0.8, "*": 0.1 } } });
      assert.ok(r.stdout.trim(), "expected an envelope on stdout\n" + r.stderr);
      const out = JSON.parse(r.stdout);
      const ctx = out.hookSpecificOutput.additionalContext;
      assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
      assert.match(ctx, /Jev edit sieve/);
      assert.match(ctx, /lib\/a\.js#alpha/);
      assert.match(ctx, /behavior change 0\.90/);
      assert.match(ctx, /nullability 0\.80/);
      assert.match(ctx, /advisory/i);
      const req = r.requests.find((q) => q.body && q.body.questions && q.body.questions.behavior_changed);
      assert.ok(req, "sieve request must reach the provider");
      assert.equal(req.body.state.symbol, "alpha");
      assert.ok(req.body.state.before_source.includes("x == null"), "before_source is the HEAD scope");
      assert.ok(req.body.state.after_source.includes("!x"), "after_source is the on-disk scope");
      const ev = r.events.find((e) => e.name === "jev.sieve");
      assert.ok(ev, "jev.sieve telemetry");
      assert.equal(ev.behaviorChanged, 0.9);
      assert.deepEqual(ev.flagged, ["nullability"]);
      assert.equal(ev.noted, true);
      assert.ok(r.events.some((e) => e.name === "jev.invoked" && e.purpose === "sieve" && e.ok === true));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("ON but all-low: silent stdout, jev.sieve{noted:false}; Read tools never consult; jev.lanes.editSieve=false disables", async () => {
    const dir = await buildRepo("low");
    try {
      fs.writeFileSync(path.join(dir, "lib", "a.js"), AFTER);
      let r = runPost(dir, editPayload(dir), { jev: true, cfgHome, mock: { noul: { "*": 0.1 } } });
      assert.equal(r.stdout, "", "all-low → no envelope");
      const ev = r.events.find((e) => e.name === "jev.sieve");
      assert.ok(ev && ev.noted === false);

      r = runPost(dir, { tool_name: "Read", tool_input: { file_path: path.join(dir, "lib", "a.js") }, session_id: "s" }, { jev: true, cfgHome, mock: { noul: { "*": 0.9 } } });
      assert.equal(r.requests.length, 1, "a Read must not add a provider request (only the earlier Edit's)");

      fs.writeFileSync(path.join(dir, ".codebase-intel.json"), JSON.stringify({ jev: { lanes: { editSieve: false } } }));
      r = runPost(dir, editPayload(dir), { jev: true, cfgHome, mock: { noul: { "*": 0.9 } } });
      assert.equal(r.requests.length, 1, "lane off → no new request");
      assert.equal(r.stdout, "");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

// ─── telemetry + doctor surfaces ────────────────────────────────────────────

describe("telemetry summarize/printSummary: jev section", () => {
  const { summarize, printSummary } = require("../commands/telemetry");

  it("aggregates calls, tokens, cost estimate, per-purpose and per-reason counts, lane counters", () => {
    const events = [
      { ts: 1, name: "jev.invoked", purpose: "rerank", ok: true, model: "jev-1.13.0", durationMs: 180, inputTokens: 1000, outputTokens: 4 },
      { ts: 2, name: "jev.invoked", purpose: "rerank", ok: true, model: "jev-1.13.0", durationMs: 220, inputTokens: 500, outputTokens: 3 },
      { ts: 3, name: "jev.invoked", purpose: "challenge", ok: false, model: "jev-1.13.0", durationMs: 5, reason: "no_credential" },
      { ts: 4, name: "jev.invoked", purpose: "sieve", ok: false, model: "jev-1.13.0", durationMs: 700, reason: "timeout" },
      { ts: 5, name: "jev.rerank", candidates: 2, moved: true, none: false },
      { ts: 6, name: "jev.rerank", candidates: 3, moved: false, none: true },
      { ts: 7, name: "jev.intent", probability: 0.1, overrode: true, confidence: 0.6 },
      { ts: 8, name: "jev.sieve", behaviorChanged: 0.9, flagged: ["nullability"], noted: true },
      { ts: 9, name: "jev.sieve", behaviorChanged: 0.1, flagged: [], noted: false },
    ];
    const s = summarize(events);
    assert.equal(s.jev.calls, 4);
    assert.equal(s.jev.ok, 2);
    assert.equal(s.jev.errors, 2);
    assert.equal(s.jev.inputTokens, 1500);
    assert.equal(s.jev.outputTokens, 7);
    assert.equal(s.jev.estCostUsd, 1500 * 0.042 / 1e6);
    assert.deepEqual(s.jev.byPurpose.rerank, { calls: 2, ok: 2, errors: 0, inputTokens: 1500 });
    assert.deepEqual(s.jev.byPurpose.challenge, { calls: 1, ok: 0, errors: 1, inputTokens: 0 });
    assert.deepEqual(s.jev.byReason, { no_credential: 1, timeout: 1 });
    assert.equal(s.jev.latencyP50Ms, 200);
    assert.deepEqual(s.jev.lanes.rerank, { turns: 2, moved: 1, none: 1 });
    assert.deepEqual(s.jev.lanes.intent, { consults: 1, overrides: 1 });
    assert.deepEqual(s.jev.lanes.sieve, { runs: 2, noted: 1 });

    const text = printSummary("/tmp/x", s, null);
    const joined = Array.isArray(text) ? text.join("\n") : String(text);
    assert.match(joined, /Jev judgments/);
    assert.match(joined, /rerank/);
    assert.match(joined, /1500/);
  });

  it("with no jev events the section is absent and calls is 0", () => {
    const s = summarize([{ ts: 1, name: "freshness.fresh_hit" }]);
    assert.equal(s.jev.calls, 0);
    const text = printSummary("/tmp/x", s, null);
    const joined = Array.isArray(text) ? text.join("\n") : String(text);
    assert.doesNotMatch(joined, /Jev judgments/);
  });
});

describe("doctor: Jev status line", () => {
  let cfgHome;
  before(() => { cfgHome = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-cfg-")); });
  after(() => { fs.rmSync(cfgHome, { recursive: true, force: true }); });

  function doctor(dir) {
    const env = { ...process.env, XDG_CONFIG_HOME: cfgHome };
    delete env.TYPESAFE_API_KEY;
    delete env.SEXTANT_JEV;
    const res = spawnSync(process.execPath, [BIN, "doctor", "--root", dir], { cwd: dir, encoding: "utf8", env, timeout: 30000 });
    return (res.stdout || "") + (res.stderr || "");
  }

  it("off by default → 'Jev: off'; enabled without credential → an action pointing at `sextant jev status`", async () => {
    const dir = await buildRepo("doctor");
    try {
      assert.match(doctor(dir), /Jev: off/);
      fs.writeFileSync(path.join(dir, ".codebase-intel.json"), JSON.stringify({ jev: { enabled: true } }));
      const out = doctor(dir);
      assert.match(out, /Jev/);
      assert.match(out, /no credential/i);
      assert.match(out, /sextant jev status/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
