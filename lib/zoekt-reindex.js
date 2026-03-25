// WHY: Extracted reindex logic so both watch.js and scan.js can trigger
// Zoekt reindexing without duplicating condition checks or state management.
// The watcher calls triggerReindex() non-blocking after each flush;
// scan.js calls buildIndex() synchronously at the end of a full scan.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { stateDir } = require("./utils");
const zoekt = require("./zoekt");

const REINDEX_COOLDOWN_MS = 3 * 60 * 1000; // 3 minutes

function reindexStatePath(root) {
  return path.join(stateDir(root), ".zoekt_reindex_state.json");
}

function readReindexState(root) {
  const p = reindexStatePath(root);
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return { lastReindexMs: 0, inProgress: false };
  }
}

function writeReindexState(root, state) {
  const p = reindexStatePath(root);
  try {
    fs.writeFileSync(p, JSON.stringify(state, null, 2) + "\n");
  } catch {}
}

// WHY: Pure condition check separated from side effects so it's testable.
// Checks all four preconditions: installed, cooldown elapsed, not in progress,
// files actually changed.
function shouldReindex(root, { filesChanged = 0, nowMs = Date.now() } = {}) {
  if (filesChanged <= 0) return false;
  if (!zoekt.isInstalled()) return false;

  const state = readReindexState(root);
  if (state.inProgress) return false;
  if (nowMs - (state.lastReindexMs || 0) < REINDEX_COOLDOWN_MS) return false;

  return true;
}

// WHY: Non-blocking spawn with detached: true + child.unref().
// The watcher must never wait for indexing — it can take 10-60s on large repos.
// We register child.on('exit') BEFORE unref() so we still get notified
// when the reindex finishes (if the watcher is still running).
function triggerReindex(root) {
  const indexDir = zoekt.zoektIndexDir(root);
  fs.mkdirSync(indexDir, { recursive: true });

  // Determine which binary to use
  const isGit = fs.existsSync(path.join(root, ".git"));
  const bin = isGit ? "zoekt-git-index" : "zoekt-index";

  const args = ["-index", indexDir, root];

  // Mark in-progress before spawning
  const state = readReindexState(root);
  state.inProgress = true;
  writeReindexState(root, state);

  const child = spawn(bin, args, {
    cwd: root,
    detached: true,
    stdio: "ignore",
  });

  // Register exit handler BEFORE unref so we get notified
  child.on("exit", (code) => {
    const updated = readReindexState(root);
    updated.inProgress = false;
    if (code === 0) {
      updated.lastReindexMs = Date.now();
      updated.lastReindexOk = true;
    } else {
      updated.lastReindexOk = false;
      updated.lastReindexError = `exit code ${code}`;
    }
    writeReindexState(root, updated);
  });

  child.on("error", (err) => {
    const updated = readReindexState(root);
    updated.inProgress = false;
    updated.lastReindexOk = false;
    updated.lastReindexError = err.message;
    writeReindexState(root, updated);
  });

  child.unref();
}

module.exports = {
  REINDEX_COOLDOWN_MS,
  reindexStatePath,
  readReindexState,
  writeReindexState,
  shouldReindex,
  triggerReindex,
};
