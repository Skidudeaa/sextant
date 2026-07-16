"use strict";

// Phase-F outcome experiment substrate.
//
// This module deliberately does not render context and does not append telemetry.
// It only assigns a sticky experimental arm, keeps a short per-session exposure
// window, and returns flat events for the caller to record. The control arm is
// named `holdback`; the treatment arm is `armed`.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const fileMutex = require("./file-mutex");

const SCHEMA_VERSION = 1;
const EXPERIMENT_NAME = "overlap-holdback-v1";
const HOLD_BACK_PCT = 50;
const TOUCH_LIMIT = 8;
const WINDOW_TTL_MS = 30 * 60 * 1000;
const MAX_PATHS = 50;
const MAX_WINDOWS = 16;
const MAX_SEEN_OPPORTUNITIES = 128;
const MAX_PATH_BYTES = 512;
const MAX_STATE_BYTES = 512 * 1024;
const STATE_PREFIX = ".coherence-experiment.";
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_STATE_FILES = 2048;
const LOCK_ATTEMPTS = 25;
const LOCK_WAIT_MS = 2;
const LOCK_STALE_MS = 60 * 1000;

const EVENT_OPENED = "coherence.experiment.window_opened";
const EVENT_DEDUPED = "coherence.experiment.window_deduped";
const EVENT_CLOSED = "coherence.experiment.window_closed";
const EVENT_OBSERVATION_FAILED = "coherence.experiment.observation_failed";

function own(object, key) {
  return !!object && Object.prototype.hasOwnProperty.call(object, key);
}

function finiteTime(value, fallback = Date.now()) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : Math.floor(fallback);
}

function boundedOpaque(value, maxBytes = 160) {
  if (typeof value !== "string" || value.length === 0) return null;
  if (/[\0\r\n]/.test(value) || Buffer.byteLength(value, "utf8") > maxBytes) return null;
  return value;
}

function hashOpaque(kind, value, length = 20) {
  return crypto
    .createHash("sha256")
    .update(kind)
    .update("\0")
    .update(value)
    .digest("hex")
    .slice(0, length);
}

function forcedArm(options, env, config) {
  const candidate =
    (own(options, "force") ? options.force : undefined) ??
    (own(env, "SEXTANT_COHERENCE_HOLDBACK_FORCE")
      ? env.SEXTANT_COHERENCE_HOLDBACK_FORCE
      : undefined) ??
    (config && config.coherenceExperiment && config.coherenceExperiment.force) ??
    (config && config.coherenceHoldbackForce);
  return candidate === "armed" || candidate === "holdback" ? candidate : null;
}

function configuredPct(options, env, config) {
  let value;
  if (own(options, "holdbackPct")) {
    value = options.holdbackPct;
  } else if (own(env, "SEXTANT_COHERENCE_HOLDBACK_PCT")) {
    value = env.SEXTANT_COHERENCE_HOLDBACK_PCT;
  } else if (config && config.coherenceExperiment && own(config.coherenceExperiment, "holdbackPct")) {
    value = config.coherenceExperiment.holdbackPct;
  } else if (config && own(config, "coherenceHoldbackPct")) {
    value = config.coherenceHoldbackPct;
  } else if (config && own(config, "holdbackPct")) {
    value = config.holdbackPct;
  } else {
    value = 0;
  }
  // Phase F intentionally has one experiment design: a balanced 50/50 split.
  // Any other value is off, rather than silently changing statistical power.
  return Number(value) === HOLD_BACK_PCT ? HOLD_BACK_PCT : 0;
}

