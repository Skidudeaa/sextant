"use strict";

// Lightweight Claude hook settings inspection shared by init/status and the
// PreToolUse runtime conflict fence. Keep this module limited to core Node
// dependencies: loading the full indexer on every child spawn adds hundreds of
// milliseconds before the experiment can even build orientation.

const fs = require("fs");
const os = require("os");
const path = require("path");

function ownedCommandHook(hook, command) {
  return Boolean(
    hook && typeof hook === "object" &&
    hook.type === "command" && hook.command === command
  );
}

function synchronousHook(hook) {
  return Boolean(
    hook && typeof hook === "object" &&
    hook.async !== true && hook.asyncRewake !== true
  );
}

// `args` switches Claude to exec form, where `sextant hook ...` would be
// treated as one executable name. `if` makes the handler conditional, while
// async/asyncRewake cannot publish hook output.
function exactSynchronousShellHook(hook, command) {
  return Boolean(
    ownedCommandHook(hook, command) &&
    synchronousHook(hook) &&
    !Object.hasOwn(hook, "args") &&
    !Object.hasOwn(hook, "if")
  );
}

// Claude treats simple `|`/`,` matchers as sets of exact names. Accept an
// existing superset (including historic `Agent|Task`) without double-wiring.
function matcherCovers(actual, desired) {
  const actualText = typeof actual === "string" ? actual.trim() : "";
  const desiredText = typeof desired === "string" ? desired.trim() : "";
  const actualAll = actualText === "" || actualText === "*";
  const desiredAll = desiredText === "" || desiredText === "*";
  if (desiredAll) return actualAll;
  if (actualAll) return true;
  if (actualText === desiredText) return true;

  const exactSet = (value) => {
    if (!/^[A-Za-z0-9_\- ,|]+$/.test(value)) return null;
    const names = value.split(/[|,]/).map((part) => part.trim()).filter(Boolean);
    return names.length ? new Set(names) : null;
  };
  const wanted = exactSet(desiredText);
  if (!wanted) return false;
  const offered = exactSet(actualText);
  if (offered) return [...wanted].every((name) => offered.has(name));
  try {
    const pattern = new RegExp(actualText);
    return [...wanted].every((name) => pattern.test(name));
  } catch {
    return false;
  }
}

function matcherOverlaps(actual, desired) {
  const names = typeof desired === "string"
    ? desired.split(/[|,]/).map((part) => part.trim()).filter(Boolean)
    : [];
  return names.some((name) => matcherCovers(actual, name));
}

function settingsHookConflict(settings, event, command, matcher) {
  const events = settings?.hooks?.[event];
  if (!Array.isArray(events)) return false;
  return events.some((group) => {
    if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) return false;
    if (!matcherOverlaps(group.matcher, matcher)) return false;
    return group.hooks.some((hook) =>
      synchronousHook(hook) && !ownedCommandHook(hook, command));
  });
}

function settingsHasUnhealthyOwnedHook(settings, event, command, matcher) {
  const events = settings?.hooks?.[event];
  if (!Array.isArray(events)) return false;
  return events.some((group) =>
    group && typeof group === "object" &&
    matcherOverlaps(group.matcher, matcher) &&
    Array.isArray(group.hooks) &&
    group.hooks.some((hook) =>
      ownedCommandHook(hook, command) &&
      !exactSynchronousShellHook(hook, command))
  );
}

function readClaudeSettingsSource(file, scope) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return { file, scope, settings: parsed };
  } catch {
    return null;
  }
}

function managedClaudeSettingsSources(overrideFiles) {
  if (Array.isArray(overrideFiles)) return overrideFiles;
  let directory;
  if (process.platform === "darwin") {
    directory = "/Library/Application Support/ClaudeCode";
  } else if (process.platform === "win32") {
    directory = path.join(process.env.ProgramFiles || "C:\\Program Files", "ClaudeCode");
  } else {
    directory = "/etc/claude-code";
  }
  const files = [path.join(directory, "managed-settings.json")];
  const dropins = path.join(directory, "managed-settings.d");
  try {
    files.push(...fs.readdirSync(dropins, { withFileTypes: true })
      .filter((entry) =>
        entry.isFile() && !entry.name.startsWith(".") && entry.name.endsWith(".json"))
      .map((entry) => path.join(dropins, entry.name))
      .sort());
  } catch {}
  return files;
}

// Best-effort static view. Plugin hooks, active skill/agent frontmatter,
// server-managed policy, and in-memory session hooks remain visible only in
// Claude's `/hooks` browser and are an explicit operator boundary.
function inspectClaudeHookScopes(rootAbs, {
  home = os.homedir(),
  configDir = process.env.CLAUDE_CONFIG_DIR || null,
  managedFiles = null,
} = {}) {
  const projectFile = path.join(rootAbs, ".claude", "settings.json");
  const userConfigDir = configDir || path.join(home, ".claude");
  const descriptors = [
    { file: path.join(userConfigDir, "settings.json"), scope: "user" },
    { file: projectFile, scope: "project" },
    { file: path.join(rootAbs, ".claude", "settings.local.json"), scope: "local" },
    ...managedClaudeSettingsSources(managedFiles)
      .map((file) => ({ file, scope: "managed" })),
  ];
  const sources = descriptors
    .map(({ file, scope }) => readClaudeSettingsSource(file, scope))
    .filter(Boolean);
  const preTaskCommand = "sextant hook pretask";
  const preTaskMatcher = "Task|Agent";
  const externalPreTaskConflicts = sources
    .filter((source) => source.file !== projectFile)
    .filter((source) =>
      settingsHookConflict(
        source.settings,
        "PreToolUse",
        preTaskCommand,
        preTaskMatcher
      ) ||
      settingsHasUnhealthyOwnedHook(
        source.settings,
        "PreToolUse",
        preTaskCommand,
        preTaskMatcher
      ))
    .map((source) => ({ file: source.file, scope: source.scope }));

  const lastBoolean = (scope, key) => {
    const matching = sources.filter((source) => source.scope === scope);
    let found = null;
    for (const source of matching) {
      if (typeof source.settings[key] === "boolean") {
        found = { value: source.settings[key], file: source.file, scope };
      }
    }
    return found;
  };
  const managedDisabled = lastBoolean("managed", "disableAllHooks");
  const localDisabled = lastBoolean("local", "disableAllHooks");
  const projectDisabled = lastBoolean("project", "disableAllHooks");
  const userDisabled = lastBoolean("user", "disableAllHooks");
  const disabledSetting =
    managedDisabled || localDisabled || projectDisabled || userDisabled;
  const managedOnly = lastBoolean("managed", "allowManagedHooksOnly");

  return {
    sources,
    externalPreTaskConflicts,
    hooksDisabled: Boolean(disabledSetting && disabledSetting.value),
    hooksDisabledSource:
      disabledSetting && disabledSetting.value ? disabledSetting : null,
    projectHooksBlockedByPolicy: Boolean(managedOnly && managedOnly.value),
    managedOnlySource: managedOnly && managedOnly.value ? managedOnly : null,
  };
}

module.exports = {
  exactSynchronousShellHook,
  inspectClaudeHookScopes,
  matcherCovers,
  matcherOverlaps,
  ownedCommandHook,
  settingsHookConflict,
  synchronousHook,
};
