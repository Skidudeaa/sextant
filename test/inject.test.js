"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

// WHY: regression test for the bug where `sextant inject --root /other`
// silently ignored --root and injected from process.cwd(). This was the
// same shape as the watch-start / watch-stop bug fixed in 4a89721 — the
// command hardcoded process.cwd() instead of going through the shared
// rootsFromArgs() parser.

describe("inject CLI --root flag", () => {
  let cwdDir, targetDir;
  const binPath = path.resolve(__dirname, "..", "bin", "intel.js");

  beforeEach(() => {
    cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-inject-cwd-"));
    targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-inject-target-"));
    // Lay down a non-empty summary in both dirs so the inject command finds
    // something to read in either case. The freshness gate may strip custom
    // markers on stale state — instead we assert on the Root path, which the
    // gate preserves and which is the most direct signal of which dir was used.
    for (const d of [cwdDir, targetDir]) {
      const intelDir = path.join(d, ".planning", "intel");
      fs.mkdirSync(intelDir, { recursive: true });
      fs.writeFileSync(
        path.join(intelDir, "summary.md"),
        `## Codebase intelligence\n\n- **Root**: \`${d}\`\n`
      );
    }
  });

  function cleanupDirs() {
    for (const d of [cwdDir, targetDir]) {
      if (d && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    }
  }

  it("injects --root's summary, not cwd's", () => {
    try {
      const result = spawnSync(process.execPath, [binPath, "inject", "--root", targetDir], {
        cwd: cwdDir,
        encoding: "utf8",
        timeout: 30000,
      });
      assert.equal(result.status, 0, `inject exited ${result.status}: ${result.stderr}`);

      // Output must reference targetDir as the Root — proves --root was honoured.
      assert.ok(
        result.stdout.includes(targetDir),
        `expected targetDir path in stdout, got: ${result.stdout.slice(0, 400)}`
      );

      // And must NOT reference cwdDir's path — proves the bug is fixed.
      assert.ok(
        !result.stdout.includes(cwdDir),
        `cwdDir path leaked into output: ${result.stdout.slice(0, 400)}`
      );

      // Sanity: output is wrapped in the expected XML envelope.
      assert.ok(
        result.stdout.includes("<codebase-intelligence>"),
        "output should be wrapped in <codebase-intelligence> tag"
      );
    } finally {
      cleanupDirs();
    }
  });
});
