#!/usr/bin/env node
"use strict";

// WHY: Migration script to replace legacy "node tools/codebase_intel/refresh.js"
// hooks with "sextant hook refresh" across all deployed projects.
// The legacy copy-and-deploy pattern is obsolete — sextant is globally available
// via npm link, so there's no need for per-project script copies.
//
// Usage: node scripts/migrate-hooks.js [--dry-run] [--global]
//   --dry-run   Show what would change without writing
//   --global    Also update ~/.claude/settings.json

const fs = require("fs");
const path = require("path");
const os = require("os");

const LEGACY_CMD = "node tools/codebase_intel/refresh.js";
const NEW_CMD = "sextant hook refresh";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const includeGlobal = args.includes("--global");

// Known deployed project roots
const PROJECT_ROOTS = [
  "/root/jan25",
  "/root/readingRoom",
  "/root/gsd-archived",
  "/root/defGen2",
  "/root/dictum",
  "/root/infograph",
  "/root/tradingDesk",
  "/root/amoSportsCenter",
  "/root/somaNotes",
  "/root/pointclick",
  "/root/sinter",
];

function migrateSettingsFile(settingsPath, label) {
  if (!fs.existsSync(settingsPath)) {
    console.log(`  SKIP ${label}: file not found`);
    return false;
  }

  let content;
  try {
    content = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    console.log(`  SKIP ${label}: invalid JSON`);
    return false;
  }

  let changed = false;
  const hooks = content?.hooks;
  if (!hooks) {
    console.log(`  SKIP ${label}: no hooks section`);
    return false;
  }

  // Walk all hook types looking for the legacy command
  for (const [hookType, matcherArr] of Object.entries(hooks)) {
    if (!Array.isArray(matcherArr)) continue;
    for (const matcher of matcherArr) {
      if (!Array.isArray(matcher?.hooks)) continue;

      // Find and replace legacy command
      for (let i = 0; i < matcher.hooks.length; i++) {
        const h = matcher.hooks[i];
        if (h?.type === "command" && h.command === LEGACY_CMD) {
          // Check if the new command already exists
          const hasNew = matcher.hooks.some(
            (x) => x?.type === "command" && x.command === NEW_CMD
          );
          if (hasNew) {
            // Remove the duplicate legacy entry
            matcher.hooks.splice(i, 1);
            i--;
            console.log(`  ${hookType}: removed duplicate legacy hook (new already present)`);
          } else {
            // Replace legacy with new
            h.command = NEW_CMD;
            console.log(`  ${hookType}: replaced legacy → sextant hook refresh`);
          }
          changed = true;
        }
      }
    }
  }

  if (!changed) {
    console.log(`  OK   ${label}: no legacy hooks found`);
    return false;
  }

  if (dryRun) {
    console.log(`  DRY  ${label}: would write changes`);
    return true;
  }

  fs.writeFileSync(settingsPath, JSON.stringify(content, null, 2) + "\n");
  console.log(`  DONE ${label}: updated`);
  return true;
}

function cleanupLegacyScript(root) {
  const scriptPath = path.join(root, "tools", "codebase_intel", "refresh.js");
  if (!fs.existsSync(scriptPath)) return;

  if (dryRun) {
    console.log(`  DRY  would delete ${scriptPath}`);
    return;
  }

  try {
    fs.unlinkSync(scriptPath);
    // Clean empty directories
    const dir = path.dirname(scriptPath);
    const entries = fs.readdirSync(dir);
    if (entries.length === 0) {
      fs.rmdirSync(dir);
      const parent = path.dirname(dir);
      const parentEntries = fs.readdirSync(parent);
      if (parentEntries.length === 0) fs.rmdirSync(parent);
    }
    console.log(`  DONE deleted legacy script from ${root}`);
  } catch (e) {
    console.log(`  WARN failed to delete ${scriptPath}: ${e.message}`);
  }
}

// --- Main ---
console.log(`\nSextant hook migration${dryRun ? " (DRY RUN)" : ""}\n`);

let totalChanged = 0;

for (const root of PROJECT_ROOTS) {
  const settingsPath = path.join(root, ".claude", "settings.json");
  console.log(`\n${root}:`);
  if (migrateSettingsFile(settingsPath, path.basename(root))) totalChanged++;
  cleanupLegacyScript(root);
}

if (includeGlobal) {
  const globalPath = path.join(os.homedir(), ".claude", "settings.json");
  console.log(`\nGlobal (~/.claude/settings.json):`);
  if (migrateSettingsFile(globalPath, "global")) totalChanged++;
}

console.log(`\n${totalChanged} file(s) ${dryRun ? "would be " : ""}updated.\n`);
