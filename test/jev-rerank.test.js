"use strict";

// Acceptance contract for the retrieval-side Jev lanes:
//   lib/jev-rerank.js   rerankCandidates()  — docs/044: Choice reranking over
//                       identical real candidate pools moved MRR 0.895 → 0.938
//   lib/jev-intent.js   intentSecondOpinion() — docs/043: shouldRetrieve over-
//                       fires on acknowledgments / quoted identifiers
//                       ("thanks for resolveImportPath" → confidence 0.6)
//   commands/hook-refresh.js wiring (opt-in: SEXTANT_JEV=1 or `jev.enabled`)
//   commands/retrieve.js --judge
// The hook end-to-end cases run the real hook process with a mock fetch preloaded
// through NODE_OPTIONS (test/helpers/jev-mock-fetch.js). No provider is called.

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
const KEY = "sk-test-CANARY-KEY-rerank";

function okResponse(body) {
  return { ok: true, status: 200, body: { cancel: async () => {} }, json: async () => body };
}

function mkSourceRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-rerank-"));
  fs.mkdirSync(path.join(root, ".planning", "intel"), { recursive: true });
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "lib", "a.js"), "function alpha(x) {\n  return x + 1;\n}\n\nfunction beta(y) {\n  return y * 2;\n}\nmodule.exports = { alpha, beta };\n");
  fs.writeFileSync(path.join(root, "lib", "b.js"), "function gamma() {\n  return 'g';\n}\nmodule.exports = { gamma };\n");
  fs.writeFileSync(path.join(root, "lib", "c.js"), "const x = 1;\nmodule.exports = { x };\n");
  for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(root, "lib", `f${i}.js`), `function f${i}() {\n  return ${i};\n}\n`);
  fs.writeFileSync(path.join(root, ".env"), "S=1\n");
  return root;
}

// ─── rerankCandidates (pure, injected fetch) ────────────────────────────────

