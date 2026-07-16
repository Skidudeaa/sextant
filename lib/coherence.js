"use strict";

// MULTI-AGENT COHERENCE CORE (Phase F).
//
// A boundary snapshot is an immutable observation: which repository version,
// workset, and claims were delivered to a parent or prepared by the hook for a
// child spawn. Snapshots are kept one-per-generation so parallel spawns never
// contend on a shared registry. This module only reports visibility and
// invalidation; it does not assign files, coordinate writers, or enforce
// concurrency policy.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const claims = require("./claims");

const SNAPSHOT_PREFIX = ".agent-capsule.";
const CONTENTION_PREFIX = ".agent-capsule-contention.";
const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SNAPSHOTS = 64;
const MAX_STORED_GENERATIONS = 2048;
// A direct join reads only the newest bounded set of generations for one exact
// agent key. This is separate from MAX_SNAPSHOTS: that cap bounds reporting
// across agents and must not make a known child identity unjoinable.
const MAX_DIRECT_CANDIDATES = 64;
const MAX_OVERLAP_ITEMS = 50;
const MAX_OVERLAP_PAIRS = 64;
// Contention exists only when the exact same spawn identity is concurrently
// registering/returning. A bounded wait protects hook latency; an immutable
// contention marker now makes timeout a safe fail-closed lifecycle outcome.
const AGENT_LOCK_ATTEMPTS = 50;
const AGENT_LOCK_WAIT_MS = 2;
const SNAPSHOT_RE = /^\.agent-capsule\.([A-Za-z0-9_-]+)\.(\d+)\.([A-Za-z0-9_-]+)\.json$/;
const CONTENTION_RE = /^\.agent-capsule-contention\.([A-Za-z0-9_-]+)\.(\d+)\.([A-Za-z0-9_-]+)\.json$/;
const OVERLAP_ROLES = ["primary", "support", "witnesses", "context"];
const agentWaitCell = new Int32Array(new SharedArrayBuffer(4));

// Phase F is a second, explicit opt-in on top of Task Capsules. Existing
// capsule dogfooders must not silently gain a cross-agent injection lane.
function coherenceEnabled(root, env = process.env) {
  const value = env && env.SEXTANT_COHERENCE;
  if (value === "0" || value === "false") return false;
  let capsuleOn = false;
  try {
    capsuleOn = require("./capsule").capsuleEnabled(root, env);
  } catch {}
  if (!capsuleOn) return false;
  if (value === "1" || value === "true") return true;
  try {
    return require("./config").loadRepoConfig(root).coherence === true;
  } catch {
    return false;
  }
}

function hashKey(kind, values) {
  const h = crypto.createHash("sha256");
  h.update(kind);
  for (const value of values) {
    h.update("\0");
    h.update(String(value));
  }
  return `${kind}_${h.digest("hex").slice(0, 16)}`;
}

// Hash the RAW id rather than a filename-sanitized/truncated derivative.  For
// example, "session/a" and "session_a" must remain different agents.
function parentAgentKey(sessionKey) {
  if (sessionKey == null || String(sessionKey).length === 0) return null;
  return hashKey("parent", [sessionKey]);
}

// toolUseId is the stable identity of one spawn attempt.  There is no honest
// collision-free fallback when it is absent (identical parallel prompts exist),
// so callers receive null and can decline to record a child capsule.
function childAgentKey(parentKey, toolUseId) {
  if (parentKey == null || String(parentKey).length === 0) return null;
  if (toolUseId == null || String(toolUseId).length === 0) return null;
  return hashKey("child", [parentKey, toolUseId]);
}

function cloneJson(value, fallback) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function buildSnapshot({
  taskId,
  agentKey,
  parentAgentKey: parentKey,
  spawnToolUseId,
  kind,
  agentType,
  state,
  generation,
  createdAt,
  repo,
  intent,
  workset,
  servedClaims,
  blockHash,
} = {}) {
  const at = Number.isFinite(createdAt) ? Math.floor(createdAt) : Date.now();
  return {
    schemaVersion: 1,
    taskId: taskId == null ? "" : String(taskId),
    agentKey: agentKey == null ? "" : String(agentKey),
    parentAgentKey: parentKey == null ? null : String(parentKey),
    spawnToolUseId: spawnToolUseId == null ? null : String(spawnToolUseId),
    kind: kind === "child" ? "child" : "parent",
    agentType: agentType == null ? null : String(agentType),
    state: state == null ? "served" : String(state),
    generation: Number.isInteger(generation) && generation > 0 ? generation : 1,
    createdAt: at,
    repo: cloneJson(repo, {}),
    intent: cloneJson(intent, intent == null ? {} : String(intent)),
    workset: cloneJson(workset, {
      primary: [], support: [], witnesses: [], hazards: [], unknowns: [],
    }),
    servedClaims: cloneJson(servedClaims, []),
    blockHash: blockHash == null ? "" : String(blockHash),
  };
}

