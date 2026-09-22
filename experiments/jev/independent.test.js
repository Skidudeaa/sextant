"use strict";

// Independent validity controls: no provider calls and no expected values
// derived from the implementation's own mutation evaluator.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { hash, shuffle, buildRequest, replay, summarize, parseArgs, metrics, predictions, VARIANTS } = require("./lab");
const { buildCases } = require("./mutations");
const repository = require("./repository");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function fixture(id, split = "development") {
  return { id, family: "independent", groupId: id, split, provenance: { kind: "synthetic" }, rationale: "Independent control: x is one, not two.",
    state: { x: 1 }, questions: { flag: { type: "noul", instructions: "Is x equal to two?", criteria: { true: "x equals two", false: "x differs from two" } } }, expected: { flag: false } };
}

function runFixture({ count = 2, variants = ["original"], model = "jev-latest" } = {}) {
  const corpus = Array.from({ length: count }, (_, i) => fixture(`independent-${i}`, i ? "holdout" : "development"));
  const seed = 19;
  const tasks = shuffle(corpus.flatMap(c => variants.map(variant => ({ c, variant }))), seed);
  const manifest = { kind: "manifest", corpusSnapshot: corpus, corpusHash: hash(corpus), seed, model, variants,
    corpus: "authored", cases: corpus.length, requests: tasks.length,
    plannedTasks: tasks.map(({ c, variant }) => ({ caseId: c.id, variant, requestHash: hash(buildRequest(c, variant, model).request) })) };
  const results = tasks.map(({ c, variant }, index) => {
    const { request } = buildRequest(c, variant, model);
    return { kind: "result", caseId: c.id, family: c.family, groupId: c.groupId, split: c.split, variant,
      requestHash: hash(request), latencyMs: index + 1,
      response: { model: "jev-1.13.0", usage: { input_tokens: 10, output_tokens: 0 }, answers: { flag: { type: "noul", noul: variant === "negated" ? 0.9 : 0.1 } } } };
  });
  return { manifest, results, corpus };
}

test("frozen schedule rejects an otherwise well-formed unplanned variant", () => {
  const { manifest, results, corpus } = runFixture({ count: 1 });
  const unplanned = { ...results[0], variant: "negated", requestHash: hash(buildRequest(corpus[0], "negated", manifest.model).request),
    response: { ...results[0].response, answers: { flag: { type: "noul", noul: 0.9 } } } };
  assert.throws(() => replay([manifest, unplanned]), /variant|schedule|planned|task/i);
});

test("partial replay explicitly reports missing planned requests", () => {
  const { manifest, results } = runFixture();
  const summary = summarize(replay([manifest, results[0]]));
  assert.match(summary.status, /partial/i);
  assert.equal(summary.plannedRequests, 2);
  assert.equal(summary.completedRequests, 1);
  assert.equal(summary.unattemptedRequests, 1);
});

test("sequential frozen run refuses reordered responses inconsistent with its schedule", () => {
  const { manifest, results } = runFixture();
  assert.throws(() => replay([manifest, ...results.toReversed()]), /order|schedule|sequence/i);
});

test("duplicate error records cannot inflate failure counts", () => {
  const { manifest, results } = runFixture({ count: 1 });
  const failed = { kind: "error", caseId: results[0].caseId, variant: results[0].variant, requestHash: results[0].requestHash, error: "JevError", status: 429 };
  assert.throws(() => replay([manifest, failed, failed]), /duplicate|schedule|task/i);
});

test("error evidence must belong to a planned case and transmitted request", () => {
  const { manifest } = runFixture({ count: 1 });
  assert.throws(() => replay([manifest, { kind: "error", caseId: "nonexistent", variant: "original", requestHash: "arbitrary", error: "JevError" }]), /unknown|case|task|fingerprint|schedule/i);
});

test("duplicate variant CLI arguments fail before any paid requests", () => {
  assert.throws(() => parseArgs(["live", "--variants", "original,original"]), /duplicate|unique/i);
});