// Deterministic assignment makes an opaque task stay in one arm across prompts,
// processes, and retries. Default-off means normal behavior remains `armed` but
// `enabled` is false, so callers must not count it as an experimental exposure.
function assignArm(taskId, options = {}) {
  try {
    const rawTask = boundedOpaque(taskId, 1024);
    if (!rawTask) {
      return {
        enabled: false,
        arm: "armed",
        taskKey: null,
        holdbackPct: 0,
        assignmentMode: "off",
      };
    }
    const env = options && options.env && typeof options.env === "object"
      ? options.env
      : process.env;
    const config = options && options.config && typeof options.config === "object"
      ? options.config
      : {};
    // Use the exact same opaque join key as coherence.report/lifecycle events.
    // Assignment still uses its own digest below so changing a telemetry label
    // can never reshuffle an already-running experiment.
    const taskKey = require("./coherence-metrics").opaqueTaskKey(rawTask);
    const taskDigest = hashOpaque("coherence-task-v1", rawTask, 24);
    const force = forcedArm(options || {}, env, config);
    if (force) {
      return {
        enabled: true,
        arm: force,
        taskKey,
        holdbackPct: HOLD_BACK_PCT,
        assignmentMode: "forced",
      };
    }
    const pct = configuredPct(options || {}, env, config);
    if (pct !== HOLD_BACK_PCT) {
      return {
        enabled: false,
        arm: "armed",
        taskKey,
        holdbackPct: 0,
        assignmentMode: "off",
      };
    }
    const bucket = parseInt(taskDigest.slice(0, 8), 16) / 0x100000000;
    return {
      enabled: true,
      arm: bucket < pct / 100 ? "holdback" : "armed",
      taskKey,
      holdbackPct: pct,
      assignmentMode: "randomized",
    };
  } catch {
    return {
      enabled: false,
      arm: "armed",
      taskKey: null,
      holdbackPct: 0,
      assignmentMode: "off",
    };
  }
}

function repoRelativePath(value) {
  try {
    if (typeof value !== "string" || !value || /[\0\r\n]/.test(value)) return null;
    if (Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES) return null;
    const slashed = value.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!slashed || slashed === "." || slashed.startsWith("/") || /^[A-Za-z]:\//.test(slashed)) {
      return null;
    }
    if (slashed.split("/").some((segment) => segment === "..")) return null;
    const normalized = path.posix.normalize(slashed);
    if (
      !normalized ||
      normalized === "." ||
      normalized === ".." ||
      normalized.startsWith("../") ||
      normalized.startsWith("/")
    ) return null;
    return normalized;
  } catch {
    return null;
  }
}

function normalizePaths(values) {
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const rel = repoRelativePath(value);
    if (!rel) continue;
    seen.add(rel);
  }
  return [...seen].sort((a, b) => a.localeCompare(b)).slice(0, MAX_PATHS);
}

// Extract the exact file paths represented by an eligible Phase-F overlap
// result. Regions are not promoted into paths and invalid/unbounded values are
// dropped. The caller still decides whether either arm renders the report.
function eligiblePaths(result) {
  try {
    const values = [];
    for (const overlap of result && Array.isArray(result.overlaps) ? result.overlaps : []) {
      for (const rel of overlap && Array.isArray(overlap.sharedPaths) ? overlap.sharedPaths : []) {
        values.push(rel);
      }
    }
    return normalizePaths(values);
  } catch {
    return [];
  }
}

function opportunityKey(incidentId, surface) {
  try {
    const incident = boundedOpaque(incidentId, 160);
    const boundarySurface = boundedOpaque(surface, 64);
    if (!incident || !boundarySurface) return null;
    return `copportunity_${hashOpaque(
      "coherence-opportunity-v1",
      `${incident}\0${boundarySurface}`,
      24
    )}`;
  } catch {
    return null;
  }
}

function sessionIdentity(sessionKey) {
  const raw = boundedOpaque(sessionKey, 1024);
  return raw ? hashOpaque("coherence-session-v1", raw, 24) : null;
}

function experimentStatePath(root, sessionKey) {
  try {
    if (typeof root !== "string" || !root) return null;
    const sessionHash = sessionIdentity(sessionKey);
    if (!sessionHash) return null;
    return path.join(path.resolve(root), ".planning", "intel", `${STATE_PREFIX}${sessionHash}.json`);
  } catch {
    return null;
  }
}

function experimentLockPath(root, sessionKey) {
  const statePath = experimentStatePath(root, sessionKey);
  return statePath ? statePath.replace(/\.json$/, ".lock") : null;
}

function experimentActivePath(root, sessionKey) {
  const statePath = experimentStatePath(root, sessionKey);
  return statePath ? statePath.replace(/\.json$/, ".active") : null;
}

function stateFileHasLiveWindow(file, nowMs) {
  try {
    const match = path.basename(file).match(
      /^\.coherence-experiment\.([a-f0-9]{24})\.json$/
    );
    if (!match) return false;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_STATE_BYTES) return false;
    const state = normalizeState(JSON.parse(fs.readFileSync(file, "utf8")), match[1]);
    return state.windows.some(
      (window) => window.totalTouches < TOUCH_LIMIT && nowMs < window.expiresAt
    );
  } catch {
    return false;
  }
}

