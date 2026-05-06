"use strict";

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const {
  claimPidLock,
  releasePidLock,
  isPidAlive,
  pidLockPath,
} = require("../watch");

// ---------------------------------------------------------------------------
// pidLockPath
// ---------------------------------------------------------------------------

describe("pidLockPath", () => {
  it("returns .planning/intel/.watcher.pid under the given root", () => {
    const p = pidLockPath("/tmp/x");
    assert.equal(p, path.join("/tmp/x", ".planning", "intel", ".watcher.pid"));
  });
});

// ---------------------------------------------------------------------------
// isPidAlive
// ---------------------------------------------------------------------------

describe("isPidAlive", () => {
  it("returns false for null, undefined, NaN", () => {
    assert.equal(isPidAlive(null), false);
    assert.equal(isPidAlive(undefined), false);
    assert.equal(isPidAlive(NaN), false);
  });

  it("returns true for the current process", () => {
    assert.equal(isPidAlive(process.pid), true);
  });

  it("returns false for an obviously dead PID", async () => {
    // WHY: Spawn and reap a real process so we know the PID was used and is now gone.
    // Polling a fabricated high PID risks collision with running system processes.
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = child.pid;
    await new Promise((res) => child.on("exit", res));
    // Give the kernel a beat to clean the PID — usually immediate, but defensive.
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(isPidAlive(deadPid), false);
  });
});

// ---------------------------------------------------------------------------
// claimPidLock / releasePidLock
// ---------------------------------------------------------------------------

