"use strict";

// End-to-end tests for applyFreshnessGate (lib/cli.js) and buildStaleBody.
//
// The gate is the load-bearing piece: when graph.db state diverges from
// reality (HEAD changed, files modified, version bumped), it must produce
// a body that contains *no* numeric structural claims and a marker line
// matching the actual rescan state.  These tests exercise the full chain
// from a real git repo through the gate output.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const cli = require("../lib/cli");
const freshness = require("../lib/freshness");
const graph = require("../lib/graph");
const telemetry = require("../lib/telemetry");

function gitInit(dir) {
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  execSync("git config commit.gpgsign false", { cwd: dir });
}
function gitCommitFile(dir, name, content) {
  fs.writeFileSync(path.join(dir, name), content);
  execSync(`git add ${name}`, { cwd: dir });
  execSync(`git commit -q -m "x"`, { cwd: dir });
}
function makeRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sextant-gate-${prefix}-`));
  fs.mkdirSync(path.join(dir, ".planning", "intel"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"test"}');
  gitInit(dir);
  gitCommitFile(dir, "seed.js", "module.exports = 1;\n");
  return dir;
}

const FAKE_RAW_SUMMARY = [
  "## Codebase intelligence",
  "",
  "- **Root**: `/tmp/orig`",
  "- **Indexed files**: 73",
  `- **Generated**: ${new Date().toISOString()}`,
  "- **Git**: main @ deadbeef",
  "- **Health**: local import resolution 100% (135/135), index age 0s",
  "",
  "### Module types (top)",
  "- **js**: 73",
  "",
  "### Dependency hotspots (fan-in)",
  "- `lib/cli.js`: 16",
  "- `lib/intel.js`: 16",
  "",
  "### Likely entry points",
  "- `lib/extractors/index.js` (js)",
  "",
].join("\n");

describe("applyFreshnessGate: fresh path passes through rawSummary", () => {
  let dir;
  before(async () => {
    dir = makeRepo("fresh");
    const db = await graph.loadDb(dir);
    freshness.recordScanState(db, dir);
    await graph.persistDb(dir);
  });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("returns the original summary (with elapsed-time refresh) when state matches", async () => {
    const out = await cli.applyFreshnessGate(FAKE_RAW_SUMMARY, dir);
    // Hotspots and entry points must be preserved on the fresh path -- they
    // are the value sextant adds; only the stale path strips them.
    assert.match(out, /Dependency hotspots/);
    assert.match(out, /Likely entry points/);
    assert.match(out, /lib\/cli\.js/);
    // No "Structural claims unavailable" line on fresh.
    assert.doesNotMatch(out, /Structural claims unavailable/);
  });
});

describe("applyFreshnessGate: stale path strips structural fields", () => {
  let dir;
  before(async () => {
    dir = makeRepo("stale");
    const db = await graph.loadDb(dir);
    freshness.recordScanState(db, dir);
    await graph.persistDb(dir);
    // Make HEAD diverge from the recorded state.
    gitCommitFile(dir, "newfile.js", "module.exports = 2;\n");
  });
  after(() => {
    // The gate triggers a background spawn; give it a chance to fail-fast
    // (most CI environments won't have `sextant` on PATH) before we rmSync.
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns a minimal body containing no structural numbers", async () => {
    const out = await cli.applyFreshnessGate(FAKE_RAW_SUMMARY, dir);

    // MUST be present
    assert.match(out, /## Codebase intelligence/);
    assert.match(out, /\*\*Root\*\*/);
    assert.match(out, /Structural claims unavailable this turn/);
    assert.match(out, /reason: head_changed/);
    // Rescan state should be one of the three honest values.
    assert.match(out, /rescan (requested|pending|unavailable)/);

    // MUST be absent: any leak of the old summary's structural claims.
    assert.doesNotMatch(out, /Dependency hotspots/);
    assert.doesNotMatch(out, /Likely entry points/);
    assert.doesNotMatch(out, /Module types/);
    // The specific numeric fact "16 fan-in for cli.js" from FAKE_RAW_SUMMARY
    // must not appear in the stale body.
    assert.doesNotMatch(out, /lib\/cli\.js.*16/);
    assert.doesNotMatch(out, /Indexed files/);
    assert.doesNotMatch(out, /Health/);
  });

  it("records freshness.stale_hit and freshness.blackout_turn telemetry", async () => {
    // The previous test already triggered the gate; events should be on disk.
    const events = telemetry.readEvents(dir);
    const names = events.map((e) => e.name);
    assert.ok(names.includes("freshness.stale_hit"));
    assert.ok(names.includes("freshness.blackout_turn"));

    const staleHit = events.find((e) => e.name === "freshness.stale_hit");
    assert.equal(staleHit.reason, "head_changed");
    assert.ok(["requested", "pending", "skipped"].includes(staleHit.rescanState));
  });
});

describe("buildStaleBody invariants (direct unit test)", () => {
  let dir;
  before(() => {
    dir = makeRepo("buildbody");
  });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("includes only safe (graph-free) fields and the marker line", () => {
    const out = cli.buildStaleBody(
      dir,
      { fresh: false, reason: "schema_version_changed", evidence: {} },
      { state: "requested", pid: 1234 }
    );
    assert.match(out, /## Codebase intelligence/);
    assert.match(out, /\*\*Root\*\*/);
    assert.match(out, /\*\*Git\*\*/); // we set up a real git repo above
    assert.match(out, /rescan requested/);
    assert.match(out, /reason: schema_version_changed/);
    assert.match(out, /### Signals/);
    assert.match(out, /Node: package.json/);

    // Stale body MUST NOT carry any of these structural fields.
    for (const forbidden of [
      /Dependency hotspots/,
      /Likely entry points/,
      /Module types/,
      /Indexed files/,
      /Health.*resolution/,
      /fan-in/i,
    ]) {
      assert.doesNotMatch(out, forbidden, `stale body must not contain ${forbidden}`);
    }
  });

  it("uses 'rescan pending' when single-flight is already in flight", () => {
    const out = cli.buildStaleBody(
      dir,
      { fresh: false, reason: "head_changed", evidence: {} },
      { state: "pending", since: Date.now() - 1000 }
    );
    assert.match(out, /rescan pending/);
    assert.doesNotMatch(out, /rescan requested/);
  });

  it("uses 'rescan unavailable' when enqueue was skipped (e.g. spawn failure)", () => {
    const out = cli.buildStaleBody(
      dir,
      { fresh: false, reason: "head_changed", evidence: {} },
      { state: "skipped", reason: "spawn_failed" }
    );
    assert.match(out, /rescan unavailable/);
  });
});
