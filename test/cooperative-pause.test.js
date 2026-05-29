"use strict";

// Regression guard for the cooperative watcher-pause clobber bug (HIGH).
//
// The watcher's incremental graph.db write happens on a debounced timer inside
// intel.js (updateFile -> scheduleGraphPersist -> persistGraphUnlocked). An
// adversarial review proved that guarding only watch.js:flush() was
// insufficient: a persist timer armed in the window BEFORE a manual scan drops
// its .scan_in_progress marker would still fire mid-scan and overwrite the
// scan's fresh graph.db with the watcher's stale in-memory snapshot
// (SCAN_WORK_LOST). The fix moves the pause check onto the timer's persist
// callback. This test drives the real intel.js timer path and asserts the
// watcher defers its write while a scan marker is fresh, then resumes after.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const intel = require("../lib/intel");
const freshness = require("../lib/freshness");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("cooperative watcher pause — incremental persist defers to an active scan", () => {
  it("watcher's armed persist timer does NOT write graph.db while a scan marker is fresh, and resumes after it clears", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-coop-pause-"));
    try {
      fs.writeFileSync(path.join(root, "a.js"), "export const a = 1;\n");
      fs.writeFileSync(path.join(root, "b.js"), "export const b = 2;\n");
      await intel.scan(root, ["**/*.js"], {});

      const dbPath = path.join(root, ".planning", "intel", "graph.db");
      const m0 = fs.statSync(dbPath).mtimeMs;

      // A manual scan now owns graph.db.
      freshness.markScanInProgress(root);

      // The watcher indexes a new file: mutates its in-memory db AND arms the
      // debounced persist timer (the writer the flush-deferral can't reach).
      fs.writeFileSync(path.join(root, "c.js"), "export const c = 3;\n");
      await intel.updateFile(root, "c.js");

      // Wait well past the persist debounce (750ms) + one retry (1000ms): the
      // timer fires during the scan and must DEFER, leaving graph.db untouched.
      await sleep(2000);
      assert.equal(
        fs.statSync(dbPath).mtimeMs,
        m0,
        "watcher must NOT persist (clobber the scan) while the scan marker is fresh"
      );

      // Scan finishes and clears its marker; the watcher's re-armed retry now
      // persists its queued change on top of the scan's (mtime-gated) db.
      freshness.clearScanMarker(root);
      let resumed = false;
      for (let i = 0; i < 30; i++) {
        if (fs.statSync(dbPath).mtimeMs !== m0) { resumed = true; break; }
        await sleep(150);
      }
      assert.ok(resumed, "watcher must resume persisting once the scan marker clears");
    } finally {
      freshness.clearScanMarker(root);
      await sleep(50);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