function gcExperimentSidecars(directory, options = {}) {
  let removed = 0;
  try {
    const now = finiteTime(options.nowMs);
    const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : STATE_TTL_MS;
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const file = path.join(directory, entry.name);
      const candidate = entry.name.match(
        /^(\.coherence-experiment\.[a-f0-9]{24}\.lock)\.candidate\.[a-f0-9]{32}$/
      );
      const legacy = entry.name.match(
        /^(\.coherence-experiment\.[a-f0-9]{24}\.lock)$/
      );
      if (candidate || legacy) {
        const base = path.join(directory, (candidate || legacy)[1]);
        const observed = fileMutex.readCandidate(file);
        if (fileMutex.removeDeadCandidate(file, base, observed, LOCK_STALE_MS, now)) removed++;
        continue;
      }

      const tmp = entry.name.match(
        /^\.coherence-experiment\.[a-f0-9]{24}\.(?:json|active)\.(\d+)\.[a-f0-9]{12}\.tmp$/
      );
      if (tmp) {
        try {
          const stat = fs.lstatSync(file);
          const pid = Number(tmp[1]);
          if (
            stat.isFile() && now - stat.mtimeMs > ttlMs &&
            !fileMutex.processIsLive(pid)
          ) {
            fs.rmSync(file);
            removed++;
          }
        } catch {}
        continue;
      }

      const active = entry.name.match(
        /^(\.coherence-experiment\.[a-f0-9]{24})\.active$/
      );
      if (active) {
        const stateFile = path.join(directory, `${active[1]}.json`);
        if (stateFileHasLiveWindow(stateFile, now)) continue;
        const lock = acquireLockFile(path.join(directory, `${active[1]}.lock`));
        if (!lock) continue;
        try {
          if (!stateFileHasLiveWindow(stateFile, now)) {
            fs.rmSync(file, { force: true });
            removed++;
          }
        } catch {
          // A malformed non-file marker fails closed and remains inspectable.
        } finally {
          releaseLock(lock);
        }
      }
    }
  } catch {}
  return removed;
}

