#!/usr/bin/env node
"use strict";

// WHY: Standalone refresh script deployed into each project's tools/ directory.
// Called by the UserPromptSubmit hook to inject updated summaries mid-session.
// Reads summary.md, compares SHA-256 hash to last injection, emits on change.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = process.cwd();
const summaryPath = path.join(root, ".planning", "intel", "summary.md");

async function main() {
  // Read hook payload from stdin
  let input = "";
  process.stdin.setEncoding("utf8");
  await new Promise((resolve) => {
    process.stdin.on("data", (c) => (input += c));
    process.stdin.on("end", resolve);
  });

  let data = {};
  try {
    data = input ? JSON.parse(input) : {};
  } catch {}

  if (!fs.existsSync(summaryPath)) process.exit(0);

  const summary = fs.readFileSync(summaryPath, "utf8").trim();
  if (!summary) process.exit(0);

  // Per-session dedupe: derive session key from hook payload or env
  const sessionKey = (
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

  const cachePath = path.join(
    root,
    ".planning",
    "intel",
    `.last_injected_hash.${sessionKey}`
  );

  const h = crypto.createHash("sha256").update(summary).digest("hex");
  const last = fs.existsSync(cachePath)
    ? fs.readFileSync(cachePath, "utf8").trim()
    : "";

  if (last === h) process.exit(0);

  fs.writeFileSync(cachePath, h);

  // stdout -> Claude context
  // WHY: Strip XML wrapper tags as defense-in-depth against tampered summary.md
  const safe = summary.replace(/<\/?codebase-intelligence[^>]*>/gi, "");
  process.stdout.write(
    `<codebase-intelligence>\n(refreshed: ${new Date().toISOString()})\n${safe}\n</codebase-intelligence>`
  );
}

main().catch(() => process.exit(1));
