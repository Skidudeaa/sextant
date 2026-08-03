"use strict";

// Tests for the mcp.invoked aggregation in commands/telemetry.js:summarize()
// (SEXTANT-USAGE-REPORT-2026-07-28 follow-up: "I never called a single sextant
// MCP tool" — mcp/server.js has RECORDED mcp.invoked since docs/035 #3, but
// nothing aggregated it, so the reach question was unanswerable from the audit
// surface). Mutation-checked: removing the aggregation, dropping the error
// split, or treating "(tools/list)" as a tool call each fails a case.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { summarize } = require("../commands/telemetry");

describe("telemetry summarize: MCP tool surface", () => {
  it("aggregates per-tool calls with ok/error split and the tools/list denominator", () => {
    const s = summarize([
      { name: "mcp.invoked", tool: "(tools/list)", count: 9, ts: 1 },
      { name: "mcp.invoked", tool: "(tools/list)", count: 9, ts: 2 },
      { name: "mcp.invoked", tool: "sextant_search", ok: true, durationMs: 42, ts: 3 },
      { name: "mcp.invoked", tool: "sextant_search", ok: true, durationMs: 51, ts: 4 },
      { name: "mcp.invoked", tool: "sextant_explain", ok: false, reason: "handler_error", ts: 5 },
    ]);
    assert.equal(s.mcp.toolsList, 2);
    assert.equal(s.mcp.toolDefs, 9);
    assert.equal(s.mcp.totalCalls, 3);
    assert.equal(s.mcp.callsPerList, 1.5);
    assert.deepEqual(s.mcp.byTool.sextant_search, { calls: 2, ok: 2, errors: 0 });
    assert.deepEqual(s.mcp.byTool.sextant_explain, { calls: 1, ok: 0, errors: 1 });
    // The denominator must NOT appear as a callable tool.
    assert.equal(s.mcp.byTool["(tools/list)"], undefined);
  });

  it("reports the usage-report condition: definitions loaded, zero calls", () => {
    const s = summarize([
      { name: "mcp.invoked", tool: "(tools/list)", count: 9, ts: 1 },
    ]);
    assert.equal(s.mcp.toolsList, 1);
    assert.equal(s.mcp.totalCalls, 0);
    assert.equal(s.mcp.callsPerList, 0);
    assert.deepEqual(s.mcp.byTool, {});
  });

  it("unknown-tool dispatches count as calls with their error", () => {
    const s = summarize([
      { name: "mcp.invoked", tool: "sextant_nope", ok: false, reason: "unknown_tool", ts: 1 },
    ]);
    assert.equal(s.mcp.totalCalls, 1);
    assert.deepEqual(s.mcp.byTool.sextant_nope, { calls: 1, ok: 0, errors: 1 });
  });

  it("is absent-shaped (zeros) when no mcp.invoked events exist", () => {
    const s = summarize([{ name: "freshness.fresh_hit", ts: 1 }]);
    assert.equal(s.mcp.toolsList, 0);
    assert.equal(s.mcp.totalCalls, 0);
    assert.equal(s.mcp.callsPerList, null);
  });

  it("splits reach AND rent per client; unstamped rows go to (unattributed), never a named client", () => {
    const s = summarize([
      // codex: 1 load, 2 calls
      { name: "mcp.invoked", tool: "(tools/list)", count: 9, client: "codex", ts: 1 },
      { name: "mcp.invoked", tool: "sextant_search", ok: true, client: "codex", ts: 2 },
      { name: "mcp.invoked", tool: "sextant_search", ok: true, client: "codex", ts: 3 },
      // kimi: rent-only — 2 loads, ZERO calls (the finding this split exists for)
      { name: "mcp.invoked", tool: "(tools/list)", count: 9, client: "kimi", ts: 4 },
      { name: "mcp.invoked", tool: "(tools/list)", count: 9, client: "kimi", ts: 5 },
      // pre-stamp history: no client field
      { name: "mcp.invoked", tool: "sextant_health", ok: true, ts: 6 },
    ]);
    assert.deepEqual(s.mcp.byClient.codex, {
      toolsList: 1,
      calls: 2,
      callsPerList: 2,
      byTool: { sextant_search: 2 },
    });
    // Rent-only client is VISIBLE with its loads and a hard zero ratio.
    assert.deepEqual(s.mcp.byClient.kimi, {
      toolsList: 2,
      calls: 0,
      callsPerList: 0,
      byTool: {},
    });
    assert.deepEqual(s.mcp.byClient["(unattributed)"], {
      toolsList: 0,
      calls: 1,
      callsPerList: null,
      byTool: { sextant_health: 1 },
    });
    // No named client absorbed the unstamped row.
    assert.equal(s.mcp.byClient.codex.byTool.sextant_health, undefined);
    // The denominator must NOT appear as a callable tool inside any client either.
    assert.equal(s.mcp.byClient.codex.byTool["(tools/list)"], undefined);
    // Cross-check: per-client calls sum to the aggregate.
    const clientCalls = Object.values(s.mcp.byClient).reduce((n, c) => n + c.calls, 0);
    assert.equal(clientCalls, s.mcp.totalCalls);
  });
});