// Per-session state is intentionally small, but session ids are unbounded over
// the life of a repo. Prune only logically inactive state, never the current
// enrollment and never a state with a live window or lock. The cap is therefore
// soft only when more than MAX_STATE_FILES sessions are simultaneously active.
function gcExperimentStates(root, options = {}) {
  let gcLock = null;
  try {
    if (typeof root !== "string" || !root) return { scanned: 0, removed: 0 };
    const directory = path.join(path.resolve(root), ".planning", "intel");
    fs.mkdirSync(directory, { recursive: true });
    gcLock = acquireLockFile(path.join(directory, ".coherence-experiment.gc.lock"), {
      attempts: 1,
      waitMs: 0,
    });
    // Another collector owns the repo-wide snapshot/cap decision. Skipping is
    // safer and cheaper than letting two private entry counts over-prune.
    if (!gcLock) return { scanned: 0, removed: 0, sidecarsRemoved: 0, skipped: true };
    const now = finiteTime(options.nowMs);
    const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs >= WINDOW_TTL_MS
      ? Math.floor(options.ttlMs)
      : STATE_TTL_MS;
    const maxFiles = Number.isInteger(options.maxFiles) && options.maxFiles >= 1
      ? options.maxFiles
      : MAX_STATE_FILES;
    const currentFile = typeof options.currentFile === "string"
      ? path.resolve(options.currentFile)
      : null;
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() &&
        /^\.coherence-experiment\.[a-f0-9]{24}\.json$/.test(entry.name))
      .map((entry) => {
        const file = path.join(directory, entry.name);
        try {
          const stat = fs.lstatSync(file);
          return stat.isFile() ? {
            file,
            mtimeMs: stat.mtimeMs,
            dev: stat.dev,
            ino: stat.ino,
          } : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    let removed = 0;
    const removedFiles = new Set();
    const remove = (entry) => {
      if (!entry || entry.file === currentFile) return false;
      const lock = acquireLockFile(entry.file.replace(/\.json$/, ".lock"));
      if (!lock) return false;
      try {
        const current = fs.lstatSync(entry.file);
        // Eligibility was selected before taking this session's mutex. A legal
        // writer may have refreshed the state while GC waited; never apply the
        // stale age/order decision to a replacement generation.
        if (
          !current.isFile() || current.dev !== entry.dev || current.ino !== entry.ino ||
          current.mtimeMs !== entry.mtimeMs || stateFileHasLiveWindow(entry.file, now)
        ) return false;
        fs.rmSync(entry.file);
        removedFiles.add(entry.file);
        removed++;
        try { fs.rmSync(entry.file.replace(/\.json$/, ".active"), { force: true }); } catch {}
        return true;
      } catch {
        return false;
      } finally {
        releaseLock(lock);
      }
    };

    for (const entry of entries) {
      if (now - entry.mtimeMs > ttlMs) remove(entry);
    }
    let retained = entries.filter((entry) => !removedFiles.has(entry.file));
    if (retained.length > maxFiles) {
      retained = retained.sort(
        (left, right) => left.mtimeMs - right.mtimeMs || left.file.localeCompare(right.file)
      );
      for (const entry of retained) {
        if (entries.length - removed <= maxFiles) break;
        remove(entry);
      }
    }
    const sidecarsRemoved = gcExperimentSidecars(directory, { nowMs: now, ttlMs });
    return { scanned: entries.length, removed, sidecarsRemoved };
  } catch {
    return { scanned: 0, removed: 0, sidecarsRemoved: 0 };
  } finally {
    releaseLock(gcLock);
  }
}

function acquireLockFile(file, options = {}) {
  return fileMutex.acquireFileMutex(file, {
    attempts: options.attempts || LOCK_ATTEMPTS,
    waitMs: Number.isFinite(options.waitMs) ? options.waitMs : LOCK_WAIT_MS,
    staleMs: LOCK_STALE_MS,
  });
}

function acquireLock(root, sessionKey) {
  return acquireLockFile(experimentLockPath(root, sessionKey));
}

function releaseLock(lock) {
  fileMutex.releaseFileMutex(lock);
}

function emptyState(sessionHash) {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionHash,
    updatedAt: 0,
    windows: [],
    seen: [],
  };
}

function normalizeWindow(value) {
  if (!value || typeof value !== "object") return null;
  const opportunityId = boundedOpaque(value.opportunityId);
  const taskKey = boundedOpaque(value.taskKey);
  const surface = boundedOpaque(value.surface, 64);
  const arm = value.arm === "armed" || value.arm === "holdback" ? value.arm : null;
  const assignmentMode = ["randomized", "forced", "unknown"].includes(value.assignmentMode)
    ? value.assignmentMode
    : "unknown";
  const paths = normalizePaths(value.paths);
  const openedAt = finiteTime(value.openedAt, -1);
  const expiresAt = finiteTime(value.expiresAt, -1);
  if (!opportunityId || !taskKey || !surface || !arm || !paths.length) return null;
  if (openedAt < 0 || expiresAt < openedAt) return null;
  const pathSet = new Set(paths);
  const readPaths = normalizePaths(value.readPaths).filter((rel) => pathSet.has(rel));
  return {
    opportunityId,
    taskKey,
    arm,
    assignmentMode,
    surface,
    paths,
    openedAt,
    expiresAt,
    totalTouches: Math.max(0, Math.min(TOUCH_LIMIT, Math.floor(Number(value.totalTouches) || 0))),
    targetRead: value.targetRead === true || readPaths.length > 0,
    targetMutation: value.targetMutation === true,
    blindTargetMutation: value.blindTargetMutation === true,
    firstTargetRank:
      Number.isInteger(value.firstTargetRank) && value.firstTargetRank >= 1 &&
      value.firstTargetRank <= TOUCH_LIMIT
        ? value.firstTargetRank
        : null,
    readPaths,
  };
}

function normalizeState(parsed, sessionHash) {
  const state = emptyState(sessionHash);
  if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION || parsed.sessionHash !== sessionHash) {
    return state;
  }
  const seenWindows = new Set();
  for (const raw of Array.isArray(parsed.windows) ? parsed.windows : []) {
    const window = normalizeWindow(raw);
    if (!window || seenWindows.has(window.opportunityId)) continue;
    seenWindows.add(window.opportunityId);
    state.windows.push(window);
  }
  state.windows.sort((a, b) => a.openedAt - b.openedAt || a.opportunityId.localeCompare(b.opportunityId));
  state.windows = state.windows.slice(-MAX_WINDOWS);

  const seenIds = new Set();
  for (const entry of Array.isArray(parsed.seen) ? parsed.seen : []) {
    const opportunityId = boundedOpaque(entry && entry.opportunityId);
    if (!opportunityId || seenIds.has(opportunityId)) continue;
    seenIds.add(opportunityId);
    state.seen.push({
      opportunityId,
      taskKey: boundedOpaque(entry && entry.taskKey),
      seenAt: finiteTime(entry && entry.seenAt, 0),
    });
  }
  state.seen.sort((a, b) => b.seenAt - a.seenAt || a.opportunityId.localeCompare(b.opportunityId));
  state.seen = state.seen.slice(0, MAX_SEEN_OPPORTUNITIES);
  for (const window of state.windows) {
    const seen = state.seen.find((entry) => entry.opportunityId === window.opportunityId);
    if (seen) {
      // Backfill state written before task-level enrollment was introduced.
      if (!seen.taskKey) seen.taskKey = window.taskKey;
    } else {
      state.seen.push({
        opportunityId: window.opportunityId,
        taskKey: window.taskKey,
        seenAt: window.openedAt,
      });
    }
  }
  state.updatedAt = finiteTime(parsed.updatedAt, 0);
  return state;
}

