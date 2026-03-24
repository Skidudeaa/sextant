const { getWatcherStatus } = require("../lib/cli");

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
  console.log("watcher started (pid " + child.pid + ")");
  process.exit(0);
}

module.exports = { run };
