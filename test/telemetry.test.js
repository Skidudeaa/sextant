"use strict";

// Tests for lib/telemetry.js -- append-only JSONL events feeding the
// future Option-5 adaptive sync/async decision.  Coverage:
//   - recordEvent appends valid JSON lines
//   - readEvents round-trips
//   - rotation kicks in past TELEMETRY_MAX_BYTES
//   - failures are silent (never throw)
//   - malformed lines are skipped on read

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const telemetry = require("../lib/telemetry");

function makeRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sextant-tel-${prefix}-`));
  fs.mkdirSync(path.join(dir, ".planning", "intel"), { recursive: true });
  return dir;
}

describe("telemetry.recordEvent + readEvents", () => {
  let dir;
  before(() => { dir = makeRepo("basic"); });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("round-trips events", () => {
    telemetry.recordEvent(dir, "test.first", { a: 1 });
    telemetry.recordEvent(dir, "test.second", { reason: "x" });

    const events = telemetry.readEvents(dir);
    assert.equal(events.length, 2);
    assert.equal(events[0].name, "test.first");
    assert.equal(events[0].a, 1);
    assert.ok(typeof events[0].ts === "number");
    assert.equal(events[1].name, "test.second");
    assert.equal(events[1].reason, "x");
  });

  it("readEvents returns [] when file missing", () => {
    const empty = makeRepo("empty");
    try {
      assert.deepEqual(telemetry.readEvents(empty), []);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("readEvents skips malformed lines without throwing", () => {
    const file = telemetry.telemetryPath(dir);
    fs.appendFileSync(file, "not-json-at-all\n");
    fs.appendFileSync(file, '{"name":"test.valid","ts":1}\n');

    const events = telemetry.readEvents(dir);
    // The bad line is skipped; the valid one is parsed.
    const names = events.map((e) => e.name);
    assert.ok(names.includes("test.valid"));
  });
});

describe("telemetry rotation", () => {
  let dir;
  before(() => { dir = makeRepo("rotate"); });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("rotates the active file to .old when it exceeds TELEMETRY_MAX_BYTES", () => {
    const file = telemetry.telemetryPath(dir);
    const oldFile = telemetry.telemetryOldPath(dir);

    // Pre-fill the active file just over the threshold.
    const filler = "x".repeat(telemetry.TELEMETRY_MAX_BYTES + 1024);
    fs.writeFileSync(file, filler);

    // Next write should trigger rotation.
    telemetry.recordEvent(dir, "test.after_rotate", {});

    assert.ok(fs.existsSync(oldFile), ".old should exist after rotation");
    const activeContents = fs.readFileSync(file, "utf8");
    // Active file now starts fresh, containing only our latest event.
    assert.ok(activeContents.includes("test.after_rotate"));
    assert.ok(!activeContents.includes("xxxx"), "active file should not retain pre-rotation filler");
  });
});

describe("telemetry never throws", () => {
  let dir;
  before(() => { dir = makeRepo("nothrow"); });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("recordEvent absorbs unserializable payload silently", () => {
    // Self-referential object -> JSON.stringify throws.  recordEvent's job
    // is to swallow that and still return -- a hot-path logger that
    // crashes its caller is worse than a dropped event.
    const cycle = {};
    cycle.self = cycle;
    assert.doesNotThrow(() =>
      telemetry.recordEvent(dir, "test.cycle", { obj: cycle })
    );
  });

  it("recordEvent absorbs malformed root types", () => {
    // Hot path may receive null/undefined/non-string roots from a degraded
    // hook context.  Must not throw.  We avoid testing /proc-style paths
    // because Linux's procfs makes mkdirSync hang for paths under /proc.
    assert.doesNotThrow(() => telemetry.recordEvent(null, "test.null", {}));
    assert.doesNotThrow(() => telemetry.recordEvent(undefined, "test.und", {}));
    assert.doesNotThrow(() => telemetry.recordEvent(42, "test.num", {}));
  });
});
