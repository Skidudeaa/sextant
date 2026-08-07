"use strict";

// sextant reject — capture a rejected approach so the agent doesn't re-propose it.
// docs/003-rejected-approaches-log.md
//
// Usage:
//   sextant reject "shared SQLite connection pool" --files lib/graph.js,lib/intel.js --why "WAL + concurrent writes = SQLITE_BUSY"
//   sextant reject --list
//   sextant reject --delete 3

const path = require("path");
const graph = require("../lib/graph");
const { flag, hasFlag } = require("../lib/cli");

async function run(ctx) {
  const root = ctx.roots[0];
  if (!root) {
    console.error("sextant reject: no repo root (use --root <path>)");
    process.exit(1);
  }

  const listMode = hasFlag(process.argv, "--list");
  const deleteId = flag(process.argv, "--delete");

  // --list mode
  if (listMode) {
    const db = await graph.loadDb(root);
    const rows = graph.findAllRejections(db);
    if (!rows.length) {
      console.log("No rejections recorded.");
      return;
    }
    for (const r of rows) {
      let files = [];
      try { files = JSON.parse(r.files || "[]"); } catch {}
      const fileStr = files.length ? files.join(", ") : "(repo-wide)";
      const date = r.created_at ? r.created_at.split("T")[0] : "?";
      console.log(`[${r.id}] ${r.status} — ${r.description}`);
      console.log(`    files: ${fileStr}`);
      console.log(`    reason: ${r.reason}`);
      console.log(`    source: ${r.source} · ${date}`);
      console.log();
    }
    return;
  }

  // --delete mode
  if (deleteId) {
    const id = parseInt(deleteId, 10);
    if (!id) {
      console.error(`sextant reject: invalid id "${deleteId}"`);
      process.exit(1);
    }
    const db = await graph.loadDb(root);
    graph.deleteRejection(db, id);
    await graph.persistDb(root);
    console.log(`Deleted rejection ${id}.`);
    return;
  }

  // Create mode — description is the first positional arg after the subcommand
  const description = ctx.argv[1];
  if (!description) {
    console.error('sextant reject: missing description (quote it: sextant reject "don\'t use X" --why "...")');
    process.exit(1);
  }

  const why = flag(process.argv, "--why");
  if (!why) {
    console.error("sextant reject: --why is required (the reason is the whole value of a rejection)");
    process.exit(1);
  }

  const filesRaw = flag(process.argv, "--files");
  const files = filesRaw ? filesRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];

  const db = await graph.loadDb(root);
  const id = graph.insertRejection(db, {
    description,
    reason: why,
    files,
    source: "manual",
  });
  await graph.persistDb(root);
  console.log(`Recorded rejection [${id}]: ${description}`);
  if (files.length) console.log(`  files: ${files.join(", ")}`);
  console.log(`  reason: ${why}`);
}

module.exports = { run };
