const fs = require("fs");
const path = require("path");
const os = require("os");
const intel = require("../lib/intel");
const { hasFlag } = require("../lib/cli");

// WHY: .mcp.json registers the sextant MCP server with Claude Code.
// Merges into existing file to avoid clobbering other MCP servers.
const SEXTANT_MCP_ENTRY = {
  type: "stdio",
  command: "sextant",
  args: ["mcp"],
};

function ensureMcpJson(root) {
  const p = path.join(root, ".mcp.json");
  let existing = {};
  if (fs.existsSync(p)) {
    try { existing = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  }
  if (existing?.mcpServers?.sextant) return { path: p, alreadyRegistered: true };
  existing.mcpServers = existing.mcpServers || {};
  existing.mcpServers.sextant = SEXTANT_MCP_ENTRY;
  // WHY tmp+rename: .mcp.json may already hold OTHER MCP servers. A bare
  // writeFileSync truncates-then-writes; a crash mid-write leaves a truncated
  // file and silently wipes the user's other servers. rename(2) is atomic on
  // the same filesystem — the file is either the old valid JSON or the new.
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(existing, null, 2) + "\n");
  fs.renameSync(tmp, p);
  return { path: p, alreadyRegistered: false };
}

// WHY: init was silent — users had no feedback on what it did.  intel.init()
// (called from run() below) DOES wire the SessionStart + UserPromptSubmit
// hooks into .claude/settings.json via ensureClaudeSettingsUnlocked.  These
// helpers VERIFY the write landed and report it.  The "add to settings.json"
// fallback in printStatus only fires in the rare case ensureClaudeSettings
// bailed without writing — a pre-existing settings.json that isn't readable
// JSON or isn't an object (it deliberately refuses to clobber unreadable user
// config).  Honest output beats mismatched docs.
function hasSextantHook(settings, event) {
  const events = settings?.hooks?.[event];
  if (!Array.isArray(events)) return false;
  for (const group of events) {
    const hooks = group?.hooks;
    if (!Array.isArray(hooks)) continue;
    for (const h of hooks) {
      if (typeof h?.command !== "string") continue;
      if (/\b(sextant|codebase-intel)\s+hook\b/.test(h.command)) return true;
    }
  }
  return false;
}

