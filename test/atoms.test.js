"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { splitAtoms, citedGlobs, repoIndex, compileRepo, replayRepo, bashReadTarget, appendExposure, relay } = require("../commands/atoms");

const CLAUDE_MD = [
  "# Project",
  "Always be terse.",
  "## Freshness",
  "See `lib/a.js:checkFreshness` for the gate.",
  "```",
  "## not a heading inside a fence",
  "```",
  "1. **Extractors** (`src/x/`) parse imports",
  "## Unique basename",
  "The y.py module.",
  "## Review rules",
  "Check `lib/b.js` before merge.",
  "## Missing",
  "See `lib/gone.js`.",
].join("\n");

function repo() {
  // A dot in the root, because Claude Code keeps dots in transcript directory names.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atoms.v1-"));
  for (const f of ["lib/a.js", "lib/b.js", "src/x/y.py", "README.md"]) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), "x\n");
  }
  fs.writeFileSync(path.join(root, "CLAUDE.md"), CLAUDE_MD);
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "add", "-A"]);
  return root;
}

test("splitAtoms splits at headings and numbered bold items, not inside fences", () => {
  const titles = splitAtoms(CLAUDE_MD).map(a => a.title);
  assert.deepEqual(titles, ["# Project", "## Freshness", "1. **Extractors** (`src/x/`) parse imports", "## Unique basename", "## Review rules", "## Missing"]);
  assert.equal(splitAtoms(CLAUDE_MD).map(a => a.text).join(""), CLAUDE_MD + "\n");
});

test("citedGlobs binds files, directories and unique basenames, and drops dead paths", () => {
  const root = repo();
  const index = repoIndex(root);
  const globs = splitAtoms(CLAUDE_MD).map(a => citedGlobs(a.text, index));
  assert.deepEqual(globs, [[], ["lib/a.js"], ["src/x/**"], ["src/x/y.py"], ["lib/b.js"], []]);
  assert.deepEqual(citedGlobs(`see ${root}/lib/a.js`, index), ["lib/a.js"]);
  const r = compileRepo(root);
  assert.equal(r.boundAtoms, 4);
  assert.equal(r.oversize, 0);
});

test("bashReadTarget matches one-file cat, head or sed -n only", () => {
  assert.equal(bashReadTarget("cat lib/a.js"), "lib/a.js");
  assert.equal(bashReadTarget("head -n 40 /root/x/lib/a.js"), "/root/x/lib/a.js");
  assert.equal(bashReadTarget("cat lib/a.js lib/b.js"), null);
  assert.equal(bashReadTarget("grep foo lib/a.js"), null);
  // sed -n on one file loads a paths rule (probed on Claude Code 2.1.318).
  assert.equal(bashReadTarget("sed -n 1,40p lib/a.js"), "lib/a.js");
  assert.equal(bashReadTarget("sed -n '5,9p' lib/a.js lib/b.js"), null);
});

test("replay scores each decision against atoms that arrived in time, per channel set", () => {
  const root = repo();
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), "atoms-projects-"));
  // Observed on 2.1.309: /root/.claude is stored as -root-.claude.
  const tdir = path.join(projects, root.split("/").join("-"));
  fs.mkdirSync(path.join(tdir, "s1", "subagents"), { recursive: true });
  const at = s => `2026-10-01T00:00:${String(s).padStart(2, "0")}Z`;
  const use = (s, id, name, input) => JSON.stringify({ timestamp: at(s), type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
  const result = (s, id, text = "ok") => JSON.stringify({ timestamp: at(s), type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] } });
  fs.writeFileSync(path.join(tdir, "s1.jsonl"), [
    use(1, "r1", "Read", { file_path: `${root}/lib/a.js` }), result(2, "r1"),
    use(3, "e1", "Edit", { file_path: `${root}/lib/a.js` }), result(4, "e1"),
    use(5, "a1", "Agent", { prompt: "Fix src/x/y.py" }), result(6, "a1", "launched"),
    // The child finished at 12, so the parent's next record carries its return.
    use(20, "d1", "Bash", { command: "git diff" }), result(21, "d1", "diff --git a/lib/b.js b/lib/b.js"),
    use(22, "w1", "Write", { file_path: `${root}/lib/b.js` }), result(23, "w1"),
    '{"type":"user","mess',
  ].join("\n"));
  fs.writeFileSync(path.join(tdir, "s1", "subagents", "agent-c1.jsonl"), [
    use(7, "c1", "Read", { file_path: `${root}/src/x/y.py` }), result(8, "c1"),
    use(9, "c2", "Edit", { file_path: `${root}/src/x/y.py` }), result(12, "c2"),
  ].join("\n"));
  // s2: a file named only in plain Bash output, and a file named in a command that is not a native read.
  fs.writeFileSync(path.join(tdir, "s2.jsonl"), [
    use(1, "x1", "Bash", { command: "git status --short" }), result(1, "x1", " M lib/b.js"),
    use(2, "x2", "Write", { file_path: `${root}/lib/b.js` }), result(2, "x2"),
    // grep names the file without loading its rule (2.1.318 probe); a one-file sed -n would load it.
    use(3, "x3", "Bash", { command: "grep -n x lib/a.js" }), result(3, "x3", "x"),
    use(4, "x4", "Edit", { file_path: `${root}/lib/a.js` }), result(4, "x4"),
  ].join("\n"));
  // s3: a diff run with git's global options before the subcommand.
  fs.writeFileSync(path.join(tdir, "s3.jsonl"), [
    use(1, "y1", "Bash", { command: `git -C ${root} --no-pager diff` }), result(1, "y1", "diff --git a/lib/b.js b/lib/b.js"),
    use(2, "y2", "Edit", { file_path: `${root}/lib/b.js` }), result(2, "y2"),
  ].join("\n"));

  const { tally, sessions, subagents, shares } = replayRepo(root, projects, 60);
  assert.equal(sessions, 3);
  assert.equal(subagents, 1);
  // s1 Edit after a Read: native. s1 Write of b.js: the diff relay. Child Edit
  // after its own Read: native. s2 Write of b.js: only plain output named it.
  // s2 Edit of a.js: only the grep command named it. s3 Edit of b.js: the diff relay.
  assert.deepEqual(tally.edit, { events: 6, pairs: 7, covered: [3, 6, 7, 7], full: [2, 5, 6, 6] });
  assert.equal(tally.writeBlind, 2);
  // The parent named y.py in a spawn prompt before anything delivered its atoms.
  assert.deepEqual(tally.spawn, { events: 1, pairs: 2, covered: [0, 0, 0, 0], full: [0, 0, 0, 0] });
  assert.deepEqual(tally.return, { events: 1, pairs: 2, covered: [0, 0, 0, 2], full: [0, 0, 0, 1] });
  assert.deepEqual(tally.review, { events: 2, pairs: 2, covered: [0, 2, 2, 2], full: [0, 2, 2, 2] });

  // s2 per request: before each of its 4 calls, what had arrived so far. Its
  // own Write and Edit load their atoms natively, but only after those calls.
  const c = compileRepo(root);
  const F = c.atoms.find(a => a.title === "## Freshness").chars;
  const R = c.atoms.find(a => a.title === "## Review rules").chars;
  const base = c.chars - c.boundChars;
  const perRequest = [2 * R, 2 * R + F, 3 * R + F, 3 * R + F].map(n => (base + n / 4) / c.chars);
  assert.ok(shares.some(s => JSON.stringify(s.perRequest) === JSON.stringify(perRequest)), JSON.stringify(shares));
});

