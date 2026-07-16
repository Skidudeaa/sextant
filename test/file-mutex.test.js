"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const mutexPath = path.resolve(__dirname, "..", "lib", "file-mutex.js");

function deadPid() {
  return 2_147_483_647;
}

function runWorker(base, counter) {
  const source = [
    `const fs = require("fs");`,
    `const mutex = require(${JSON.stringify(mutexPath)});`,
    `const base = process.argv[1];`,
    `const counter = process.argv[2];`,
    `const lock = mutex.acquireFileMutex(base, { attempts: 1000, waitMs: 2, staleMs: 10 });`,
    `if (!lock) process.exit(2);`,
    `const value = Number(fs.readFileSync(counter, "utf8"));`,
    `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3);`,
    `fs.writeFileSync(counter, String(value + 1));`,
    `mutex.releaseFileMutex(lock);`,
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", source, base, counter], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`mutex worker exited ${code}: ${stderr}`)));
  });
}

describe("file mutex", () => {
  it("fails closed when contender enumeration is unavailable", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sx-file-mutex-enum-"));
    const base = path.join(root, "state.lock");
    const original = fs.readdirSync;
    let injectFailure = true;
    try {
      fs.readdirSync = function patched(directory, ...args) {
        const requested = Buffer.isBuffer(directory) ? directory.toString() : directory;
        if (injectFailure && path.resolve(requested) === path.resolve(root)) {
          const error = new Error("synthetic enumeration failure");
          error.code = "EIO";
          throw error;
        }
        return original.call(this, directory, ...args);
      };
      const mutex = require("../lib/file-mutex");
      assert.equal(mutex.acquireFileMutex(base, {
        attempts: 2,
        waitMs: 1,
        staleMs: 10,
      }), null);
    } finally {
      // Node may lazily capture the wrapper in its internal rimraf helper.
      // Disable injection before restoring so later cleanup cannot be poisoned.
      injectFailure = false;
      fs.readdirSync = original;
      assert.deepEqual(
        original(root).filter((name) => name.startsWith("state.lock.candidate.")),
        []
      );
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("serializes contenders after a stale v2 generation without split ownership", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sx-file-mutex-"));
    try {
      const base = path.join(root, "state.lock");
      const counter = path.join(root, "counter");
      const token = "f".repeat(32);
      const stale = `${base}.candidate.${token}`;
      fs.writeFileSync(stale, JSON.stringify({
        schemaVersion: 1,
        token,
        pid: deadPid(),
        processStartIdentity: "dead-generation",
        choosing: false,
        ticket: 1,
        createdAt: 1,
      }), {
        mode: 0o600,
      });
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(stale, old, old);
      fs.writeFileSync(counter, "0");

      await Promise.all(Array.from({ length: 12 }, () => runWorker(base, counter)));
      assert.equal(Number(fs.readFileSync(counter, "utf8")), 12);
      assert.equal(fs.existsSync(stale), false);
      assert.deepEqual(
        fs.readdirSync(root).filter((name) => name.startsWith("state.lock.candidate.")),
        []
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a dead legacy fixed path as a tombstone while allowing v2 ownership", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sx-file-mutex-legacy-"));
    try {
      const base = path.join(root, "state.lock");
      fs.writeFileSync(base, JSON.stringify({
        token: "a".repeat(32),
        pid: deadPid(),
        createdAt: 1,
      }), { mode: 0o600 });
      const mutex = require("../lib/file-mutex");
      const lock = mutex.acquireFileMutex(base, {
        attempts: 2,
        waitMs: 1,
        staleMs: 10,
      });
      assert.ok(lock);
      assert.equal(fs.existsSync(base), true);
      mutex.releaseFileMutex(lock);
      assert.equal(fs.existsSync(base), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on live or malformed legacy fixed-path ownership", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sx-file-mutex-legacy-live-"));
    try {
      const mutex = require("../lib/file-mutex");
      const liveBase = path.join(root, "live.lock");
      fs.writeFileSync(liveBase, JSON.stringify({
        token: "c".repeat(32),
        pid: process.pid,
        createdAt: 1,
      }), { mode: 0o600 });
      assert.equal(mutex.acquireFileMutex(liveBase, {
        attempts: 2, waitMs: 1, staleMs: 10,
      }), null);

      const malformedBase = path.join(root, "malformed.lock");
      fs.writeFileSync(malformedBase, "{", { mode: 0o600 });
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(malformedBase, old, old);
      assert.equal(mutex.acquireFileMutex(malformedBase, {
        attempts: 2, waitMs: 1, staleMs: 10,
      }), null);
      assert.equal(fs.existsSync(malformedBase), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not age out a live v2 owner when its process generation is unavailable", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sx-file-mutex-live-"));
    try {
      const base = path.join(root, "state.lock");
      const token = "b".repeat(32);
      const owner = `${base}.candidate.${token}`;
      fs.writeFileSync(owner, JSON.stringify({
        schemaVersion: 1,
        token,
        pid: process.pid,
        processStartIdentity: null,
        choosing: false,
        ticket: 1,
        createdAt: 1,
      }), { mode: 0o600 });
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(owner, old, old);

      const mutex = require("../lib/file-mutex");
      assert.equal(mutex.acquireFileMutex(base, {
        attempts: 2,
        waitMs: 1,
        staleMs: 10,
      }), null);
      assert.equal(fs.existsSync(owner), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
