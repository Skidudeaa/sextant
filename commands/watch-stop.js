const fs = require("fs");
const path = require("path");

async function run() {
  const root = process.cwd();
  const dir = path.join(root, ".planning", "intel");
  const hbPath = path.join(dir, ".watcher_heartbeat");
  const lockPath = path.join(dir, ".watcher.pid");

  // WHY: scope the kill to THIS root's watcher only. The previous
  // implementation used `pgrep -f 'sextant watch'` which matched every sextant
  // watcher on the machine — running watch-stop in one project silently killed
  // watchers for every other project on the same host.  The PID lockfile is
  // the source of truth for "who owns this root's watcher"; use it.
  let pid = null;
  try {
    pid = parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
  } catch {}

  if (!pid || !Number.isFinite(pid)) {
    if (fs.existsSync(hbPath)) fs.unlinkSync(hbPath);
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    console.log("no watcher running for " + root);
    process.exit(0);
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log("watcher stopped (pid " + pid + ", root " + root + ")");
  } catch (e) {
    // ESRCH = already dead; that's fine, just clean up the lock
    if (e.code !== "ESRCH") {
      console.error("kill " + pid + " failed: " + e.message);
      process.exit(1);
    }
    console.log("watcher process " + pid + " was already dead (cleaning stale lock)");
  }

  if (fs.existsSync(hbPath)) fs.unlinkSync(hbPath);
  // WHY: SIGTERM handler in watch.js releases the lock, but if the watcher was
  // killed hard (SIGKILL) or crashed the lockfile can linger. Remove defensively.
  if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  process.exit(0);
}

module.exports = { run };
