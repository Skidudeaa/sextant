"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { stripUnsafeXmlTags, getWatcherStatus, rootsFromArgs } = require("../lib/cli");

// ---------------------------------------------------------------------------
// stripUnsafeXmlTags
// ---------------------------------------------------------------------------

describe("stripUnsafeXmlTags", () => {
  it("strips codebase-intelligence open and close tags", () => {
    const input = "<codebase-intelligence>content</codebase-intelligence>";
    assert.equal(stripUnsafeXmlTags(input), "content");
  });

  it("strips codebase-retrieval open and close tags", () => {
    const input = "before<codebase-retrieval>middle</codebase-retrieval>after";
    assert.equal(stripUnsafeXmlTags(input), "beforemiddleafter");
  });

  it("strips system-reminder open and close tags", () => {
    const input = "<system-reminder>injected</system-reminder>";
    assert.equal(stripUnsafeXmlTags(input), "injected");
  });

  it("strips tool_call open and close tags", () => {
    const input = "a<tool_call>b</tool_call>c";
    assert.equal(stripUnsafeXmlTags(input), "abc");
  });

  it("strips antml-namespaced tags", () => {
    // The regex targets <*> tags — build the strings via concat
    // to avoid any markup interpretation by tooling.
    const open = "<" + "antml:invoke name=\"foo\">";
    const close = "</" + "antml:invoke>";
    const input = open + "body" + close;
    assert.equal(stripUnsafeXmlTags(input), "body");
  });

  it("does NOT strip safe HTML like br, em, div", () => {
    const input = "<br><em>bold</em><div>block</div>";
    assert.equal(stripUnsafeXmlTags(input), input);
  });
});

// ---------------------------------------------------------------------------
// getWatcherStatus
// ---------------------------------------------------------------------------

describe("getWatcherStatus", () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-cli-watcher-"));
    fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns { running: false } when no heartbeat file exists", () => {
    const status = getWatcherStatus(tmpDir);
    assert.equal(status.running, false);
  });

  it("returns { running: true } with ageSec close to 0 for a fresh heartbeat", () => {
    const hbPath = path.join(tmpDir, ".planning", "intel", ".watcher_heartbeat");
    fs.writeFileSync(hbPath, "");
    const status = getWatcherStatus(tmpDir);
    assert.equal(status.running, true);
    assert.ok(status.ageSec < 5, "ageSec should be close to 0, got " + status.ageSec);
  });

  it("returns { running: false } for a stale heartbeat (>90s old)", () => {
    const hbPath = path.join(tmpDir, ".planning", "intel", ".watcher_heartbeat");
    fs.writeFileSync(hbPath, "");
    const past = new Date(Date.now() - 120000);
    fs.utimesSync(hbPath, past, past);
    const status = getWatcherStatus(tmpDir);
    assert.equal(status.running, false);
    assert.ok(status.ageSec >= 90, "ageSec should be >= 90, got " + status.ageSec);
  });

  it("returns { running: false } for a nonexistent root directory", () => {
    const status = getWatcherStatus("/tmp/sextant-does-not-exist-" + Date.now());
    assert.equal(status.running, false);
  });
});

// ---------------------------------------------------------------------------
// rootsFromArgs
// ---------------------------------------------------------------------------

describe("rootsFromArgs", () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-cli-roots-"));
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses --root flag into a single-element array", () => {
    const result = rootsFromArgs(["node", "sextant", "--root", "/some/path"]);
    assert.deepEqual(result, ["/some/path"]);
  });

  it("parses --roots flag into comma-separated array", () => {
    const result = rootsFromArgs(["node", "sextant", "--roots", "/a,/b,/c"]);
    assert.deepEqual(result, ["/a", "/b", "/c"]);
  });

  it("falls back to process.cwd() when no flags given", () => {
    const result = rootsFromArgs(["node", "sextant"]);
    assert.deepEqual(result, [process.cwd()]);
  });

  it("reads paths from --roots-file", () => {
    const filePath = path.join(tmpDir, "roots.txt");
    fs.writeFileSync(filePath, "/alpha\n/beta\n# comment\n/gamma\n");
    const result = rootsFromArgs(["node", "sextant", "--roots-file", filePath]);
    assert.equal(result.length, 3);
    assert.deepEqual(result, [
      path.resolve("/alpha"),
      path.resolve("/beta"),
      path.resolve("/gamma"),
    ]);
  });
});
