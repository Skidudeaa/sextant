// Replay a repo's sessions against (a) the old CLAUDE.md eager and (b) a new core
// CLAUDE.md plus hand-written .claude/rules/*.md path rules, using sextant's atoms replay.
// Usage: node measure2.js <root> <oldClaudeMd> <newDir> [days]
const fs = require("fs"), path = require("path"), os = require("os");
const A = require("../../commands/atoms.js");
const [root, oldFile, newDir, days = "60"] = process.argv.slice(2);
if (!root || !oldFile || !newDir) { console.error("usage: node measure2.js <root> <old CLAUDE.md> <new dir> [days]"); process.exit(2); }
const index = A.repoIndex(root);
const core = fs.readFileSync(path.join(newDir, "CLAUDE.md"), "utf8");
const rdir = path.join(newDir, ".claude/rules");
const atoms = [{ title: "core", chars: core.length, globs: [] }];
for (const f of fs.readdirSync(rdir).filter(f => f.endsWith(".md")).sort()) {
  const text = fs.readFileSync(path.join(rdir, f), "utf8");
  const globs = [...(/^---\npaths:\n([\s\S]*?)\n---/.exec(text)[1].matchAll(/"([^"]+)"/g))].map(m => m[1]);
  atoms.push({ title: f, chars: text.length, globs: index.list.filter(t => globs.some(g => path.matchesGlob(t, g))) });
}
const bound = atoms.filter(a => a.globs.length), boundChars = bound.reduce((n, a) => n + a.chars, 0);
const total = atoms.reduce((n, a) => n + a.chars, 0);
const compiled = { root, chars: total, atoms, boundAtoms: bound.length, boundChars, index };
const r = A.replayRepo(root, path.join(os.homedir(), ".claude", "projects"), +days, compiled);
const med = v => (v.sort((a, b) => a - b), v[Math.floor(v.length / 2)]);
const types = Object.entries(r.tally).filter(([k]) => k !== "writeBlind");
const rec = (c, only) => { const t = types.filter(([k]) => !only || k === only); const p = t.reduce((n, [, x]) => n + x.pairs, 0); return p ? +(t.reduce((n, [, x]) => n + x.covered[c], 0) / p).toFixed(3) : null; };
const old = fs.readFileSync(oldFile, "utf8").length;
console.log(JSON.stringify({ root, days: +days, sessions: r.sessions, subagents: r.subagents, oldEagerChars: old, coreChars: core.length, ruleChars: boundChars, rules: bound.length,
  perRequestMedianChars: Math.round(med(r.shares.map(s => s.perRequest[0])) * total), endMedianChars: Math.round(med(r.shares.map(s => s.end[0])) * total),
  ruleRecallNative: { all: rec(0), edit: rec(0, "edit"), review: rec(0, "review"), spawn: rec(0, "spawn") },
  events: Object.fromEntries(types.map(([k, t]) => [k, t.events])), writeBlind: r.tally.writeBlind || 0 }, null, 1));
