const { execSync } = require("child_process");

// WHY: Unified git info — was duplicated in summary.js, bin/intel.js, retrieve.js.
// Returns { branch, head } or null if not a git repo.
function getGitInfo(root) {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const head = execSync("git rev-parse HEAD", {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (branch && head) return { branch, head };
  } catch {}
  return null;
}

module.exports = { getGitInfo };
