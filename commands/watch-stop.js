const fs = require("fs");
const path = require("path");

async function run() {
  const root = process.cwd();
  const dir = path.join(root, ".planning", "intel");
  const hbPath = path.join(dir, ".watcher_heartbeat");
  const lockPath = path.join(dir, ".watcher.pid");
  // Find and kill the watcher process
  try {
    const { execSync } = require("child_process");
    const pids = execSync("pgrep -f 'sextant watch'", { encoding: "utf8" }).trim().split("\n");
    for (const pid of pids) {
      if (pid && pid !== String(process.pid)) {
        process.kill(parseInt(pid, 10), "SIGTERM");
      }
    }
    if (fs.existsSync(hbPath)) fs.unlinkSync(hbPath);
    // WHY: SIGTERM handler in watch.js releases the lock, but if the watcher was
    // killed hard (SIGKILL) or crashed the lockfile can linger. Remove defensively.
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    console.log("watcher stopped");
  } catch {
    console.log("no watcher running");
  }
  process.exit(0);
}

module.exports = { run };