function readState(root, sessionKey) {
  const file = experimentStatePath(root, sessionKey);
  const sessionHash = sessionIdentity(sessionKey);
  if (!file || !sessionHash) return null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_STATE_BYTES) {
      return { file, state: emptyState(sessionHash) };
    }
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return { file, state: normalizeState(parsed, sessionHash) };
  } catch {
    return { file, state: emptyState(sessionHash) };
  }
}

function hasActiveExposure(root, sessionKey) {
  try {
    const file = experimentActivePath(root, sessionKey);
    return !!file && fs.existsSync(file);
  } catch {
    return false;
  }
}

function inactiveMarkerNeedsSync(loaded) {
  try {
    if (!loaded || !loaded.file || !loaded.state || loaded.state.windows.length > 0) return false;
    return fs.existsSync(loaded.file.replace(/\.json$/, ".active"));
  } catch {
    return false;
  }
}

function capSeen(state) {
  const seenById = new Map(state.seen.map((entry) => [entry.opportunityId, entry]));
  const byNewest = [...state.seen].sort(
    (a, b) => b.seenAt - a.seenAt || a.opportunityId.localeCompare(b.opportunityId)
  );
  const kept = [];
  const ids = new Set();
  // Active windows must always remain deduped. MAX_WINDOWS is deliberately
  // smaller than MAX_SEEN_OPPORTUNITIES, leaving room for recent history.
  for (const window of state.windows) {
    ids.add(window.opportunityId);
    const prior = seenById.get(window.opportunityId);
    kept.push({
      opportunityId: window.opportunityId,
      taskKey: window.taskKey,
      seenAt: prior ? prior.seenAt : window.openedAt,
    });
  }
  for (const entry of byNewest) {
    if (ids.has(entry.opportunityId)) continue;
    if (kept.length >= MAX_SEEN_OPPORTUNITIES) break;
    ids.add(entry.opportunityId);
    kept.push(entry);
  }
  state.seen = kept.slice(0, MAX_SEEN_OPPORTUNITIES);
}

function writeState(loaded, nowMs) {
  let tmp = null;
  let markerTmp = null;
  let marker = null;
  let markerExisted = false;
  let markerPublished = false;
  let stateCommitted = false;
  try {
    if (!loaded || !loaded.file || !loaded.state) return false;
    loaded.state.schemaVersion = SCHEMA_VERSION;
    loaded.state.updatedAt = finiteTime(nowMs);
    capSeen(loaded.state);
    const raw = JSON.stringify(loaded.state) + "\n";
    if (Buffer.byteLength(raw, "utf8") > MAX_STATE_BYTES) return false;
    fs.mkdirSync(path.dirname(loaded.file), { recursive: true });
    tmp = `${loaded.file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, raw, { flag: "wx", mode: 0o600 });

    marker = loaded.file.replace(/\.json$/, ".active");
    const active = loaded.state.windows.length > 0;
    // Publish the marker first when opening. A concurrent hook may briefly do
    // one extra state operation, but can never skip a committed active window;
    // the session lock keeps it from observing the pair mid-write.
    if (active) {
      markerExisted = fs.existsSync(marker);
      if (!markerExisted) {
        markerTmp = `${marker}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
        fs.writeFileSync(markerTmp, `${SCHEMA_VERSION}\n`, { flag: "wx", mode: 0o600 });
        fs.renameSync(markerTmp, marker);
        markerTmp = null;
        markerPublished = true;
      } else if (!fs.statSync(marker).isFile()) {
        throw new Error("coherence experiment active marker is not a file");
      }
      fs.chmodSync(marker, 0o600);
    }

    fs.renameSync(tmp, loaded.file);
    tmp = null;
    stateCommitted = true;
    if (!active) fs.rmSync(marker, { force: true });
    return true;
  } catch {
    if (tmp) {
      try { fs.rmSync(tmp, { force: true }); } catch {}
    }
    if (markerTmp) {
      try { fs.rmSync(markerTmp, { force: true }); } catch {}
    }
    // If this was the first activation and the state rename failed, do not
    // leave a marker for a window that never committed. An existing marker
    // belongs to the prior active state and must remain intact.
    if (!stateCommitted && markerPublished && !markerExisted && marker) {
      try { fs.rmSync(marker, { force: true }); } catch {}
    }
    return false;
  }
}

