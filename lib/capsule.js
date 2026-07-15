"use strict";

// TASK CAPSULE — the durable envelope (docs/027 Phase B).
//
// A prompt is ephemeral; the capsule is the persistent object representing the
// coding task underway: the task text, the repository VERSION it was compiled
// against, and the role-based workset (lib/workset.js). It is the generalization
// of .last_injected_paths — a task sextant can follow across prompts. Phase C/D
// grow it (servedClaims, touchedRegions, status transitions); v1 stubs those.
//
// Facts only; best-effort persistence; never throws.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function shortHash(s) {
  return crypto.createHash("sha256").update(String(s || "")).digest("hex").slice(0, 10);
}

function capsuleFile(root, sessionKey) {
  return path.join(root, ".planning", "intel", `.capsule.${sessionKey}`);
}

// Repo fingerprint = the version the capsule was compiled against. Reuses the
// freshness anchors (git HEAD + status hash) + branch, so a later read can tell
// whether the capsule's structural claims are still valid (Phase C invalidation).
function repoFingerprint(rootAbs) {
  const fp = { root: rootAbs, branch: null, head: null, statusHash: null };
  try {
    const { getGitInfo } = require("./git");
    const gi = getGitInfo(rootAbs);
    if (gi) {
      fp.branch = gi.branch;
      fp.head = gi.head;
    }
  } catch {}
  try {
    const state = require("./freshness").captureCurrentState(rootAbs);
    if (state) {
      if (state.head) fp.head = state.head;
      fp.statusHash = state.statusHash ?? null;
    }
  } catch {}
  return fp;
}

// Build a capsule object (does not persist — call writeCapsule).
//   { root, sessionKey, taskText, workset, nowMs }
// taskId is derived from sessionKey → one stable capsule per session (v1).
function buildCapsule({ root, sessionKey, taskText, workset, nowMs }) {
  const repo = repoFingerprint(root);
  return {
    taskId: "task_" + shortHash(sessionKey),
    sessionId: String(sessionKey || ""),
    createdAt: typeof nowMs === "number" ? nowMs : Date.now(),
    repo,
    intent: { text: typeof taskText === "string" ? taskText.slice(0, 500) : "", declaredBy: "agent" },
    workset: workset || { primary: [], support: [], witnesses: [], hazards: [], unknowns: [] },
    // Phase C/D substrate — present but empty in v1 so consumers can rely on shape.
    servedClaims: [],
    touchedRegions: [],
    status: "orienting",
  };
}

// A fresh retrieval recompiles the task's workset and served-claim baseline,
// but it does NOT start a new task. Preserve evidence accumulated by
// PostToolUse across prompt turns (Phase D touchedRegions) plus the original
// creation time/status. `servedClaims` deliberately comes from `next`: those
// are the facts in the newly served block, not an append-only history.
//
// Kept pure so hook-refresh can stage a candidate capsule and publish it only
// after the armed/non-deduped block is actually emitted. That avoids recording
// holdback or deduped rows as "served" facts.
function carryForwardCapsule(next, prior) {
  if (!next || typeof next !== "object") return next;
  if (!prior || typeof prior !== "object" || prior.taskId !== next.taskId) return next;
  return {
    ...next,
    createdAt: typeof prior.createdAt === "number" ? prior.createdAt : next.createdAt,
    touchedRegions: Array.isArray(prior.touchedRegions) ? prior.touchedRegions : [],
    status: typeof prior.status === "string" ? prior.status : next.status,
  };
}

const CAPSULE_LOCK_ATTEMPTS = 25;
const CAPSULE_LOCK_WAIT_MS = 2;
const capsuleWaitCell = new Int32Array(new SharedArrayBuffer(4));

function capsuleLockFile(root, sessionKey) {
  return path.join(root, ".planning", "intel", `.capsule-lock.${shortHash(sessionKey)}`);
}

