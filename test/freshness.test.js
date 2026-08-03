"use strict";

// Tests for lib/freshness.js -- the real-state freshness gate.
//
// Each describe block sets up a fresh temp git repo so the freshness
// signals (HEAD, status hash) have something real to anchor on.  We use
// `git init` directly rather than mocks because the production code
// shells out to git via execSync and we want to exercise that path.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync, spawnSync } = require("child_process");

const freshness = require("../lib/freshness");
const graph = require("../lib/graph");

function gitInit(dir) {
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  // Disable signing for CI environments that have it on globally.
  execSync("git config commit.gpgsign false", { cwd: dir });
}

function gitCommitFile(dir, name, content, message = "commit") {
  fs.writeFileSync(path.join(dir, name), content);
  execSync(`git add ${name}`, { cwd: dir });
  execSync(`git commit -q -m "${message}"`, { cwd: dir });
}

function makeRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sextant-fresh-${prefix}-`));
  fs.mkdirSync(path.join(dir, ".planning", "intel"), { recursive: true });
  gitInit(dir);
  gitCommitFile(dir, "seed.js", "module.exports = 1;\n", "seed");
  return dir;
}

// WHY: enqueueRescan() spawns `sextant scan` via PATH lookup. On a fresh clone
// with no `npm link`, the spawn fails ENOENT *asynchronously*, after the
// triggering test has already returned — node:test then reports it as an
// unhandled error and fails the whole suite. A no-op `sextant` on PATH makes
// the spawn resolve and exit 0 deterministically, regardless of environment.
function installSextantShim() {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-shim-"));
  fs.writeFileSync(path.join(shimDir, "sextant"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(shimDir, "sextant"), 0o755);
  const prevPath = process.env.PATH;
  process.env.PATH = shimDir + path.delimiter + prevPath;
  return () => {
    process.env.PATH = prevPath;
    try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch {}
  };
}

describe("freshness.captureCurrentState", () => {
  let dir;
  before(() => { dir = makeRepo("capture"); });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("captures head, statusHash, scannerVersion, schemaVersion", () => {
    const state = freshness.captureCurrentState(dir);
    assert.ok(state.head, "head should be a non-empty string in a real git repo");
    assert.match(state.head, /^[0-9a-f]{40}$/, "head should be a 40-char SHA");
    assert.ok(state.statusHash, "statusHash should be set even on a clean repo");
    assert.equal(state.scannerVersion, freshness.SCANNER_VERSION);
    assert.equal(state.schemaVersion, freshness.SCHEMA_VERSION);
  });

  it("returns a different statusHash after an untracked file is added", () => {
    const before = freshness.captureCurrentState(dir).statusHash;
    fs.writeFileSync(path.join(dir, "new.js"), "x");
    const after = freshness.captureCurrentState(dir).statusHash;
    assert.notEqual(after, before, "untracked file should change the status fingerprint");
    fs.unlinkSync(path.join(dir, "new.js"));
  });

  it("changes statusHash when an already-dirty file changes bytes again", () => {
    const file = path.join(dir, "seed.js");
    fs.writeFileSync(file, "dirty once\n");
    const before = freshness.captureCurrentState(dir).statusHash;
    fs.writeFileSync(file, "dirty twice\n");
    const after = freshness.captureCurrentState(dir).statusHash;
    assert.notEqual(after, before, "dirty-file content must participate in freshness");
    fs.writeFileSync(file, "module.exports = 1;\n");
  });

  it("tracks repeated edits for space, non-ASCII, and renamed paths", () => {
    const spaced = path.join(dir, "a b.js");
    const unicode = path.join(dir, "café.js");
    fs.writeFileSync(spaced, "one\n");
    fs.writeFileSync(unicode, "one\n");
    execSync('git add -- "a b.js" "café.js" && git commit -q -m names', { cwd: dir });

    fs.writeFileSync(spaced, "dirty one\n");
    const spacedBefore = freshness.captureCurrentState(dir).statusHash;
    fs.writeFileSync(spaced, "dirty two\n");
    assert.notEqual(freshness.captureCurrentState(dir).statusHash, spacedBefore);

    fs.writeFileSync(unicode, "dirty one\n");
    const unicodeBefore = freshness.captureCurrentState(dir).statusHash;
    fs.writeFileSync(unicode, "dirty two\n");
    assert.notEqual(freshness.captureCurrentState(dir).statusHash, unicodeBefore);

    // Restore both files, then exercise porcelain -z's two-field rename form.
    fs.writeFileSync(spaced, "one\n");
    fs.writeFileSync(unicode, "one\n");
    execSync('git mv -- "a b.js" "renamed file.js"', { cwd: dir });
    const renamed = path.join(dir, "renamed file.js");
    const renameBefore = freshness.captureCurrentState(dir).statusHash;
    fs.writeFileSync(renamed, "changed after rename\n");
    assert.notEqual(freshness.captureCurrentState(dir).statusHash, renameBefore);

    execSync('git reset -q HEAD -- .', { cwd: dir });
    fs.rmSync(renamed, { force: true });
    fs.writeFileSync(spaced, "one\n");
  });

  it("degrades to a metadata fingerprint rather than reading an oversized dirty file", () => {
    // THE INVARIANT THIS TEST OWNS IS UNCHANGED: over-budget content is never
    // READ on the hook path. What changed (docs/035 #6) is the consequence.
    //
    // It used to return null, and captureStatusState turns one null into a null
    // anchor for the WHOLE repo, which checkFreshness reports as
    // `status_changed` FOREVER — no rescan can clear it. Measured cost:
    // /root/somaNotes (20.4 MiB dirty) and /root/open-interpreter-fork
    // (392.9 MiB) were permanently content-stale, which is 202 of 234 subagent
    // orientation skips fleet-wide, and it suppressed every structural claim on
    // those repos too. "Fail closed" that can never re-open is not a gate, it is
    // an outage.
    //
    // A file too big to read still has a real fingerprint: size + mtime + inode.
    // Weaker than a content hash — a change preserving all three is invisible —
    // but a genuine signal rather than a guess, and reported via `degradedFiles`
    // rather than implied.
    const file = path.join(dir, "seed.js");
    fs.truncateSync(file, 3 * 1024 * 1024);
    const state = freshness.captureCurrentState(dir);
    assert.ok(state.statusHash, "an over-budget dirty file must not null the whole anchor");
    assert.ok(state.degradedFiles >= 1, "and the weaker mode must be reported, not implied");

    // The no-read invariant, asserted directly: the degraded fingerprint must
    // change when the file's SIZE changes, and it must be produced without the
    // content ever entering the hash (a 3 MiB read would exceed the per-file
    // cap this test exists to enforce).
    const before = state.statusHash;
    fs.truncateSync(file, 4 * 1024 * 1024);
    assert.notEqual(freshness.captureCurrentState(dir).statusHash, before);

    fs.writeFileSync(file, "module.exports = 1;\n");
  });

  // SKIPPED ON DARWIN: this test's premise is a filename that is not valid
  // UTF-8 (a lone 0xff byte). APFS/HFS+ validate filename encoding at the
  // syscall boundary, so the fixture write fails with EILSEQ before the
  // invariant is ever exercised — the assertion never runs, and the failure
  // says nothing about lib/freshness.js. The invariant itself (raw pathname
  // BYTES address and hash the file, never a lossy utf8 decode) is real and
  // still enforced on any filesystem that can hold such a name, which is
  // where it matters: Linux ext4/xfs checkouts, where Git happily reports
  // undecodable paths in `status -z`.
  it("hashes invalid-UTF8 Git paths without lossy string decoding", {
    skip: process.platform === "win32" || process.platform === "darwin",
  }, () => {
    const rawPath = Buffer.concat([
      Buffer.from(dir + path.sep),
      Buffer.from([0xff]),
      Buffer.from(".js"),
    ]);
    try {
      fs.writeFileSync(rawPath, "one\n");
      const before = freshness.captureCurrentState(dir).statusHash;
      fs.writeFileSync(rawPath, "two\n");
      const after = freshness.captureCurrentState(dir).statusHash;
      assert.notEqual(after, before, "raw pathname bytes must still address and hash the file");
    } finally {
      fs.rmSync(rawPath, { force: true });
    }
  });

  it("fails closed when HEAD moves inside one capture", () => {
    // Run in a child so child_process.execSync can be wrapped before freshness
    // destructures it at module load. The first rev-parse returns H0, then the
    // wrapper commits H1 before git status; the trailing HEAD read must reject
    // that old-HEAD/new-status hybrid.
    const script = String.raw`
      const fs = require("fs");
      const path = require("path");
      const cp = require("child_process");
      const original = cp.execSync;
      let armed = false;
      let moved = false;
      cp.execSync = function(command, options) {
        const out = original.call(this, command, options);
        if (armed && !moved && command === "git rev-parse HEAD") {
          moved = true;
          fs.writeFileSync(path.join(process.env.TEST_REPO, "seed.js"), "module.exports = 2;\n");
          original("git add seed.js && git commit -qm moved", { cwd: process.env.TEST_REPO });
        }
        return out;
      };
      const freshness = require(process.env.FRESHNESS_MODULE);
      armed = true;
      process.stdout.write(JSON.stringify(freshness.captureCurrentState(process.env.TEST_REPO)));
    `;
    const originalHead = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    try {
      const result = spawnSync(process.execPath, ["-e", script], {
        encoding: "utf8",
        env: {
          ...process.env,
          TEST_REPO: dir,
          FRESHNESS_MODULE: path.resolve(__dirname, "..", "lib", "freshness.js"),
        },
      });
      assert.equal(result.status, 0, result.stderr);
      const raced = JSON.parse(result.stdout);
      assert.equal(raced.head, null);
      assert.equal(raced.statusHash, null, "hybrid repo observations must be unverifiable");
    } finally {
      // Restore the shared fixture even if the child/assertion failed.
      execSync(`git reset --hard -q ${originalHead}`, { cwd: dir });
    }
  });

  it("never reads more than the bounded cap when a dirty file grows after fstat", () => {
    const file = path.join(dir, "seed.js");
    fs.writeFileSync(file, "x");
    const originalRead = fs.readSync;
    let grew = false;
    let maxRequested = 0;
    fs.readSync = function(fd, buffer, offset, length, position) {
      maxRequested = Math.max(maxRequested, length);
      if (!grew) {
        grew = true;
        fs.truncateSync(file, 3 * 1024 * 1024);
      }
      return originalRead.call(this, fd, buffer, offset, length, position);
    };
    try {
      assert.equal(freshness.captureCurrentState(dir).statusHash, null);
      assert.ok(grew, "test must exercise the descriptor read");
      assert.ok(maxRequested <= 2 * 1024 * 1024 + 1, "read request exceeded cap+1");
    } finally {
      fs.readSync = originalRead;
      fs.writeFileSync(file, "module.exports = 1;\n");
    }
  });

  it("fails closed when an early dirty file moves while later dirty files are hashed", () => {
    const early = path.join(dir, "a-early.js");
    const late = path.join(dir, "z-late.js");
    fs.writeFileSync(early, "base early\n");
    fs.writeFileSync(late, "base late\n");
    execSync("git add a-early.js z-late.js && git commit -qm evidence-base", { cwd: dir });
    fs.writeFileSync(early, "dirty early\n");
    fs.writeFileSync(late, "dirty late\n");

    const originalRead = fs.readSync;
    let reads = 0;
    fs.readSync = function(fd, buffer, offset, length, position) {
      const n = originalRead.call(this, fd, buffer, offset, length, position);
      reads += 1;
      if (reads === 2) {
        // a-early.js has already passed its own descriptor before/after check.
        // Only the global evidence revalidation can catch this later move.
        fs.writeFileSync(early, "foreign after early hash\n");
      }
      return n;
    };
    try {
      assert.equal(freshness.captureCurrentState(dir).statusHash, null);
      assert.ok(reads >= 2, "fixture must hash both dirty files");
    } finally {
      fs.readSync = originalRead;
      fs.writeFileSync(early, "base early\n");
      fs.writeFileSync(late, "base late\n");
    }
  });
});

describe("freshness.checkFreshness: no scan record means stale", () => {
  let dir;
  before(() => { dir = makeRepo("noscan"); });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("a fresh graph.db with no scanned-state meta is treated as stale", async () => {
    // loadDb creates an empty schema; we never recorded scan-state, so the
    // gate should fail-closed with reason no_scan_record.
    await graph.loadDb(dir);
    const result = await freshness.checkFreshness(dir);
    assert.equal(result.fresh, false);
    assert.equal(result.reason, "no_scan_record");
    assert.equal(result.graphGeneration, "");
  });
});

describe("freshness.checkFreshness: recorded state matches → fresh", () => {
  let dir;
  before(() => { dir = makeRepo("fresh"); });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("returns fresh after recordScanState on an unchanged repo", async () => {
    const db = await graph.loadDb(dir);
    assert.equal(freshness.recordScanState(db, dir), true);
    const generation = graph.getMetaValue(db, freshness.META_GRAPH_GENERATION);
    assert.match(generation, /^[0-9a-f]{32}$/);
    await graph.persistDb(dir);

    const result = await freshness.checkFreshness(dir);
    assert.equal(result.fresh, true);
    assert.equal(result.reason, null);
    assert.equal(result.graphGeneration, generation);

    assert.equal(freshness.recordScanState(db, dir), true);
    assert.notEqual(
      graph.getMetaValue(db, freshness.META_GRAPH_GENERATION),
      generation,
      "every graph publication must receive a new generation token"
    );
  });
});

describe("freshness.checkFreshness: missing Git HEAD is unverifiable", () => {
  it("refuses head=null + status=valid instead of treating null as a non-git anchor", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-unborn-head-"));
    try {
      gitInit(dir); // Deliberately no first commit: status works, HEAD does not.
      fs.mkdirSync(path.join(dir, ".planning", "intel"), { recursive: true });
      fs.writeFileSync(path.join(dir, "a.js"), "export const a = 1;\n");
      const captured = freshness.captureCurrentState(dir);
      assert.equal(captured.head, null);
      assert.ok(captured.statusHash, "fixture must retain a valid porcelain fingerprint");

      const db = await graph.loadDb(dir);
      assert.equal(freshness.recordScanState(db, dir), false);
      const invalidGeneration = graph.getMetaValue(db, freshness.META_GRAPH_GENERATION);
      assert.match(invalidGeneration, /^[0-9a-f]{32}$/);
      assert.equal(freshness.recordScanState(db, dir), false);
      assert.notEqual(graph.getMetaValue(db, freshness.META_GRAPH_GENERATION), invalidGeneration);
      const latestInvalidGeneration = graph.getMetaValue(db, freshness.META_GRAPH_GENERATION);
      await graph.persistDb(dir);

      const checked = await freshness.checkFreshness(dir);
      assert.equal(checked.fresh, false);
      assert.equal(checked.reason, "head_changed");
      assert.equal(checked.graphGeneration, latestInvalidGeneration);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("freshness.checkFreshness: HEAD change → stale", () => {
  let dir;
  before(() => { dir = makeRepo("head"); });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("returns stale with reason head_changed after a new commit", async () => {
    const db = await graph.loadDb(dir);
    freshness.recordScanState(db, dir);
    await graph.persistDb(dir);

    gitCommitFile(dir, "later.js", "module.exports = 2;\n", "later");

    const result = await freshness.checkFreshness(dir);
    assert.equal(result.fresh, false);
    assert.equal(result.reason, "head_changed");
    assert.ok(result.evidence.stored !== result.evidence.current);
  });
});

describe("freshness.checkFreshness: working-tree change → stale", () => {
  let dir;
  before(() => { dir = makeRepo("status"); });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("returns stale with reason status_changed when an untracked file appears", async () => {
    const db = await graph.loadDb(dir);
    freshness.recordScanState(db, dir);
    await graph.persistDb(dir);

    fs.writeFileSync(path.join(dir, "untracked.js"), "x");

    const result = await freshness.checkFreshness(dir);
    assert.equal(result.fresh, false);
    assert.equal(result.reason, "status_changed");
  });
});

describe("freshness.checkFreshness: scanner_version mismatch → stale", () => {
  let dir;
  before(() => { dir = makeRepo("scanner"); });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("returns stale with reason scanner_version_changed when stored version is older", async () => {
    const db = await graph.loadDb(dir);
    freshness.recordScanState(db, dir);
    // Simulate an older scanner having written this graph.db.
    graph.setMetaValue(db, freshness.META_SCANNER_VERSION, "0");
    await graph.persistDb(dir);

    const result = await freshness.checkFreshness(dir);
    assert.equal(result.fresh, false);
    assert.equal(result.reason, "scanner_version_changed");
    assert.equal(result.evidence.stored, "0");
    assert.equal(result.evidence.current, freshness.SCANNER_VERSION);
  });
});

describe("freshness.checkFreshness: pre-NodeNext resolver scans → stale", () => {
  let dir;
  before(() => { dir = makeRepo("nodenext-version"); });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("treats scanner version 1 records as stale under the current resolver semantics", async () => {
    const db = await graph.loadDb(dir);
    freshness.recordScanState(db, dir);
    // Version 1 predates the NodeNext .js -> .ts resolver rewrite. Old graphs
    // can contain unresolved edges that current code would now resolve, so they
    // must be invalidated instead of treated as fresh.
    graph.setMetaValue(db, freshness.META_SCANNER_VERSION, "1");
    await graph.persistDb(dir);

    const result = await freshness.checkFreshness(dir);
    assert.equal(result.fresh, false);
    assert.equal(result.reason, "scanner_version_changed");
    assert.equal(result.evidence.stored, "1");
    assert.equal(result.evidence.current, freshness.SCANNER_VERSION);
  });
});

// ─── contentChanged matrix (T1.2 follow-up) ─────────────────────────────────
//
// checkFreshness now returns a REASON-INDEPENDENT `contentChanged` boolean.  The
// load-bearing case is the last one: a scanner_version mismatch that COINCIDES
// with a moved HEAD must still report contentChanged=true even though `reason`
// (single-valued, version-first) stays "scanner_version_changed".  That is what
// stops a routine sextant upgrade from masking a checkout's content move.
describe("freshness.checkFreshness: contentChanged (T1.2 follow-up)", () => {
  let dir;
  before(() => { dir = makeRepo("contentchanged"); });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("fresh repo → contentChanged false", async () => {
    const db = await graph.loadDb(dir);
    freshness.recordScanState(db, dir);
    await graph.persistDb(dir);

    const result = await freshness.checkFreshness(dir);
    assert.equal(result.fresh, true);
    assert.equal(result.contentChanged, false);
  });

  it("HEAD moved → contentChanged true (reason head_changed)", async () => {
    const db = await graph.loadDb(dir);
    freshness.recordScanState(db, dir);
    await graph.persistDb(dir);

    gitCommitFile(dir, "moved.js", "module.exports = 9;\n", "moved");

    const result = await freshness.checkFreshness(dir);
    assert.equal(result.fresh, false);
    assert.equal(result.reason, "head_changed");
    assert.equal(result.contentChanged, true);
  });

  it("dirty working tree (untracked file) → contentChanged true (reason status_changed)", async () => {
    const db = await graph.loadDb(dir);
    freshness.recordScanState(db, dir);
    await graph.persistDb(dir);

    fs.writeFileSync(path.join(dir, "dirty.js"), "x");

    const result = await freshness.checkFreshness(dir);
    assert.equal(result.fresh, false);
    assert.equal(result.reason, "status_changed");
    assert.equal(result.contentChanged, true);

    fs.unlinkSync(path.join(dir, "dirty.js"));
  });

  it("scanner_version mismatch + HEAD SAME → contentChanged false (cried-wolf preserved)", async () => {
    const db = await graph.loadDb(dir);
    freshness.recordScanState(db, dir);
    // Pure version bump: stored scanner_version differs, but HEAD/status match.
    graph.setMetaValue(db, freshness.META_SCANNER_VERSION, "0");
    await graph.persistDb(dir);

    const result = await freshness.checkFreshness(dir);
    assert.equal(result.fresh, false);
    assert.equal(result.reason, "scanner_version_changed");
    // KEY: a pure version bump did NOT touch files → contentChanged must be
    // false so the suppressive path stays off (the cried-wolf guard).
    assert.equal(result.contentChanged, false);
  });

  it("scanner_version mismatch + HEAD MOVED → contentChanged TRUE, reason still scanner_version_changed (masking closed)", async () => {
    const db = await graph.loadDb(dir);
    freshness.recordScanState(db, dir);
    // Simulate the coincidence the gap describes: an older scanner wrote this
    // graph.db (version mismatch) AND the repo has since been checked out to a
    // new HEAD (content move).  `reason` is single-valued and version-first, so
    // it reports scanner_version_changed — but contentChanged must surface the
    // real content move so hook-refresh can still suppress + drop phantoms.
    graph.setMetaValue(db, freshness.META_SCANNER_VERSION, "0");
    await graph.persistDb(dir);

    gitCommitFile(dir, "coincident.js", "module.exports = 42;\n", "coincident");

    const result = await freshness.checkFreshness(dir);
    assert.equal(result.fresh, false);
    // Reason ordering is UNCHANGED — version still wins (cli.js depends on it).
    assert.equal(result.reason, "scanner_version_changed");
    // THE KEY new assertion: the API no longer masks the content change.
    assert.equal(result.contentChanged, true);
  });

  it("no_scan_record and db_load_failed paths report contentChanged true (degrade-don't-guess)", async () => {
    // A fresh graph.db with no recorded scan-state can't be verified against a
    // baseline → conservative contentChanged true.
    const noScanDir = makeRepo("contentchanged-noscan");
    try {
      await graph.loadDb(noScanDir);
      const r = await freshness.checkFreshness(noScanDir);
      assert.equal(r.reason, "no_scan_record");
      assert.equal(r.contentChanged, true);
    } finally {
      fs.rmSync(noScanDir, { recursive: true, force: true });
    }
  });

  it("db_load_failed (unreadable graph.db) reports contentChanged true — guards the T1.2 corrupt-db path", async () => {
    // The branch the test above NAMED but never exercised. Force graph.loadDb to
    // throw by replacing graph.db with a DIRECTORY (readFileSync → EISDIR). The
    // contract is load-bearing: on a corrupt db the hook's content-stale path
    // must engage (contentChanged true → structural suppression), not silently
    // treat the turn as fresh and trust an unverifiable graph.
    const dir = makeRepo("contentchanged-dbfail");
    try {
      const dbPath = graph.graphDbPath(dir);
      fs.mkdirSync(dbPath, { recursive: true }); // a directory where a file is expected
      const r = await freshness.checkFreshness(dir);
      assert.equal(r.reason, "db_load_failed");
      assert.equal(r.fresh, false);
      assert.equal(r.contentChanged, true); // FAIL-pre if this branch drops contentChanged
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("freshness.enqueueRescan: atomic single-flight", () => {
  let dir;
  let restoreShim;
  before(() => { restoreShim = installSextantShim(); dir = makeRepo("rescan"); });
  after(() => {
    if (restoreShim) restoreShim();
    if (dir) {
      // Best-effort: clean any spawned scan output before tearing down.
      try { fs.rmSync(path.join(dir, ".planning"), { recursive: true, force: true }); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("first call requests, second call sees pending", () => {
    const r1 = freshness.enqueueRescan(dir);
    assert.equal(r1.state, "requested", "first enqueue must request");
    assert.ok(fs.existsSync(freshness.rescanMarkerPath(dir)), "marker must exist after request");

    const r2 = freshness.enqueueRescan(dir);
    assert.equal(r2.state, "pending", "second enqueue while marker is fresh must be pending");
    assert.ok(typeof r2.since === "number", "pending should report when the prior request started");
  });

  it("a stale marker (older than RESCAN_MARKER_STALE_MS) is replaced", () => {
    // Write an artificially-old marker manually.
    const markerPath = freshness.rescanMarkerPath(dir);
    fs.writeFileSync(
      markerPath,
      JSON.stringify({ pid: 999999, startedAt: Date.now() - 10 * 60 * 1000 })
    );

    const r = freshness.enqueueRescan(dir);
    assert.equal(r.state, "requested", "stale marker must be replaced, not honored");
  });
});

describe("freshness.clearRescanMarker", () => {
  let dir;
  before(() => { dir = makeRepo("clear"); });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("removes the marker if it exists, no-op otherwise", () => {
    fs.writeFileSync(
      freshness.rescanMarkerPath(dir),
      JSON.stringify({ pid: 1, startedAt: Date.now() })
    );
    assert.ok(fs.existsSync(freshness.rescanMarkerPath(dir)));
    freshness.clearRescanMarker(dir);
    assert.equal(fs.existsSync(freshness.rescanMarkerPath(dir)), false);

    // Second call (no marker) must not throw.
    freshness.clearRescanMarker(dir);
  });
});

describe("freshness scan-in-progress marker (cooperative watcher pause)", () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-scanmarker-"));
    fs.mkdirSync(path.join(dir, ".planning", "intel"), { recursive: true });
  });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("isScanInProgress: false with no marker, true after mark, false after clear", () => {
    assert.equal(freshness.isScanInProgress(dir), false);
    freshness.markScanInProgress(dir);
    assert.equal(freshness.isScanInProgress(dir), true);
    freshness.clearScanMarker(dir);
    assert.equal(freshness.isScanInProgress(dir), false);
  });

  it("treats a marker older than SCAN_MARKER_STALE_MS as not-in-progress (crashed scan recovers)", () => {
    freshness.markScanInProgress(dir);
    const p = freshness.scanMarkerPath(dir);
    // Backdate the marker past the stale window — simulates a scan that crashed
    // without clearing it. The watcher must resume rather than freeze forever.
    const staleSec = (Date.now() - freshness.SCAN_MARKER_STALE_MS - 5000) / 1000;
    fs.utimesSync(p, staleSec, staleSec);
    assert.equal(freshness.isScanInProgress(dir), false);
    // A fresh re-mark flips it back true (refresh-during-scan keeps it alive).
    freshness.markScanInProgress(dir);
    assert.equal(freshness.isScanInProgress(dir), true);
    freshness.clearScanMarker(dir);
  });

  it("clearScanMarker is a no-op when no marker exists", () => {
    assert.equal(fs.existsSync(freshness.scanMarkerPath(dir)), false);
    freshness.clearScanMarker(dir); // must not throw
    assert.equal(freshness.isScanInProgress(dir), false);
  });

  it("clearScanMarker leaves a marker owned by a different live pid (two concurrent scans)", () => {
    // Simulate scan B's marker, then scan A (this process) calling clear in its
    // finally — it must NOT unlink B's claim, or the watcher would resume while
    // B is still writing. A non-matching pid is preserved; ownerless/our-pid
    // markers are cleared.
    const p = freshness.scanMarkerPath(dir);
    const otherPid = process.pid + 1; // a different (here, not-running) pid stands in for scan B
    fs.writeFileSync(p, JSON.stringify({ pid: otherPid, at: new Date().toISOString() }) + "\n");
    freshness.clearScanMarker(dir);
    assert.equal(fs.existsSync(p), true, "must not clear another scan's marker");

    // Our own marker clears normally.
    freshness.markScanInProgress(dir); // rewrites with this process's pid
    freshness.clearScanMarker(dir);
    assert.equal(fs.existsSync(p), false, "must clear our own marker");
  });
});

describe("isSelfCausedStatusDrift (docs/016 blast-radius fix)", () => {
  const { execFileSync } = require("child_process");
  const graph = require("../lib/graph");
  let dir, db;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-selfdrift-"));
    fs.mkdirSync(path.join(dir, ".planning", "intel"), { recursive: true });
    const git = (...a) =>
      execFileSync("git", a, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    fs.writeFileSync(path.join(dir, "a.js"), "1");
    fs.writeFileSync(path.join(dir, "b.js"), "2");
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "base");
    db = await graph.loadDb(dir);
    freshness.recordScanState(db, dir);
  });

  after(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("recordScanState persists the dirty-path hash map (empty at a clean tree)", () => {
    const raw = graph.getMetaValue(db, freshness.META_STATUS_FILES);
    assert.deepEqual(JSON.parse(raw), { version: 2, files: {} });
  });

  it("records the status hash and dirty-file map from one stabilized pass", async () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-samepass-"));
    try {
      fs.mkdirSync(path.join(dir2, ".planning", "intel"), { recursive: true });
      const git = (...a) => execFileSync("git", a, {
        cwd: dir2,
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
      });
      fs.writeFileSync(path.join(dir2, "a.js"), "base");
      git("init", "-q");
      git("add", "-A");
      git("commit", "-qm", "base");
      fs.writeFileSync(path.join(dir2, "a.js"), "dirty-A");
      const db2 = await graph.loadDb(dir2);

      const originalRead = fs.readSync;
      let moved = false;
      fs.readSync = function(fd, buffer, offset, length, position) {
        const n = originalRead.call(this, fd, buffer, offset, length, position);
        if (!moved) {
          moved = true;
          fs.writeFileSync(path.join(dir2, "a.js"), "foreign-B");
        }
        return n;
      };
      try {
        assert.equal(freshness.recordScanState(db2, dir2), false);
      } finally {
        fs.readSync = originalRead;
      }
      assert.equal(graph.getMetaValue(db2, freshness.META_STATUS_HASH), "");
      assert.equal(graph.getMetaValue(db2, freshness.META_STATUS_FILES), "");
      assert.equal(
        freshness.isSelfCausedStatusDrift(db2, dir2, new Set()),
        false,
        "an unstable pass must not leave a newer exemption map beside an older hash"
      );
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("content re-drift on an ALREADY-dirty untouched file is FOREIGN (review MEDIUM)", async () => {
    // a.js is dirty AT scan time → present in the stored map with its hash.
    // A foreign actor then changes a.js's CONTENT again: porcelain still shows
    // the same "M a.js" line, so a presence-only comparison is blind to it.
    // The stored content hash must catch it.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-redrift-"));
    try {
      fs.mkdirSync(path.join(dir2, ".planning", "intel"), { recursive: true });
      const git = (...a) =>
        execFileSync("git", a, { cwd: dir2, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
      fs.writeFileSync(path.join(dir2, "a.js"), "committed");
      fs.writeFileSync(path.join(dir2, "c.js"), "committed");
      git("init", "-q");
      git("add", "-A");
      git("commit", "-qm", "base");
      fs.writeFileSync(path.join(dir2, "a.js"), "dirty-at-scan");
      const db2 = await graph.loadDb(dir2);
      freshness.recordScanState(db2, dir2);

      // Session touches only c.js; a.js keeps its scan-time dirty content.
      fs.writeFileSync(path.join(dir2, "c.js"), "session edit");
      assert.equal(
        freshness.isSelfCausedStatusDrift(db2, dir2, new Set(["c.js"])),
        true,
        "a.js dirty state is byte-identical to scan time → self-caused"
      );

      // Foreign actor re-modifies a.js: same porcelain line, new bytes.
      fs.writeFileSync(path.join(dir2, "a.js"), "foreign re-drift");
      assert.equal(
        freshness.isSelfCausedStatusDrift(db2, dir2, new Set(["c.js"])),
        false,
        "untouched a.js content moved since scan → foreign"
      );
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("drift confined to touched files → true; foreign drift → false", () => {
    fs.writeFileSync(path.join(dir, "a.js"), "changed");
    assert.equal(
      freshness.isSelfCausedStatusDrift(db, dir, new Set(["a.js"])),
      true,
      "only a.js drifted and a.js is touched"
    );
    assert.equal(
      freshness.isSelfCausedStatusDrift(db, dir, new Set(["b.js"])),
      false,
      "a.js drifted but only b.js is touched"
    );
    fs.writeFileSync(path.join(dir, "b.js"), "also changed");
    assert.equal(
      freshness.isSelfCausedStatusDrift(db, dir, new Set(["a.js"])),
      false,
      "b.js drift is foreign"
    );
    assert.equal(
      freshness.isSelfCausedStatusDrift(db, dir, new Set(["a.js", "b.js"])),
      true,
      "both drifted, both touched"
    );
  });

  it("a moved HEAD disqualifies the check (porcelain baseline shifted)", () => {
    const git = (...a) =>
      execFileSync("git", a, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    git("add", "-A");
    git("commit", "-qm", "moves head");
    assert.equal(
      freshness.isSelfCausedStatusDrift(db, dir, new Set(["a.js", "b.js"])),
      false,
      "HEAD moved since scan → cannot compare path lists"
    );
  });

  it("a missing stored list (pre-upgrade graph or >cap tree) → false", async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-selfdrift-bare-"));
    try {
      fs.mkdirSync(path.join(bare, ".planning", "intel"), { recursive: true });
      const db2 = await graph.loadDb(bare);
      assert.equal(freshness.isSelfCausedStatusDrift(db2, bare, new Set(["x.js"])), false);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});
