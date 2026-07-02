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
