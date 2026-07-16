"use strict";

// A small cross-process bakery mutex built from unique contender files. Unlike
// a fixed lockfile, a crashed contender is never replaced at the same path, so
// another process can remove that exact dead generation without a compare-and-
// unlink race deleting a newly published owner.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MAX_CANDIDATES = 4096;
const waitCell = new Int32Array(new SharedArrayBuffer(4));

function processIsLive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !!error && error.code === "EPERM";
  }
}

function processStartIdentity(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(")");
    if (close < 0) return null;
    const fields = raw.slice(close + 2).trim().split(/\s+/);
    // /proc/<pid>/stat field 22; fields[0] is field 3 (`state`).
    return fields[19] ? String(fields[19]) : null;
  } catch {
    return null;
  }
}

function ownerIsLive(payload, observed, staleMs, nowMs = Date.now()) {
  if (!payload || !processIsLive(payload.pid)) return false;
  if (typeof payload.processStartIdentity === "string" && payload.processStartIdentity) {
    const current = processStartIdentity(payload.pid);
    // If the platform cannot expose a generation, fail closed. On Linux a
    // mismatched start tick proves PID reuse rather than lock ownership.
    return current == null || current === payload.processStartIdentity;
  }
  // A live PID without a portable generation is ambiguous. Fail closed even
  // after the stale lease: unlinking a paused owner's unique contender would
  // permit split ownership on platforms without /proc start ticks.
  return true;
}

function readCandidate(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 2048) return { stat, payload: null };
    const payload = JSON.parse(fs.readFileSync(file, "utf8"));
    return { stat, payload };
  } catch {
    return null;
  }
}

function candidatePaths(base) {
  try {
    const directory = path.dirname(base);
    const name = path.basename(base);
    const prefix = `${name}.candidate.`;
    const files = fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) &&
        /^[a-f0-9]{32}$/.test(entry.name.slice(prefix.length)))
      .map((entry) => path.join(directory, entry.name));
    // Read-only compatibility with a lock left by the fixed-path v1 protocol.
    if (fs.existsSync(base)) files.push(base);
    return files.slice(0, MAX_CANDIDATES);
  } catch {
    return null;
  }
}

function validPayload(file, base, observed) {
  const payload = observed && observed.payload;
  if (!payload || typeof payload.token !== "string" ||
      !/^[a-f0-9]{32}$/.test(payload.token) ||
      !Number.isInteger(payload.pid) || payload.pid <= 0) return null;
  const legacy = file === base;
  if (!legacy && !file.endsWith(`.candidate.${payload.token}`)) return null;
  if (legacy) {
    return { ...payload, choosing: false, ticket: 0, legacy: true };
  }
  if (payload.schemaVersion !== 1 || typeof payload.choosing !== "boolean") return null;
  if (!payload.choosing && (!Number.isInteger(payload.ticket) || payload.ticket < 1)) return null;
  return { ...payload, legacy: false };
}

// Safe because contender paths are immutable generations: no future owner ever
// publishes at the same random-token path. The exact fixed base is legacy-only;
// this module never creates a successor there.
function removeDeadCandidate(file, base, observed, staleMs, nowMs = Date.now()) {
  try {
    // The fixed v1 pathname is an upgrade tombstone, not a reusable v2
    // generation. Never unlink it here: leaving a proven-dead owner in place
    // prevents an old writer from republishing at that ambiguous pathname.
    if (file === base) return false;
    if (!observed || nowMs - observed.stat.mtimeMs < staleMs) return false;
    const payload = validPayload(file, base, observed);
    if (payload && (payload.legacy || ownerIsLive(payload, observed, staleMs, nowMs))) return false;
    const again = readCandidate(file);
    if (!again) return false;
    if (payload) {
      const current = validPayload(file, base, again);
      if (!current || current.token !== payload.token || current.pid !== payload.pid) return false;
      if (current.legacy || ownerIsLive(current, again, staleMs, nowMs)) return false;
    } else if (
      again.stat.ino !== observed.stat.ino ||
      again.stat.dev !== observed.stat.dev ||
      nowMs - again.stat.mtimeMs < staleMs
    ) {
      return false;
    }
    fs.rmSync(file);
    return true;
  } catch {
    return false;
  }
}