function commonEvent(window, name) {
  return {
    schemaVersion: SCHEMA_VERSION,
    name,
    opportunityId: window.opportunityId,
    taskKey: window.taskKey,
    arm: window.arm,
    assignmentMode: window.assignmentMode,
    surface: window.surface,
    targetPathCount: window.paths.length,
  };
}

function closeEvent(window, reason, nowMs) {
  const closedAt = finiteTime(nowMs);
  return {
    ...commonEvent(window, EVENT_CLOSED),
    openedAt: window.openedAt,
    closedAt,
    windowMs: Math.max(0, closedAt - window.openedAt),
    closeReason: reason,
    targetRead: window.targetRead === true,
    targetMutation: window.targetMutation === true,
    blindTargetMutation: window.blindTargetMutation === true,
    firstTargetRank: window.firstTargetRank,
    totalTouches: window.totalTouches,
  };
}

function observationFailure(reason, nowMs, activeWindowCount = 0) {
  return {
    schemaVersion: SCHEMA_VERSION,
    name: EVENT_OBSERVATION_FAILED,
    operation: "score_touch",
    reason,
    observedAt: finiteTime(nowMs),
    activeWindowCount: Math.max(0, Math.min(MAX_WINDOWS, Number(activeWindowCount) || 0)),
  };
}

function closeMatching(state, predicate, reason, nowMs) {
  const retained = [];
  const events = [];
  for (const window of state.windows) {
    if (predicate(window)) events.push(closeEvent(window, reason, nowMs));
    else retained.push(window);
  }
  state.windows = retained;
  return events;
}

function expireLoaded(state, nowMs) {
  const now = finiteTime(nowMs);
  const events = [];
  const retained = [];
  for (const window of state.windows) {
    if (window.totalTouches >= TOUCH_LIMIT) {
      events.push(closeEvent(window, "touch_limit", now));
    } else if (now >= window.expiresAt) {
      events.push(closeEvent(window, "timeout", now));
    } else {
      retained.push(window);
    }
  }
  state.windows = retained;
  return events;
}

