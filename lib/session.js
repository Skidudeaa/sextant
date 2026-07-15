"use strict";

const crypto = require("crypto");

// Raw identity is kept separately from the filesystem-safe key. Phase F hashes
// the raw value so two runtime IDs that sanitize to the same filename cannot be
// conflated as one recorded agent.
function rawSessionIdentity(data) {
  return (
    data?.session_id ||
    data?.conversation_id ||
    data?.run_id ||
    data?.terminal_id ||
    process.env.CURSOR_SESSION_ID ||
    process.env.TMUX_PANE ||
    process.env.SSH_TTY ||
    String(process.ppid || process.pid)
  ).toString();
}

// WHY: Centralized filesystem-safe session key used by hooks for per-session
// dedupe/state filenames.
function deriveSessionKey(data) {
  const raw = rawSessionIdentity(data).toString();
  const sanitized = raw.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (sanitized === raw && raw.length <= 80) return raw;

  // Sanitizing or truncating is lossy (`session/a` and `session_a` used to
  // collapse onto one mutable capsule/task id). Retain a readable prefix but
  // append a hash of the RAW identity whenever loss occurred. Allowed short
  // ids keep their legacy filename byte-for-byte.
  const suffix = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12);
  const prefix = sanitized.slice(0, 80 - suffix.length - 1);
  return `${prefix}_${suffix}`;
}

module.exports = { deriveSessionKey, rawSessionIdentity };