// Cross-process integrity lock for the mutable per-session capsule. This does
// not coordinate agents or reserve code: it only makes the capsule's own
// read-modify-write operations atomic so a prompt refresh cannot erase a
// concurrent PostToolUse structural-delta append.
function withCapsuleLock(root, sessionKey, fn) {
  const lock = capsuleLockFile(root, sessionKey);
  const token = `${process.pid}:${crypto.randomBytes(12).toString("hex")}`;
  let fd = null;
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    for (let attempt = 0; attempt < CAPSULE_LOCK_ATTEMPTS; attempt++) {
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
        if (created) {
          try { fs.rmSync(lock, { force: true }); } catch {}
          return false;
        }
        if (!error || error.code !== "EEXIST") return false;
        // Fail closed on every existing path. A stat/read followed by unlink
        // can delete a newly recreated owner's lock, and an old owner must
        // never unconditionally remove a successor's path.
        Atomics.wait(capsuleWaitCell, 0, 0, CAPSULE_LOCK_WAIT_MS);
      }
    }
    if (fd == null) return false;
    return fn();
  } catch {
    return false;
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

function writeCapsuleUnlocked(root, sessionKey, capsule) {
  try {
    const file = capsuleFile(root, sessionKey);
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(capsule));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

function writeCapsule(root, sessionKey, capsule) {
  return withCapsuleLock(root, sessionKey, () =>
    writeCapsuleUnlocked(root, sessionKey, capsule)
  );
}

// A refresh stages its new workset/claim baseline before it reaches the output
// boundary. Merge task-long evidence again INSIDE the write lock so an edit
// appended after staging but before publication cannot be lost.
function writeCapsulePreservingEvidence(root, sessionKey, capsule) {
  return withCapsuleLock(root, sessionKey, () => {
    const current = readCapsule(root, sessionKey);
    const merged = carryForwardCapsule(capsule, current);
    return writeCapsuleUnlocked(root, sessionKey, merged);
  });
}

function readCapsule(root, sessionKey) {
  try {
    return JSON.parse(fs.readFileSync(capsuleFile(root, sessionKey), "utf8"));
  } catch {
    return null;
  }
}

// Most-recently-written capsule for a repo (MCP has no sessionKey — it reports
// whatever the live session most recently focused). null when none.
function readLatestCapsule(root) {
  try {
    const dir = path.join(root, ".planning", "intel");
    const files = fs
      .readdirSync(dir)
      .filter((n) => n.startsWith(".capsule."))
      .map((n) => {
        const p = path.join(dir, n);
        let mtime = 0;
        try {
          mtime = fs.statSync(p).mtimeMs;
        } catch {}
        return { p, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return null;
    return JSON.parse(fs.readFileSync(files[0].p, "utf8"));
  } catch {
    return null;
  }
}

// Is a capsule's repo fingerprint still current? (Phase C invalidation seed.)
// Returns { fresh, reason } — reason names the first anchor that moved.
function capsuleFreshness(root, capsule) {
  try {
    if (!capsule || !capsule.repo) return { fresh: false, reason: "no_capsule" };
    const cur = repoFingerprint(root);
    if (capsule.repo.head && cur.head && capsule.repo.head !== cur.head) {
      return { fresh: false, reason: "head_changed" };
    }
    if ((capsule.repo.statusHash ?? "") !== (cur.statusHash ?? "")) {
      return { fresh: false, reason: "status_changed" };
    }
    return { fresh: true, reason: null };
  } catch {
    return { fresh: false, reason: "error" };
  }
}

// Is capsule mode on for this repo? SEXTANT_CAPSULE=1 env or `.codebase-intel.json`
// `capsule: true`. Default-off (canonical gate — hook-refresh + hook-posttooluse
// both read this so B/C/D turn on together).
function capsuleEnabled(root, env = process.env) {
  const e = env && env.SEXTANT_CAPSULE;
  if (e === "1" || e === "true") return true;
  if (e === "0" || e === "false") return false;
  try {
    return require("./config").loadRepoConfig(root).capsule === true;
  } catch {
    return false;
  }
}

// STRUCTURAL DELTA seam (docs/029 Phase D): append a touched-region record (the
// per-edit structural delta) to the capsule so the closure report can summarize
// what the task changed. Bounded; no-op when no capsule exists for the session.
function appendTouchedRegion(root, sessionKey, entry, maxEntries = 200) {
  return withCapsuleLock(root, sessionKey, () => {
    const cap = readCapsule(root, sessionKey);
    if (!cap) return false;
    if (!Array.isArray(cap.touchedRegions)) cap.touchedRegions = [];
    cap.touchedRegions.push(entry);
    if (cap.touchedRegions.length > maxEntries) {
      cap.touchedRegions = cap.touchedRegions.slice(-maxEntries);
    }
    return writeCapsuleUnlocked(root, sessionKey, cap);
  });
}

module.exports = {
  capsuleFile,
  repoFingerprint,
  buildCapsule,
  carryForwardCapsule,
  writeCapsule,
  writeCapsulePreservingEvidence,
  readCapsule,
  readLatestCapsule,
  capsuleFreshness,
  capsuleEnabled,
  appendTouchedRegion,
  shortHash,
};
