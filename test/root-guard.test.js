"use strict";

// Root-sanity guard (lib/root-guard.js) — the 2026-07-10 home-dir incident
// regression suite. Two layers:
//   (1) pure checkRoot() semantics
//   (2) end-to-end: hooks/scan/init/watch spawned against refused roots must
//       exit cleanly WITHOUT creating any .planning state, and against
//       accepted roots must proceed.
// HOME is pinned per-spawn (os.homedir() reads $HOME on POSIX) so the "this
// directory IS the home dir" case is hermetic.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { checkRoot, hasProjectMarker } = require("../lib/root-guard");

const BIN = path.join(__dirname, "..", "bin", "intel.js");

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// Hermetic env: neutralize ambient overrides (dogfooding settings can carry
// SEXTANT_* vars into spawned-binary tests — see feedback memory), pin HOME.
function guardEnv(home, extra = {}) {
  return {
    ...process.env,
    HOME: home,
    SEXTANT_ALLOW_UNSAFE_ROOT: "",
    SEXTANT_HOLDBACK_PCT: "0",
    SEXTANT_HOLDBACK_FORCE: "",
    ...extra,
  };
}

// A no-op `sextant` on PATH so accepted-root hook runs don't spawn the real
// npm-linked binary (background rescans / watcher auto-start racing rmSync).
function installSextantShim() {
  const shimDir = tmp("sextant-shim-rg-");
  fs.writeFileSync(path.join(shimDir, "sextant"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(shimDir, "sextant"), 0o755);
  return {
    dir: shimDir,
    pathEnv: shimDir + path.delimiter + process.env.PATH,
    cleanup: () => {
      try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch {}
    },
  };
}

describe("root-guard — checkRoot semantics", () => {
  let dir;
  before(() => { dir = tmp("sextant-rootguard-"); });
  after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it("refuses the filesystem root", () => {
    const res = checkRoot("/", { env: {} });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "filesystem-root");
    assert.match(res.message, /allow-unsafe-root/);
  });

  it("refuses the home directory even with a project marker present", () => {
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    const res = checkRoot(dir, { env: { HOME: dir } });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "home-directory");
    fs.unlinkSync(path.join(dir, "package.json"));
  });

  it("refuses the home directory's parent (/Users, /home)", () => {
    const home = path.join(dir, "me");
    fs.mkdirSync(home, { recursive: true });
    const res = checkRoot(dir, { env: { HOME: home } });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "home-parent");
  });

  it("non-strict: allows a markerless directory (deliberate CLI use)", () => {
    const d = path.join(dir, "markerless");
    fs.mkdirSync(d, { recursive: true });
    assert.equal(checkRoot(d, { env: {} }).ok, true);
  });

  it("strict: refuses a markerless directory with reason no-project-marker", () => {
    const d = path.join(dir, "markerless2");
    fs.mkdirSync(d, { recursive: true });
    const res = checkRoot(d, { requireMarker: true, env: {} });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "no-project-marker");
  });

  it("strict: accepts .git / package.json / .planning-intel markers", () => {
    for (const marker of [".git", "package.json", path.join(".planning", "intel")]) {
      const d = path.join(dir, `marked-${marker.replace(/[^a-z]/gi, "_")}`);
      fs.mkdirSync(path.join(d, marker), { recursive: true });
      assert.equal(checkRoot(d, { requireMarker: true, env: {} }).ok, true, `marker ${marker}`);
      assert.equal(hasProjectMarker(d), true);
    }
  });

  it("SEXTANT_ALLOW_UNSAFE_ROOT=1 overrides every refusal", () => {
    const res = checkRoot(dir, {
      requireMarker: true,
      env: { HOME: dir, SEXTANT_ALLOW_UNSAFE_ROOT: "1" },
    });
    assert.equal(res.ok, true);
  });

  it("--allow-unsafe-root in argv overrides every refusal", () => {
    const res = checkRoot(dir, {
      requireMarker: true,
      env: { HOME: dir },
      argv: ["node", "intel.js", "scan", "--allow-unsafe-root"],
    });
    assert.equal(res.ok, true);
  });

  it('config "allowUnsafeRoot": true overrides (and the file itself is a marker)', () => {
    const d = path.join(dir, "cfg-override");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, ".codebase-intel.json"), JSON.stringify({ allowUnsafeRoot: true }));
    const res = checkRoot(d, { requireMarker: true, env: { HOME: d } });
    assert.equal(res.ok, true);
  });
});

