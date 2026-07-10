// Probe 3 (docs/019): subproject-detection accuracy for MAPPING (not exclusion).
// Enumerates depth<=2 dirs carrying a manifest and prints judgment context:
// indexed-file count under the dir, junk-path hints (fixtures/test/vendor),
// nested .git. The real/junk call is made by the reader in the synthesis doc —
// this script only lays out the evidence.
//
// Usage: node probe3-subprojects.js <repoRoot>
"use strict";

const fs = require("fs");
const path = require("path");
const { openDb, rows, manifestDirs } = require("./common");

const JUNK_HINT = /(^|\/)(fixtures?|examples?|demos?|samples?|tests?|__tests__|testdata|vendor|third_party|e2e|playground|templates?|scaffold)(\/|$)/i;

async function main() {
  const root = process.argv[2];
  if (!root) { console.error("usage: probe3-subprojects.js <repoRoot>"); process.exit(1); }

  let db = null;
  try { db = await openDb(root); } catch { /* no graph — counts become n/a */ }
  const fileCountUnder = (dir) => {
    if (!db) return "n/a";
    const r = rows(db, "SELECT COUNT(*) AS n FROM files WHERE path LIKE ?", [dir + "%"]);
    return r.length ? r[0].n : 0;
  };

  const found = manifestDirs(root, 2);
  console.log(`repo=${root} manifestDirs(depth<=2)=${found.length}`);
  for (const m of found) {
    const abs = path.join(root, m.dir);
    const nestedGit = fs.existsSync(path.join(abs, ".git")) ? " NESTED-GIT" : "";
    const junk = JUNK_HINT.test(m.dir) ? " JUNK-HINT" : "";
    console.log(
      `  ${m.dir.padEnd(44)} [${m.manifests.join(",")}] indexedFiles=${fileCountUnder(m.dir)}${nestedGit}${junk}`
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
