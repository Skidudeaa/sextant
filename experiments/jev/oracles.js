"use strict";

const assert = require("node:assert/strict");
const vm = require("node:vm");
const { isDeepStrictEqual } = require("node:util");
const { parse } = require("@babel/parser");
const { extractImports } = require("../../lib/extractors/javascript");
const { shouldRetrieve } = require("../../lib/classifier");
const { cases } = require("./cases");

// This executes only the committed, authored fixture snippets. node:vm is not
// a security boundary and must not be offered arbitrary repository/provider code.
function execute(source, bindings = {}) {
  return vm.runInNewContext(source, bindings, { timeout: 1000 });
}

function canonical(value) {
  return value === undefined ? { undefined: true } : JSON.parse(JSON.stringify(value));
}

async function behavior(row) {
  const scenario = row.groupId.split("/")[1];
  const { before, after } = row.state.observation;
  const samples = [];
  if (scenario === "boundary") {
    for (const age of [-1, 0, 17, 18, 19, 100]) {
      samples.push({ input: age, before: execute(before, { age }), after: execute(after, { age }) });
    }
  } else if (scenario === "order") {
    for (const items of [[], [1], [1, 2], [2, 1, 2]]) {
      samples.push({ input: items, before: canonical(execute(`(() => { ${before} })()`, { items })), after: canonical(execute(`(() => { ${after} })()`, { items })) });
    }
  } else if (scenario === "nullability") {
    for (const found of [undefined, null, 0, false, "value"]) {
      samples.push({ input: canonical(found), before: canonical(execute(`(() => { ${before} })()`, { found })), after: canonical(execute(`(() => { ${after} })()`, { found })) });
    }
  } else if (scenario === "timing") {
    async function trace(source) {
      const events = [];
      let finishPersist;
      const persist = () => new Promise(resolve => { finishPersist = () => { events.push("persisted"); resolve(); }; });
      const result = execute(`(async () => { ${source} })()`, { persist });
      result.then(() => events.push("returned"));
      await Promise.resolve();
      const beforeRelease = [...events];
      finishPersist();
      await result;
      await Promise.resolve();
      return { beforeRelease, events };
    }
    samples.push({ input: "persist completion withheld until explicit release", before: await trace(before), after: await trace(after) });
  } else {
    throw new Error(`No behavior oracle for ${scenario}`);
  }
  return { observedFlag: samples.some(sample => !isDeepStrictEqual(sample.before, sample.after)), method: "Executed before/after snippets on discriminating inputs", evidence: samples };
}

function dependency(row) {
  const scenario = row.groupId.split("/")[1];
  const { context, observation } = row.state;
  if (scenario === "direct-import" || scenario === "transitive") {
    const edges = Object.entries(context.files).flatMap(([file, code]) =>
      extractImports(code, file).map(imp => `${file} -> ${imp.specifier.replace(/^\.\//, "")}.js`));
    return { observedFlag: !edges.includes(observation.edge), method: "Actual Sextant AST-first import extraction", evidence: { edges, assertedEdge: observation.edge } };
  }
  if (scenario === "type-only") {
    const body = parse(context.files["a.ts"], { sourceType: "module", plugins: ["typescript"] }).program.body;
    const imports = body.filter(node => node.type === "ImportDeclaration");
    const runtimeImports = imports.filter(node => node.importKind !== "type");
    const assertions = new Map([
      ["a.ts has no runtime import of b.ts from the shown statement.", false],
      ["a.ts executes b.ts at runtime due to the shown statement.", true],
    ]);
    assert.ok(assertions.has(observation.claim), "Unrecognized type-import proposition");
    const actual = runtimeImports.some(node => node.source.value === "./b");
    return { observedFlag: actual !== assertions.get(observation.claim), method: "Babel TypeScript AST importKind (independent runtime-edge classification)", evidence: { importKinds: imports.map(node => node.importKind), runtimeImport: actual, sextantGraphImports: extractImports(context.files["a.ts"], "a.ts") } };
  }
  if (scenario === "comment-import") {
    const imports = extractImports(context.code, "comment.js");
    const assertions = new Map([
      ["There is no executable import of ./deleted in this code.", false],
      ["This code executes an import of ./deleted.", true],
    ]);
    assert.ok(assertions.has(observation.claim), "Unrecognized comment-import proposition");
    return { observedFlag: imports.some(imp => imp.specifier === "./deleted") !== assertions.get(observation.claim), method: "Actual Sextant AST-first import extraction", evidence: { imports } };
  }
  throw new Error(`No dependency oracle for ${scenario}`);
}