function validAgentKey(key) {
  return typeof key === "string" && /^[A-Za-z0-9_-]+$/.test(key);
}

function sameRepoAnchor(validated, current) {
  if (!validated || !current) return false;
  return (
    (validated.head ?? "") === (current.head ?? "") &&
    (validated.statusHash ?? "") === (current.statusHash ?? "")
  );
}

// Persist a new immutable generation. The random nonce makes concurrent
// boundaries for the same agent/timestamp distinct; tmp+rename prevents torn reads.
// Returns the final path, or null on any failure.
function writeSnapshot(root, snapshot) {
  let tmp = null;
  try {
    if (typeof root !== "string" || !root) return null;
    if (!snapshot || !validAgentKey(snapshot.agentKey)) return null;
    if (!Number.isFinite(snapshot.createdAt)) return null;

    const dir = path.join(root, ".planning", "intel");
    fs.mkdirSync(dir, { recursive: true });
    const servedAt = Math.floor(snapshot.createdAt);
    const nonce = crypto.randomBytes(10).toString("hex");
    const name = `${SNAPSHOT_PREFIX}${snapshot.agentKey}.${servedAt}.${nonce}.json`;
    const file = path.join(dir, name);
    tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot), { flag: "wx" });
    fs.renameSync(tmp, file);
    // Reads are TTL-filtered, but immutable generations would otherwise remain
    // on disk forever. Prune validated filename/payload pairs after atomic
    // publication; temp files do not match the snapshot pattern. Use the observation clock so synthetic tests
    // and a temporarily skewed wall clock cannot erase a just-written record.
    pruneSnapshots(root, { nowMs: servedAt });
    return file;
  } catch {
    if (tmp) {
      try { fs.rmSync(tmp, { force: true }); } catch {}
    }
    return null;
  }
}

// Opportunistic storage GC. Deletes expired generations first, then the oldest
// live generations above a hard global cap. It validates payload identity and
// generation ordering, never touches temp files, and failure cannot break
// snapshot publication.
function pruneSnapshots(root, opts = {}) {
  try {
    const dir = path.join(root, ".planning", "intel");
    const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
    const ttlMs = positiveInt(opts.ttlMs, SNAPSHOT_TTL_MS);
    const maxStored = positiveInt(opts.maxStored, MAX_STORED_GENERATIONS);
    const retained = [];
    let removed = 0;
    for (const name of fs.readdirSync(dir)) {
      const match = SNAPSHOT_RE.exec(name);
      if (!match) continue;
      const createdAt = Number(match[2]);
      if (!Number.isFinite(createdAt)) continue;
      if (createdAt <= nowMs && nowMs - createdAt > ttlMs) {
        try {
          fs.rmSync(path.join(dir, name), { force: true });
          removed++;
        } catch {}
        continue;
      }
      const parsed = readValidSnapshot(dir, {
        name,
        fileAgentKey: match[1],
        fileCreatedAt: createdAt,
      });
      if (!parsed) {
        try {
          fs.rmSync(path.join(dir, name), { force: true });
          removed++;
        } catch {}
        continue;
      }
      retained.push({
        name,
        createdAt,
        agentKey: match[1],
        generation: parsed.generation,
      });
    }
    retained.sort((a, b) =>
      b.createdAt - a.createdAt ||
      b.generation - a.generation ||
      b.name.localeCompare(a.name)
    );
    // Protect the newest live generation for each agent before spending the
    // remaining cap on historical generations. A busy parent must not evict an
    // older child's only joinable spawn merely by producing many newer parent
    // generations. If distinct live agents alone exceed the hard cap, newest
    // agents win and the retention bound remains honest.
    const protectedNewest = [];
    const historical = [];
    const seenAgents = new Set();
    for (const entry of retained) {
      if (seenAgents.has(entry.agentKey)) historical.push(entry);
      else {
        seenAgents.add(entry.agentKey);
        protectedNewest.push(entry);
      }
    }
    const keep = new Set(
      protectedNewest.slice(0, maxStored).map((entry) => entry.name)
    );
    for (const entry of historical) {
      if (keep.size >= maxStored) break;
      keep.add(entry.name);
    }
    for (const entry of retained) {
      if (keep.has(entry.name)) continue;
      try {
        fs.rmSync(path.join(dir, entry.name), { force: true });
        removed++;
      } catch {}
    }
    return { removed, retained: keep.size };
  } catch {
    return { removed: 0, retained: 0 };
  }
}

