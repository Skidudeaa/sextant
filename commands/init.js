const fs = require("fs");
const path = require("path");
const intel = require("../lib/intel");

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
  // WHY: tmp+rename so a crash mid-write can't truncate .mcp.json and
  // wipe other MCP servers the user has registered.  Mirrors the atomic
  // write in lib/intel.js:ensureClaudeSettingsUnlocked.
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(existing, null, 2) + "\n");
  fs.renameSync(tmp, p);
  return { path: p, alreadyRegistered: false };
}

// WHY: init was silent — users had no feedback on what it did.  intel.init()
// (called by run() below) wires SessionStart and UserPromptSubmit hooks
// into .claude/settings.json — creating the file if it doesn't exist,
// otherwise merging in.  Report the result so users can see what changed
// and so the rare failure modes (unparseable existing settings.json,
// permission errors) surface as "hooks not wired" rather than silently
// missing the integration.
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
  } else if (!hooks.sessionStart || !hooks.userPromptSubmit) {
    const missing = [];
    if (!hooks.sessionStart) missing.push("SessionStart");
    if (!hooks.userPromptSubmit) missing.push("UserPromptSubmit");
    lines.push(`  ⚠ Missing Claude Code hook(s): ${missing.join(", ")}`);
  } else {
    lines.push(`  ✓ Claude Code hooks configured`);
  }
  lines.push("");
  lines.push("Next:");
  lines.push("  sextant scan --force        # build the dependency graph");
  if (!hooks.exists || !hooks.sessionStart || !hooks.userPromptSubmit) {
    lines.push("");
    lines.push("To wire the Claude Code hooks, add to .claude/settings.json:");
    lines.push('  "hooks": {');
    lines.push('    "SessionStart":     [{ "matcher": "*", "hooks": [{ "type": "command", "command": "sextant hook sessionstart" }] }],');
    lines.push('    "UserPromptSubmit": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "sextant hook refresh"       }] }]');
    lines.push("  }");
  }
  process.stdout.write(lines.join("\n") + "\n");
}

async function run(ctx) {
  for (const r of ctx.roots) {
    await intel.init(r);
    const mcp = ensureMcpJson(r);
    const hooks = checkClaudeHooks(r);
    printStatus(r, mcp, hooks);
  }
}

module.exports = { run, ensureMcpJson, checkClaudeHooks, hasSextantHook };
