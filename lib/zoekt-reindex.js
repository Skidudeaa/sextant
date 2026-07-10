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

const STUCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

function readReindexState(root) {
  const p = reindexStatePath(root);
  try {
    const state = JSON.parse(fs.readFileSync(p, "utf8"));
    // WHY: Recovery for crashed watcher — if inProgress is stuck for >10 minutes,
    // the watcher likely died mid-reindex. Clear the flag so reindexing can resume.
    // The recorded pid is surfaced as `stuckPid` (not just dropped): the previous
    // indexer may still be ALIVE and grinding through a huge tree — clearing the
    // flag alone made the next trigger spawn a second indexer alongside it
    // (overlapping full rebuilds, one of the 101 GB incident's compounders).
    // triggerReindex kills a verified-zoekt stuck pid before spawning.
    if (state.inProgress && Date.now() - (state.inProgressSince || 0) > STUCK_TIMEOUT_MS) {
      state.inProgress = false;
      if (state.inProgressPid) state.stuckPid = state.inProgressPid;
    }
    return state;
  } catch {
    return { lastReindexMs: 0, inProgress: false };
  }
}

// Only ever kill a pid we can positively identify as a zoekt indexer — pids
// recycle, and killing an innocent process is worse than tolerating overlap.
// `ps -p <pid> -o command=` works on both macOS and Linux.
function pidLooksLikeZoekt(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    const { spawnSync } = require("child_process");
    const r = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 5000,
    });
    return r.status === 0 && /zoekt/.test(r.stdout || "");
  } catch {
    return false;
  }
}

function killStuckIndexer(state) {
  if (!state || !state.stuckPid) return false;
  if (!pidLooksLikeZoekt(state.stuckPid)) return false;
  try {
    process.kill(state.stuckPid, "SIGKILL");
    return true;
  } catch {
    return false;
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
  // A disabled lane (corpus/index-size cap tripped) stays off until a human
  // re-enables it — `sextant doctor` carries the reason and the command.
  if (require("./zoekt-scope").isDisabled(root)) return false;

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
  const scope = require("./zoekt-scope");
  if (scope.isDisabled(root)) return;

  const indexDir = zoekt.zoektIndexDir(root);
  fs.mkdirSync(indexDir, { recursive: true });

  // Hygiene before every run: interrupted indexers leak *.tmp shards nothing
  // else deletes (age-gated so a live run's in-flight files are safe).
  scope.cleanupTmpShards(indexDir);

  // Circuit breaker at trigger time: catches growth from runs whose exit
  // handler never fired (watcher died mid-index) before adding to it.
  const caps = scope.readZoektCaps(root);
  if (scope.checkIndexSizeCap(root, caps).disabled) return;

  // Determine which binary to use
  const isGit = fs.existsSync(path.join(root, ".git"));
  const bin = isGit ? "zoekt-git-index" : "zoekt-index";

  // Non-git roots get the scoped walk + corpus pre-check (see lib/zoekt-scope.js;
  // git roots index committed content, bounded by the repo).
  if (!isGit) {
    const est = scope.estimateCorpusBytes(root, { capBytes: caps.maxCorpusBytes });
    if (est.exceeded) {
      scope.writeDisabled(root, {
        reason: "corpus-too-large",
        detail: `estimated indexable corpus exceeds the ${caps.maxCorpusBytes}-byte cap (${est.reason}); refusing to index`,
      });
      return;
    }
  }

  const args = isGit
    ? ["-index", indexDir, root]
    : ["-index", indexDir, "-ignore_dirs", scope.ZOEKT_IGNORE_DIRS.join(","), root];

  // WHY: Double-check inProgress to reduce TOCTOU window between shouldReindex and here.
  // Not a true file lock, but narrows the race to near-zero for the watcher flush case.
  const state = readReindexState(root);
  if (state.inProgress) return;
  // A stuck-but-alive previous indexer gets killed (identity-verified) instead
  // of being run alongside — overlapping full rebuilds compound disk churn.
  if (killStuckIndexer(state)) delete state.stuckPid;
  state.inProgress = true;
  state.inProgressSince = Date.now();
  writeReindexState(root, state);

  const child = spawn(bin, args, {
    cwd: root,
    detached: true,
    stdio: "ignore",
  });
  state.inProgressPid = child.pid;
  writeReindexState(root, state);

  // Register exit handler BEFORE unref so we get notified
  child.on("exit", (code) => {
    const updated = readReindexState(root);
    updated.inProgress = false;
    delete updated.inProgressPid;
    if (code === 0) {
      updated.lastReindexMs = Date.now();
      updated.lastReindexOk = true;
    } else {
      updated.lastReindexOk = false;
      updated.lastReindexError = `exit code ${code}`;
    }
    writeReindexState(root, updated);
    // Post-run circuit breaker: if this run blew past the index cap despite
    // the scope controls, delete the shards and disable the lane loudly.
    if (code === 0) {
      try {
        scope.checkIndexSizeCap(root, caps);
      } catch {}
    }
  });

  child.on("error", (err) => {
    const updated = readReindexState(root);
    updated.inProgress = false;
    delete updated.inProgressPid;
    updated.lastReindexOk = false;
    updated.lastReindexError = err.message;
    writeReindexState(root, updated);
  });

  child.unref();
}

module.exports = {
  REINDEX_COOLDOWN_MS,
  STUCK_TIMEOUT_MS,
  reindexStatePath,
  readReindexState,
  writeReindexState,
  shouldReindex,
  triggerReindex,
  pidLooksLikeZoekt,
  killStuckIndexer,
};