// A lock acquisition failure cannot safely choose between an older prepared
// spawn and the registration that failed to serialize with it. Persist an
// immutable, tokenized marker outside the exact-agent lock so every later
// lifecycle reader fails closed for that identity. Marker filenames carry all
// information needed by readers: even an unreadable payload remains poison.
function writeContentionMarker(root, agentKey, reason) {
  let tmp = null;
  try {
    if (typeof root !== "string" || !root || !validAgentKey(agentKey)) return null;
    const dir = path.join(root, ".planning", "intel");
    fs.mkdirSync(dir, { recursive: true });
    const createdAt = Date.now();
    const nonce = crypto.randomBytes(10).toString("hex");
    const name = `${CONTENTION_PREFIX}${agentKey}.${createdAt}.${nonce}.json`;
    const file = path.join(dir, name);
    tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({
      schemaVersion: 1,
      agentKey,
      createdAt,
      reason: typeof reason === "string" ? reason : "state_lock_failed",
    }), { flag: "wx" });
    fs.renameSync(tmp, file);
    pruneContentionMarkers(root, { nowMs: createdAt });
    return file;
  } catch {
    if (tmp) {
      try { fs.rmSync(tmp, { force: true }); } catch {}
    }
    return null;
  }
}

// Markers live at least as long as the snapshot they poison: they are created
// after that snapshot, and use the same TTL. Unique random filenames have no
// mutable owner, so deleting one expired token cannot delete a newer marker.
function pruneContentionMarkers(root, opts = {}) {
  try {
    const dir = path.join(root, ".planning", "intel");
    const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
    const ttlMs = positiveInt(opts.ttlMs, SNAPSHOT_TTL_MS);
    for (const name of fs.readdirSync(dir)) {
      const match = CONTENTION_RE.exec(name);
      if (!match) continue;
      const createdAt = Number(match[2]);
      if (!Number.isFinite(createdAt) || createdAt > nowMs || nowMs - createdAt <= ttlMs) {
        continue;
      }
      try { fs.rmSync(path.join(dir, name), { force: true }); } catch {}
    }
  } catch {}
}

function liveContentionAgent(name, nowMs, ttlMs, expectedAgentKey) {
  const match = CONTENTION_RE.exec(name);
  if (!match) return null;
  const agentKey = match[1];
  if (expectedAgentKey != null && agentKey !== expectedAgentKey) return null;
  const createdAt = Number(match[2]);
  // A syntactically valid marker with an unrepresentable or future timestamp
  // is not evidence of safe expiry, so retain its poison semantics.
  if (!Number.isFinite(createdAt) || createdAt > nowMs || nowMs - createdAt <= ttlMs) {
    return agentKey;
  }
}

function hasLiveContentionMarker(root, agentKey, opts = {}) {
  if (typeof root !== "string" || !root || !validAgentKey(agentKey)) return true;
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const ttlMs = positiveInt(opts.ttlMs, SNAPSHOT_TTL_MS);
  let handle = null;
  try {
    const dir = path.join(root, ".planning", "intel");
    handle = fs.opendirSync(dir);
    let entry;
    while ((entry = handle.readSync()) !== null) {
      if (liveContentionAgent(entry.name, nowMs, ttlMs, agentKey)) return true;
    }
    return false;
  } catch (error) {
    // A repository with no state directory is clear. Any other inability to
    // inspect poison evidence is itself unverifiable and therefore withheld.
    return !!(!error || error.code !== "ENOENT");
  } finally {
    if (handle) {
      try { handle.closeSync(); } catch {}
    }
  }
}

// Integrity lock for one immutable-agent stream. This coordinates only the
// read/compare/publish of snapshot state; it is not a code, file, or work lock.
function withAgentStateLock(root, agentKey, fn) {
  const dir = path.join(root, ".planning", "intel");
  const lock = path.join(dir, `.agent-capsule-state-lock.${agentKey}`);
  const token = `${process.pid}:${crypto.randomBytes(12).toString("hex")}`;
  let fd = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (let attempt = 0; attempt < AGENT_LOCK_ATTEMPTS; attempt++) {
      let created = false;
      try {
        fd = fs.openSync(lock, "wx");
        created = true;
        fs.writeFileSync(fd, token);
        break;
      } catch (error) {
        if (fd != null) {
          try { fs.closeSync(fd); } catch {}
          fd = null;
        }
        // We alone created this inode, so a failed token write is safe to
        // clean up. Do not leave an unreadable lock that suppresses all later
        // lifecycle joins.
        if (created) {
          try { fs.rmSync(lock, { force: true }); } catch {}
          return null;
        }
        if (!error || error.code !== "EEXIST") return null;
        // Never reap an existing path here. A check-then-unlink stale-lock
        // recovery can delete a new owner's lock after a rename/recreate race.
        // Normal owners remove their token in finally; a crashed owner makes
        // this one identity fail closed until an operator removes the residue.
        Atomics.wait(agentWaitCell, 0, 0, AGENT_LOCK_WAIT_MS);
      }
    }
    if (fd == null) return null;
    return fn();
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
      try {
        if (fs.readFileSync(lock, "utf8") === token) {
          fs.rmSync(lock, { force: true });
        }
      } catch {}
    }
  }
}

