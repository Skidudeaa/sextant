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

function writeCapsule(root, sessionKey, capsule) {
  try {
    const file = capsuleFile(root, sessionKey);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(capsule));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
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

module.exports = {
  capsuleFile,
  repoFingerprint,
  buildCapsule,
  writeCapsule,
  readCapsule,
  readLatestCapsule,
  capsuleFreshness,
  shortHash,
};
