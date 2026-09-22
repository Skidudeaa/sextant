"use strict";

// Test-only preload: replaces globalThis.fetch with a deterministic TypeSafe
// System One responder so hook processes can be exercised end-to-end WITHOUT a
// network or credential. Load with
//   NODE_OPTIONS="--require /abs/path/test/helpers/jev-mock-fetch.js"
// Configure through env:
//   SEXTANT_JEV_MOCK      JSON. Keys:
//     noul:   number | { "<questionId>": number, "*": number }
//     choice: string | { "<questionId>": "<optionKey>", "*": "<optionKey>" }
//     choiceByPath: { "<questionId>": "<candidate path>" } — picks the option
//             whose criteria value carries that path (rerank best_file style)
//     score:  number | { "<questionId>": number }
//     model:  string (default "jev-1.13.0")
//     fail:   "http" | "throw" | "hang" | "invalid"
//   SEXTANT_JEV_MOCK_LOG  path; every systemone request body is appended as one
//                         JSON line so tests can assert wire content.
// Production code never references this file.

const fs = require("fs");

function cfg() {
  try { return JSON.parse(process.env.SEXTANT_JEV_MOCK || "{}"); } catch { return {}; }
}

function pick(table, qid, fallback) {
  if (table == null) return fallback;
  if (typeof table !== "object") return table;
  if (Object.hasOwn(table, qid)) return table[qid];
  if (Object.hasOwn(table, "*")) return table["*"];
  return fallback;
}

function distribute(keys, selected, weight) {
  const rest = keys.length > 1 ? (1 - weight) / (keys.length - 1) : 0;
  const out = {};
  for (const k of keys) out[k] = k === selected ? (keys.length > 1 ? weight : 1) : rest;
  return out;
}

function answerFor(qid, q, c) {
  if (q.type === "noul") return { type: "noul", noul: Number(pick(c.noul, qid, 0.5)) };
  if (q.type === "choice") {
    const keys = Object.keys(q.criteria);
    let selected = pick(c.choice, qid, null);
    const byPath = c.choiceByPath && c.choiceByPath[qid];
    if (byPath) {
      selected = keys.find((k) => JSON.stringify(q.criteria[k] || "").includes(byPath)) || selected;
    }
    if (!selected || !keys.includes(selected)) selected = keys[0];
    return { type: "choice", choice: selected, probabilities: distribute(keys, selected, 0.8), confidence: 0.8 };
  }
  if (q.type === "score") {
    const keys = q.criteria.map((_, i) => String(i));
    const level = String(pick(c.score, qid, 0));
    const probabilities = distribute(keys, level, 0.8);
    const score = keys.reduce((s, k) => s + Number(k) * probabilities[k], 0);
    return { type: "score", score, probabilities, confidence: 0.8, legend: Object.fromEntries(keys.map((k) => [k, q.criteria[Number(k)]])) };
  }
  return { type: q.type };
}

globalThis.fetch = async function mockFetch(url, init) {
  const c = cfg();
  if (process.env.SEXTANT_JEV_MOCK_LOG) {
    try { fs.appendFileSync(process.env.SEXTANT_JEV_MOCK_LOG, JSON.stringify({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null }) + "\n"); } catch {}
  }
  if (c.fail === "throw") throw new Error("mock connection failure");
  if (c.fail === "hang") return new Promise(() => {});
  if (c.fail === "http") return { ok: false, status: 503, body: { cancel: async () => {} }, json: async () => ({ error: "mock" }) };
  if (String(url).endsWith("/v1/models")) {
    return { ok: true, status: 200, body: { cancel: async () => {} }, json: async () => ({ models: [{ name: c.model || "jev-1.13.0", description: "mock", release_date: "2026-01-01" }] }) };
  }
  const req = JSON.parse(init.body);
  const answers = {};
  for (const [qid, q] of Object.entries(req.questions)) answers[qid] = answerFor(qid, q, c);
  if (c.fail === "invalid") delete answers[Object.keys(answers)[0]];
  const body = {
    model: c.model || "jev-1.13.0",
    usage: { input_tokens: Math.max(1, Math.floor(Buffer.byteLength(init.body) / 4)), output_tokens: Object.keys(answers).length },
    answers,
  };
  return { ok: true, status: 200, body: { cancel: async () => {} }, json: async () => body };
};
