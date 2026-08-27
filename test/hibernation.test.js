"use strict";

const { afterEach, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { isHibernating, markerPath } = require("../lib/hibernation");

const created = [];

afterEach(() => {
  while (created.length) fs.rmSync(created.pop(), { recursive: true, force: true });
  delete process.env.SEXTANT_HIBERNATION_MARKER;
});

function marker() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-hibernation-"));
  created.push(dir);
  const file = path.join(dir, "hibernating");
  fs.writeFileSync(file, "test\n");
  return file;
}

describe("hibernation gate", () => {
  it("uses an explicit marker override", () => {
    const file = marker();
    const env = { SEXTANT_HIBERNATION_MARKER: file };
    assert.equal(markerPath(env), file);
    assert.equal(isHibernating(env), true);
    fs.unlinkSync(file);
    assert.equal(isHibernating(env), false);
  });

  it("makes hook entry points silent before they create repo state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-hibernating-root-"));
    created.push(root);
    fs.mkdirSync(path.join(root, ".git"));
    const result = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "intel.js"), "hook", "sessionstart"], {
      cwd: root,
      env: { ...process.env, SEXTANT_HIBERNATION_MARKER: marker() },
      input: JSON.stringify({ source: "startup" }),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(fs.existsSync(path.join(root, ".planning")), false);
  });

  it("keeps MCP healthy while exposing no dormant tools", async () => {
    process.env.SEXTANT_HIBERNATION_MARKER = marker();
    const { dispatch } = require("../mcp/server");
    const initialized = await dispatch("initialize", { clientInfo: { name: "test" } });
    assert.equal(initialized.serverInfo.name, "sextant");
    assert.deepEqual(await dispatch("tools/list", {}), { tools: [] });
    const call = await dispatch("tools/call", { name: "sextant_health", arguments: {} });
    assert.equal(call.isError, true);
    assert.match(call.content[0].text, /hibernating/i);
  });
});
