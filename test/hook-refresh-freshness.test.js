"use strict";

// T1.2 — Measurable proof that the hook RETRIEVAL lane is freshness-gated.
//
// After a checkout/edit the hook must stop asserting graph structure that may
// point at moved/deleted files.  The gate keys on CONTENT change (HEAD /
// git-status), NOT on version bumps — a routine scanner/schema version change
// means the CODE moved on, not the files, so suppressing on it would re-create
// the cried-wolf alarm the freshness redesign deliberately deleted
// ("freshness != age").
//
// DETERMINISM (no cold-zoekt / network dependence):
//   - Each fixture is a REAL git repo (git init + one commit) so checkFreshness
//     can compare a stored HEAD/status against the live repo.
//   - graph.db is prebuilt on disk with a distinctive exported symbol; we set
//     the meta scan-state by hand so we control fresh / content-stale / version-
//     stale precisely.
//   - We deliberately do NOT build a zoekt index (no daemon.json) → searchFast
//     returns empty → the merged set is GRAPH-ONLY.  That is exactly the regime
//     where structural suppression and the existsSync-drop are observable.
//   - The gate's stale path calls enqueueRescan, which spawns `sextant` via
//     PATH; a no-op shim on PATH makes that resolve and exit 0 deterministically
//     (mirrors freshness-gate.test.js).

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync, execSync } = require("child_process");

const graph = require("../lib/graph");
const freshness = require("../lib/freshness");
const telemetry = require("../lib/telemetry");

const BIN = path.resolve(__dirname, "..", "bin", "intel.js");

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