test("mixed model stamps cannot publish one pooled variant calibration curve", () => {
  const { manifest, results } = runFixture();
  results[1].response.model = "jev-1.12.0";
  let summary;
  try { summary = summarize(replay([manifest, ...results])); }
  catch (error) { assert.match(error.message, /model/i); return; }
  assert.equal(summary.models.length, 2);
  assert.ok(!summary.byVariant?.original, "Model-specific calibration must not be pooled under original");
  assert.ok(summary.byModel && Object.keys(summary.byModel).length === 2, "Preserve each resolved model's results separately");
});

test("polarity consistency does not compare responses from different model versions", () => {
  const { manifest, results } = runFixture({ count: 1, variants: ["original", "negated"] });
  results.find(row => row.variant === "negated").response.model = "jev-1.12.0";
  let summary;
  try { summary = summarize(replay([manifest, ...results])); }
  catch (error) { assert.match(error.message, /model/i); return; }
  assert.ok(!summary.consistency?.negated || summary.consistency.negated.n === 0,
    "Cross-version differences must not be presented as same-model polarity instability");
});

test("96 mutation labels match independently derived per-input truth tables", () => {
  const differs = {
    nullish: [1, 2, 3], boundary: [1], "number-sort": [0, 2], "dedup-order": [0, 2],
    "strict-equality": [0, 2], "slice-end": [0, 3], "filter-presence": [0, 3],
    "last-write": [0, 3], "case-sensitive": [0, 2], "fallback-key": [0],
    "empty-all": [0], "prefix-parse": [0, 2, 3],
  };
  const rows = buildCases();
  assert.equal(rows.length, 96);
  for (const row of rows) {
    const [, program, input, variant] = row.id.split("/");
    assert.ok(Object.hasOwn(differs, program));
    assert.equal(row.expected.flag, variant === "semantic" && differs[program].includes(Number(input)), row.id);
  }
});

test("error-rate and calibration arithmetic have an independent hand-computed control", () => {
  const result = metrics([{ p: 0.1, expected: false }, { p: 0.2, expected: false }, { p: 0.9, expected: true }, { p: 0.4, expected: true }]);
  assert.deepEqual([result.tp, result.fp, result.tn, result.fn], [1, 0, 2, 1]);
  assert.equal(result.accuracy, 3 / 4);
  assert.equal(result.sensitivity, 1 / 2);
  assert.equal(result.falseAcceptanceRate, 1 / 3);
  assert.ok(Math.abs(result.brier - 0.105) < 1e-12);
  assert.ok(Math.abs(result.ece - 0.25) < 1e-12);
});

test("every transformation preserves a bad-true target label independently of target qid", () => {
  const row = fixture("meaning");
  row.expected.flag = true;
  for (const variant of VARIANTS) {
    const { request, targets } = buildRequest(row, variant, "jev-1.13.0");
    const answers = {};
    for (const [qid, q] of Object.entries(request.questions)) {
      answers[qid] = q.type === "choice" ? { type: "choice", probabilities: { yes: 0.8, no: 0.2 } }
        : q.type === "score" ? { type: "score", probabilities: { 0: 0.2, 1: 0.8 } }
          : { type: "noul", noul: variant === "negated" ? 0.2 : 0.8 };
    }
    const output = predictions({ answers }, targets);
    assert.equal(output.length, 1);
    assert.equal(output[0].expected, true);
    assert.ok(Math.abs(output[0].p - 0.8) < 1e-12, variant);
  }
});

function repositoryFixture(id = "repository-independent") {
  const candidates = ["lib/distractor.js", "lib/definition.js"].map((file, i) => ({
    id: `candidate_${i}`, path: file, fileSha256: "fixture",
    spans: [{ startLine: 1, endLine: 1, text: i ? "function target() { return true; }" : "const text = 'target';" }],
  }));
  const request = repository.buildRequest("target", candidates);
  const task = { id, candidates, request, requestHash: hash(request), labels: { relevantFiles: ["lib/definition.js", "lib/omitted.js"], acceptableFiles: [], topK: 3 } };
  const response = { model: "jev-1.13.0", usage: { input_tokens: 10, output_tokens: 0 }, answers: {
    relevance_candidate_0: { type: "noul", noul: 0.2 }, relevance_candidate_1: { type: "noul", noul: 0.8 },
    best_file: { type: "choice", choice: "candidate_1", confidence: 0.5, probabilities: { candidate_0: 0.5, candidate_1: 0.5, none: 0 } },
  } };
  return { task, response };
}

