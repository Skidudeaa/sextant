"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const cochange = require("../lib/cochange");
const graph = require("../lib/graph");

// ---------------------------------------------------------------------------
// Pure computation (computeCoChange)

describe("cochange.computeCoChange", () => {
  const C = (hash, files) => ({ hash, files });

  it("counts pairs across commits with confidence = count/min(occur)", () => {
    const commits = [
      C("1", ["a.js", "b.js"]),
      C("2", ["a.js", "b.js"]),
      C("3", ["a.js", "b.js"]),
      C("4", ["a.js", "c.js"]),
    ];
    const { pairs } = cochange.computeCoChange(commits, { minCount: 1 });
    const ab = pairs.find((p) => p.a === "a.js" && p.b === "b.js");
    assert.equal(ab.count, 3);
    // a occurs 4x, b occurs 3x -> conf = 3/3 = 1.0
    assert.equal(ab.confidence, 1);
    const ac = pairs.find((p) => p.a === "a.js" && p.b === "c.js");
    assert.equal(ac.count, 1);
  });

  it("applies the minCount floor (default 3)", () => {
    const commits = [C("1", ["a.js", "b.js"]), C("2", ["a.js", "b.js"])];
    const { pairs } = cochange.computeCoChange(commits);
    assert.equal(pairs.length, 0);
  });

  it("excludes bulk commits by RAW touched-file count, even when few pass the filter", () => {
    const bulk = Array.from({ length: 25 }, (_, i) => `vendor/f${i}.txt`);
    bulk.push("a.js", "b.js");
    const commits = [
      C("1", bulk),
      C("2", ["a.js", "b.js"]),
      C("3", ["a.js", "b.js"]),
      C("4", ["a.js", "b.js"]),
    ];
    const res = cochange.computeCoChange(commits, {
      isIncluded: (f) => f.endsWith(".js"),
    });
    assert.equal(res.excludedCommits, 1);
    const ab = res.pairs.find((p) => p.a === "a.js");
    assert.equal(ab.count, 3); // bulk commit contributed nothing
  });

  it("isIncluded filters BEFORE pairing and occurrence counting", () => {
    const commits = [
      C("1", ["a.js", "CHANGELOG.md"]),
      C("2", ["a.js", "CHANGELOG.md"]),
      C("3", ["a.js", "CHANGELOG.md"]),
    ];
    const { pairs, degree } = cochange.computeCoChange(commits, {
      isIncluded: (f) => f.endsWith(".js"),
    });
    assert.equal(pairs.length, 0); // junk pair never formed
    assert.equal(degree.size, 0);
  });

  it("returns per-file churn over included, non-bulk commits", () => {
    const commits = [
      { files: ["lib/a.js", "lib/b.js"] },
      { files: ["lib/a.js", "docs/x.md"] },
      { files: ["lib/a.js"] },
      // bulk commit: excluded by raw count, so it adds no churn
      { files: Array.from({ length: 60 }, (_, i) => (i === 0 ? "lib/b.js" : `gen/f${i}.js`)) },
    ];
    const { churn } = cochange.computeCoChange(commits, {
      isIncluded: (f) => f.startsWith("lib/"),
      maxFilesPerCommit: 40,
    });
    assert.equal(churn.get("lib/a.js"), 3);
    assert.equal(churn.get("lib/b.js"), 1);
    assert.equal(churn.has("docs/x.md"), false);
  });

  it("dedupes files within a commit", () => {
    const commits = [
      C("1", ["a.js", "a.js", "b.js"]),
      C("2", ["a.js", "b.js"]),
      C("3", ["a.js", "b.js"]),
    ];
    const { pairs } = cochange.computeCoChange(commits);
    assert.equal(pairs[0].count, 3);
  });

  it("handles filenames containing spaces (NUL-separated pair keys)", () => {
    const commits = [
      C("1", ["My File.js", "other.js"]),
      C("2", ["My File.js", "other.js"]),
      C("3", ["My File.js", "other.js"]),
    ];
    const { pairs } = cochange.computeCoChange(commits);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].a, "My File.js");
    assert.equal(pairs[0].b, "other.js");
    assert.equal(pairs[0].count, 3);
  });

  it("computes degree = distinct partners among kept pairs", () => {
    const commits = [];
    // hub pairs with x, y, z (3x each); x/y/z never pair with each other
    for (const p of ["x.js", "y.js", "z.js"]) {
      for (let i = 0; i < 3; i++) commits.push(C(`${p}${i}`, ["hub.js", p]));
    }
    const { degree } = cochange.computeCoChange(commits);
    assert.equal(degree.get("hub.js"), 3);
    assert.equal(degree.get("x.js"), 1);
  });

  it("caps stored pairs at maxPairs, keeping the highest counts", () => {
    const commits = [];
    for (let i = 0; i < 5; i++) {
      const n = 3 + i; // pair_i seen 3+i times
      for (let k = 0; k < n; k++) commits.push(C(`${i}-${k}`, [`a${i}.js`, `b${i}.js`]));
    }
    const { pairs } = cochange.computeCoChange(commits, { maxPairs: 2 });
    assert.equal(pairs.length, 2);
    assert.equal(pairs[0].count, 7);
    assert.equal(pairs[1].count, 6);
  });
});

