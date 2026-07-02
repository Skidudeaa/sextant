"use strict";

// 009 #1 — outcome-telemetry substrate. Two layers of proof:
//
//  (A) Pure-unit: the verdict/normalization helpers (classifyOpen, toRepoRel,
//      extractFilePath, buildInjectedPaths) — deterministic, no spawn.
//
//  (B) End-to-end loop: spawn `hook refresh` against a prepared fixture so it
//      injects a retrieval block AND writes the per-session injected-path set,
//      then spawn `hook posttooluse` with a Read of that same file and assert a
//      retrieval.path_hit{source} lands; a Read of an un-surfaced file → path_miss;
//      a different session (no set) → no event; a non-file tool → no event.
//      This proves the whole surfaced→opened loop, not just the pieces.
//
// DETERMINISM: like hook-refresh-telemetry.test.js, the fixture's graph.db is
// prebuilt on disk with one exported symbol and NO zoekt index (no daemon.json),
// so the merged set is graph-only — the injected `source` is deterministically
// the graph signal `exported_symbol`.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const graph = require("../lib/graph");
const telemetry = require("../lib/telemetry");
const { summarize, printSummary } = require("../commands/telemetry");
const {
  classifyOpen,
  toRepoRel,
  extractFilePath,
  injectedPathsFile,
  readInjectedRaw,
} = require("../commands/hook-posttooluse");
const { buildInjectedPaths } = require("../commands/hook-refresh");

const BIN = path.resolve(__dirname, "..", "bin", "intel.js");
const SESSION = "pt-test";

// ─── (A) pure-unit helpers ──────────────────────────────────────────────────

describe("hook-posttooluse — pure helpers", () => {
  it("classifyOpen: hit returns the surfacing source; miss returns no source", () => {
    const map = new Map([
      ["lib/graph.js", "exported_symbol"],
      ["lib/util.js", "text_only"],
    ]);
    assert.deepEqual(classifyOpen(map, "lib/graph.js"), { hit: true, source: "exported_symbol" });
    assert.deepEqual(classifyOpen(map, "lib/util.js"), { hit: true, source: "text_only" });
    assert.deepEqual(classifyOpen(map, "lib/other.js"), { hit: false, source: null });
    assert.equal(classifyOpen(null, "lib/graph.js"), null, "no set → not scoreable");
    assert.equal(classifyOpen(map, null), null, "no path → not scoreable");
  });

  it("toRepoRel: absolute in-root → repo-relative; relative → resolved; outside → null", () => {
    const root = "/repo";
    assert.equal(toRepoRel(root, "/repo/lib/graph.js"), "lib/graph.js");
    assert.equal(toRepoRel(root, "lib/graph.js"), "lib/graph.js");
    assert.equal(toRepoRel(root, "/etc/passwd"), null, "outside root → null");
    assert.equal(toRepoRel(root, "/repo"), null, "root itself → null");
    assert.equal(toRepoRel(root, ""), null);
    assert.equal(toRepoRel(root, null), null);
  });

  it("toRepoRel: realpath-collapses symlinked representations (SPM-1 regression)", () => {
    // A real dir + file, plus a sibling symlink pointing at it. An open via the
    // symlink path must resolve to the SAME repo-relative path as via the real
    // path — otherwise every open false-MISSES on macOS (/tmp→/private/tmp) and
    // any symlinked checkout, silently zeroing open-precision.
    const realRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sx-spm-real-")));
    const symRoot = path.join(os.tmpdir(), `sx-spm-sym-${process.pid}-${realRoot.split("-").pop()}`);
    try {
      fs.mkdirSync(path.join(realRoot, "lib"), { recursive: true });
      fs.writeFileSync(path.join(realRoot, "lib", "f.js"), "x");
      fs.symlinkSync(realRoot, symRoot, "dir");
      // open via the symlinked root, scan root is the real path
      assert.equal(toRepoRel(realRoot, path.join(symRoot, "lib", "f.js")), path.join("lib", "f.js"));
      // and the inverse: scan root symlinked, open via the real path
      assert.equal(toRepoRel(symRoot, path.join(realRoot, "lib", "f.js")), path.join("lib", "f.js"));
      // a genuinely-outside path is still rejected
      assert.equal(toRepoRel(realRoot, "/etc/hostname"), null);
    } finally {
      try { fs.unlinkSync(symRoot); } catch {}
      fs.rmSync(realRoot, { recursive: true, force: true });
    }
  });

  it("readInjectedRaw: rejects an expired or ts-less set (TTL — stale sessions must not score)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sx-ttl-"));
    try {
      fs.mkdirSync(path.join(root, ".planning", "intel"), { recursive: true });
      const write = (payload) =>
        fs.writeFileSync(injectedPathsFile(root, "ttl-s"), JSON.stringify(payload));
      const paths = [{ path: "lib/a.js", source: "exported_symbol" }];

      // Fresh set → scoreable.
      write({ ts: Date.now(), arm: "armed", paths });
      assert.ok(readInjectedRaw(root, "ttl-s"), "fresh set must be readable");

      // 25h-old set → null: sessionKey fallbacks (terminal_id/ppid) recycle
      // across days; a dead session's corpus must not score today's opens.
      write({ ts: Date.now() - 25 * 60 * 60 * 1000, arm: "armed", paths });
      assert.equal(readInjectedRaw(root, "ttl-s"), null, "expired set must be rejected");

      // Legacy ts-less set → null (unscoreable, not a miss).
      write({ arm: "armed", paths });
      assert.equal(readInjectedRaw(root, "ttl-s"), null, "ts-less set must be rejected");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("extractFilePath: file_path, notebook_path, or empty", () => {
    assert.equal(extractFilePath({ tool_input: { file_path: "/a/b.js" } }), "/a/b.js");
    assert.equal(extractFilePath({ tool_input: { notebook_path: "/a/n.ipynb" } }), "/a/n.ipynb");
    assert.equal(extractFilePath({ tool_input: {} }), "");
    assert.equal(extractFilePath({}), "");
    assert.equal(extractFilePath(null), "");
  });

  it("buildInjectedPaths: source = graphSignal, or text_only when null", () => {
    const out = buildInjectedPaths([
      { path: "lib/a.js", graphSignal: "exported_symbol" },
      { path: "lib/b.js", graphSignal: "swift_decl_type" },
      { path: "lib/c.js", graphSignal: null },
      { path: "lib/d.js" },
      { notpath: 1 }, // skipped — no string path
    ]);
    assert.deepEqual(out, [
      { path: "lib/a.js", source: "exported_symbol" },
      { path: "lib/b.js", source: "swift_decl_type" },
      { path: "lib/c.js", source: "text_only" },
      { path: "lib/d.js", source: "text_only" },
    ]);
    assert.deepEqual(buildInjectedPaths(null), []);
  });
});