test("appendExposure keeps the listed path fields and nothing else", () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "atoms-exp-")), "exposure.jsonl");
  appendExposure({ session_id: "s", agent_id: "a", load_reason: "path_glob_match", file_path: "/r/.claude/rules/x.md", globs: ["lib/a.js"], content: "SECRET" }, out);
  const row = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(row.load_reason, "path_glob_match");
  assert.deepEqual(row.globs, ["lib/a.js"]);
  assert.equal(row.content, undefined);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
});

function rulesRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-"));
  for (const f of ["src/a.js", "lib/b.js"]) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), "x\n");
  }
  fs.mkdirSync(path.join(root, ".claude/rules"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude/rules/src.md"), '---\npaths:\n  - "src/**"\n---\nSRC RULE BODY\n');
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "add", "-A"]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-state-"));
  return { root, opts: { stateDir: path.join(dir, "state"), logFile: path.join(dir, "relay.jsonl"), exposureLog: path.join(dir, "exposure.jsonl") } };
}
const bash = (root, session, command, stdout = "", agent) => ({ tool_name: "Bash", session_id: session, agent_id: agent, cwd: root, tool_input: { command }, tool_response: { stdout } });

test("relay sends the rule for files a git diff prints, once per agent per session", () => {
  const { root, opts } = rulesRepo();
  const diff = "diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n";
  const first = relay(bash(root, "s1", "git diff", diff), opts);
  assert.ok(first, "a diff of a bound file must relay its rule");
  assert.deepEqual(first.rules, [".claude/rules/src.md"]);
  assert.equal(first.trigger, "review");
  assert.match(first.context, /SRC RULE BODY/);
  assert.equal(relay(bash(root, "s1", "git diff", diff), opts), null, "the same agent gets it once");
  assert.ok(relay(bash(root, "s1", "git diff", diff, "child-1"), opts), "a subagent gets its own copy");
  assert.ok(relay(bash(root, "s2", "git -C " + root + " diff", diff), opts), "a new session gets it again");
});

test("relay reads output only for git diff/show, and skips native reads and unbound files", () => {
  const { root, opts } = rulesRepo();
  assert.equal(relay(bash(root, "s", "git status", " M src/a.js\n"), opts), null, "status output is not read");
  assert.equal(relay(bash(root, "s", "sed -n 1,5p src/a.js"), opts), null, "a native read already loaded it");
  assert.equal(relay(bash(root, "s", "grep -n x lib/b.js"), opts), null, "no rule binds lib/b.js");
  const named = relay(bash(root, "s", "grep -n x src/a.js"), opts);
  assert.ok(named, "a command naming a bound file relays its rule");
  assert.equal(named.trigger, "command");
});

test("relay skips a rule the exposure log shows was loaded natively", () => {
  const { root, opts } = rulesRepo();
  fs.writeFileSync(opts.exposureLog, JSON.stringify({ session_id: "s", load_reason: "path_glob_match", file_path: path.join(root, ".claude/rules/src.md") }) + "\n");
  assert.equal(relay(bash(root, "s", "grep -n x src/a.js"), opts), null);
});
