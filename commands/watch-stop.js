const fs = require("fs");
const path = require("path");

async function run() {
  const root = process.cwd();
  const hbPath = path.join(root, ".planning", "intel", ".watcher_heartbeat");
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
    console.log("watcher stopped");
  } catch {
    console.log("no watcher running");
  }
  process.exit(0);
}

module.exports = { run };
