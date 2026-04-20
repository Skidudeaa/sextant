"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  stripUnsafeXmlTags,
  getWatcherStatus,
  rootsFromArgs,
  refreshSummaryAge,
} = require("../lib/cli");

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

// ---------------------------------------------------------------------------
// refreshSummaryAge
// ---------------------------------------------------------------------------

describe("refreshSummaryAge", () => {
  function buildSummary({ generatedAt, age = "10s", withAlert = false, withHealthFail = false }) {
    const parts = [];
    if (withHealthFail) {
      parts.push("ALERT: CODEBASE INTEL HEALTH FAIL -- local import resolution 54% (12/22)");
      parts.push("");
    }
    if (withAlert) {
      parts.push("ALERT: INDEX STALE -- last update 48.0h ago (watcher dead?)");
      parts.push("");
    }
    parts.push("## Codebase intelligence");
    parts.push("");
    parts.push("- **Root**: `/tmp/x`");
    parts.push("- **Indexed files**: 69");
    parts.push(`- **Generated**: ${generatedAt}`);
    parts.push("- **Git**: main @ abc123");
    parts.push(`- **Health**: local import resolution 97% (123/127), index age ${age}`);
    return parts.join("\n");
  }

  it("returns empty input unchanged", () => {
    assert.equal(refreshSummaryAge(""), "");
    assert.equal(refreshSummaryAge(null), null);
    assert.equal(refreshSummaryAge(undefined), undefined);
  });

  it("returns input unchanged when no Generated line present", () => {
    const input = "## Codebase intelligence\n- **Root**: `/tmp/x`\n- **Health**: index age 10s";
    assert.equal(refreshSummaryAge(input), input);
  });

  it("returns input unchanged when Generated timestamp is malformed", () => {
    const input = buildSummary({ generatedAt: "not-a-date" });
    assert.equal(refreshSummaryAge(input), input);
  });

  it("rewrites index age against the Generated timestamp for fresh summary", () => {
    const generated = new Date(Date.now() - 30_000).toISOString();
    const input = buildSummary({ generatedAt: generated, age: "0s" });
    const out = refreshSummaryAge(input);
    const m = out.match(/index age (\d+)s/);
    assert.ok(m, "expected an age match, got: " + out);
    const newAge = parseInt(m[1], 10);
    assert.ok(newAge >= 29 && newAge <= 32, "expected age near 30s, got " + newAge);
  });

  it("clamps negative ages (clock skew) to 0s", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const input = buildSummary({ generatedAt: future, age: "10s" });
    const out = refreshSummaryAge(input);
    assert.match(out, /index age 0s/);
  });

  it("inserts a stale ALERT when newly-computed age exceeds 24h and none is present", () => {
    // WHY: refresh must not silently drop the ALERT summary.js would have
    // written at generation time for stale data.
    const generated = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const input = buildSummary({ generatedAt: generated, age: "10s" });
    const out = refreshSummaryAge(input);
    assert.match(out, /^ALERT: INDEX STALE -- last update 48\.0h ago \(watcher dead\?\)$/m);
    // Must remain above the `## Codebase intelligence` block
    const alertIdx = out.indexOf("ALERT: INDEX STALE");
    const headerIdx = out.indexOf("## Codebase intelligence");
    assert.ok(alertIdx !== -1 && headerIdx !== -1 && alertIdx < headerIdx);
  });

  it("does not duplicate an existing stale ALERT", () => {
    const generated = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const input = buildSummary({ generatedAt: generated, age: "10s", withAlert: true });
    const out = refreshSummaryAge(input);
    const alertCount = (out.match(/^ALERT: INDEX STALE/gm) || []).length;
    assert.equal(alertCount, 1);
  });

  it("places stale ALERT below an existing HEALTH FAIL ALERT, above the header", () => {
    const generated = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const input = buildSummary({ generatedAt: generated, age: "10s", withHealthFail: true });
    const out = refreshSummaryAge(input);
    const healthIdx = out.indexOf("CODEBASE INTEL HEALTH FAIL");
    const staleIdx = out.indexOf("ALERT: INDEX STALE");
    const headerIdx = out.indexOf("## Codebase intelligence");
    assert.ok(healthIdx >= 0 && staleIdx >= 0 && headerIdx >= 0);
    assert.ok(healthIdx < staleIdx, "HEALTH FAIL should come first");
    assert.ok(staleIdx < headerIdx, "stale ALERT should come before header");
  });

  it("does not insert a stale ALERT when age is under 24h", () => {
    const generated = new Date(Date.now() - 60_000).toISOString();
    const input = buildSummary({ generatedAt: generated, age: "10s" });
    const out = refreshSummaryAge(input);
    assert.doesNotMatch(out, /ALERT: INDEX STALE/);
  });
});