function checkClaudeHooks(root) {
  const p = path.join(root, ".claude", "settings.json");
  if (!fs.existsSync(p)) {
    return { path: p, exists: false, sessionStart: false, userPromptSubmit: false };
  }
  let data = {};
  try { data = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  return {
    path: p,
    exists: true,
    sessionStart: hasSextantHook(data, "SessionStart"),
    userPromptSubmit: hasSextantHook(data, "UserPromptSubmit"),
    postToolUse: hasSextantHook(data, "PostToolUse"),
  };
}

function printStatus(root, mcp, hooks) {
  const rel = (p) => path.relative(root, p) || p;
  const stateDir = path.join(root, ".planning", "intel");
  const lines = [];
  lines.push(`Initializing sextant in ${root}`);
  lines.push(`  ✓ Created ${rel(stateDir)}/`);
  if (mcp.alreadyRegistered) {
    lines.push(`  ✓ MCP server already registered in ${rel(mcp.path)}`);
  } else {
    lines.push(`  ✓ Registered MCP server in ${rel(mcp.path)}`);
  }
  if (!hooks.exists) {
    lines.push(`  ⚠ .claude/settings.json not found — Claude Code hooks NOT configured`);
  } else if (!hooks.sessionStart || !hooks.userPromptSubmit || !hooks.postToolUse) {
    const missing = [];
    if (!hooks.sessionStart) missing.push("SessionStart");
    if (!hooks.userPromptSubmit) missing.push("UserPromptSubmit");
    if (!hooks.postToolUse) missing.push("PostToolUse");
    lines.push(`  ⚠ Missing Claude Code hook(s): ${missing.join(", ")}`);
  } else {
    lines.push(`  ✓ Claude Code hooks configured`);
  }
  lines.push("");
  lines.push("Next:");
  lines.push("  sextant scan --force        # build the dependency graph");
  if (!hooks.exists || !hooks.sessionStart || !hooks.userPromptSubmit || !hooks.postToolUse) {
    lines.push("");
    lines.push("To wire the Claude Code hooks, add to .claude/settings.json:");
    lines.push('  "hooks": {');
    lines.push('    "SessionStart":     [{ "matcher": "*", "hooks": [{ "type": "command", "command": "sextant hook sessionstart" }] }],');
    lines.push('    "UserPromptSubmit": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "sextant hook refresh"       }] }],');
    lines.push('    "PostToolUse":      [{ "matcher": "Read|Edit|Write|MultiEdit|NotebookEdit", "hooks": [{ "type": "command", "command": "sextant hook posttooluse" }] }]');
    lines.push("  }");
  }
  process.stdout.write(lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// Codex wiring (`sextant init --codex`)
//
// Codex reads NONE of the Claude-Code surfaces sextant normally writes:
//   - `.mcp.json`           → Claude only; Codex MCP lives in ~/.codex/config.toml
//   - `.claude/settings.json` hooks → Claude only; Codex hooks live in .codex/hooks.json
// so a plain `sextant init` leaves sextant completely dark under Codex. `--codex`
// writes the three pieces Codex DOES read: per-repo .codex/hooks.json (auto-
// injection), per-repo AGENTS.md (session-start orientation), and the GLOBAL
// ~/.codex/config.toml MCP registration (on-demand search tools).
// ---------------------------------------------------------------------------

// WHY mirror the Claude hook shape: Codex accepts the same `{hooks:{Event:[...]}}`
// JSON and maps SessionStart/UserPromptSubmit onto its internal session_start /
// user_prompt_submit events (verified: ~/.codex/config.toml stores a trusted_hash
// for an existing repo's .codex/hooks.json with `user_prompt_submit:0:0`).
// PostToolUse is intentionally omitted — it's unverified under Codex and an
// unknown event could break hook parsing; the static+query-aware injection (the
// two events here) is the proven set.
const CODEX_SESSIONSTART = { matcher: "*", hooks: [{ type: "command", command: "sextant hook sessionstart" }] };
const CODEX_USERPROMPT = { hooks: [{ type: "command", command: "sextant hook refresh" }] };

function ensureCodexHooks(root) {
  const dir = path.join(root, ".codex");
  // A stray FILE named .codex (e.g. an accidental `touch`/redirect) makes
  // mkdirSync throw a bare EEXIST stack trace. Surface it as an actionable
  // message instead — sextant exists to make state legible, not crash on it.
  if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) {
    throw new Error(
      `${dir} exists but is not a directory — remove it, then re-run \`sextant init --codex\``
    );
  }
  const p = path.join(dir, "hooks.json");
  let existing = {};
  if (fs.existsSync(p)) {
    try { existing = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  }
  const hadSession = hasSextantHook(existing, "SessionStart");
  const hadPrompt = hasSextantHook(existing, "UserPromptSubmit");
  if (hadSession && hadPrompt) return { path: p, alreadyConfigured: true };
  existing.hooks = existing.hooks || {};
  if (!hadSession) {
    existing.hooks.SessionStart = existing.hooks.SessionStart || [];
    existing.hooks.SessionStart.push(CODEX_SESSIONSTART);
  }
  if (!hadPrompt) {
    existing.hooks.UserPromptSubmit = existing.hooks.UserPromptSubmit || [];
    existing.hooks.UserPromptSubmit.push(CODEX_USERPROMPT);
  }
  fs.mkdirSync(dir, { recursive: true });
  // Atomic: .codex/hooks.json may hold the user's own hooks — tmp+rename so a
  // crash mid-write can't truncate them (same rationale as ensureMcpJson).
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(existing, null, 2) + "\n");
  fs.renameSync(tmp, p);
  return { path: p, alreadyConfigured: false };
}

// WHY check-then-append, no auto-create: ~/.codex/config.toml is GLOBAL user
// config. If it doesn't exist Codex isn't set up here — synthesizing one is
// overreach, so we report exists:false and let printCodexStatus print the block.
// Node has no TOML writer, but a fresh `[mcp_servers.sextant]` table appended at
// EOF is unambiguous TOML regardless of what precedes it (a table header starts
// a new table), so a literal append is safe and lossless for the additive case.
function ensureCodexMcp(home = os.homedir()) {
  const p = path.join(home, ".codex", "config.toml");
  if (!fs.existsSync(p)) return { path: p, exists: false, alreadyRegistered: false };
  const content = fs.readFileSync(p, "utf8");
  if (/^[ \t]*\[mcp_servers\.sextant\]/m.test(content)) {
    return { path: p, exists: true, alreadyRegistered: true };
  }
  const sep = content.endsWith("\n") ? "" : "\n";
  const block = `${sep}\n[mcp_servers.sextant]\ncommand = "sextant"\nargs = ["mcp"]\n`;
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, content + block);
  fs.renameSync(tmp, p);
  return { path: p, exists: true, alreadyRegistered: false };
}

const AGENTS_SEXTANT_SECTION = `## Orientation: use sextant before grepping

This repo is indexed by **sextant** (dependency-graph + full-text code intelligence).

- A \`.codex/hooks.json\` hook injects a fresh codebase map at session start and
  query-aware file hits on each prompt. Trust those over guessing file paths; an
  "index stale" note means structural ranking is suppressed (live text matches only).
- Prefer the sextant MCP tools over raw \`grep\`/\`rg\`:
  - \`sextant_search\` — ranked code search (use INSTEAD of grep to find defs/symbols).
  - \`sextant_related\` — imports + dependents of a file (blast radius before editing).
  - \`sextant_explain\` — a file's fan-in/fan-out, exports, role.
  - \`sextant_health\` — index resolution % + freshness (check before trusting ranks).
  - \`sextant_scope\` — what's excluded from the index (vendored subtrees).
`;

const AGENTS_HEADER = `# AGENTS.md

Guidance for coding agents working in this repo.

`;

// WHY merge, don't clobber: AGENTS.md is user-authored project content. Create it
// only when absent; if it exists but never mentions sextant, append our section;
// if it already mentions sextant, leave it entirely alone.
function ensureAgentsMd(root) {
  const p = path.join(root, "AGENTS.md");
  if (fs.existsSync(p)) {
    const content = fs.readFileSync(p, "utf8");
    if (/sextant/i.test(content)) return { path: p, action: "already-mentions" };
    const sep = content.endsWith("\n") ? "\n" : "\n\n";
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, content + sep + AGENTS_SEXTANT_SECTION);
    fs.renameSync(tmp, p);
    return { path: p, action: "appended" };
  }
  fs.writeFileSync(p, AGENTS_HEADER + AGENTS_SEXTANT_SECTION);
  return { path: p, action: "created" };
}