// A no-op `sextant` on PATH so the gate's background enqueueRescan spawn
// resolves and exits 0 instead of ENOENT-ing asynchronously after the test
// returns (which node:test would report as an unhandled failure).
function installSextantShim() {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-shim-t12-"));
  fs.writeFileSync(path.join(shimDir, "sextant"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(shimDir, "sextant"), 0o755);
  const prevPath = process.env.PATH;
  process.env.PATH = shimDir + path.delimiter + prevPath;
  return () => {
    process.env.PATH = prevPath;
    try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch {}
  };
}

// Build a fixture git repo with:
//   - a committed source file `lib/resolveImportPath.js` exporting an
//     identifier-shaped symbol (so the classifier fires retrieve:true AND the
//     graph lane returns a hit on its own),
//   - graph.db prebuilt with that export.
// Leaves the scan-state UNSET — the caller stamps it via setScanState() so each
// test controls fresh / content-stale / version-stale.
async function buildFixture(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sextant-hook-fresh-${prefix}-`));
  fs.mkdirSync(path.join(dir, ".planning", "intel"), { recursive: true });
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  gitInit(dir);
  // Real on-disk source so existsSync sees it; content is irrelevant to the
  // graph-only path (no zoekt index).
  gitCommitFile(
    dir,
    "lib/resolveImportPath.js",
    "function resolveImportPath(spec) { return spec; }\nmodule.exports = { resolveImportPath };\n"
  );

  const db = await graph.loadDb(dir);
  graph.upsertFile(db, { relPath: "lib/resolveImportPath.js", type: "js", sizeBytes: 500, mtimeMs: 1 });
  graph.replaceExports(db, "lib/resolveImportPath.js", [
    { name: "resolveImportPath", kind: "named" },
  ]);
  await graph.persistDb(dir);

  return dir;
}

// Stamp the graph.db meta scan-state.  `mode`:
//   - "fresh"        : record the CURRENT head + status → checkFreshness fresh.
//   - "version"      : record current state, then overwrite scanner_version with
//                      a bogus value → checkFreshness scanner_version_changed.
// (Content-stale is produced by recording fresh, then committing AFTER — the
//  caller does that with an extra gitCommitFile so HEAD diverges.)
async function setScanState(dir, mode) {
  const db = await graph.loadDb(dir);
  freshness.recordScanState(db, dir);
  if (mode === "version") {
    graph.setMetaValue(db, freshness.META_SCANNER_VERSION, "BOGUS-OLD-VERSION");
  }
  await graph.persistDb(dir);
}

// Run the hook with a prompt; return stdout + the recorded retrieval.* events.
function runHook(dir, prompt) {
  const res = spawnSync(process.execPath, [BIN, "hook", "refresh"], {
    cwd: dir,
    input: JSON.stringify({ prompt, session_id: "t12-test" }),
    encoding: "utf8",
    timeout: 20000,
  });
  return {
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    status: res.status,
    events: telemetry
      .readEvents(dir)
      .filter((e) => String(e.name || "").startsWith("retrieval.")),
  };
}

const MARKER_RE = /index stale: repo changed since last scan/;

// ─── (i) STALE marker: content-stale shows it, fresh does not ──────────────

describe("hook-refresh freshness (T1.2) — content-stale STALE marker", () => {
  let dir, restoreShim;
  before(async () => {
    restoreShim = installSextantShim();
    dir = await buildFixture("marker");
    await setScanState(dir, "fresh");
    // Diverge HEAD AFTER recording state → checkFreshness returns head_changed
    // → content-stale.
    gitCommitFile(dir, "unrelated.js", "module.exports = 2;\n");
  });
  after(() => {
    if (restoreShim) restoreShim();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("injects a <codebase-retrieval> block CONTAINING the stale marker", () => {
    const { stdout } = runHook(dir, "where is resolveImportPath defined");
    assert.ok(
      stdout.includes("<codebase-retrieval>"),
      `expected a <codebase-retrieval> block, got:\n${stdout}`
    );
    assert.match(stdout, MARKER_RE,
      `content-stale turn must prepend the stale marker, got:\n${stdout}`);
  });

  it("records retrieval.stale_hit{reason:head_changed} on the content-stale turn", () => {
    const events = telemetry.readEvents(dir).filter((e) => e.name === "retrieval.stale_hit");
    assert.ok(events.length >= 1, "expected a retrieval.stale_hit event");
    assert.equal(events[0].reason, "head_changed");
  });
});

describe("hook-refresh freshness (T1.2) — fresh turn omits the marker (no-op)", () => {
  let dir;
  before(async () => {
    dir = await buildFixture("fresh");
    await setScanState(dir, "fresh"); // HEAD/status recorded == current, no later commit
  });
  after(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("injects the block WITHOUT the stale marker and emits NO retrieval.stale_hit", () => {
    const { stdout, events } = runHook(dir, "where is resolveImportPath defined");
    assert.ok(
      stdout.includes("<codebase-retrieval>"),
      `expected a <codebase-retrieval> block, got:\n${stdout}`
    );
    assert.doesNotMatch(stdout, MARKER_RE,
      `fresh turn must NOT carry the stale marker, got:\n${stdout}`);
    assert.equal(
      events.find((e) => e.name === "retrieval.stale_hit"),
      undefined,
      "fresh turn must not record a retrieval.stale_hit"
    );
  });
});

// ─── (ii) existsSync-drop: a graph-only phantom is absent when content-stale ─

describe("hook-refresh freshness (T1.2) — existsSync-drop of a graph-only phantom", () => {
  let dir, restoreShim;
  before(async () => {
    restoreShim = installSextantShim();
    dir = await buildFixture("phantom");
    // Add a graph entry for a file that EXPORTS the queried symbol but does NOT
    // exist on disk — the post-checkout phantom the gate must drop.  Same
    // symbol so the graph lane surfaces it for the query "resolveImportPath".
    const db = await graph.loadDb(dir);
    graph.upsertFile(db, { relPath: "lib/deleted_ghost.js", type: "js", sizeBytes: 100, mtimeMs: 1 });
    graph.replaceExports(db, "lib/deleted_ghost.js", [
      { name: "resolveImportPath", kind: "named" },
    ]);
    await graph.persistDb(dir);
    await setScanState(dir, "fresh");
    // Diverge HEAD → content-stale, so the phantom-drop path runs.
    gitCommitFile(dir, "unrelated.js", "module.exports = 3;\n");
    // Sanity: the ghost file genuinely does not exist on disk.
    assert.equal(fs.existsSync(path.join(dir, "lib/deleted_ghost.js")), false);
    // ...while the real exporter does.
    assert.equal(fs.existsSync(path.join(dir, "lib/resolveImportPath.js")), true);
  });
  after(() => {
    if (restoreShim) restoreShim();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("absent from the content-stale block: the on-disk file stays, the ghost is dropped", () => {
    const { stdout } = runHook(dir, "where is resolveImportPath defined");
    assert.ok(stdout.includes("<codebase-retrieval>"), `expected a block, got:\n${stdout}`);
    assert.match(stdout, MARKER_RE, "expected the content-stale marker");
    assert.ok(
      stdout.includes("lib/resolveImportPath.js"),
      `the still-present exporter must remain, got:\n${stdout}`
    );
    assert.ok(
      !stdout.includes("lib/deleted_ghost.js"),
      `the graph-only phantom (no zoekt hit, gone on disk) must be dropped, got:\n${stdout}`
    );
  });
});

// ─── (iii) version-stale does NOT suppress (the cried-wolf guard) ───────────

describe("hook-refresh freshness (T1.2) — version-stale does NOT suppress", () => {
  let dir, restoreShim;
  before(async () => {
    restoreShim = installSextantShim();
    dir = await buildFixture("version");
    // HEAD/status match current; only scanner_version is mismatched →
    // checkFreshness returns scanner_version_changed (stale, but NOT content).
    await setScanState(dir, "version");
  });
  after(() => {
    if (restoreShim) restoreShim();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  // One hook invocation, several asserts: a second run with the same
  // prompt+session would dedupe to empty stdout (the per-session
  // .last_injected_hash.retrieval cache), so we must not split this across
  // multiple `it`s sharing the fixture.
  it("records stale_hit{scanner_version_changed} but does NOT suppress (no marker, boosts intact)", () => {
    const { stdout, events } = runHook(dir, "where is resolveImportPath defined");
    assert.ok(stdout.includes("<codebase-retrieval>"), `expected a block, got:\n${stdout}`);

    // The stale lane still records (so the rescan fires) ...
    const staleHit = events.find((e) => e.name === "retrieval.stale_hit");
    assert.ok(staleHit, "version-stale must still record a retrieval.stale_hit");
    assert.equal(staleHit.reason, "scanner_version_changed");

    // ... but the SUPPRESSIVE path must NOT engage: no marker line.
    assert.doesNotMatch(stdout, MARKER_RE,
      `version-only stale must NOT prepend the marker (cried-wolf guard), got:\n${stdout}`);

    // Structural authority is intact: merge ran with stale:false, so the
    // exported_symbol def keeps its DEF_SCORE_FLOOR and the on-disk exporter is
    // present with its graph export provenance.
    assert.ok(
      stdout.includes("lib/resolveImportPath.js"),
      `the canonical exporter must be present (boosts intact), got:\n${stdout}`
    );
    assert.match(stdout, /exports resolveImportPath|export match/,
      `graph export provenance must be retained on version-stale, got:\n${stdout}`);
  });
});

// ─── telemetry aggregation: retrieval.stale_hit ────────────────────────────

describe("telemetry summarize — retrieval stale aggregation (T1.2)", () => {
  const { summarize } = require("../commands/telemetry");

  it("counts retrieval.stale_hit, computes the retrieval stale rate, and splits reasons", () => {
    const events = [
      { ts: 1, name: "retrieval.classified", retrieve: true, confidence: 1, termCount: 2 },
      { ts: 2, name: "retrieval.classified", retrieve: true, confidence: 1, termCount: 2 },
      { ts: 3, name: "retrieval.classified", retrieve: true, confidence: 1, termCount: 2 },
      { ts: 4, name: "retrieval.classified", retrieve: true, confidence: 1, termCount: 2 },
      { ts: 5, name: "retrieval.stale_hit", reason: "head_changed" },
      { ts: 6, name: "retrieval.stale_hit", reason: "status_changed" },
      { ts: 7, name: "retrieval.stale_hit", reason: "scanner_version_changed" },
    ];
    const r = summarize(events).retrieval;
    assert.equal(r.classifiedRetrieve, 4);
    assert.equal(r.staleHits, 3);
    // stale rate = 3 stale_hit / 4 retrieve-classified
    assert.equal(r.staleRate, 0.75);
    assert.equal(r.staleReasons.head_changed, 1);
    assert.equal(r.staleReasons.status_changed, 1);
    assert.equal(r.staleReasons.scanner_version_changed, 1);
  });

  it("returns zero count and null rate on an empty event set", () => {
    const r = summarize([]).retrieval;
    assert.equal(r.staleHits, 0);
    assert.equal(r.staleRate, null);
    assert.deepEqual(r.staleReasons, {});
  });
});
