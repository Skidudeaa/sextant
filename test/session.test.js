"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { deriveSessionKey } = require("../lib/session");

describe("deriveSessionKey", () => {
  // Save original env values to restore after tests
  const savedEnv = {};

  before(() => {
    savedEnv.CURSOR_SESSION_ID = process.env.CURSOR_SESSION_ID;
    savedEnv.TMUX_PANE = process.env.TMUX_PANE;
    savedEnv.SSH_TTY = process.env.SSH_TTY;
    // Clear env vars so they don't interfere with fallback tests
    delete process.env.CURSOR_SESSION_ID;
    delete process.env.TMUX_PANE;
    delete process.env.SSH_TTY;
  });

  after(() => {
    // Restore env
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("uses session_id when present", () => {
    const key = deriveSessionKey({ session_id: "abc-123" });
    assert.equal(key, "abc-123");
  });

  it("falls back to conversation_id", () => {
    const key = deriveSessionKey({ conversation_id: "conv-456" });
    assert.equal(key, "conv-456");
  });

  it("falls back to run_id", () => {
    const key = deriveSessionKey({ run_id: "run-789" });
    assert.equal(key, "run-789");
  });

  it("falls back to terminal_id", () => {
    const key = deriveSessionKey({ terminal_id: "term-001" });
    assert.equal(key, "term-001");
  });

  it("falls back to CURSOR_SESSION_ID env var", () => {
    process.env.CURSOR_SESSION_ID = "cursor-env-id";
    const key = deriveSessionKey({});
    assert.equal(key, "cursor-env-id");
    delete process.env.CURSOR_SESSION_ID;
  });

  it("falls back to TMUX_PANE env var", () => {
    process.env.TMUX_PANE = "%3";
    const key = deriveSessionKey({});
    assert.equal(key, "_3");
    delete process.env.TMUX_PANE;
  });

  it("falls back to pid when no other sources", () => {
    const key = deriveSessionKey({});
    // Should be a stringified pid
    assert.ok(key.length > 0);
    assert.match(key, /^[\w._-]+$/);
  });

  it("sanitizes non-alphanumeric to underscore", () => {
    const key = deriveSessionKey({ session_id: "abc/def:ghi@jkl" });
    assert.equal(key, "abc_def_ghi_jkl");
  });

  it("truncates to 80 chars", () => {
    const longId = "a".repeat(100);
    const key = deriveSessionKey({ session_id: longId });
    assert.equal(key.length, 80);
  });

  it("handles null data gracefully", () => {
    // When data is null, all data?.X are undefined, falls through to env/pid
    const key = deriveSessionKey(null);
    assert.ok(key.length > 0);
    assert.match(key, /^[\w._-]+$/);
  });

  it("handles undefined data gracefully", () => {
    const key = deriveSessionKey(undefined);
    assert.ok(key.length > 0);
    assert.match(key, /^[\w._-]+$/);
  });

  it("priority: session_id > conversation_id > run_id", () => {
    const key = deriveSessionKey({
      session_id: "sess",
      conversation_id: "conv",
      run_id: "run",
    });
    assert.equal(key, "sess");
  });

  it("preserves dots and dashes", () => {
    const key = deriveSessionKey({ session_id: "abc.def-ghi_123" });
    assert.equal(key, "abc.def-ghi_123");
  });
});