// Atomically register one spawn identity. Concurrent identical retries collapse
// to one generation; divergent payloads publish an empty ambiguity tombstone so
// PostToolUse cannot join and advance an arbitrary older spawn.
function registerSpawnSnapshot(root, candidate) {
  if (!candidate || candidate.state !== "spawn_prepared" || !validAgentKey(candidate.agentKey)) {
    return { status: "failed", snapshot: null };
  }
  if (hasLiveContentionMarker(root, candidate.agentKey)) {
    return { status: "withheld", snapshot: null };
  }
  const result = withAgentStateLock(root, candidate.agentKey, () => {
    if (hasLiveContentionMarker(root, candidate.agentKey)) {
      return { status: "withheld", snapshot: null };
    }
    // Make repository validation part of the atomic registration boundary.
    // The caller can emit immediately after this returns without persisting a
    // preparation that was already stale before registration.
    let currentRepo = null;
    try {
      currentRepo = require("./freshness").captureCurrentState(root);
    } catch {}
    if (!sameRepoAnchor(candidate.repo, currentRepo)) {
      return { status: "moved", snapshot: null };
    }
    const current = readAgentSnapshotUnchecked(root, candidate.agentKey, { taskId: candidate.taskId });
    if (!current) {
      return writeSnapshot(root, candidate)
        ? { status: "written", snapshot: candidate }
        : { status: "failed", snapshot: null };
    }
    if (current.state === "identity_ambiguous") {
      return { status: "ambiguous", snapshot: current };
    }
    if (current.state === "spawn_withheld") {
      return { status: "withheld", snapshot: current };
    }
    if (current.blockHash === candidate.blockHash) {
      return { status: "retry", snapshot: current };
    }
    const tombstone = buildSnapshot({
      ...current,
      state: "identity_ambiguous",
      generation: Math.max(Number(current.generation || 1), Number(candidate.generation || 1)) + 1,
      createdAt: Math.max(Date.now(), Number(current.createdAt || 0), Number(candidate.createdAt || 0)),
      workset: {
        primary: [], support: [], witnesses: [], hazards: [], unknowns: [], context: [],
      },
      servedClaims: [],
      blockHash: `ambiguous_${candidate.blockHash}`,
    });
    return writeSnapshot(root, tombstone)
      ? { status: "ambiguous", snapshot: tombstone }
      : { status: "failed", snapshot: null };
  });
  if (!result) {
    return writeContentionMarker(root, candidate.agentKey, "spawn_state_lock_failed") ||
      hasLiveContentionMarker(root, candidate.agentKey)
      ? { status: "withheld", snapshot: null }
      : { status: "failed", snapshot: null };
  }
  if (hasLiveContentionMarker(root, candidate.agentKey)) {
    return { status: "withheld", snapshot: null };
  }
  return result;
}

// Atomically advance one exact child lifecycle after the parent-side tool
// returns. Re-read under the same identity lock used by spawn registration so
// a divergent PreToolUse tombstone cannot be overwritten by a later generation.
function registerReturnSnapshot(root, agentKey) {
  if (!validAgentKey(agentKey)) return { status: "failed", snapshot: null };
  if (hasLiveContentionMarker(root, agentKey)) {
    return { status: "withheld", snapshot: null };
  }
  const result = withAgentStateLock(root, agentKey, () => {
    if (hasLiveContentionMarker(root, agentKey)) {
      return { status: "withheld", snapshot: null };
    }
    const current = readAgentSnapshotUnchecked(root, agentKey);
    if (!current) return { status: "missing", snapshot: null };
    if (current.state === "identity_ambiguous") {
      return { status: "ambiguous", snapshot: current };
    }
    if (current.state === "spawn_withheld") {
      return { status: "withheld", snapshot: current };
    }
    if (current.state === "tool_returned") {
      return { status: "retry", snapshot: current };
    }
    if (current.state !== "spawn_prepared" || current.kind !== "child") {
      return { status: "failed", snapshot: current };
    }
    const returned = buildSnapshot({
      ...current,
      state: "tool_returned",
      generation: Number(current.generation || 1) + 1,
      createdAt: Math.max(Date.now(), Number(current.createdAt || 0)),
    });
    return writeSnapshot(root, returned)
      ? { status: "written", snapshot: returned }
      : { status: "failed", snapshot: null };
  });
  if (hasLiveContentionMarker(root, agentKey)) {
    return { status: "withheld", snapshot: null };
  }
  return result || { status: "failed", snapshot: null };
}

