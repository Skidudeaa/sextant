const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const rg = require("../lib/rg");
const { retrieve } = require("../lib/retrieve");

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sextant-retrieve-mts-cts-"));
}

function writeFile(root, rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, "utf8");
}

test(
  "retrieve via rg gives .mts/.cts definitions source-first when graph has no index",
  { skip: rg.isInstalled() ? false : "rg not installed" },
  async () => {
    const root = makeRoot();
    try {
      for (let i = 0; i < 12; i += 1) {
        writeFile(root, `${String(i).padStart(3, "0")}-notes.md`, "moduleBudgetMarker\n");
      }
      writeFile(root, "src/module.mts", [
        "export function moduleBudgetMarker() {",
        "  return 'esm';",
        "}",
        "",
      ].join("\n"));
      writeFile(root, "src/module.cts", [
        "export function moduleBudgetMarkerCommon() {",
        "  return 'cjs';",
        "}",
        "// moduleBudgetMarker",
        "",
      ].join("\n"));

      const result = await retrieve(root, "moduleBudgetMarker", {
        backend: "rg",
        maxHits: 2,
        contextLines: 0,
        hitsPerFileCap: 5,
        rerankMinResolutionPct: 101,
      });

      const paths = result.results.files.map((f) => String(f.path).replace(/^\.\//, ""));
      const topTwo = paths.slice(0, 2);
      assert.deepEqual(topTwo, ["src/module.mts", "src/module.cts"]);

      const hitPaths = result.results.hits.map((h) => String(h.path).replace(/^\.\//, ""));
      assert.deepEqual([...new Set(hitPaths)], ["src/module.mts", "src/module.cts"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);
