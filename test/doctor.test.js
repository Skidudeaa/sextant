"use strict";

// Doctor's watcher code-version action (017 lever #4): a LIVE watcher whose
// heartbeat stamp differs from the code on disk gets a restart action — an
// old-code watcher rewrites summary.md in the OLD shape on its next flush
// (bitten twice on somaNotes before this existed).

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const { codeVersionStamp } = require("../lib/utils");

const BIN = path.resolve(__dirname, "..", "bin", "intel.js");

// Hermetic env: dogfooding knobs from .claude/settings.json must not reach the
// spawned binary (see feedback: ambient env flags poison spawned-process tests).
function hermeticEnv() {
  return { ...process.env, SEXTANT_HOLDBACK_PCT: "0", SEXTANT_HOLDBACK_FORCE: "" };
}

function runDoctor(root) {
  const res = spawnSync(process.execPath, [BIN, "doctor", "--root", root], {
    encoding: "utf8",
    env: hermeticEnv(),
    timeout: 60000,
  });
  return (res.stdout || "") + (res.stderr || "");
}

describe("doctor — watcher code-version action (017 lever #4)", () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-doctor-"));
    // project marker so the root guard treats it as a project
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
  });
  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeHb(payload) {
    const iso = new Date().toISOString();
    fs.writeFileSync(
      path.join(tmpDir, ".planning", "intel", ".watcher_heartbeat"),
      iso + "\n" + JSON.stringify({ pid: process.pid, ...payload }) + "\n"
    );
  }

  it("flags a live watcher whose heartbeat stamp differs from the code on disk", () => {
    writeHb({ codeVersion: "0.0.0@0000000" });
    const out = runDoctor(tmpDir);
    assert.match(out, /Watcher running outdated code \(0\.0\.0@0000000, current /);
    assert.match(out, /watch-stop && sextant watch-start/);
  });

  it("flags a live pre-stamp watcher (no codeVersion in heartbeat)", () => {
    writeHb({});
    const out = runDoctor(tmpDir);
    assert.match(out, /Watcher running outdated code \(pre-stamp, current /);
  });

  it("no version action when the live watcher's stamp matches current code", () => {
    writeHb({ codeVersion: codeVersionStamp() });
    const out = runDoctor(tmpDir);
    assert.doesNotMatch(out, /Watcher running outdated code/);
  });
});