// Terminally suppress a preparation that was persisted but not emitted. The
// empty generation keeps immutable history while preventing reports or a later
// PostToolUse join from treating the withheld payload as child context.
function suppressSpawnSnapshot(root, agentKey, blockHash) {
  if (!validAgentKey(agentKey) || typeof blockHash !== "string" || !blockHash) {
    return { status: "failed", snapshot: null };
  }
  if (hasLiveContentionMarker(root, agentKey)) {
    return { status: "withheld", snapshot: null };
  }
  const result = withAgentStateLock(root, agentKey, () => {
    if (hasLiveContentionMarker(root, agentKey)) {
      return { status: "withheld", snapshot: null };
    }
    const current = readAgentSnapshotUnchecked(root, agentKey);
    if (!current) return { status: "missing", snapshot: null };
    if (current.state === "identity_ambiguous") {
      return { status: "ambiguous", snapshot: current };
    }
    if (current.state === "spawn_withheld") {
      return { status: "withheld", snapshot: current };
    }
    if (current.state !== "spawn_prepared" || current.blockHash !== blockHash) {
      return { status: "mismatch", snapshot: current };
    }
    const withheld = buildSnapshot({
      ...current,
      state: "spawn_withheld",
      generation: Number(current.generation || 1) + 1,
      createdAt: Math.max(Date.now(), Number(current.createdAt || 0)),
      workset: {
        primary: [], support: [], witnesses: [], hazards: [], unknowns: [], context: [],
      },
      servedClaims: [],
    });
    return writeSnapshot(root, withheld)
      ? { status: "withheld", snapshot: withheld }
      : { status: "failed", snapshot: null };
  });
  if (!result) {
    return writeContentionMarker(root, agentKey, "suppression_state_lock_failed") ||
      hasLiveContentionMarker(root, agentKey)
      ? { status: "withheld", snapshot: null }
      : { status: "failed", snapshot: null };
  }
  if (hasLiveContentionMarker(root, agentKey)) {
    return { status: "withheld", snapshot: null };
  }
  return result;
}

function positiveInt(value, fallback) {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function validSnapshot(parsed, fileAgentKey, fileCreatedAt) {
  return !!(
    parsed &&
    typeof parsed === "object" &&
    parsed.schemaVersion === 1 &&
    parsed.agentKey === fileAgentKey &&
    validAgentKey(parsed.agentKey) &&
    Number.isInteger(parsed.generation) &&
    parsed.generation > 0 &&
    Number.isFinite(parsed.createdAt) &&
    Math.floor(parsed.createdAt) === fileCreatedAt &&
    typeof parsed.taskId === "string" &&
    Array.isArray(parsed.servedClaims)
  );
}

function liveSnapshotCandidate(name, nowMs, ttlMs, expectedAgentKey) {
  const match = SNAPSHOT_RE.exec(name);
  if (!match) return null;
  const fileAgentKey = match[1];
  if (expectedAgentKey != null && fileAgentKey !== expectedAgentKey) return null;
  const fileCreatedAt = Number(match[2]);
  if (
    !Number.isFinite(fileCreatedAt) ||
    fileCreatedAt > nowMs ||
    nowMs - fileCreatedAt > ttlMs
  ) return null;
  return { name, fileAgentKey, fileCreatedAt };
}

function readValidSnapshot(dir, candidate) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, candidate.name), "utf8"));
    return validSnapshot(parsed, candidate.fileAgentKey, candidate.fileCreatedAt)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function newestCandidateFirst(a, b) {
  return b.fileCreatedAt - a.fileCreatedAt || b.name.localeCompare(a.name);
}

// Wall-clock milliseconds are not a safe generation counter: PreToolUse and
// PostToolUse can land in the same tick. Order equal-timestamp generations by
// the explicit monotonic value carried in the immutable snapshot, then use the
// nonce-bearing filename only as a deterministic final tie-break.
function newerSnapshot(left, leftName, right, rightName) {
  if (!right) return true;
  if (left.createdAt !== right.createdAt) return left.createdAt > right.createdAt;
  if (left.generation !== right.generation) return left.generation > right.generation;
  return leftName > rightName;
}

// Exact identity lookup for lifecycle joins/retries. Unlike listSnapshots(),
// this cannot drop the requested agent merely because 64 newer peer agents
// exist. Directory traversal memory and candidate parsing stay bounded:
// filenames are streamed, only the newest 64 exact-key candidates are retained,
// and at most those 64 JSON files are parsed. TTL, future-time, schema, and
// filename/payload identity checks are identical to the reporting reader.
function readAgentSnapshotUnchecked(root, agentKey, opts = {}) {
  if (typeof root !== "string" || !root || !validAgentKey(agentKey)) return null;
  if (!opts || typeof opts !== "object") opts = {};
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const ttlMs = positiveInt(opts.ttlMs, SNAPSHOT_TTL_MS);
  const candidates = [];
  let handle = null;
  try {
    const dir = path.join(root, ".planning", "intel");
    handle = fs.opendirSync(dir);
    let entry;
    while ((entry = handle.readSync()) !== null) {
      const candidate = liveSnapshotCandidate(entry.name, nowMs, ttlMs, agentKey);
      if (!candidate) continue;
      candidates.push(candidate);
      candidates.sort(newestCandidateFirst);
      if (candidates.length > MAX_DIRECT_CANDIDATES) candidates.pop();
    }
    handle.closeSync();
    handle = null;

    let newest = null;
    let newestName = "";
    for (const candidate of candidates) {
      const parsed = readValidSnapshot(dir, candidate);
      if (!parsed) continue;
      if (opts.taskId != null && parsed.taskId !== String(opts.taskId)) continue;
      if (newerSnapshot(parsed, candidate.name, newest, newestName)) {
        newest = parsed;
        newestName = candidate.name;
      }
    }
    return newest;
  } catch {
    return null;
  } finally {
    if (handle) {
      try { handle.closeSync(); } catch {}
    }
  }
}

