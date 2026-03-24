"use strict";

// WHY: Centralized session key derivation used by hooks for per-session dedupe.
// The refresh script (tools/codebase_intel/refresh.js) has an intentional copy
// of this logic because it's deployed standalone into target projects.
function deriveSessionKey(data) {
  return (
    data?.session_id ||
    data?.conversation_id ||
    data?.run_id ||
    data?.terminal_id ||
    process.env.CURSOR_SESSION_ID ||
    process.env.TMUX_PANE ||
    process.env.SSH_TTY ||
    String(process.ppid || process.pid)
  )
    .toString()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 80);
}

module.exports = { deriveSessionKey };