describe("root-guard — hooks refuse without creating state", () => {
  let markerless, fakeHome, shim;
  before(() => {
    markerless = tmp("sextant-rg-markerless-");
    fakeHome = tmp("sextant-rg-home-");
    // fakeHome gets a marker to prove home-refusal beats markers.
    fs.writeFileSync(path.join(fakeHome, "package.json"), "{}");
    shim = installSextantShim();
  });
  after(() => {
    shim.cleanup();
    for (const d of [markerless, fakeHome]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });

  function runHook(hookName, cwd, home, input = "{}") {
    return spawnSync(process.execPath, [BIN, "hook", hookName], {
      cwd,
      input,
      encoding: "utf8",
      timeout: 30000,
      env: guardEnv(home, { PATH: shim.pathEnv }),
    });
  }

  it("sessionstart in a markerless dir: honest OFF note, exit 0, NO .planning created", () => {
    const res = runHook("sessionstart", markerless, fakeHome);
    assert.equal(res.status, 0);
    assert.match(res.stdout || "", /<codebase-intelligence>/);
    assert.match(res.stdout || "", /OFF/);
    assert.match(res.stdout || "", /no project marker/);
    assert.equal(fs.existsSync(path.join(markerless, ".planning")), false, "must not create state");
  });

  it("sessionstart in the home directory: refused despite package.json marker", () => {
    const res = runHook("sessionstart", fakeHome, fakeHome);
    assert.equal(res.status, 0);
    assert.match(res.stdout || "", /home directory/);
    assert.equal(fs.existsSync(path.join(fakeHome, ".planning")), false, "must not create state");
  });

  it("refresh in a markerless dir: silent exit 0, NO .planning created", () => {
    const res = runHook("refresh", markerless, fakeHome, JSON.stringify({ prompt: "how does resolveImportPath work?" }));
    assert.equal(res.status, 0);
    assert.equal((res.stdout || "").trim(), "", "refusal must be silent (SessionStart already spoke)");
    assert.equal(fs.existsSync(path.join(markerless, ".planning")), false);
  });

  it("posttooluse in a markerless dir: silent exit 0, NO .planning created", () => {
    const res = runHook(
      "posttooluse",
      markerless,
      fakeHome,
      JSON.stringify({ tool_name: "Edit", tool_input: { file_path: path.join(markerless, "a.js") }, session_id: "s1" })
    );
    assert.equal(res.status, 0);
    assert.equal((res.stdout || "").trim(), "");
    assert.equal(fs.existsSync(path.join(markerless, ".planning")), false);
  });

  it("sessionstart in a marked dir proceeds (positive control — guard is not a blanket off-switch)", () => {
    const marked = tmp("sextant-rg-marked-");
    fs.writeFileSync(path.join(marked, "package.json"), JSON.stringify({ name: "fixture" }));
    fs.writeFileSync(path.join(marked, "a.js"), "module.exports = 1;\n");
    try {
      const res = runHook("sessionstart", marked, fakeHome);
      assert.equal(res.status, 0);
      assert.doesNotMatch(res.stdout || "", /is OFF for this session/);
      assert.equal(fs.existsSync(path.join(marked, ".planning", "intel")), true, "state dir should exist after accepted init");
    } finally {
      try { fs.rmSync(marked, { recursive: true, force: true }); } catch {}
    }
  });
});

describe("root-guard — CLI surfaces", () => {
  let fakeHome, shim;
  before(() => {
    fakeHome = tmp("sextant-rg-clihome-");
    fs.writeFileSync(path.join(fakeHome, "package.json"), "{}");
    shim = installSextantShim();
  });
  after(() => {
    shim.cleanup();
    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
  });

  function runCli(args, cwd, home, extraEnv = {}) {
    return spawnSync(process.execPath, [BIN, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 60000,
      env: guardEnv(home, { PATH: shim.pathEnv, ...extraEnv }),
    });
  }

  it("scan in the home directory: exit 2 with the refusal on stderr", () => {
    const res = runCli(["scan"], fakeHome, fakeHome);
    assert.equal(res.status, 2);
    assert.match(res.stderr || "", /refusing to index the home directory/);
    assert.equal(fs.existsSync(path.join(fakeHome, ".planning")), false);
  });

  it("scan in a markerless temp dir proceeds (deliberate use, non-strict)", () => {
    const d = tmp("sextant-rg-scanok-");
    fs.writeFileSync(path.join(d, "a.js"), "module.exports = 1;\n");
    try {
      const res = runCli(["scan"], d, fakeHome);
      assert.equal(res.status, 0, `stderr: ${res.stderr}`);
      assert.equal(fs.existsSync(path.join(d, ".planning", "intel")), true);
    } finally {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });

  it("scan --allow-unsafe-root in the home directory proceeds", () => {
    const d = tmp("sextant-rg-scanhome-");
    fs.writeFileSync(path.join(d, "a.js"), "module.exports = 1;\n");
    try {
      const res = runCli(["scan", "--allow-unsafe-root"], d, d);
      assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    } finally {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });

  it("init in the home directory: exit 2 (would wire GLOBAL Claude settings)", () => {
    const res = runCli(["init"], fakeHome, fakeHome);
    assert.equal(res.status, 2);
    assert.match(res.stderr || "", /refusing to index the home directory/);
    assert.equal(fs.existsSync(path.join(fakeHome, ".claude")), false, "must not wire hooks");
  });

  it("watch in a markerless dir: exit 2 with the strict refusal", () => {
    const d = tmp("sextant-rg-watch-");
    try {
      const res = runCli(["watch", "--no-dashboard"], d, fakeHome);
      assert.equal(res.status, 2);
      assert.match(res.stderr || "", /no project marker/);
      assert.equal(fs.existsSync(path.join(d, ".planning")), false);
    } finally {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });
});