function readAgentSnapshot(root, agentKey, opts = {}) {
  if (typeof root !== "string" || !root || !validAgentKey(agentKey)) return null;
  if (!opts || typeof opts !== "object") opts = {};
  if (hasLiveContentionMarker(root, agentKey, opts)) return null;
  const snapshot = readAgentSnapshotUnchecked(root, agentKey, opts);
  // A marker can be published without this identity lock while the immutable
  // snapshot scan is in progress. Recheck before exposing an older preparation.
  return hasLiveContentionMarker(root, agentKey, opts) ? null : snapshot;
}

// Read at most one (the newest) live generation per agent.  `max` may request a
// smaller result but cannot raise the hard 64-agent ceiling.
function listSnapshots(root, opts = {}) {
  try {
    const dir = path.join(root, ".planning", "intel");
    const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
    const ttlMs = positiveInt(opts.ttlMs, SNAPSHOT_TTL_MS);
    const requested = positiveInt(opts.max, MAX_SNAPSHOTS);
    const limit = Math.min(requested, MAX_SNAPSHOTS);
    const byAgent = new Map();
    const contendedAgents = new Set();
    const names = fs.readdirSync(dir);

    for (const name of names) {
      const agentKey = liveContentionAgent(name, nowMs, ttlMs);
      if (agentKey) contendedAgents.add(agentKey);
    }

    for (const name of names) {
      const candidate = liveSnapshotCandidate(name, nowMs, ttlMs);
      if (!candidate) continue;
      const parsed = readValidSnapshot(dir, candidate);
      if (!parsed) continue;
      if (opts.taskId != null && parsed.taskId !== String(opts.taskId)) continue;

      const prior = byAgent.get(parsed.agentKey);
      if (!prior || newerSnapshot(parsed, name, prior.snapshot, prior.name)) {
        byAgent.set(parsed.agentKey, { snapshot: parsed, name });
      }
    }

    const selected = [...byAgent.values()]
      .sort((a, b) =>
        b.snapshot.createdAt - a.snapshot.createdAt ||
        a.snapshot.agentKey.localeCompare(b.snapshot.agentKey)
      )
      // An ambiguity tombstone suppresses the older spawn from reporting while
      // remaining visible to exact lifecycle joins. A contention marker is a
      // fail-closed identity poison and suppresses every older generation.
      .filter((entry) =>
        !contendedAgents.has(entry.snapshot.agentKey) &&
        !["identity_ambiguous", "spawn_withheld"].includes(entry.snapshot.state)
      )
      .slice(0, limit)
      .map((entry) => entry.snapshot);

    // Marker publication intentionally happens outside the identity lock. A
    // second directory boundary catches poison that landed while snapshot
    // payloads were being parsed; failure to perform it withholds the report.
    const finalContendedAgents = new Set(contendedAgents);
    for (const name of fs.readdirSync(dir)) {
      const agentKey = liveContentionAgent(name, nowMs, ttlMs);
      if (agentKey) finalContendedAgents.add(agentKey);
    }
    return selected.filter((snapshot) => !finalContendedAgents.has(snapshot.agentKey));
  } catch {
    return [];
  }
}

function canonicalPath(value) {
  if (typeof value !== "string" || !value) return null;
  let rel = value.replace(/\\/g, "/");
  while (rel.startsWith("./")) rel = rel.slice(2);
  rel = path.posix.normalize(rel);
  if (!rel || rel === "." || rel === ".." || rel.startsWith("../") || rel.startsWith("/")) {
    return null;
  }
  return rel;
}

function regionIdentity(relPath, entry) {
  const region = entry && entry.region;
  if (!region) return null;
  if (typeof region === "string" && region) {
    return region.includes("#") ? region : `${relPath}#${region}`;
  }
  if (typeof region.id === "string" && region.id) return region.id;
  if (typeof region.name === "string" && region.name) return `${relPath}#${region.name}`;
  return null;
}

function flattenWorkset(value) {
  const workset = value && value.workset ? value.workset : value;
  const paths = new Set();
  const regions = new Set();
  if (!workset || typeof workset !== "object") return { paths, regions };

  for (const role of OVERLAP_ROLES) {
    const entries = Array.isArray(workset[role]) ? workset[role] : [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const relPath = canonicalPath(entry.path);
      if (!relPath) continue;
      paths.add(relPath);
      const rid = regionIdentity(relPath, entry);
      if (rid) regions.add(rid);
    }
  }
  return { paths, regions };
}