async function testMutation(row) {
  const scenario = row.groupId.split("/")[1];
  const source = row.state.observation.tests;
  async function runVersion(version) {
    const bindings = { assert };
    let setup = "";
    if (scenario === "zero-boundary") {
      bindings.predicate = version === "before" ? n => n > 0 : n => n >= 0;
    } else if (scenario === "real-constructor") {
      // Keep constructor arrays and test literals in the same VM realm so a
      // prototype mismatch cannot masquerade as a killed code mutation.
      setup = version === "before"
        ? "class Store { save(value) { this.queue.push(value); } }"
        : "class Store { constructor() { this.queue = []; } save(value) { this.queue.push(value); } }";
    } else if (scenario === "cancellation") {
      const controller = new AbortController();
      const db = { writes: [] };
      Object.assign(bindings, { db, signal: controller.signal, nonAbortedSignal: new AbortController().signal, abort: () => controller.abort() });
      bindings.run = async signal => {
        await Promise.resolve();
        if (version === "before") db.writes.push(1);
        if (signal.aborted) throw new Error("aborted");
        if (version === "after") db.writes.push(1);
      };
    } else if (scenario === "indirect-integration") {
      bindings.getUser = () => ({ nickname: undefined });
      bindings.request = async () => ({ body: { nickname: version === "before" ? undefined : null } });
    } else {
      throw new Error(`No test mutation oracle for ${scenario}`);
    }
    try {
      await execute(`(async () => { ${setup}\n${source} })()`, bindings);
      return { passed: true };
    } catch (error) {
      // Failure is the measured mutation-test outcome, retained as evidence.
      return { passed: false, error: error.name, message: error.message };
    }
  }
  const before = await runVersion("before");
  const after = await runVersion("after");
  assert.equal(after.passed, true, `${row.id}: supplied test fails even with the specified repaired behavior`);
  return { observedFlag: before.passed === after.passed, method: "Executed supplied test against explicit original and changed fixture behavior", evidence: { before, after } };
}

function crossFile(row) {
  const scenario = row.groupId.split("/")[1];
  const value = row.state.observation;
  if (scenario === "units") {
    const produced = execute(`(() => { ${value.producer} })()`);
    let delay;
    execute(value.consumer, { value: produced, cancel: () => {}, setTimeout: (_, ms) => { delay = ms; } });
    return { observedFlag: delay !== 5000, method: "Executed producer and consumer with captured timer delay", evidence: { produced, observedDelayMs: delay, requiredDelayMs: 5000 } };
  }
  if (scenario === "field-rename") {
    const produced = execute(`(() => { ${value.producer} })()`);
    let recorded;
    execute(value.consumer, { value: produced, record: id => { recorded = id; } });
    return { observedFlag: recorded !== produced.turnId, method: "Executed producer and consumer with captured record value", evidence: { produced, recorded: canonical(recorded) } };
  }
  if (scenario === "closed-enum") {
    const missing = value.producerStates.filter(state => !value.consumerHandledStates.includes(state));
    return { observedFlag: missing.length !== 0, method: "Exhaustive finite-state set difference", evidence: { missing } };
  }
  if (scenario === "timezone") {
    const utcAware = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.producer);
    return { observedFlag: !utcAware, method: "Explicit UTC serialization contract check (no host-local Date parsing)", evidence: { serialized: value.producer, utcAware } };
  }
  throw new Error(`No cross-file oracle for ${scenario}`);
}

async function runOracles(rows = cases) {
  const implementations = new Map([
    ["behavior_change", behavior], ["dependency_edge", dependency],
    ["test_gap", testMutation], ["cross_file_invariant", crossFile],
  ]);
  const verified = [];
  const unexecuted = [];
  for (const row of rows) {
    const oracle = implementations.get(row.family);
    if (!oracle) { unexecuted.push(row.id); continue; }
    const result = await oracle(row);
    verified.push({ id: row.id, family: row.family, expectedFlag: row.expected.flag, ...result, agrees: result.observedFlag === row.expected.flag });
  }
  return { kind: "executable-fixture-label-audit", totalCases: rows.length, verifiedCount: verified.length, unexecutedCount: unexecuted.length, mismatches: verified.filter(row => !row.agrees), verified, unexecuted };
}

function compareIntentBaseline(rows = cases) {
  return rows.filter(row => row.family === "intent").map(row => {
    const decision = shouldRetrieve(row.state.context.user);
    const predictedFlag = row.state.observation.retrieve !== decision.retrieve;
    return { id: row.id, expectedFlag: row.expected.flag, predictedFlag, agrees: predictedFlag === row.expected.flag, retrieve: decision.retrieve, terms: decision.terms, confidence: decision.confidence,
      note: "Classifier baseline comparison, not independent verification of the authored user-intent label. Current classifier receives only current prompt, not priorTask." };
  });
}

if (require.main === module) {
  runOracles().then(report => {
    const intent = compareIntentBaseline();
    console.log(JSON.stringify({ ...report, intentBaseline: intent }, null, 2));
    if (report.mismatches.length) process.exitCode = 1;
  }).catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { runOracles, compareIntentBaseline };
