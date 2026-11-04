// Split a CLAUDE.md into outputs by line range, verbatim. Fails unless every
// source line lands in exactly one output and every `paths` glob matches a
// tracked file. Usage: node split.js <plan.json> <outdir>
// Plan: { repo, source, outputs: [{ path, paths?: [glob], text: "...{{L a-b}}..." }] }
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const [planFile, outDir] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
const src = fs.readFileSync(plan.source, "utf8").replace(/\n$/, "").split("\n");
const tracked = execFileSync("git", ["-C", plan.repo, "ls-files"], { maxBuffer: 1 << 28 }).toString().split("\n").filter(Boolean);
const owner = new Array(src.length + 1).fill(null);
const errors = [];
for (const o of plan.outputs) {
  for (const g of o.paths || []) if (!tracked.some(f => path.matchesGlob(f, g))) errors.push(`${o.path}: glob matches no tracked file: ${g}`);
  // {{D a-b}} copies lines without owning them (a deliberate duplicate).
  o.text = o.text.replace(/\{\{D (\d+)-(\d+)\}\}/g, (_, a, b) => src.slice(+a - 1, +b).join("\n"));
  o.body = o.text.replace(/\{\{L (\d+)-(\d+)\}\}/g, (_, a, b) => {
    a = +a; b = +b;
    if (a < 1 || b > src.length || a > b) errors.push(`${o.path}: bad range ${a}-${b}`);
    for (let i = a; i <= b; i++) {
      if (owner[i]) errors.push(`line ${i} in both ${owner[i]} and ${o.path}`);
      owner[i] = o.path;
    }
    return src.slice(a - 1, b).join("\n");
  });
}
const missing = [];
for (let i = 1; i <= src.length; i++) if (!owner[i] && src[i - 1].trim() !== "" && src[i - 1].trim() !== "---") missing.push(i);
if (missing.length) errors.push(`unassigned non-blank lines: ${missing.join(",")}`);
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
for (const o of plan.outputs) {
  const front = o.paths ? `---\npaths:\n${o.paths.map(g => `  - "${g}"`).join("\n")}\n---\n` : "";
  const file = path.join(outDir, o.path);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, front + o.body.replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "\n"));
  const n = o.paths ? tracked.filter(f => o.paths.some(g => path.matchesGlob(f, g))).length : 0;
  console.log(`${String(fs.statSync(file).size).padStart(7)}  ${o.path}${o.paths ? `  (${n} files)` : ""}`);
}