// Parent Task Capsules are compiled before the renderer enforces its byte cap.
// Preserve roles/regions only for file rows that the rendered payload actually
// included, so Phase-F overlap never promotes a truncated candidate into a
// delivered fact.
function visibleRoleWorkset(workset, visibleFiles) {
  const allowed = new Set();
  for (const file of visibleFiles || []) {
    const relPath = canonicalPath(file && file.path);
    if (relPath) allowed.add(relPath);
  }
  const out = {
    primary: [], support: [], witnesses: [], hazards: [], unknowns: [], context: [],
  };
  for (const role of ["primary", "support", "witnesses"]) {
    for (const entry of (workset && Array.isArray(workset[role]) ? workset[role] : [])) {
      const relPath = canonicalPath(entry && entry.path);
      if (relPath && allowed.has(relPath)) out[role].push(cloneJson(entry, { path: relPath }));
    }
  }
  return out;
}

// The compact child orientation renders a factual path list, not Task Capsule
// roles or regions. Represent exactly that visible surface in a neutral context
// bucket so path overlap remains available without inventing hidden metadata.
function contextPathWorkset(visibleFiles) {
  const seen = new Set();
  const context = [];
  for (const file of visibleFiles || []) {
    const relPath = canonicalPath(file && file.path);
    if (!relPath || seen.has(relPath)) continue;
    seen.add(relPath);
    context.push({ path: relPath });
  }
  context.sort((a, b) => a.path.localeCompare(b.path));
  return {
    primary: [], support: [], witnesses: [], hazards: [], unknowns: [], context,
  };
}

function sortedIntersection(left, right) {
  const out = [];
  for (const item of left) if (right.has(item)) out.push(item);
  return out.sort((a, b) => a.localeCompare(b));
}

function worksetOverlap(a, b) {
  const left = flattenWorkset(a);
  const right = flattenWorkset(b);
  const allPaths = sortedIntersection(left.paths, right.paths);
  const allRegions = sortedIntersection(left.regions, right.regions);
  return {
    sharedPaths: allPaths.slice(0, MAX_OVERLAP_ITEMS),
    sharedRegions: allRegions.slice(0, MAX_OVERLAP_ITEMS),
    sharedPathTotal: allPaths.length,
    sharedRegionTotal: allRegions.length,
  };
}

function emptyDiff() {
  return { unchanged: [], changed: [], invalidated: [], unknown: [] };
}

function analyzeCoherence(root, { taskId, currentAgentKey, nowMs, maxSnapshots } = {}) {
  const snapshots = listSnapshots(root, { taskId, nowMs, max: maxSnapshots });
  const ordered = [...snapshots].sort((a, b) => a.agentKey.localeCompare(b.agentKey));
  const agentClaims = [];
  let unchangedTotal = 0;
  let changedTotal = 0;
  let invalidatedTotal = 0;
  let unknownTotal = 0;

  for (const snapshot of ordered) {
    let diff = emptyDiff();
    try {
      diff = claims.diffClaims(root, snapshot.servedClaims);
    } catch {}
    unchangedTotal += diff.unchanged.length;
    changedTotal += diff.changed.length;
    invalidatedTotal += diff.invalidated.length;
    unknownTotal += (diff.unknown || []).length;
    agentClaims.push({
      agentKey: snapshot.agentKey,
      parentAgentKey: snapshot.parentAgentKey || null,
      kind: snapshot.kind,
      state: snapshot.state,
      isCurrent: snapshot.agentKey === currentAgentKey,
      unchanged: diff.unchanged,
      changed: diff.changed,
      invalidated: diff.invalidated,
      unknown: diff.unknown || [],
    });
  }

  const allOverlaps = [];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const a = ordered[i];
      const b = ordered[j];
      const overlap = worksetOverlap(a, b);
      if (overlap.sharedPathTotal === 0 && overlap.sharedRegionTotal === 0) continue;
      allOverlaps.push({
        agentA: a.agentKey,
        agentB: b.agentKey,
        involvesCurrent: a.agentKey === currentAgentKey || b.agentKey === currentAgentKey,
        ...overlap,
      });
    }
  }
  allOverlaps.sort((a, b) =>
    a.agentA.localeCompare(b.agentA) || a.agentB.localeCompare(b.agentB)
  );

  return {
    taskId: taskId == null ? null : String(taskId),
    currentAgentKey: currentAgentKey || null,
    snapshotCount: ordered.length,
    agents: ordered.map((snapshot) => ({
      agentKey: snapshot.agentKey,
      parentAgentKey: snapshot.parentAgentKey || null,
      kind: snapshot.kind,
      agentType: snapshot.agentType || null,
      state: snapshot.state,
      createdAt: snapshot.createdAt,
    })),
    agentClaims,
    overlaps: allOverlaps.slice(0, MAX_OVERLAP_PAIRS),
    overlapPairTotal: allOverlaps.length,
    totals: {
      unchanged: unchangedTotal,
      changed: changedTotal,
      invalidated: invalidatedTotal,
      unknown: unknownTotal,
    },
  };
}

function oneLine(value, max = 240) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
}

function claimSubject(claim) {
  const subject = claim && claim.subject ? claim.subject : {};
  const relPath = oneLine(subject.path || "unknown path");
  const symbol = oneLine(subject.symbol || "");
  return symbol ? `${relPath}#${symbol}` : relPath;
}