// ---------------------------------------------------------------------------
// git-log parsing + end-to-end mine on a real temp repo

describe("cochange.parseGitLog / mineCoChange", () => {
  let repo;

  before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-cochange-git-"));
    const git = (...args) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    git("init", "-q");
    const commit = (files, msg) => {
      for (const [f, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
        fs.writeFileSync(path.join(repo, f), content);
      }
      git("add", "-A");
      git("commit", "-qm", msg);
    };
    for (let i = 0; i < 3; i++) {
      commit({ "lib/a.js": `x${i}`, "lib/b.js": `y${i}`, "CHANGELOG.md": `c${i}` }, `pair ${i}`);
    }
    commit({ "lib/only.js": "solo" }, "solo");
  });

  after(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  it("parses commits with their file lists", () => {
    const commits = cochange.parseGitLog(repo);
    assert.equal(commits.length, 4);
    assert.ok(commits.every((c) => /^[0-9a-f]{40}$/.test(c.hash)));
    // newest first: the solo commit
    assert.deepEqual(commits[0].files, ["lib/only.js"]);
  });

  it("mineCoChange end-to-end with a source filter", () => {
    const res = cochange.mineCoChange(repo, {
      isIncluded: (f) => f.endsWith(".js"),
    });
    assert.equal(res.pairs.length, 1);
    assert.equal(res.pairs[0].a, "lib/a.js");
    assert.equal(res.pairs[0].b, "lib/b.js");
    assert.equal(res.pairs[0].count, 3);
    assert.equal(res.churn.get("lib/a.js"), 3);
    assert.equal(res.churn.get("lib/only.js"), 1);
    assert.equal(res.churn.has("CHANGELOG.md"), false);
  });

  it("returns empty (never throws) on a non-git directory", () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-cochange-plain-"));
    try {
      const commits = cochange.parseGitLog(plain);
      assert.deepEqual(commits, []);
      const res = cochange.mineCoChange(plain);
      assert.deepEqual(res.pairs, []);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// graph.db storage + hub-dampened partner query

describe("graph co-change storage", () => {
  let tmpDir, db;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-cochange-graph-"));
    fs.mkdirSync(path.join(tmpDir, ".planning", "intel"), { recursive: true });
    db = await graph.loadDb(tmpDir);
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("replaceCoChangePairs stores pairs and degrees, wholesale", () => {
    graph.replaceCoChangePairs(
      db,
      [
        { a: "lib/a.js", b: "lib/b.js", count: 5, confidence: 0.9 },
        { a: "lib/a.js", b: "test/a.test.js", count: 4, confidence: 1.0 },
      ],
      new Map([
        ["lib/a.js", 2],
        ["lib/b.js", 1],
        ["test/a.test.js", 1],
      ])
    );
    assert.equal(graph.countCoChangePairs(db), 2);
    // wholesale replace
    graph.replaceCoChangePairs(db, [{ a: "x.js", b: "y.js", count: 3, confidence: 0.5 }], new Map([["x.js", 1], ["y.js", 1]]));
    assert.equal(graph.countCoChangePairs(db), 1);
  });

  it("stores churn with the co-change rows, wholesale, and reports its quantile", () => {
    const churn = new Map(Array.from({ length: 10 }, (_, i) => [`lib/f${i}.js`, i + 1]));
    graph.replaceCoChangePairs(db, [], new Map(), churn);
    assert.deepEqual(
      [...graph.churnByPaths(db, ["lib/f0.js", "lib/f9.js", "lib/absent.js"]).entries()].sort(),
      [["lib/f0.js", 1], ["lib/f9.js", 10]]
    );
    // ascending counts 1..10, index floor(0.9*10)=9 -> 10
    assert.equal(graph.churnQuantile(db, 0.9), 10);
    assert.equal(graph.churnQuantile(db, 0.5), 6);
    graph.replaceCoChangePairs(db, [], new Map());
    assert.equal(graph.churnQuantile(db, 0.9), null, "a replace without churn clears it");
    assert.equal(graph.churnByPaths(db, ["lib/f9.js"]).size, 0);
  });

  it("findCoChangePartners returns partners from either pair side, ranked by confidence", () => {
    graph.replaceCoChangePairs(
      db,
      [
        { a: "lib/a.js", b: "lib/b.js", count: 5, confidence: 0.5 },
        { a: "lib/a.js", b: "test/a.test.js", count: 4, confidence: 1.0 },
        { a: "lib/0aaa.js", b: "lib/a.js", count: 3, confidence: 0.75 },
      ],
      new Map([
        ["lib/a.js", 3],
        ["lib/b.js", 1],
        ["test/a.test.js", 1],
        ["lib/0aaa.js", 1],
      ])
    );
    const partners = graph.findCoChangePartners(db, "lib/a.js");
    assert.deepEqual(
      partners.map((p) => p.partner),
      ["test/a.test.js", "lib/0aaa.js", "lib/b.js"]
    );
  });

  it("drops hub partners whose degree exceeds hubMaxDegree", () => {
    graph.replaceCoChangePairs(
      db,
      [
        { a: "lib/a.js", b: "hub.js", count: 9, confidence: 1.0 },
        { a: "lib/a.js", b: "lib/b.js", count: 3, confidence: 0.4 },
      ],
      new Map([
        ["lib/a.js", 2],
        ["hub.js", 40],
        ["lib/b.js", 1],
      ])
    );
    const partners = graph.findCoChangePartners(db, "lib/a.js", { hubMaxDegree: 25 });
    assert.deepEqual(partners.map((p) => p.partner), ["lib/b.js"]);
    // but the hub file's OWN partners are still queryable
    const hubView = graph.findCoChangePartners(db, "hub.js");
    assert.deepEqual(hubView.map((p) => p.partner), ["lib/a.js"]);
  });

  it("respects minConfidence and limit", () => {
    graph.replaceCoChangePairs(
      db,
      [
        { a: "lib/a.js", b: "lib/b.js", count: 5, confidence: 0.9 },
        { a: "lib/a.js", b: "lib/c.js", count: 5, confidence: 0.2 },
      ],
      new Map([
        ["lib/a.js", 2],
        ["lib/b.js", 1],
        ["lib/c.js", 1],
      ])
    );
    const partners = graph.findCoChangePartners(db, "lib/a.js", { minConfidence: 0.5 });
    assert.deepEqual(partners.map((p) => p.partner), ["lib/b.js"]);
    const limited = graph.findCoChangePartners(db, "lib/a.js", { limit: 1 });
    assert.equal(limited.length, 1);
  });
});

// ---------------------------------------------------------------------------
// A real bulk scan persists churn next to the co-change tables.
describe("scan populates file_churn", () => {
  let repo;
  before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-churn-scan-"));
    const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    const commit = (files, msg) => {
      for (const [f, body] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
        fs.writeFileSync(path.join(repo, f), body);
      }
      git("add", "-A");
      git("commit", "-qm", msg);
    };
    for (let i = 0; i < 4; i++) commit({ "lib/hot.js": `module.exports = ${i};\n` }, `hot ${i}`);
    commit({ "lib/cold.js": "module.exports = 1;\n" }, "cold");
  });
  after(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  it("stores commit counts for scanned files", async () => {
    const intel = require("../lib/intel");
    await intel.scan(repo, ["**/*.js"], { ignore: [] });
    const db = await graph.loadDb(repo);
    const churn = graph.churnByPaths(db, ["lib/hot.js", "lib/cold.js"]);
    assert.equal(churn.get("lib/hot.js"), 4);
    assert.equal(churn.get("lib/cold.js"), 1);
  });
});