describe("claimPidLock / releasePidLock", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-pidlock-"));
  });

  after(() => {
    // beforeEach creates a fresh dir each time; each test cleans its own.
  });

  function cleanup() {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  it("claims an empty directory and writes our PID", () => {
    try {
      assert.equal(claimPidLock(tmpDir), true);
      const stored = parseInt(fs.readFileSync(pidLockPath(tmpDir), "utf8").trim(), 10);
      assert.equal(stored, process.pid);
    } finally {
      releasePidLock(tmpDir);
      cleanup();
    }
  });

  it("is idempotent within the same process (second claim succeeds)", () => {
    // WHY: the holder-PID check treats our own PID as reclaimable, so double-claim
    // from the same process never blocks itself.
    try {
      assert.equal(claimPidLock(tmpDir), true);
      assert.equal(claimPidLock(tmpDir), true);
    } finally {
      releasePidLock(tmpDir);
      cleanup();
    }
  });

  it("refuses to claim when another live PID holds the lock", async () => {
    // Spawn a long-lived child and write its PID as the lock holder.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"]);
    try {
      fs.mkdirSync(path.dirname(pidLockPath(tmpDir)), { recursive: true });
      fs.writeFileSync(pidLockPath(tmpDir), String(child.pid));
      assert.equal(claimPidLock(tmpDir), false);
      // Lockfile must remain untouched
      assert.equal(
        parseInt(fs.readFileSync(pidLockPath(tmpDir), "utf8").trim(), 10),
        child.pid
      );
    } finally {
      child.kill();
      await new Promise((res) => child.on("exit", res));
      cleanup();
    }
  });

  it("reclaims a stale lock (holder PID no longer alive)", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = child.pid;
    await new Promise((res) => child.on("exit", res));
    await new Promise((res) => setTimeout(res, 50));

    try {
      fs.mkdirSync(path.dirname(pidLockPath(tmpDir)), { recursive: true });
      fs.writeFileSync(pidLockPath(tmpDir), String(deadPid));
      assert.equal(claimPidLock(tmpDir), true);
      const stored = parseInt(fs.readFileSync(pidLockPath(tmpDir), "utf8").trim(), 10);
      assert.equal(stored, process.pid, "stale lock should be replaced by our PID");
    } finally {
      releasePidLock(tmpDir);
      cleanup();
    }
  });

  it("reclaims a lock containing garbage data", () => {
    // WHY: a corrupted lockfile (parseInt → NaN) is indistinguishable from a stale
    // lock — isPidAlive(NaN) is false, so we clean and retry.
    try {
      fs.mkdirSync(path.dirname(pidLockPath(tmpDir)), { recursive: true });
      fs.writeFileSync(pidLockPath(tmpDir), "not-a-number-at-all");
      assert.equal(claimPidLock(tmpDir), true);
      const stored = parseInt(fs.readFileSync(pidLockPath(tmpDir), "utf8").trim(), 10);
      assert.equal(stored, process.pid);
    } finally {
      releasePidLock(tmpDir);
      cleanup();
    }
  });

  it("releasePidLock removes the file only when we own it", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"]);
    try {
      fs.mkdirSync(path.dirname(pidLockPath(tmpDir)), { recursive: true });
      fs.writeFileSync(pidLockPath(tmpDir), String(child.pid));
      releasePidLock(tmpDir);
      // File should still exist because child.pid !== process.pid
      assert.equal(fs.existsSync(pidLockPath(tmpDir)), true);
    } finally {
      child.kill();
      await new Promise((res) => child.on("exit", res));
      cleanup();
    }
  });

  it("releasePidLock is a no-op when no lockfile exists", () => {
    try {
      // Must not throw
      releasePidLock(tmpDir);
      assert.equal(fs.existsSync(pidLockPath(tmpDir)), false);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// watch-stop CLI honours --root
// ---------------------------------------------------------------------------
//
// WHY: regression test for the bug where `sextant watch-stop --root /other`
// silently ignored --root and operated on process.cwd() — meaning a user
// running watch-stop from inside repo A while passing --root /repoB would
// kill repo A's watcher and leave repo B's lockfile untouched. The same
// shape applies to watch-start. Verified end-to-end on /root/manus-api-mcp
// (2026-05-06) before the fix.
const { spawnSync } = require("child_process");

describe("watch-stop CLI --root flag", () => {
  let cwdDir, targetDir;

  beforeEach(() => {
    cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-cwd-"));
    targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-target-"));
    // Lay down fake watcher state in BOTH dirs. The bug would clean cwdDir;
    // the fix must clean only targetDir.
    for (const d of [cwdDir, targetDir]) {
      fs.mkdirSync(path.join(d, ".planning", "intel"), { recursive: true });
      // Use PID 1 — guaranteed-alive but un-killable from non-root in most
      // environments; here the test runs as root, so to avoid actually
      // signalling init we use a clearly-dead high PID instead.
      fs.writeFileSync(path.join(d, ".planning", "intel", ".watcher.pid"), "2147483646");
      fs.writeFileSync(path.join(d, ".planning", "intel", ".watcher_heartbeat"), "");
    }
  });

  function cleanupDirs() {
    for (const d of [cwdDir, targetDir]) {
      if (d && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    }
  }

  it("operates on --root, not process.cwd()", () => {
    const binPath = path.resolve(__dirname, "..", "bin", "intel.js");
    try {
      const result = spawnSync(process.execPath, [binPath, "watch-stop", "--root", targetDir], {
        cwd: cwdDir,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, `watch-stop exited ${result.status}: ${result.stderr}`);

      // Target's lockfile + heartbeat must be cleaned (the bug operated on cwd
      // instead, leaving these untouched).
      assert.equal(
        fs.existsSync(path.join(targetDir, ".planning", "intel", ".watcher.pid")),
        false,
        "expected target's .watcher.pid to be cleaned"
      );
      assert.equal(
        fs.existsSync(path.join(targetDir, ".planning", "intel", ".watcher_heartbeat")),
        false,
        "expected target's heartbeat to be cleaned"
      );

      // CWD's lockfile must still exist (the bug would clean this one).
      assert.equal(
        fs.existsSync(path.join(cwdDir, ".planning", "intel", ".watcher.pid")),
        true,
        "CWD's .watcher.pid should be untouched when --root names a different dir"
      );
    } finally {
      cleanupDirs();
    }
  });
});
