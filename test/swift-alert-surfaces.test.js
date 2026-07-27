"use strict";

// THE SWIFT-PARSER ALERT HAS NO TEST (found by the docs/035 step-6 verification
// fleet, reproduced here before acting on it).
//
// `grep -rn "SWIFT PARSER" test/` returned 0. The alert is sextant's only signal
// that Swift facts are MISSING from an otherwise healthy-looking index — the
// "parser failure must surface in health" invariant — and it is produced at two
// INJECTION surfaces, each calling getSwiftHealthCounters() inside a bare
// `catch {}`:
//     lib/summary.js:540  -> "ALERT: SWIFT PARSER <STATE>" in summary.md
//     lib/cli.js:380      -> "Swift parser <state>" in the blackout body
//
// So any change that makes those counters throw — dropping a table they read,
// a schema change, a rename — silently deletes the alert from both surfaces
// AND FROM THE STATUSLINE, with a fully green suite. That is the exact
// silent-honesty-kill this project exists to prevent, and it is what makes the
// swift_relations deletion proposal load-bearing rather than cosmetic:
// getSwiftHealthCounters aggregates over swift_relations.
//
// These tests assert the alert at both surfaces so the kill cannot be silent.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const graphMod = require("../lib/graph");
const { writeSummaryMarkdown } = require("../lib/summary");
const cli = require("../lib/cli");

let dir = null;
let db = null;

async function setup() {
  if (db) return { dir, db };
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-swiftalert-"));
  fs.mkdirSync(path.join(dir, ".planning", "intel"), { recursive: true });
  db = await graphMod.loadDb(dir);
  graphMod.upsertFile(db, { relPath: "Sources/App.swift", type: "swift" });
  return { dir, db };
}

describe("Swift parser ALERT reaches the surfaces that carry it", () => {
  after(() => {
    try {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  it("summary.md carries the ALERT when the parser failed and Swift files were seen", async () => {
    const s = await setup();
    graphMod.setMetaValue(s.db, "swift.parserState", "init_failed");
    graphMod.setMetaValue(s.db, "swift.filesSeen", "7");
    const md = writeSummaryMarkdown(s.dir, { db: s.db, graph: graphMod });
    assert.match(md, /ALERT: SWIFT PARSER INIT_FAILED/);
    assert.match(md, /7 file\(s\)/, "the file count is the actionable part");
    assert.match(md, /sextant doctor/, "and it names the diagnostic command");
  });

  it("the BLACKOUT body carries it too — a rescan cannot fix a parser failure", async () => {
    const s = await setup();
    graphMod.setMetaValue(s.db, "swift.parserState", "init_failed");
    graphMod.setMetaValue(s.db, "swift.filesSeen", "7");
    await graphMod.persistDb(s.dir, s.db);
    const body = await cli.buildStaleBody(
      s.dir,
      { fresh: false, reason: "head_changed", contentChanged: true },
      { state: "requested" }
    );
    assert.match(body, /Swift parser init_failed/);
    assert.match(body, /rescan won't fix this/, "the whole point: this is not a staleness problem");
  });

  it("stays SILENT on a healthy parser — the alert must not cry wolf", async () => {
    const s = await setup();
    graphMod.setMetaValue(s.db, "swift.parserState", "ok");
    graphMod.setMetaValue(s.db, "swift.filesSeen", "7");
    const md = writeSummaryMarkdown(s.dir, { db: s.db, graph: graphMod });
    assert.doesNotMatch(md, /SWIFT PARSER/);
  });

  it("stays SILENT on a repo with no Swift at all", async () => {
    const s = await setup();
    graphMod.setMetaValue(s.db, "swift.parserState", "init_failed");
    graphMod.setMetaValue(s.db, "swift.filesSeen", "0");
    const md = writeSummaryMarkdown(s.dir, { db: s.db, graph: graphMod });
    assert.doesNotMatch(md, /SWIFT PARSER/, "a JS/Python repo must never see a Swift alert");
  });

  it("getSwiftHealthCounters exposes the fields both surfaces read", async () => {
    // The bare `catch {}` at both call sites means a THROW here is invisible.
    // Assert the contract directly so a schema change that breaks it fails a
    // test instead of silently deleting an honesty surface.
    const s = await setup();
    graphMod.setMetaValue(s.db, "swift.parserState", "unavailable");
    graphMod.setMetaValue(s.db, "swift.filesSeen", "3");
    const h = graphMod.getSwiftHealthCounters(s.db);
    assert.equal(h.parserState, "unavailable");
    assert.equal(h.filesSeen, 3);
    // Aggregated over swift_relations — the table the step-6 deletion proposal
    // would remove. If it goes, THIS is what must be updated in the same change.
    assert.equal(typeof h.relationsIndexedTotal, "number");
  });
});