// Render whole factual lines only and return the exact finding volume that fit.
// When currentAgentKey is known, local claim changes are left to the existing
// single-agent Claim Ledger and this block reports the other recorded agents.
function renderCoherenceDetailed(result, { maxChars, includeOverlaps = true } = {}) {
  if (!result || typeof result !== "object") {
    return {
      text: "",
      delivered: { changed: 0, invalidated: 0, overlapPairs: 0 },
      overlapPaths: [],
    };
  }
  const limit = positiveInt(maxChars, 1400);
  const lines = [];
  let length = 0;
  const delivered = { changed: 0, invalidated: 0, overlapPairs: 0 };
  const overlapPaths = new Set();
  const deliveredPairs = new Set();
  const append = (line) => {
    const clean = oneLine(line, Math.max(limit, 240));
    const extra = clean.length + (lines.length ? 1 : 0);
    if (!clean || length + extra > limit) return false;
    lines.push(clean);
    length += extra;
    return true;
  };
  const finish = () => {
    const deliveredTotal = delivered.changed + delivered.invalidated + delivered.overlapPairs;
    // A capsule-count header is context, not a delivered finding. Callers that
    // already established eligible findings must not emit/score a header-only
    // block when the first whole finding line cannot fit.
    if (hasFindings(result) && deliveredTotal === 0) {
      return { text: "", delivered, overlapPaths: [...overlapPaths].sort() };
    }
    return { text: lines.join("\n"), delivered, overlapPaths: [...overlapPaths].sort() };
  };

  append(`Recorded agent capsules: ${Number(result.snapshotCount) || 0}.`);
  const claimGroups = Array.isArray(result.agentClaims) ? result.agentClaims : [];
  for (const group of claimGroups) {
    if (result.currentAgentKey && group.agentKey === result.currentAgentKey) continue;
    // A PreToolUse snapshot proves only that the rewrite was prepared and
    // published by the hook; it does not prove the Agent tool successfully ran.
    const claimBoundary = group.kind === "child"
      ? "prepared for recorded spawn"
      : "served";
    for (const item of group.invalidated || []) {
      if (!append(
        `Claim ${claimBoundary} no longer holds for ${oneLine(group.agentKey)}: ` +
        `${claimSubject(item.claim)} (${oneLine(item.reason || "invalidated")}).`
      )) return finish();
      delivered.invalidated++;
    }
    for (const item of group.changed || []) {
      if (!append(
        `Claim ${claimBoundary} changed for ${oneLine(group.agentKey)}: ${claimSubject(item.claim)} ` +
        `(${oneLine(item.from)} to ${oneLine(item.to)}).`
      )) return finish();
      delivered.changed++;
    }
  }

  let overlapIndex = 0;
  for (const overlap of includeOverlaps ? (result.overlaps || []) : []) {
    const pairKey = `${overlapIndex++}:${overlap.agentA}:${overlap.agentB}`;
    const pair = `${oneLine(overlap.agentA)} and ${oneLine(overlap.agentB)}`;
    if (overlap.sharedPaths && overlap.sharedPaths.length) {
      if (!append(`Recorded worksets share files for ${pair}: ${overlap.sharedPaths.map((item) => oneLine(item)).join(", ")}.`)) {
        delivered.overlapPairs = deliveredPairs.size;
        return finish();
      }
      deliveredPairs.add(pairKey);
      for (const relPath of overlap.sharedPaths) overlapPaths.add(relPath);
    }
    if (overlap.sharedRegions && overlap.sharedRegions.length) {
      if (!append(`Recorded worksets share regions for ${pair}: ${overlap.sharedRegions.map((item) => oneLine(item)).join(", ")}.`)) {
        delivered.overlapPairs = deliveredPairs.size;
        return finish();
      }
      deliveredPairs.add(pairKey);
    }
  }
  delivered.overlapPairs = deliveredPairs.size;
  return finish();
}

function renderCoherence(result, opts = {}) {
  return renderCoherenceDetailed(result, opts).text;
}

function hasFindings(result) {
  if (!result || typeof result !== "object") return false;
  const crossClaimChange = (result.agentClaims || []).some(
    (group) =>
      (!result.currentAgentKey || group.agentKey !== result.currentAgentKey) &&
      ((group.changed || []).length > 0 || (group.invalidated || []).length > 0)
  );
  return crossClaimChange || (Number(result.overlapPairTotal) || 0) > 0;
}

module.exports = {
  coherenceEnabled,
  parentAgentKey,
  childAgentKey,
  buildSnapshot,
  writeSnapshot,
  pruneSnapshots,
  registerSpawnSnapshot,
  registerReturnSnapshot,
  suppressSpawnSnapshot,
  readAgentSnapshot,
  listSnapshots,
  visibleRoleWorkset,
  contextPathWorkset,
  worksetOverlap,
  analyzeCoherence,
  renderCoherence,
  renderCoherenceDetailed,
  hasFindings,
};
