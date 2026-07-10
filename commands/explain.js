"use strict";

// `sextant explain <file|dir/>` — a file's role, or a directory's aggregate
// view (docs/021 form c).  Dir mode: file/type counts, hotspots within,
// inbound/outbound import edges grouped by sibling dir, and git co-change
// coupling to other dirs — the dir-level counterpart of the MCP
// sextant_explain file view.  Trailing "/" forces dir mode; otherwise a file
// match wins and the dir view is the fallback (covers `sextant explain lib`).

const path = require("path");
const { hasFlag } = require("../lib/cli");

function fmtDirList(list, unit) {
  if (!list.length) return "(none)";
  return list.map((e) => `${e.dir === "." ? "./" : e.dir} (${e.count}${unit ? ` ${unit}` : ""})`).join(", ");
}

function printDir(info) {
  const typeStr = info.types.map((t) => `${t.type} ${t.count}`).join(", ");
  console.log(`${info.dir}  ${info.files} ${info.files === 1 ? "file" : "files"}${typeStr ? ` (${typeStr})` : ""}`);
  if (info.hotspots.length) {
    const spots = info.hotspots
      .map((h) => `${h.path.slice(info.dir.length)} ${h.fanIn}`)
      .join(", ");
    console.log(`  hotspots (fan-in): ${spots}`);
  }
  console.log(`  inbound:  ${info.inbound.total} imports from ${fmtDirList(info.inbound.byDir)}`);
  console.log(`  outbound: ${info.outbound.total} imports into ${fmtDirList(info.outbound.byDir)}`);
  console.log(`  internal: ${info.internalEdges} edges`);
  if (info.cochange.length) {
    console.log(`  co-changes with: ${fmtDirList(info.cochange, "commits")}`);
  }
}

function printFile(rel, meta, fanIn, fanOut, exports_, imports) {
  console.log(`${rel}  (${meta.type || "unknown"})`);
  console.log(`  fan-in: ${fanIn}, fan-out: ${fanOut}`);
  if (exports_.length) {
    console.log(`  exports: ${exports_.map((e) => e.name).join(", ")}`);
  }
  if (imports.length) {
    console.log(`  imports: ${imports.map((i) => i.toPath || i.specifier).join(", ")}`);
  }
}

async function run(ctx) {
  const target = ctx.argv[1];
  if (!target || target.startsWith("--")) {
    console.error("Usage: sextant explain <file|dir/> [--root <path>] [--json]");
    process.exit(1);
  }
  const json = hasFlag(process.argv, "--json");
  const root = path.resolve(ctx.roots[0]);

  const graph = require("../lib/graph");
  const structure = require("../lib/structure");
  const { normalizeRelPath } = require("../lib/utils");
  const db = await graph.loadDb(root);

  const rel = normalizeRelPath(target).replace(/^\.\//, "");
  const wantsDir = target.endsWith("/");

  // File mode first unless dir mode was forced with a trailing slash.
  if (!wantsDir) {
    const meta = graph.getFileMeta(db, rel);
    if (meta) {
      const fanIn = graph.fanInByPaths(db, [rel]).get(rel) || 0;
      const fanOut = graph.fanOutByPaths(db, [rel]).get(rel) || 0;
      const exports_ = graph.queryExports(db, rel);
      const imports = graph.queryImports(db, rel);
      if (json) {
        process.stdout.write(
          JSON.stringify({ file: rel, type: meta.type || null, fanIn, fanOut, exports: exports_, imports }, null, 2) + "\n"
        );
      } else {
        printFile(rel, meta, fanIn, fanOut, exports_, imports);
      }
      return;
    }
  }

  const info = structure.explainDir(db, rel);
  if (!info) {
    console.error(`not in index: ${rel} (neither an indexed file nor a directory with indexed files)`);
    console.error("hint: paths are relative to the project root; run `sextant scan` if the index is missing");
    process.exit(1);
  }
  if (json) {
    process.stdout.write(JSON.stringify(info, null, 2) + "\n");
  } else {
    printDir(info);
  }
}

module.exports = { run };