// Opens one exact overlap opportunity. The returned array may begin with
// timeout/capacity closure events before the final opened/deduped event.
function openExposure(root, sessionKey, options = {}) {
  try {
    if (options && options.enabled === false) return [];
    const opportunityId = boundedOpaque(options.opportunityId);
    const taskKey = boundedOpaque(options.taskKey);
    const arm = options.arm === "armed" || options.arm === "holdback" ? options.arm : null;
    const assignmentMode = ["randomized", "forced"].includes(options.assignmentMode)
      ? options.assignmentMode
      : "unknown";
    const surface = boundedOpaque(options.surface, 64);
    const paths = normalizePaths(options.paths);
    if (!opportunityId || !taskKey || !arm || !surface || paths.length === 0) return [];
    const lock = acquireLock(root, sessionKey);
    if (!lock) return [];
    try {
      const loaded = readState(root, sessionKey);
      if (!loaded) return [];
      const now = finiteTime(options.nowMs);
      const events = expireLoaded(loaded.state, now);
      if (
        loaded.state.seen.some((entry) => entry.opportunityId === opportunityId) ||
        loaded.state.windows.some((window) => window.opportunityId === opportunityId)
      ) {
        const activeWindow = loaded.state.windows.find(
          (window) => window.opportunityId === opportunityId
        );
        const deduped = {
          schemaVersion: SCHEMA_VERSION,
          name: EVENT_DEDUPED,
          opportunityId,
          taskKey,
          arm,
          assignmentMode,
          surface,
          dedupedAt: now,
          dedupeReason: "exact_opportunity",
          activeWindow: !!activeWindow,
          enrolledOpportunityId: activeWindow ? activeWindow.opportunityId : null,
          activeArm: activeWindow ? activeWindow.arm : null,
          activeAssignmentMode: activeWindow ? activeWindow.assignmentMode : null,
        };
        if ((events.length || inactiveMarkerNeedsSync(loaded)) && !writeState(loaded, now)) {
          return [deduped];
        }
        return [...events, deduped];
      }

      if (
        loaded.state.seen.some((entry) => entry.taskKey === taskKey) ||
        loaded.state.windows.some((window) => window.taskKey === taskKey)
      ) {
        const activeWindow = loaded.state.windows.find((window) => window.taskKey === taskKey);
        const deduped = {
          schemaVersion: SCHEMA_VERSION,
          name: EVENT_DEDUPED,
          opportunityId,
          taskKey,
          arm,
          assignmentMode,
          surface,
          dedupedAt: now,
          dedupeReason: "task_already_enrolled",
          activeWindow: !!activeWindow,
          enrolledOpportunityId: activeWindow ? activeWindow.opportunityId : null,
          activeArm: activeWindow ? activeWindow.arm : null,
          activeAssignmentMode: activeWindow ? activeWindow.assignmentMode : null,
        };
        if ((events.length || inactiveMarkerNeedsSync(loaded)) && !writeState(loaded, now)) {
          return [deduped];
        }
        return [...events, deduped];
      }

      if (loaded.state.windows.length >= MAX_WINDOWS) {
        const oldest = loaded.state.windows[0];
        loaded.state.windows = loaded.state.windows.slice(1);
        events.push(closeEvent(oldest, "capacity", now));
      }
      const window = {
        opportunityId,
        taskKey,
        arm,
        assignmentMode,
        surface,
        paths,
        openedAt: now,
        expiresAt: now + WINDOW_TTL_MS,
        totalTouches: 0,
        targetRead: false,
        targetMutation: false,
        blindTargetMutation: false,
        firstTargetRank: null,
        readPaths: [],
      };
      loaded.state.windows.push(window);
      loaded.state.seen.push({ opportunityId, taskKey, seenAt: now });
      if (!writeState(loaded, now)) return [];
      gcExperimentStates(root, { currentFile: loaded.file, nowMs: now });
      events.push({
        ...commonEvent(window, EVENT_OPENED),
        openedAt: now,
        expiresAt: window.expiresAt,
        touchLimit: TOUCH_LIMIT,
      });
      return events;
    } finally {
      releaseLock(lock);
    }
  } catch {
    return [];
  }
}

// Scores one file-tool touch against every active window in the session. A
// mutation is blind when that exact target path has not previously been read in
// the same window. Intermediate touches stay only in bounded state; the closure
// row contains the sufficient task outcome and avoids exhausting telemetry
// retention with up to eight redundant rows per opportunity.
function scoreTouch(root, sessionKey, options = {}) {
  const now = finiteTime(options.nowMs);
  try {
    const rel = repoRelativePath(options.path);
    const action = options.action === "read" || options.action === "mutation"
      ? options.action
      : null;
    if (!rel || !action) return [];
    // Callers use the mode-0600 marker as the default-off fast path. Preserve
    // direct-call behavior too: no marker means there is no expected outcome
    // window, while a present marker makes every later failure auditable.
    if (!hasActiveExposure(root, sessionKey)) return [];
    const lock = acquireLock(root, sessionKey);
    if (!lock) return [observationFailure("lock_unavailable", now)];
    try {
      const loaded = readState(root, sessionKey);
      if (!loaded) return [observationFailure("state_unavailable", now)];
      const activeWindowCount = loaded.state.windows.length;
      if (activeWindowCount === 0) {
        // A marker without a live window is an integrity inconsistency. Heal
        // it best-effort, but do not silently turn the observed file action
        // into a clean negative experiment outcome.
        writeState(loaded, now);
        return [observationFailure("active_state_missing", now)];
      }
      const events = expireLoaded(loaded.state, now);
      const retained = [];
      let stateChanged = events.length > 0;
      for (const window of loaded.state.windows) {
        stateChanged = true;
        window.totalTouches++;
        const rank = window.totalTouches;
        const targetTouch = window.paths.includes(rel);
        if (targetTouch) {
          if (window.firstTargetRank == null) window.firstTargetRank = rank;
          if (action === "read") {
            window.targetRead = true;
            if (!window.readPaths.includes(rel)) window.readPaths.push(rel);
          } else {
            window.targetMutation = true;
            if (!window.readPaths.includes(rel)) window.blindTargetMutation = true;
          }
        }
        if (window.totalTouches >= TOUCH_LIMIT) {
          events.push(closeEvent(window, "touch_limit", now));
        } else {
          retained.push(window);
        }
      }
      loaded.state.windows = retained;
      if (!stateChanged) {
        if (inactiveMarkerNeedsSync(loaded)) writeState(loaded, now);
        return [];
      }
      return writeState(loaded, now)
        ? events
        : [observationFailure("state_write_failed", now, activeWindowCount)];
    } finally {
      releaseLock(lock);
    }
  } catch {
    return [observationFailure("score_exception", now)];
  }
}

