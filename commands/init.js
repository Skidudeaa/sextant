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
// (called from run() below) DOES wire the base Sextant Claude hook set plus
// the gated PreToolUse experiment hook when capsule+coherence are enabled
// into .claude/settings.json via ensureClaudeSettingsUnlocked.  These
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

// Unlike hasSextantHook(), this verifies one exact lifecycle surface. A generic
// "some Sextant PostToolUse exists" check cannot distinguish file scoring from
// the Task/Agent return join, and used to report incomplete Phase-F wiring as
// healthy.
function hasHookCommand(settings, event, command, matcher) {
  const events = settings?.hooks?.[event];
  if (!Array.isArray(events)) return false;
  return events.some((group) => {
    if (!group || typeof group !== "object") return false;
    if (!intel.matcherCovers(group.matcher, matcher)) return false;
    if (!Array.isArray(group.hooks)) return false;
    return group.hooks.some((hook) =>
      intel.exactSynchronousShellHook(hook, command));
  });
}

function hasHookConflict(settings, event, command, matcher) {
  return intel.settingsHookConflict(settings, event, command, matcher);
}

function checkClaudeHooks(root, scopeOptions = {}) {
  const p = path.join(root, ".claude", "settings.json");
  const scopeState = intel.inspectClaudeHookScopes(root, scopeOptions);
  const preTaskRequired = require("../lib/coherence").coherenceEnabled(root);
  if (!fs.existsSync(p)) {
    return {
      path: p,
      exists: false,
      sessionStart: false,
      userPromptSubmit: false,
      filePostToolUse: false,
      subagentStart: false,
      taskPreToolUse: false,
      taskPostToolUse: false,
      preTaskRequired,
      taskPreToolUseConflict:
        preTaskRequired && scopeState.externalPreTaskConflicts.length > 0,
      externalPreTaskConflicts: scopeState.externalPreTaskConflicts,
      hooksDisabled: scopeState.hooksDisabled,
      hooksDisabledSource: scopeState.hooksDisabledSource,
      projectHooksBlockedByPolicy: scopeState.projectHooksBlockedByPolicy,
      managedOnlySource: scopeState.managedOnlySource,
    };
  }
  let data = {};
  try { data = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  return {
    path: p,
    exists: true,
    sessionStart: hasHookCommand(
      data, "SessionStart", "sextant hook sessionstart", "*"
    ),
    userPromptSubmit: hasHookCommand(
      data, "UserPromptSubmit", "sextant hook refresh", "*"
    ),
    filePostToolUse: hasHookCommand(
      data,
      "PostToolUse",
      "sextant hook posttooluse",
      "Read|Edit|Write|MultiEdit|NotebookEdit"
    ),
    subagentStart: hasHookCommand(
      data, "SubagentStart", "sextant hook subagentstart", "*"
    ),
    taskPreToolUse: hasHookCommand(
      data, "PreToolUse", "sextant hook pretask", "Task|Agent"
    ),
    taskPostToolUse: hasHookCommand(
      data, "PostToolUse", "sextant hook posttooluse", "Task|Agent"
    ),
    preTaskRequired,
    taskPreToolUseConflict: preTaskRequired && (
      hasHookConflict(data, "PreToolUse", "sextant hook pretask", "Task|Agent") ||
      scopeState.externalPreTaskConflicts.length > 0
    ),
    externalPreTaskConflicts: scopeState.externalPreTaskConflicts,
    hooksDisabled: scopeState.hooksDisabled,
    hooksDisabledSource: scopeState.hooksDisabledSource,
    projectHooksBlockedByPolicy: scopeState.projectHooksBlockedByPolicy,
    managedOnlySource: scopeState.managedOnlySource,
  };
}

function claudeHooksComplete(hooks) {
  return Boolean(
    hooks.exists &&
    hooks.sessionStart &&
    hooks.userPromptSubmit &&
    hooks.filePostToolUse &&
    hooks.subagentStart &&
    (!hooks.preTaskRequired || hooks.taskPreToolUse) &&
    hooks.taskPostToolUse &&
    !hooks.taskPreToolUseConflict &&
    !hooks.hooksDisabled &&
    !hooks.projectHooksBlockedByPolicy
  );
}

function displayHookSource(root, source) {
  if (!source || !source.file) return "another Claude settings scope";
  const home = os.homedir();
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (configDir && source.file === path.join(configDir, "settings.json")) {
    return "$CLAUDE_CONFIG_DIR/settings.json";
  }
  if (source.file === path.join(home, ".claude", "settings.json")) {
    return "~/.claude/settings.json";
  }
  const relative = path.relative(root, source.file);
  return relative && !relative.startsWith("..") ? relative : source.file;
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
  if (hooks.hooksDisabled) {
    lines.push(`  ⚠ Claude Code hooks are disabled by ${displayHookSource(root, hooks.hooksDisabledSource)}`);
  } else if (hooks.projectHooksBlockedByPolicy) {
    lines.push(`  ⚠ Project hooks are blocked by managed allowManagedHooksOnly policy`);
  } else if (!hooks.exists) {
    lines.push(`  ⚠ .claude/settings.json not found — Claude Code hooks NOT configured`);
  } else if (!claudeHooksComplete(hooks)) {
    const missing = [];
    if (!hooks.sessionStart) missing.push("SessionStart");
    if (!hooks.userPromptSubmit) missing.push("UserPromptSubmit");
    if (!hooks.filePostToolUse) missing.push("PostToolUse(file tools)");
    if (!hooks.subagentStart) missing.push("SubagentStart");
    if (hooks.preTaskRequired && !hooks.taskPreToolUse) missing.push("PreToolUse(Task|Agent experiment)");
    if (!hooks.taskPostToolUse) missing.push("PostToolUse(Task|Agent)");
    if (hooks.taskPreToolUseConflict) missing.push("PreToolUse(Task|Agent conflict)");
    lines.push(`  ⚠ Missing Claude Code hook(s): ${missing.join(", ")}`);
    if (hooks.taskPreToolUseConflict) {
      lines.push("    Existing Task/Agent PreToolUse handler left untouched; input rewriters cannot be auto-composed safely.");
      if (hooks.externalPreTaskConflicts?.length) {
        const sources = hooks.externalPreTaskConflicts
          .map((source) => displayHookSource(root, source))
          .join(", ");
        lines.push(`    Overlap found outside project settings: ${sources}`);
      }
    }
  } else {
    lines.push(`  ✓ Claude Code hooks configured`);
  }
  lines.push("");
  lines.push("Next:");
  lines.push("  sextant scan --force        # build the dependency graph");
  if (hooks.hooksDisabled) {
    lines.push("");
    lines.push(`Set disableAllHooks to false or remove it in ${displayHookSource(root, hooks.hooksDisabledSource)}.`);
  } else if (hooks.projectHooksBlockedByPolicy) {
    lines.push("");
    lines.push("Managed policy allows only managed hooks; ask the policy owner to deploy Sextant there.");
  } else if (hooks.taskPreToolUseConflict) {
    lines.push("");
    lines.push("Resolve the existing Task/Agent PreToolUse handler before adding Sextant's input rewriter.");
    lines.push("Sextant leaves it untouched because concurrent updatedInput rewrites are not safely composable.");
  } else if (!claudeHooksComplete(hooks)) {
    lines.push("");
    lines.push("To wire the Claude Code hooks, add to .claude/settings.json:");
    lines.push('  "hooks": {');
    lines.push('    "SessionStart":     [{ "matcher": "*", "hooks": [{ "type": "command", "command": "sextant hook sessionstart" }] }],');
    lines.push('    "UserPromptSubmit": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "sextant hook refresh"       }] }],');
    lines.push('    "PostToolUse":      [{ "matcher": "Read|Edit|Write|MultiEdit|NotebookEdit", "hooks": [{ "type": "command", "command": "sextant hook posttooluse" }] },');
    lines.push('                         { "matcher": "Task|Agent", "hooks": [{ "type": "command", "command": "sextant hook posttooluse" }] }],');
    lines.push('    "SubagentStart":    [{ "matcher": "*", "hooks": [{ "type": "command", "command": "sextant hook subagentstart" }] }]' + (hooks.preTaskRequired ? ',' : ''));
    if (hooks.preTaskRequired) {
      lines.push('    "PreToolUse":       [{ "matcher": "Task|Agent", "hooks": [{ "type": "command", "command": "sextant hook pretask" }] }]');
    }
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
// Codex 0.144.4 has an exact `spawn_agent` Pre/PostToolUse identity seam, so an
// operational Phase-F spawn adapter is feasible. The existing Claude handler
// is not Codex-wire-compatible (`message` vs `prompt`, and Codex requires an
// allow decision when returning updatedInput), and Codex lacks the file-tool
// observation parity required by the overlap experiment. Keep init on the two
// field-verified hooks until a dedicated spawn adapter can be installed without
// enrolling Codex in the causal denominator.
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

// ---------------------------------------------------------------------------
// Kimi Code wiring (`sextant init --kimi`)
//
// Kimi Code (v0.31.1, verified 2026-08-02) reads: (1) global-only hooks —
// `[[hooks]]` array-of-tables in ~/.kimi-code/config.toml, strict schema, no
// per-repo hook config; (2) AGENTS.md, merged into its system prompt but
// explicitly de-privileged ("not a privileged instruction channel"); (3) the
// repo's .mcp.json (its layer-2 MCP config) — so plain `sextant init` already
// registers the MCP tools. Observed before wiring: Kimi discovered the 9 tools
// on every request and called them 2 times against 994 Grep calls — the hook
// channel delivers RESULTS instead of instructions, sidestepping that.
//
// Only UserPromptSubmit is wired: Kimi injects that event's stdout into model
// context verbatim (<hook_result> tag) but DISCARDS SessionStart output — and
// hook-sessionstart's watcher auto-start must not run globally anyway. The
// wired command sets SEXTANT_REQUIRE_STATE=1 (lib/root-guard.js: adopt only
// repos with existing .planning/intel — a GLOBAL hook fires everywhere, and
// opt-in must be per-repo) and SEXTANT_CLIENT=kimi (telemetry attribution).
// Exactly two keys in the block: the schema is .strict(), and the 30s default
// timeout covers the ~12s worst case (stdin stall + bounded sync rescan).
// ---------------------------------------------------------------------------
const KIMI_HOOK_BLOCK = `[[hooks]]
event = "UserPromptSubmit"
command = "SEXTANT_CLIENT=kimi SEXTANT_REQUIRE_STATE=1 sextant hook refresh"
`;

function ensureKimiHooks(home = os.homedir()) {
  const p = path.join(home, ".kimi-code", "config.toml");
  // No auto-create: absent global config means Kimi Code isn't set up here —
  // synthesizing one is overreach (same rationale as ensureCodexMcp).
  if (!fs.existsSync(p)) return { path: p, exists: false, alreadyConfigured: false };
  const content = fs.readFileSync(p, "utf8");
  // Anchored on an UNCOMMENTED command= line so a commented-out block does not
  // count as wired.
  if (/^[ \t]*command\s*=\s*".*\bsextant hook refresh\b/m.test(content)) {
    return { path: p, exists: true, alreadyConfigured: true };
  }
  const sep = content.endsWith("\n") ? "" : "\n";
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, content + `${sep}\n` + KIMI_HOOK_BLOCK);
  fs.renameSync(tmp, p);
  return { path: p, exists: true, alreadyConfigured: false };
}

// v2 (client-neutral + all 9 tools). The version marker makes re-running any
// `init --codex`/`--kimi` the refresh path for MANAGED sections: v1 hardcoded
// a `.codex/hooks.json` sentence that is wrong under Kimi and, because the
// /sextant/i short-circuit suppressed every later write, could never be
// corrected. User-authored sextant mentions are still left entirely alone.
const AGENTS_MANAGED_HEADER = "## Orientation: use sextant before grepping";
const AGENTS_MANAGED_MARKER = "sextant-managed:v2";
const AGENTS_SEXTANT_SECTION = `${AGENTS_MANAGED_HEADER} <!-- ${AGENTS_MANAGED_MARKER} -->

This repo is indexed by **sextant** (dependency-graph + full-text code intelligence).

- A sextant hook injects a fresh codebase map and query-aware file hits into
  context (at session start and/or on each prompt, depending on the agent CLI).
  Trust those over guessing file paths; an "index stale" note means structural
  ranking is suppressed (live text matches only).
- Prefer the sextant MCP tools over raw \`grep\`/\`rg\`:
  - \`sextant_search\` — ranked code search (use INSTEAD of grep to find defs/symbols).
  - \`sextant_related\` — imports + dependents of a file (blast radius before editing).
  - \`sextant_explain\` — a file's fan-in/fan-out, exports, role; or a directory's aggregate shape (trailing \`/\`).
  - \`sextant_health\` — index resolution % + freshness (check before trusting ranks).
  - \`sextant_scope\` — what's excluded from the index (vendored subtrees).
  - \`sextant_orient\` — compact orientation block (root, health, hotspots, task-relevant files).
  - \`sextant_focus\` — role-structured task capsule for a stated task (primary/support/witnesses/hazards).
  - \`sextant_task_status\` — the latest persisted task capsule and its workset state.
  - \`sextant_closure\` — factual evidence-closure report for the session's structural changes.
`;

const AGENTS_HEADER = `# AGENTS.md

Guidance for coding agents working in this repo.

`;

// WHY merge, don't clobber: AGENTS.md is user-authored project content. Create it
// only when absent; refresh only the section WE manage (identified by our exact
// heading, versioned by the v2 marker); if the user wrote their own sextant
// mention, leave the file entirely alone.
function ensureAgentsMd(root) {
  const p = path.join(root, "AGENTS.md");
  if (fs.existsSync(p)) {
    const content = fs.readFileSync(p, "utf8");
    if (content.includes(AGENTS_MANAGED_MARKER)) return { path: p, action: "already-current" };
    const idx = content.indexOf(AGENTS_MANAGED_HEADER);
    if (idx !== -1) {
      // A managed section without the current marker (v1): replace from its
      // heading up to the next `## ` heading (exclusive) or EOF.
      const next = content.indexOf("\n## ", idx + AGENTS_MANAGED_HEADER.length);
      const end = next === -1 ? content.length : next;
      const tmp = p + ".tmp";
      fs.writeFileSync(tmp, content.slice(0, idx) + AGENTS_SEXTANT_SECTION + content.slice(end));
      fs.renameSync(tmp, p);
      return { path: p, action: "updated" };
    }
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

// Shared by printCodexStatus and printKimiStatus — ensureAgentsMd now has five
// outcomes and both printers must know all of them.
const AGENTS_ACTION_MSG = {
  created: `  ✓ Created AGENTS.md with sextant orientation`,
  appended: `  ✓ Appended sextant section to existing AGENTS.md`,
  updated: `  ✓ Updated the managed AGENTS.md sextant section to v2`,
  "already-current": `  ✓ AGENTS.md sextant section already current (v2)`,
  "already-mentions": `  ✓ AGENTS.md already references sextant (left untouched)`,
};

function printCodexStatus(root, hooks, agents, mcp) {
  const rel = (p) => path.relative(root, p) || p;
  const lines = ["", "Codex wiring:"];
  lines.push(hooks.alreadyConfigured
    ? `  ✓ Codex hooks already configured in ${rel(hooks.path)}`
    : `  ✓ Wired Codex hooks (SessionStart + UserPromptSubmit) in ${rel(hooks.path)}`);
  lines.push(AGENTS_ACTION_MSG[agents.action]);
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

function printKimiStatus(root, hooks, agents) {
  const lines = ["", "Kimi Code wiring:"];
  if (!hooks.exists) {
    lines.push(`  ⚠ ~/.kimi-code/config.toml not found — Kimi hook NOT wired`);
    lines.push(`     Add this block to ~/.kimi-code/config.toml once Kimi Code is set up:`);
    for (const l of KIMI_HOOK_BLOCK.trimEnd().split("\n")) lines.push(`       ${l}`);
  } else if (hooks.alreadyConfigured) {
    lines.push(`  ✓ Kimi hook already configured in ${hooks.path}`);
  } else {
    lines.push(`  ✓ Wired Kimi UserPromptSubmit hook in ${hooks.path} (global)`);
  }
  lines.push(AGENTS_ACTION_MSG[agents.action]);
  lines.push(`  ✓ MCP: Kimi reads this repo's .mcp.json (registered by base init)`);
  lines.push("");
  lines.push("  Restart Kimi Code to reload the global config. The hook activates only in");
  lines.push("  repos where `sextant init` has been run (SEXTANT_REQUIRE_STATE gate) and is");
  lines.push("  a silent no-op everywhere else. Kimi discards SessionStart output, so the");
  lines.push("  codebase map arrives on the first prompt of each session instead.");
  process.stdout.write(lines.join("\n") + "\n");
}

async function run(ctx) {
  const codex = hasFlag(process.argv, "--codex");
  const kimi = hasFlag(process.argv, "--kimi");
  let codexMcp = null;
  let kimiHooks = null;
  for (const r of ctx.roots) {
    // WHY guard init hard: `sextant init` in $HOME writes hooks into
    // ~/.claude/settings.json — which Claude Code treats as GLOBAL settings,
    // wiring sextant into every session in every directory. That global
    // wiring is exactly how the home-dir indexing incident started.
    {
      const { checkRoot } = require("../lib/root-guard");
      const guard = checkRoot(r, { argv: process.argv });
      if (!guard.ok) {
        process.stderr.write(`[sextant] ${guard.message}\n`);
        process.exit(2);
      }
    }
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
    if (kimi) {
      // ensureAgentsMd is idempotent, so --codex --kimi together is safe (the
      // second call reports already-current).
      const agents = ensureAgentsMd(r);
      // Global wiring is idempotent — run once, reuse the result per root.
      kimiHooks = kimiHooks || ensureKimiHooks();
      printKimiStatus(r, kimiHooks, agents);
    }
  }
}

module.exports = {
  run,
  ensureMcpJson,
  checkClaudeHooks,
  hasSextantHook,
  hasHookCommand,
  hasHookConflict,
  claudeHooksComplete,
  ensureCodexHooks,
  ensureCodexMcp,
  ensureAgentsMd,
  ensureKimiHooks,
};