describe("rerankCandidates: request shape, ordering rule, caps, sensitive paths", () => {
  let root, cfgHome, env;
  beforeEach(() => { root = mkSourceRepo(); cfgHome = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-cfg-")); env = { XDG_CONFIG_HOME: cfgHome, TYPESAFE_API_KEY: KEY }; });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(cfgHome, { recursive: true, force: true }); });

  function answerRerank(req, { relevance, best }) {
    const ids = req.state.candidates.map((c) => c.id);
    const keys = Object.keys(req.questions.best_file.criteria);
    const probs = Object.fromEntries(keys.map((k) => [k, k === best ? 0.7 : 0.3 / (keys.length - 1)]));
    const answers = { best_file: { type: "choice", choice: best, probabilities: probs, confidence: 0.7 } };
    for (const id of ids) answers[`relevance_${id}`] = { type: "noul", noul: relevance[id] ?? 0.5 };
    return { model: req.model, usage: { input_tokens: 200, output_tokens: ids.length + 1 }, answers };
  }

  it("sends query + bounded verbatim spans per candidate; applies the Choice-first ordering", async () => {
    const { rerankCandidates } = require("../lib/jev-rerank");
    const calls = [];
    const fetch = async (url, init) => {
      const req = JSON.parse(init.body);
      calls.push(req);
      return okResponse(answerRerank(req, { relevance: { c0: 0.2, c1: 0.9, c2: 0.6 }, best: "c1" }));
    };
    const files = [
      { path: "lib/c.js", hits: [{ line: 1 }] },
      { path: "lib/a.js", hits: [{ line: 6 }] },
      { path: "lib/b.js", hits: [{ line: 2 }] },
    ];
    const r = await rerankCandidates(root, { query: "where is beta defined", files, fetch, env });
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
    const req = calls[0];
    assert.equal(req.state.query, "where is beta defined");
    assert.deepEqual(req.state.candidates.map((c) => [c.id, c.path]), [["c0", "lib/c.js"], ["c1", "lib/a.js"], ["c2", "lib/b.js"]]);
    for (const c of req.state.candidates) {
      assert.deepEqual(Object.keys(c).sort(), ["id", "path", "spans"]);
      assert.ok(c.spans.length >= 1);
      for (const s of c.spans) {
        assert.deepEqual(Object.keys(s).sort(), ["endLine", "source", "startLine"]);
        assert.ok(s.source.length > 0 && Buffer.byteLength(s.source) <= 1500);
      }
    }
    // The hit inside `beta` is presented as the enclosing scope, not a bare line.
    assert.ok(req.state.candidates[1].spans[0].source.startsWith("function beta(y) {"));
    assert.deepEqual(Object.keys(req.questions).sort(), ["best_file", "relevance_c0", "relevance_c1", "relevance_c2"]);
    assert.equal(req.questions.best_file.type, "choice");
    assert.deepEqual(Object.keys(req.questions.best_file.criteria).sort(), ["c0", "c1", "c2", "none"]);
    assert.equal(req.questions.relevance_c0.type, "noul");
    assert.ok(!JSON.stringify(req).includes("Sha256"));

    assert.deepEqual(r.order, ["lib/a.js", "lib/b.js", "lib/c.js"]);
    assert.equal(r.best, "lib/a.js");
    assert.equal(r.none, false);
    assert.deepEqual(r.relevance, { "lib/c.js": 0.2, "lib/a.js": 0.9, "lib/b.js": 0.6 });
    assert.deepEqual(r.skipped, []);
    assert.equal(r.model, "jev-1.13.0");
    assert.equal(r.usage.input_tokens, 200);
    assert.ok(!JSON.stringify(r).includes(KEY));
  });

  it("a winning `none` is reported, not hidden: none:true, best:null, order still by probability", async () => {
    const { rerankCandidates } = require("../lib/jev-rerank");
    const fetch = async (url, init) => okResponse(answerRerank(JSON.parse(init.body), { relevance: { c0: 0.1, c1: 0.3 }, best: "none" }));
    const r = await rerankCandidates(root, { query: "q", files: [{ path: "lib/a.js", hits: [{ line: 2 }] }, { path: "lib/b.js", hits: [{ line: 2 }] }], fetch, env });
    assert.equal(r.ok, true);
    assert.equal(r.none, true);
    assert.equal(r.best, null);
    assert.equal(r.order.length, 2);
  });

  it("caps candidates at maxCandidates (default 8) in input order, skips sensitive/unreadable paths with reasons", async () => {
    const { rerankCandidates, MAX_CANDIDATES } = require("../lib/jev-rerank");
    assert.equal(MAX_CANDIDATES, 8);
    let sent = null;
    const fetch = async (url, init) => { sent = JSON.parse(init.body); return okResponse(answerRerank(sent, { relevance: {}, best: "c0" })); };
    const files = [{ path: ".env", hits: [{ line: 1 }] }, { path: "lib/missing.js", hits: [{ line: 1 }] }]
      .concat(Array.from({ length: 10 }, (_, i) => ({ path: `lib/f${i}.js`, hits: [{ line: 2 }] })));
    const r = await rerankCandidates(root, { query: "q", files, fetch, env });
    assert.equal(r.ok, true);
    assert.equal(sent.state.candidates.length, 8);
    assert.deepEqual(sent.state.candidates.map((c) => c.path), Array.from({ length: 8 }, (_, i) => `lib/f${i}.js`));
    const skippedPaths = r.skipped.map((s) => s.path);
    assert.ok(skippedPaths.includes(".env") && skippedPaths.includes("lib/missing.js") && skippedPaths.includes("lib/f8.js") && skippedPaths.includes("lib/f9.js"));
    assert.equal(r.skipped.find((s) => s.path === ".env").reason, "sensitive_path");
    assert.equal(r.skipped.find((s) => s.path === "lib/f9.js").reason, "over_cap");
    // Files the model never saw keep their original relative order AFTER the judged ones.
    assert.deepEqual(r.order.slice(8), ["lib/f8.js", "lib/f9.js"]);
    assert.equal(r.order.length, 10);
  });

  it("refuses without a call when <2 judgeable candidates or Jev is unavailable", async () => {
    const { rerankCandidates } = require("../lib/jev-rerank");
    let calls = 0;
    const fetch = async () => { calls++; throw new Error("must not be called"); };
    let r = await rerankCandidates(root, { query: "q", files: [{ path: "lib/a.js", hits: [{ line: 2 }] }], fetch, env });
    assert.deepEqual([r.ok, r.reason], [false, "too_few_candidates"]);
    r = await rerankCandidates(root, { query: "q", files: [{ path: "lib/a.js", hits: [{ line: 2 }] }, { path: "lib/b.js", hits: [{ line: 2 }] }], fetch, env: { XDG_CONFIG_HOME: cfgHome } });
    assert.deepEqual([r.ok, r.reason], [false, "no_credential"]);
    assert.equal(calls, 0);
    const f500 = async () => ({ ok: false, status: 500, body: { cancel: async () => {} }, json: async () => ({}) });
    r = await rerankCandidates(root, { query: "q", files: [{ path: "lib/a.js", hits: [{ line: 2 }] }, { path: "lib/b.js", hits: [{ line: 2 }] }], fetch: f500, env });
    assert.deepEqual([r.ok, r.reason], [false, "http_error"]);
  });
});

// ─── intentSecondOpinion (pure, injected fetch) ─────────────────────────────

describe("intentSecondOpinion: one Noul over the prompt", () => {
  let root, cfgHome, env;
  beforeEach(() => { root = mkSourceRepo(); cfgHome = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-cfg-")); env = { XDG_CONFIG_HOME: cfgHome, TYPESAFE_API_KEY: KEY }; });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(cfgHome, { recursive: true, force: true }); });

  it("asks needs_code_evidence with the prompt as state; p>0.5 → retrieve", async () => {
    const { intentSecondOpinion, INTENT_MAX_CONFIDENCE } = require("../lib/jev-intent");
    assert.equal(INTENT_MAX_CONFIDENCE, 0.6);
    let sent = null;
    const fetch = async (url, init) => { sent = JSON.parse(init.body); return okResponse({ model: "jev-1.13.0", usage: { input_tokens: 40, output_tokens: 1 }, answers: { needs_code_evidence: { type: "noul", noul: 0.12 } } }); };
    const r = await intentSecondOpinion(root, { prompt: "thanks for resolveImportPath", fetch, env });
    assert.equal(r.ok, true);
    assert.equal(r.retrieve, false);
    assert.equal(r.probability, 0.12);
    assert.equal(sent.state.prompt, "thanks for resolveImportPath");
    assert.deepEqual(Object.keys(sent.questions), ["needs_code_evidence"]);
    assert.equal(sent.questions.needs_code_evidence.type, "noul");
    const r2 = await intentSecondOpinion(root, { prompt: "x", env, fetch: async () => okResponse({ model: "jev-1.13.0", usage: { input_tokens: 1, output_tokens: 1 }, answers: { needs_code_evidence: { type: "noul", noul: 0.8 } } }) });
    assert.equal(r2.retrieve, true);
    const r3 = await intentSecondOpinion(root, { prompt: "x", fetch, env: { XDG_CONFIG_HOME: cfgHome } });
    assert.deepEqual([r3.ok, r3.reason], [false, "no_credential"]);
  });
});

// ─── hook-refresh end-to-end with a mocked provider ─────────────────────────

function gitInit(dir) {
  execSync("git init -q && git config user.email t@e.com && git config user.name T && git config commit.gpgsign false", { cwd: dir });
}

function installSextantShim() {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-shim-jev-"));
  fs.writeFileSync(path.join(shimDir, "sextant"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(shimDir, "sextant"), 0o755);
  const prev = process.env.PATH;
  process.env.PATH = shimDir + path.delimiter + prev;
  return () => { process.env.PATH = prev; try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch {} };
}

async function buildHookFixture(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sextant-jevhook-${prefix}-`));
  fs.mkdirSync(path.join(dir, ".planning", "intel"), { recursive: true });
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  gitInit(dir);
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
  const rawSummary = "## Codebase intelligence\n- test\n";
  fs.writeFileSync(path.join(dir, ".planning", "intel", "summary.md"), rawSummary);
  assert.equal(await require("../lib/summary-binding").writeManifest(dir, rawSummary, { db, graph }), true);
  return dir;
}

function runHook(dir, prompt, { jev, mock, cfgHome, sessionId = "jev-hook" }) {
  const logFile = path.join(dir, ".planning", "jev-mock.log");
  const env = { ...process.env, XDG_CONFIG_HOME: cfgHome, SEXTANT_SYNC_RESCAN: "0", SEXTANT_JEV_MOCK_LOG: logFile };
  delete env.TYPESAFE_API_KEY;
  delete env.SEXTANT_JEV;
  delete env.SEXTANT_HOLDBACK_PCT;
  delete env.SEXTANT_HOLDBACK_FORCE;
  if (jev) {
    env.SEXTANT_JEV = "1";
    env.TYPESAFE_API_KEY = KEY;
    env.NODE_OPTIONS = `--require ${MOCK}`;
    env.SEXTANT_JEV_MOCK = JSON.stringify(mock || {});
  }
  const res = spawnSync(process.execPath, [BIN, "hook", "refresh"], { cwd: dir, input: JSON.stringify({ prompt, session_id: sessionId }), encoding: "utf8", timeout: 30000, env });
  let requests = [];
  try { requests = fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  return { stdout: res.stdout || "", stderr: res.stderr || "", status: res.status, requests, events: telemetry.readEvents(dir) };
}

function blockOrder(stdout) {
  const m = stdout.match(/<codebase-retrieval>[\s\S]*?<\/codebase-retrieval>/);
  if (!m) return null;
  const paths = [];
  for (const line of m[0].split("\n")) {
    const p = line.match(/lib\/resolveImportPath(?:Cache)?\.js/);
    if (p && !paths.includes(p[0])) paths.push(p[0]);
  }
  return paths;
}

describe("hook-refresh: opt-in Jev rerank + intent lanes (mock provider via NODE_OPTIONS preload)", () => {
  let restoreShim, cfgHome;
  before(() => { restoreShim = installSextantShim(); cfgHome = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-cfg-")); });
  after(() => { if (restoreShim) restoreShim(); fs.rmSync(cfgHome, { recursive: true, force: true }); });

  it("OFF by default: no jev.* telemetry, no provider request, block order unchanged", async () => {
    const dir = await buildHookFixture("off");
    try {
      const r = runHook(dir, "where is resolveImportPath defined", { jev: false, cfgHome });
      assert.ok(r.stdout.includes("<codebase-retrieval>"), r.stdout);
      assert.deepEqual(blockOrder(r.stdout), ["lib/resolveImportPath.js", "lib/resolveImportPathCache.js"]);
      assert.equal(r.requests.length, 0);
      assert.ok(!r.events.some((e) => String(e.name).startsWith("jev.")), "no jev events when off");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("RERANK: with SEXTANT_JEV=1 the Choice winner leads the block and jev.rerank / jev.invoked{purpose:rerank} are recorded", async () => {
    const dir = await buildHookFixture("rerank");
    try {
      const r = runHook(dir, "where is resolveImportPath defined", { jev: true, cfgHome, mock: { noul: { "*": 0.9 }, choiceByPath: { best_file: "lib/resolveImportPathCache.js" } } });
      assert.ok(r.stdout.includes("<codebase-retrieval>"), r.stdout + r.stderr);
      assert.deepEqual(blockOrder(r.stdout), ["lib/resolveImportPathCache.js", "lib/resolveImportPath.js"]);
      const rerankReq = r.requests.find((q) => q.body && q.body.questions && q.body.questions.best_file);
      assert.ok(rerankReq, "a rerank request must reach the provider");
      assert.equal(rerankReq.body.state.query, "where is resolveImportPath defined");
      const ev = r.events.find((e) => e.name === "jev.rerank");
      assert.ok(ev, "jev.rerank telemetry");
      assert.equal(ev.candidates, 2);
      assert.equal(ev.moved, true);
      assert.equal(ev.none, false);
      assert.ok(r.events.some((e) => e.name === "jev.invoked" && e.purpose === "rerank" && e.ok === true));
      // The injected set (PostToolUse scoring substrate) follows the judged order.
      const inj = JSON.parse(fs.readFileSync(path.join(dir, ".planning", "intel", ".last_injected_paths.retrieval.jev-hook"), "utf8"));
      assert.equal(inj.paths[0].path, "lib/resolveImportPathCache.js");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("RERANK failure is silent: provider 503 → original order, jev.invoked{ok:false} recorded, block still emitted", async () => {
    const dir = await buildHookFixture("rerankfail");
    try {
      const r = runHook(dir, "where is resolveImportPath defined", { jev: true, cfgHome, mock: { fail: "http" } });
      assert.ok(r.stdout.includes("<codebase-retrieval>"), r.stdout + r.stderr);
      assert.deepEqual(blockOrder(r.stdout), ["lib/resolveImportPath.js", "lib/resolveImportPathCache.js"]);
      assert.ok(r.events.some((e) => e.name === "jev.invoked" && e.purpose === "rerank" && e.ok === false && e.reason === "http_error"));
      assert.ok(!r.events.some((e) => e.name === "jev.rerank" && e.moved === true));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("CONTENT-STALE turn never consults Jev", async () => {
    const dir = await buildHookFixture("stale");
    try {
      fs.appendFileSync(path.join(dir, "lib", "resolveImportPath.js"), "\n// dirty\n");
      const r = runHook(dir, "where is resolveImportPath defined", { jev: true, cfgHome, mock: { noul: { "*": 0.9 } } });
      assert.equal(r.requests.length, 0, "no provider request on a content-stale turn");
      assert.ok(!r.events.some((e) => String(e.name).startsWith("jev.")));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("INTENT: a low-confidence classifier fire is overridden when Jev says no code evidence is needed", async () => {
    const dir = await buildHookFixture("intent");
    try {
      // "thanks for resolveImportPath" classifies retrieve:true at confidence 0.6
      // (docs/043's acknowledgment false positive). Jev says 0.1 → static summary.
      const { shouldRetrieve } = require("../lib/classifier");
      const c = shouldRetrieve("thanks for resolveImportPath");
      assert.equal(c.retrieve, true);
      assert.ok(c.confidence <= 0.6, `fixture prompt must be low-confidence, got ${c.confidence}`);
      const r = runHook(dir, "thanks for resolveImportPath", { jev: true, cfgHome, mock: { noul: { needs_code_evidence: 0.1, "*": 0.9 } } });
      assert.ok(!r.stdout.includes("<codebase-retrieval>"), "override → no retrieval block:\n" + r.stdout);
      const ev = r.events.find((e) => e.name === "jev.intent");
      assert.ok(ev, "jev.intent telemetry");
      assert.equal(ev.probability, 0.1);
      assert.equal(ev.overrode, true);
      assert.equal(ev.confidence, c.confidence);
      assert.ok(r.events.some((e) => e.name === "jev.invoked" && e.purpose === "intent"));
      assert.ok(!r.requests.some((q) => q.body && q.body.questions && q.body.questions.best_file), "no rerank request after an intent override");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("INTENT: a confident classifier fire is NOT consulted; a low-confidence fire that Jev confirms proceeds to retrieval", async () => {
    const dir = await buildHookFixture("intent2");
    try {
      let r = runHook(dir, "where is resolveImportPath defined", { jev: true, cfgHome, mock: { noul: { needs_code_evidence: 0.1, "*": 0.9 } }, sessionId: "s1" });
      assert.ok(r.stdout.includes("<codebase-retrieval>"), "confident turn retrieves regardless");
      assert.ok(!r.events.some((e) => e.name === "jev.intent"), "no intent consult on a confident turn");
      r = runHook(dir, "thanks for resolveImportPath", { jev: true, cfgHome, mock: { noul: { needs_code_evidence: 0.9, "*": 0.9 } }, sessionId: "s2" });
      assert.ok(r.stdout.includes("<codebase-retrieval>"), "confirmed low-confidence turn retrieves:\n" + r.stdout);
      const ev = r.events.filter((e) => e.name === "jev.intent").pop();
      assert.equal(ev.overrode, false);
      assert.equal(ev.probability, 0.9);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("lane switches: jev.lanes.rerank=false keeps intent; jev.lanes.intent=false keeps rerank", async () => {
    const dir = await buildHookFixture("lanes");
    try {
      fs.writeFileSync(path.join(dir, ".codebase-intel.json"), JSON.stringify({ jev: { lanes: { rerank: false } } }));
      let r = runHook(dir, "thanks for resolveImportPath", { jev: true, cfgHome, mock: { noul: { needs_code_evidence: 0.9, "*": 0.9 }, choiceByPath: { best_file: "lib/resolveImportPathCache.js" } }, sessionId: "l1" });
      assert.ok(r.events.some((e) => e.name === "jev.intent"));
      assert.ok(!r.events.some((e) => e.name === "jev.rerank"));
      assert.deepEqual(blockOrder(r.stdout), ["lib/resolveImportPath.js", "lib/resolveImportPathCache.js"]);
      fs.writeFileSync(path.join(dir, ".codebase-intel.json"), JSON.stringify({ jev: { lanes: { intent: false } } }));
      r = runHook(dir, "thanks for resolveImportPath", { jev: true, cfgHome, mock: { noul: { needs_code_evidence: 0.1, "*": 0.9 }, choiceByPath: { best_file: "lib/resolveImportPathCache.js" } }, sessionId: "l2" });
      assert.ok(!r.events.some((e) => e.name === "jev.intent"));
      assert.ok(r.events.some((e) => e.name === "jev.rerank"));
      assert.deepEqual(blockOrder(r.stdout), ["lib/resolveImportPathCache.js", "lib/resolveImportPath.js"]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

// ─── sextant retrieve --judge ───────────────────────────────────────────────

describe("sextant retrieve --judge", () => {
  it("attaches a `jev` object to the JSON output; without a credential it is {ok:false, reason:'no_credential'}", async () => {
    const dir = await buildHookFixture("cli");
    const cfgHome = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-jev-cfg-"));
    try {
      const env = { ...process.env, XDG_CONFIG_HOME: cfgHome };
      delete env.TYPESAFE_API_KEY;
      delete env.SEXTANT_JEV;
      const res = spawnSync(process.execPath, [BIN, "retrieve", "resolveImportPath", "--root", dir, "--backend", "rg", "--judge"], { cwd: dir, encoding: "utf8", env, timeout: 30000 });
      assert.equal(res.status, 0, res.stderr);
      const out = JSON.parse(res.stdout);
      assert.ok(out.jev, "retrieve --judge must report the judgment");
      assert.equal(out.jev.ok, false);
      assert.equal(out.jev.reason, "no_credential");
      const plain = spawnSync(process.execPath, [BIN, "retrieve", "resolveImportPath", "--root", dir, "--backend", "rg"], { cwd: dir, encoding: "utf8", env, timeout: 30000 });
      assert.equal(plain.status, 0, plain.stderr);
      assert.equal(JSON.parse(plain.stdout).jev, undefined, "no --judge → no jev field (byte-compatible output)");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(cfgHome, { recursive: true, force: true }); }
  });
});