function closeReason(value) {
  return ["next_prompt", "caller", "capacity"].includes(value) ? value : "next_prompt";
}

// With no opportunityId, closes every active exposure. That is the intended
// next-prompt call: a new prompt is the boundary for all prior opportunities.
function closeExposure(root, sessionKey, options = {}) {
  try {
    const requestedId = options.opportunityId == null
      ? null
      : boundedOpaque(options.opportunityId);
    if (options.opportunityId != null && !requestedId) return [];
    const lock = acquireLock(root, sessionKey);
    if (!lock) return [];
    try {
      const loaded = readState(root, sessionKey);
      if (!loaded) return [];
      const now = finiteTime(options.nowMs);
      const events = expireLoaded(loaded.state, now);
      events.push(...closeMatching(
        loaded.state,
        (window) => requestedId == null || window.opportunityId === requestedId,
        closeReason(options.reason),
        now
      ));
      if (events.length === 0) {
        if (inactiveMarkerNeedsSync(loaded)) writeState(loaded, now);
        return [];
      }
      return writeState(loaded, now) ? events : [];
    } finally {
      releaseLock(lock);
    }
  } catch {
    return [];
  }
}

function expireWindows(root, sessionKey, options = {}) {
  try {
    const lock = acquireLock(root, sessionKey);
    if (!lock) return [];
    try {
      const loaded = readState(root, sessionKey);
      if (!loaded) return [];
      const now = finiteTime(options.nowMs);
      const events = expireLoaded(loaded.state, now);
      if (events.length === 0) {
        if (inactiveMarkerNeedsSync(loaded)) writeState(loaded, now);
        return [];
      }
      return writeState(loaded, now) ? events : [];
    } finally {
      releaseLock(lock);
    }
  } catch {
    return [];
  }
}

function timedOperation(operation) {
  return (...args) => {
    const started = process.hrtime.bigint();
    const events = operation(...args);
    if (!Array.isArray(events) || events.length === 0) return events;
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    // One helper call can close multiple windows or close one before opening
    // another. Stamp the cost once so percentile aggregation never double-
    // weights that operation.
    return events.map((event, index) => index === 0 ? { ...event, durationMs } : event);
  };
}

function activeHoldbackEvent(events, taskKey) {
  const key = boundedOpaque(taskKey);
  if (!key) return null;
  return (Array.isArray(events) ? events : []).find((event) =>
    event && event.name === EVENT_DEDUPED && event.taskKey === key &&
    event.activeWindow === true && event.activeArm === "holdback" &&
    boundedOpaque(event.enrolledOpportunityId)
  ) || null;
}

const openExposureTimed = timedOperation(openExposure);
const scoreTouchTimed = timedOperation(scoreTouch);
const closeExposureTimed = timedOperation(closeExposure);
const expireWindowsTimed = timedOperation(expireWindows);

module.exports = {
  SCHEMA_VERSION,
  EXPERIMENT_NAME,
  HOLD_BACK_PCT,
  TOUCH_LIMIT,
  WINDOW_TTL_MS,
  MAX_PATHS,
  MAX_WINDOWS,
  MAX_SEEN_OPPORTUNITIES,
  STATE_TTL_MS,
  MAX_STATE_FILES,
  LOCK_ATTEMPTS,
  LOCK_WAIT_MS,
  EVENT_OPENED,
  EVENT_DEDUPED,
  EVENT_CLOSED,
  EVENT_OBSERVATION_FAILED,
  assignArm,
  eligiblePaths,
  opportunityKey,
  experimentStatePath,
  experimentLockPath,
  experimentActivePath,
  gcExperimentStates,
  hasActiveExposure,
  activeHoldbackEvent,
  openExposure: openExposureTimed,
  scoreTouch: scoreTouchTimed,
  closeExposure: closeExposureTimed,
  expireWindows: expireWindowsTimed,
};