test("repository Choice metrics honor the selected option when probabilities tie", () => {
  const { task, response } = repositoryFixture();
  const compared = repository.compareRankings(task, response);
  assert.equal(compared.rankings.choice[0], "lib/definition.js");
  assert.equal(compared.choice.mrr, 1);
  assert.equal(compared.candidateCoverage, 0.5);
  assert.ok(compared.choice.ndcg < 1, "The absent secondary gold must remain in the ideal denominator");
});

test("repository summary cannot pool distinct returned model versions", () => {
  const first = repositoryFixture("first");
  const second = repositoryFixture("second");
  second.response.model = "jev-1.12.0";
  const rows = [first, second].map(({ task, response }) => ({ kind: "result", id: task.id, response, comparison: repository.compareRankings(task, response) }));
  let measured;
  try { measured = repository.summary([first.task, second.task], rows); }
  catch (error) { assert.match(error.message, /model/i); return; }
  assert.ok(!measured.arms?.choice, "A pooled Choice curve hides version-specific quality");
  assert.equal(Object.keys(measured.byModel).length, 2);
});

test("repository duplicate results cannot increase the no-answer or quality denominator", () => {
  const { task, response } = repositoryFixture();
  const row = { kind: "result", id: task.id, response, comparison: repository.compareRankings(task, response) };
  assert.throws(() => repository.summary([task], [row, row]), /duplicate|unique|result/i);
});

test("repository no-answer controls do not erase missing gold or inflate positive-query averages", () => {
  const { task } = repositoryFixture();
  const negative = { ...repositoryFixture("negative").task, labels: { relevantFiles: [], acceptableFiles: [] } };
  const response = { model: "jev-1.13.0", usage: { input_tokens: 10, output_tokens: 0 }, answers: {
    relevance_candidate_0: { type: "noul", noul: 0.1 }, relevance_candidate_1: { type: "noul", noul: 0.1 },
    best_file: { type: "choice", choice: "none", confidence: 0.9, probabilities: { candidate_0: 0.05, candidate_1: 0.05, none: 0.9 } },
  } };
  const row = { kind: "result", id: negative.id, response, comparison: repository.compareRankings(negative, response) };
  const measured = repository.summary([task, negative], [row]);
  assert.equal(measured.candidateRecall, 0.5);
  assert.equal(measured.arms.baseline.mrr, 0.5);
  assert.equal(measured.noAnswerCases, 1);
  assert.equal(measured.noAnswerEvaluated, 1);
  assert.equal(measured.noAnswerCorrect, 1);
});

test("repository request reconstruction blocks label-bearing request tampering even with an updated outer hash", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jev-independent-artifact-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { task } = repositoryFixture();
  task.request.state.expected = "LABEL_FROM_OUTSIDE_EVIDENCE";
  task.requestHash = hash(task.request);
  fs.writeFileSync(path.join(directory, "tasks.json"), JSON.stringify([task]));
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ model: "jev-1.13.0", tasksHash: hash([task]) }));
  let calls = 0;
  await assert.rejects(repository.live(directory, path.join(directory, "output.jsonl"), { client: { async systemOne() { calls++; throw new Error("Must not call"); } } }), /request|builder|label-free/i);
  assert.equal(calls, 0);
});

test("repository candidates read actual bounded file bytes and reject symlink sources", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jev-independent-source-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, "lib"));
  fs.writeFileSync(path.join(directory, "lib/source.js"), "function target() { return 3; }\n");
  fs.symlinkSync("source.js", path.join(directory, "lib/link.js"));
  const result = relative => ({ results: { files: [{ path: relative }], hits: [{ path: relative, lineNumber: 1, line: "DO_NOT_USE_UNTRUSTED_RETRIEVAL_TEXT" }] } });
  const candidate = repository.candidatesFromResult(directory, result("lib/source.js"))[0];
  assert.match(candidate.spans[0].text, /return 3/);
  assert.doesNotMatch(candidate.spans[0].text, /DO_NOT_USE/);
  assert.throws(() => repository.candidatesFromResult(directory, result("lib/link.js")), /symlink|regular file/i);
});