function writePayload(fd, payload) {
  const raw = JSON.stringify(payload);
  fs.ftruncateSync(fd, 0);
  fs.writeSync(fd, raw, 0, "utf8");
  fs.fsyncSync(fd);
}

function acquireFileMutex(base, options = {}) {
  const attempts = Number.isInteger(options.attempts) && options.attempts > 0
    ? options.attempts
    : 25;
  const waitMs = Number.isFinite(options.waitMs) && options.waitMs >= 0
    ? options.waitMs
    : 2;
  const staleMs = Number.isFinite(options.staleMs) && options.staleMs >= 1
    ? options.staleMs
    : 60_000;
  if (typeof base !== "string" || !base) return null;
  const token = crypto.randomBytes(16).toString("hex");
  const file = `${base}.candidate.${token}`;
  let fd = null;
  try {
    fs.mkdirSync(path.dirname(base), { recursive: true });
    fd = fs.openSync(file, "wx", 0o600);
    writePayload(fd, {
      schemaVersion: 1,
      token,
      pid: process.pid,
      processStartIdentity: processStartIdentity(process.pid),
      choosing: true,
      ticket: null,
      createdAt: Date.now(),
    });

    let maxTicket = 0;
    const initialCandidates = candidatePaths(base);
    if (!initialCandidates) throw new Error("mutex contender enumeration failed");
    for (const other of initialCandidates) {
      if (other === file) continue;
      const observed = readCandidate(other);
      const payload = validPayload(other, base, observed);
      if (payload && payload.legacy && !ownerIsLive(payload, observed, staleMs)) {
        // A dead valid v1 owner is safe to ignore only because its fixed path
        // remains occupied as a tombstone. Old writers cannot acquire it, and
        // v2 never publishes there.
        continue;
      }
      if (payload && !payload.legacy && !ownerIsLive(payload, observed, staleMs)) {
        removeDeadCandidate(other, base, observed, staleMs);
        continue;
      }
      if (payload && Number.isInteger(payload.ticket)) {
        maxTicket = Math.max(maxTicket, payload.ticket);
      }
    }
    const ticket = maxTicket + 1;
    writePayload(fd, {
      schemaVersion: 1,
      token,
      pid: process.pid,
      processStartIdentity: processStartIdentity(process.pid),
      choosing: false,
      ticket,
      createdAt: Date.now(),
    });
    fs.closeSync(fd);
    fd = null;

    for (let attempt = 0; attempt < attempts; attempt++) {
      let blocked = false;
      const listed = candidatePaths(base);
      const files = listed || [];
      if (!listed || files.length >= MAX_CANDIDATES) blocked = true;
      for (const other of files) {
        if (other === file) continue;
        const observed = readCandidate(other);
        const payload = validPayload(other, base, observed);
        if (!payload) {
          if (!removeDeadCandidate(other, base, observed, staleMs)) blocked = true;
          continue;
        }
        if (payload.legacy) {
          if (ownerIsLive(payload, observed, staleMs)) blocked = true;
          continue;
        }
        if (!ownerIsLive(payload, observed, staleMs)) {
          removeDeadCandidate(other, base, observed, staleMs);
          continue;
        }
        if (
          payload.choosing || payload.ticket < ticket ||
          (payload.ticket === ticket && payload.token.localeCompare(token) < 0)
        ) {
          blocked = true;
        }
      }
      const own = readCandidate(file);
      const ownPayload = validPayload(file, base, own);
      if (!blocked && ownPayload && ownPayload.token === token && ownPayload.ticket === ticket) {
        return { file, token, base, ticket };
      }
      if (attempt + 1 < attempts) Atomics.wait(waitCell, 0, 0, waitMs);
    }
  } catch {
    // Fail closed below.
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  try { fs.rmSync(file, { force: true }); } catch {}
  return null;
}

function releaseFileMutex(lock) {
  try {
    if (!lock || !lock.file || !lock.token) return;
    const observed = readCandidate(lock.file);
    const payload = validPayload(lock.file, lock.base, observed);
    if (!payload || payload.token !== lock.token || payload.pid !== process.pid) return;
    fs.rmSync(lock.file);
  } catch {}
}

module.exports = {
  acquireFileMutex,
  releaseFileMutex,
  readCandidate,
  processIsLive,
  processStartIdentity,
  removeDeadCandidate,
};
