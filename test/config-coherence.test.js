"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { loadRepoConfig } = require("../lib/config");

function withConfig(value, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sx-config-coherence-"));
  try {
    if (value !== undefined) {
      fs.writeFileSync(
        path.join(root, ".codebase-intel.json"),
        JSON.stringify({ coherenceHoldbackPct: value })
      );
    }
    fn(loadRepoConfig(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("Phase-F holdback config", () => {
  it("is default-off and accepts only the pre-registered balanced split", () => {
    withConfig(undefined, (config) => assert.equal(config.coherenceHoldbackPct, 0));
    withConfig(50, (config) => assert.equal(config.coherenceHoldbackPct, 50));
    for (const value of [1, 49, 51, 100, "bad", null]) {
      withConfig(value, (config) => assert.equal(
        config.coherenceHoldbackPct,
        0,
        `value ${String(value)} must not silently change the experiment design`
      ));
    }
  });
});
