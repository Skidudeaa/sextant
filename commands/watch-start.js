const { getWatcherStatus } = require("../lib/cli");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  const root = process.cwd();
  const ws = getWatcherStatus(root);
  if (ws.running) {
    console.log("watcher already running (" + ws.ageSec + "s ago)");
    process.exit(0);
  }
  const { spawn: spawnChild } = require("child_process");
  const child = spawnChild("sextant", ["watch"], {
    cwd: root,
    stdio: "ignore",
    detached: true,
  });
  child.unref();

  // WHY: previously we printed "watcher started (pid X)" immediately after
  // spawn and exited, which lied when the child quickly failed (e.g. lost
  // the PID lockfile race against an existing zombie, or the binary threw
  // during init).  Wait briefly and verify via the heartbeat file — that's
  // the same ground truth used by getWatcherStatus, statusline, doctor, and
  // the SessionStart hook.  Report either the verified PID from the lock
  // file (the actual long-lived watcher) or surface the failure honestly.
  const path = require("path");
  const fs = require("fs");
  const lockPath = path.join(root, ".planning", "intel", ".watcher.pid");

  let verified = false;
  let lockedPid = null;
  for (let i = 0; i < 12 && !verified; i++) {
    await sleep(100);
    const stat = getWatcherStatus(root);
    if (stat.running) {
      verified = true;
      try { lockedPid = parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10); } catch {}
    }
  }

  if (verified) {
    const pidStr = lockedPid && Number.isFinite(lockedPid) ? lockedPid : child.pid;
    console.log("watcher started (pid " + pidStr + ", root " + root + ")");
    process.exit(0);
  } else {
    console.error(
      "watcher failed to start within 1.2s — no heartbeat detected.\n" +
      "  Check: sextant watch  (runs foreground to see errors)\n" +
      "  Or:    tail -f " + path.join(root, ".planning", "intel", "zoekt", "webserver.log")
    );
    process.exit(1);
  }
}

module.exports = { run };