// ─── (B) end-to-end surfaced → opened loop ──────────────────────────────────

async function buildFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-posttooluse-"));
  fs.mkdirSync(path.join(dir, ".planning", "intel"), { recursive: true });
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "lib", "resolveImportPath.js"),
    "function resolveImportPath(spec) { return spec; }\nmodule.exports = { resolveImportPath };\n"
  );
  const db = await graph.loadDb(dir);
  graph.upsertFile(db, { relPath: "lib/resolveImportPath.js", type: "js", sizeBytes: 500, mtimeMs: 1 });
  graph.replaceExports(db, "lib/resolveImportPath.js", [{ name: "resolveImportPath", kind: "named" }]);
  await graph.persistDb(dir);
  return dir;
}

// A no-op `sextant` on PATH: the fixture has no scan-state (no_scan_record →
// content-stale), so the refresh hook's freshness gate spawns a detached
// background rescan. Without the shim that resolves the REAL npm-linked
// sextant, which scans the fixture asynchronously and races the after()
// rmSync (ENOTEMPTY) — same hazard hook-refresh-freshness.test.js shims.
function installSextantShim() {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-shim-ptu-"));
  fs.writeFileSync(path.join(shimDir, "sextant"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(shimDir, "sextant"), 0o755);
  const prevPath = process.env.PATH;
  process.env.PATH = shimDir + path.delimiter + prevPath;
  return () => {
    process.env.PATH = prevPath;
    try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch {}
  };
}

// HERMETIC ARM: pin the holdback decision to default-off — an inherited
// SEXTANT_HOLDBACK_PCT (dogfooding env) would randomly turn refresh spawns
// into holdback turns and tag the persisted set arm:"holdback". Captured
// per-spawn because installSextantShim() mutates process.env.PATH.
function hookEnv() {
  return { ...process.env, SEXTANT_HOLDBACK_PCT: "0", SEXTANT_HOLDBACK_FORCE: "" };
}
function runRefresh(dir, prompt) {
  return spawnSync(process.execPath, [BIN, "hook", "refresh"], {
    cwd: dir,
    input: JSON.stringify({ prompt, session_id: SESSION }),
    encoding: "utf8",
    timeout: 20000,
    env: hookEnv(),
  });
}

function runPost(dir, payload) {
  return spawnSync(process.execPath, [BIN, "hook", "posttooluse"], {
    cwd: dir,
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 20000,
  });
}

function pathEvents(dir) {
  return telemetry
    .readEvents(dir)
    .filter((e) => e.name === "retrieval.path_hit" || e.name === "retrieval.path_miss");
}

describe("hook-posttooluse — end-to-end surfaced→opened loop", () => {
  let dir, restoreShim;
  before(async () => {
    restoreShim = installSextantShim();
    dir = await buildFixture();
  });
  after(() => {
    if (restoreShim) restoreShim();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refresh writes the per-session injected-path set with {path, source}", () => {
    const res = runRefresh(dir, "where is resolveImportPath defined");
    assert.ok(
      (res.stdout || "").includes("<codebase-retrieval>"),
      `expected a retrieval block, got:\n${res.stdout}`
    );
    const setFile = injectedPathsFile(dir, SESSION);
    assert.ok(fs.existsSync(setFile), "expected the injected-path set file to be written");
    const parsed = JSON.parse(fs.readFileSync(setFile, "utf8"));
    assert.ok(Array.isArray(parsed.paths) && parsed.paths.length >= 1, "expected >=1 injected path");
    const entry = parsed.paths.find((p) => p.path === "lib/resolveImportPath.js");
    assert.ok(entry, "expected the surfaced exporter in the set");
    assert.equal(typeof entry.source, "string");
    assert.ok(entry.source.length > 0, "expected a non-empty surfacing source");
  });

  it("PostToolUse on the surfaced file emits retrieval.path_hit{source}, not a miss", () => {
    const before = pathEvents(dir).length;
    const res = runPost(dir, {
      tool_name: "Read",
      tool_input: { file_path: path.join(dir, "lib", "resolveImportPath.js") },
      session_id: SESSION,
    });
    assert.equal(res.stdout || "", "", "PostToolUse must write NOTHING to stdout (out-of-band)");
    const evs = pathEvents(dir);
    assert.equal(evs.length, before + 1, "expected exactly one new path_* event");
    const hit = evs[evs.length - 1];
    assert.equal(hit.name, "retrieval.path_hit");
    assert.equal(hit.tool, "Read");
    assert.equal(typeof hit.source, "string");
    assert.ok(hit.source.length > 0, "hit must carry the surfacing source for attribution");
  });

  it("PostToolUse on an un-surfaced file emits retrieval.path_miss", () => {
    const before = pathEvents(dir).length;
    runPost(dir, {
      tool_name: "Edit",
      tool_input: { file_path: path.join(dir, "lib", "never-surfaced.js") },
      session_id: SESSION,
    });
    const evs = pathEvents(dir);
    assert.equal(evs.length, before + 1);
    assert.equal(evs[evs.length - 1].name, "retrieval.path_miss");
    assert.equal(evs[evs.length - 1].tool, "Edit");
  });

  it("a different session (no injected set) scores nothing", () => {
    const before = pathEvents(dir).length;
    runPost(dir, {
      tool_name: "Read",
      tool_input: { file_path: path.join(dir, "lib", "resolveImportPath.js") },
      session_id: "some-other-session",
    });
    assert.equal(pathEvents(dir).length, before, "no set for that session → no event");
  });

  it("a non-file tool (Bash) scores nothing", () => {
    const before = pathEvents(dir).length;
    runPost(dir, {
      tool_name: "Bash",
      tool_input: { command: "ls" },
      session_id: SESSION,
    });
    assert.equal(pathEvents(dir).length, before, "non-file tool → no event");
  });

  it("an open OUTSIDE the repo scores nothing", () => {
    const before = pathEvents(dir).length;
    runPost(dir, {
      tool_name: "Read",
      tool_input: { file_path: "/etc/hostname" },
      session_id: SESSION,
    });
    assert.equal(pathEvents(dir).length, before, "outside-root open → no event");
  });
});

// ─── (D) blast-radius emitter (docs/016 Sprint 1) ───────────────────────────
//
// The action-time injection lane: an Edit/Write on a file with untouched
// dependents or co-change partners emits ONE additionalContext JSON envelope;
// everything else stays byte-silent on stdout.  Fixtures are real git repos so
// the freshness gate sees a genuine fresh/stale state.

const { execFileSync } = require("child_process");
const freshness = require("../lib/freshness");

async function buildBlastFixture({ recordScan = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-blast-"));
  fs.mkdirSync(path.join(dir, ".planning", "intel"), { recursive: true });
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  const write = (rel, content) => fs.writeFileSync(path.join(dir, rel), content);
  write("lib/core.js", "module.exports = {};\n");
  for (const n of ["a", "b", "c"]) write(`lib/${n}.js`, "require('./core');\n");
  write("lib/solo.js", "module.exports = 1;\n");
  write("lib/leaf.js", "module.exports = 2;\n");
  write("lib/leafdep.js", "require('./leaf');\n");
  const git = (...a) =>
    execFileSync("git", a, {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "fixture");

  const db = await graph.loadDb(dir);
  for (const rel of ["lib/core.js", "lib/a.js", "lib/b.js", "lib/c.js", "lib/solo.js", "lib/leaf.js", "lib/leafdep.js"]) {
    graph.upsertFile(db, { relPath: rel, type: "js", sizeBytes: 10, mtimeMs: 1 });
  }
  for (const n of ["a", "b", "c"]) {
    graph.replaceImports(db, `lib/${n}.js`, [{ specifier: "./core", toPath: "lib/core.js", kind: "relative" }]);
  }
  graph.replaceImports(db, "lib/leafdep.js", [{ specifier: "./leaf", toPath: "lib/leaf.js", kind: "relative" }]);
  // solo.js has no import edges — its blast radius is purely co-change.
  graph.replaceCoChangePairs(
    db,
    [{ a: "lib/solo.js", b: "lib/a.js", count: 4, confidence: 0.8 }],
    new Map([["lib/solo.js", 1], ["lib/a.js", 1]])
  );
  if (recordScan) freshness.recordScanState(db, dir);
  await graph.persistDb(dir);
  return dir;
}

function parseEnvelope(stdout) {
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PostToolUse");
  return parsed.hookSpecificOutput.additionalContext;
}

function blastEvents(dir) {
  return telemetry.readEvents(dir).filter((e) => e.name === "blastradius.injected");
}

describe("hook-posttooluse — blast-radius emitter", () => {
  let dir;
  before(async () => {
    dir = await buildBlastFixture();
  });
  after(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("Edit on a high-fan-in file emits the additionalContext envelope + telemetry", () => {
    const res = runPost(dir, {
      tool_name: "Edit",
      tool_input: { file_path: path.join(dir, "lib", "core.js") },
      session_id: "blast-1",
    });
    const note = parseEnvelope(res.stdout);
    assert.match(note, /Blast radius of lib\/core\.js/);
    assert.match(note, /3 files import it/);
    assert.match(note, /lib\/a\.js/);
    assert.ok(note.length < 600, `note must stay compact, got ${note.length} chars`);
    const evs = blastEvents(dir);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].dependents, 3);
  });

  it("second Edit on the same file in the same session is byte-silent (once per session/file)", () => {
    const res = runPost(dir, {
      tool_name: "Edit",
      tool_input: { file_path: path.join(dir, "lib", "core.js") },
      session_id: "blast-1",
    });
    assert.equal(res.stdout || "", "");
    assert.equal(blastEvents(dir).length, 1, "no second telemetry event");
  });

  it("Read never emits — even on the high-fan-in file", () => {
    const res = runPost(dir, {
      tool_name: "Read",
      tool_input: { file_path: path.join(dir, "lib", "core.js") },
      session_id: "blast-read",
    });
    assert.equal(res.stdout || "", "");
  });

  it("dependents already touched this session are subtracted; all-touched → silent", () => {
    const session = "blast-touched";
    for (const n of ["a", "b", "c"]) {
      runPost(dir, {
        tool_name: "Read",
        tool_input: { file_path: path.join(dir, "lib", `${n}.js`) },
        session_id: session,
      });
    }
    const res = runPost(dir, {
      tool_name: "Edit",
      tool_input: { file_path: path.join(dir, "lib", "core.js") },
      session_id: session,
    });
    assert.equal(res.stdout || "", "", "every dependent already opened → nothing worth saying");
  });

  it("co-change partners surface for a file with no import fan-in", () => {
    const res = runPost(dir, {
      tool_name: "Write",
      tool_input: { file_path: path.join(dir, "lib", "solo.js") },
      session_id: "blast-cc",
    });
    const note = parseEnvelope(res.stdout);
    assert.match(note, /historically co-changes with lib\/a\.js \(4 commits\)/);
    assert.doesNotMatch(note, /files import it/, "no fan-in claim without fan-in");
  });

  it("a leaf file below the fan-in floor is silent", () => {
    const res = runPost(dir, {
      tool_name: "Edit",
      tool_input: { file_path: path.join(dir, "lib", "leaf.js") },
      session_id: "blast-leaf",
    });
    assert.equal(res.stdout || "", "", "fan-in 1 < floor 3 and no partners → silent");
  });

  it("content-stale graph emits NOTHING (silent absence over false confidence)", async () => {
    const staleDir = await buildBlastFixture();
    try {
      // Change tracked content AFTER the scan record → status-hash mismatch →
      // contentChanged=true. (A missing record is also content-stale, but this
      // exercises the real "repo moved under the graph" path.)
      fs.writeFileSync(path.join(staleDir, "lib", "core.js"), "module.exports = { changed: true };\n");
      const res = runPost(staleDir, {
        tool_name: "Edit",
        tool_input: { file_path: path.join(staleDir, "lib", "core.js") },
        session_id: "blast-stale",
      });
      assert.equal(res.stdout || "", "", "content-stale → no structural claims");
      assert.equal(blastEvents(staleDir).length, 0);
    } finally {
      fs.rmSync(staleDir, { recursive: true, force: true });
    }
  });

  it("outcome scoring still works on an emission turn (both lanes fire)", async () => {
    const dir2 = await buildBlastFixture();
    try {
      // Surface lib/core.js for this session, then Edit it: expect BOTH a
      // path_hit AND the blast-radius envelope from one hook invocation.
      fs.writeFileSync(
        injectedPathsFile(dir2, "blast-both"),
        JSON.stringify({ ts: Date.now(), arm: "armed", paths: [{ path: "lib/core.js", source: "exported_symbol" }] })
      );
      const res = runPost(dir2, {
        tool_name: "Edit",
        tool_input: { file_path: path.join(dir2, "lib", "core.js") },
        session_id: "blast-both",
      });
      parseEnvelope(res.stdout);
      const hits = telemetry.readEvents(dir2).filter((e) => e.name === "retrieval.path_hit");
      assert.equal(hits.length, 1);
      assert.equal(hits[0].source, "exported_symbol");
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });
});

// ─── (C) telemetry aggregation ──────────────────────────────────────────────

describe("telemetry summarize — outcome substrate aggregation", () => {
  it("computes open-precision and per-source hit breakdown", () => {
    const events = [
      { ts: 1, name: "retrieval.path_hit", source: "exported_symbol", tool: "Read" },
      { ts: 2, name: "retrieval.path_hit", source: "exported_symbol", tool: "Edit" },
      { ts: 3, name: "retrieval.path_hit", source: "text_only", tool: "Read" },
      { ts: 4, name: "retrieval.path_miss", tool: "Read" },
    ];
    const r = summarize(events).retrieval;
    assert.equal(r.pathHits, 3);
    assert.equal(r.pathMisses, 1);
    assert.equal(r.openPrecision, 0.75); // 3 / (3 + 1)
    assert.equal(r.pathHitsBySource.exported_symbol, 2);
    assert.equal(r.pathHitsBySource.text_only, 1);
  });

  it("returns null open-precision and zero counts on an empty event set", () => {
    const r = summarize([]).retrieval;
    assert.equal(r.pathHits, 0);
    assert.equal(r.pathMisses, 0);
    assert.equal(r.openPrecision, null);
    assert.deepEqual(r.pathHitsBySource, {});
  });

  // VH-1: open-precision must render even when the only retrieval.classified
  // event has rotated into .old (classifiedTotal===0) but path events remain in
  // the current window — otherwise the audit hides the metric exactly when
  // volume is high.
  it("printSummary shows open-precision when classifiedTotal===0 but path events exist", () => {
    const events = [
      { ts: 1, name: "retrieval.path_hit", source: "exported_symbol", tool: "Read" },
      { ts: 2, name: "retrieval.path_miss", tool: "Read" },
    ];
    const out = printSummary("/x", summarize(events));
    assert.match(out, /open-precision: 50\.0%/, "open-precision must render post-rotation");
    assert.match(out, /Outcome substrate/);
  });

  // VH-2: the human-facing caveat must carry BOTH halves so "open-precision: 7%"
  // can't be misread as "retrieval is 93% wrong."
  it("printSummary caveat carries both the baseline-pending AND precision-flavored halves", () => {
    const out = printSummary("/x", summarize([
      { ts: 1, name: "retrieval.path_hit", source: "exported_symbol", tool: "Read" },
      { ts: 2, name: "retrieval.path_miss", tool: "Read" },
    ]));
    assert.match(out, /baseline pending/);
    assert.match(out, /never surfaced|precision-flavored|not.*coverage/);
  });
});