function printCodexStatus(root, hooks, agents, mcp) {
  const rel = (p) => path.relative(root, p) || p;
  const lines = ["", "Codex wiring:"];
  lines.push(hooks.alreadyConfigured
    ? `  ✓ Codex hooks already configured in ${rel(hooks.path)}`
    : `  ✓ Wired Codex hooks (SessionStart + UserPromptSubmit) in ${rel(hooks.path)}`);
  const agentMsg = {
    created: `  ✓ Created AGENTS.md with sextant orientation`,
    appended: `  ✓ Appended sextant section to existing AGENTS.md`,
    "already-mentions": `  ✓ AGENTS.md already references sextant`,
  };
  lines.push(agentMsg[agents.action]);
  if (!mcp.exists) {
    lines.push(`  ⚠ ~/.codex/config.toml not found — Codex MCP NOT registered`);
    lines.push(`     Add this block to ~/.codex/config.toml once Codex is set up:`);
    lines.push(`       [mcp_servers.sextant]`);
    lines.push(`       command = "sextant"`);
    lines.push(`       args = ["mcp"]`);
  } else if (mcp.alreadyRegistered) {
    lines.push(`  ✓ Codex MCP server already registered in ${mcp.path}`);
  } else {
    lines.push(`  ✓ Registered Codex MCP server in ${mcp.path}`);
  }
  lines.push("");
  lines.push("  Restart Codex to load the changes; it will prompt to trust .codex/hooks.json.");
  process.stdout.write(lines.join("\n") + "\n");
}

async function run(ctx) {
  const codex = hasFlag(process.argv, "--codex");
  let codexMcp = null;
  for (const r of ctx.roots) {
    await intel.init(r);
    const mcp = ensureMcpJson(r);
    const hooks = checkClaudeHooks(r);
    printStatus(r, mcp, hooks);
    if (codex) {
      const codexHooks = ensureCodexHooks(r);
      const agents = ensureAgentsMd(r);
      // Global registration is idempotent — run once, reuse the result per root.
      codexMcp = codexMcp || ensureCodexMcp();
      printCodexStatus(r, codexHooks, agents, codexMcp);
    }
  }
}

module.exports = {
  run,
  ensureMcpJson,
  checkClaudeHooks,
  hasSextantHook,
  ensureCodexHooks,
  ensureCodexMcp,
  ensureAgentsMd,
};
