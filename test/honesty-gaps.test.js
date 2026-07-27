"use strict";

// FOUR HONESTY DEFECTS (docs/035 step 1), each reproduced by DRIVING it before
// it was fixed. All four share a shape: sextant asserted something it could not
// stand behind, and no fixture existed to say so.
//
//   1. lib/freshness.js — a root that never had git reported `head_changed`
//      forever, and paid a futile rescan on every read.
//   2. lib/zoekt-scope.js — the non-git index ingests the live tree, so a
//      gitignored .env reached the injection path with its values intact.
//   3. lib/zoekt.js — a dead daemon PID on a reused port served a FOREIGN
//      repo's index as this repo's facts.
//   4. lib/summary.js — the 2200-char clamp cut mid-token inside an
//      unterminated backtick, fabricating a path.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const freshness = require("../lib/freshness");
const { isSensitivePath } = require("../lib/zoekt-scope");
const { clampChars, clampBlock } = require("../lib/summary");
const cli = require("../lib/cli");

// ─── 1. non-git root: an honest reason, and no futile rescan ────────────────

describe("freshness — a root with no git repository", () => {
  let dir;
  let gitDir;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-nogit-"));
    fs.writeFileSync(path.join(dir, "package.json"), '{"name":"nogit","version":"1.0.0"}');
    fs.writeFileSync(path.join(dir, "index.js"), 'module.exports = { a: 1 };\n');
    execFileSync(process.execPath, [path.join(__dirname, "..", "bin", "intel.js"), "scan", "--root", dir], {
      stdio: "ignore",
    });

    // Control: the same tree, but a real git repo.
    gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-git-"));
    fs.writeFileSync(path.join(gitDir, "package.json"), '{"name":"git","version":"1.0.0"}');
    fs.writeFileSync(path.join(gitDir, "index.js"), 'module.exports = { a: 1 };\n');
    const g = (...args) => execFileSync("git", args, { cwd: gitDir, stdio: "ignore" });
    g("init", "-q");
    g("config", "user.email", "t@t.t");
    g("config", "user.name", "t");
    g("add", "-A");
    g("-c", "commit.gpgsign=false", "commit", "-qm", "init");
    execFileSync(process.execPath, [path.join(__dirname, "..", "bin", "intel.js"), "scan", "--root", gitDir], {
      stdio: "ignore",
    });
  });

  after(() => {
    for (const d of [dir, gitDir]) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {}
    }
  });

  it("reports git_absent, not a fabricated head_changed", async () => {
    // FAIL-pre: this returned {reason:"head_changed", contentChanged:true,
    // evidence:{stored:"",current:null}} on 3/3 consecutive calls immediately
    // after a SUCCESSFUL scan, and still after `rescan --force`. Nothing had
    // moved; there was simply never an anchor. Reporting a moved HEAD in a
    // directory that has no HEAD is a fabricated fact.
    const r = await freshness.checkFreshness(dir);
    assert.equal(r.fresh, false, "still not fresh — freshness is genuinely unverifiable here");
    assert.equal(r.reason, "git_absent");
    assert.notEqual(r.reason, "head_changed");
  });

  it("is stable across repeated calls and a forced rescan", async () => {
    const reasons = [];
    for (let i = 0; i < 3; i++) reasons.push((await freshness.checkFreshness(dir)).reason);
    assert.deepEqual(reasons, ["git_absent", "git_absent", "git_absent"]);
  });

  it("marks the rescan useless so the gate stops enqueueing one", async () => {
    // The permanent blackout also burned one successful-but-futile
    // `freshness_gate` scan per read, forever.
    const r = await freshness.checkFreshness(dir);
    assert.equal(r.rescanUseless, true);
  });

  it("still withholds structural claims (degrade, don't guess)", async () => {
    // The fix makes the REASON honest; it must not invent freshness. Without
    // git there is no cheap tree fingerprint, so silent absence is still right.
    const r = await freshness.checkFreshness(dir);
    const body = await cli.buildStaleBody(dir, r, { state: "unavailable", reason: r.reason });
    assert.match(body, /Structural claims unavailable this turn/);
    assert.match(body, /no git repository at this root/);
    assert.match(body, /git init/, "names the one action that resolves it");
    assert.doesNotMatch(body, /import resolution/, "no graph-derived numbers in a blackout body");
  });

  it("a real git repo is unaffected", async () => {
    const r = await freshness.checkFreshness(gitDir);
    assert.equal(r.reason, null);
    assert.equal(r.fresh, true);
    assert.notEqual(r.rescanUseless, true);
  });

  it("a repo that HAD git and lost it keeps the loud head_changed path", async () => {
    // Deliberate: git_absent requires stored.head to be empty too. A deleted
    // .git is a real anomaly and must not be quietly reclassified as "this was
    // never a git repo".
    fs.rmSync(path.join(gitDir, ".git"), { recursive: true, force: true });
    const r = await freshness.checkFreshness(gitDir);
    assert.equal(r.reason, "head_changed");
    assert.notEqual(r.reason, "git_absent");
  });
});

// ─── 2. secrets never reach the injection path ──────────────────────────────

describe("zoekt scope — secret-bearing paths", () => {
  it("drops the credential conventions", () => {
    for (const p of [
      ".env",
      ".env.local",
      ".env.production",
      "packages/api/.env",
      "config/id_rsa",
      "certs/server.pem",
      "certs/server.key",
      "deploy/keystore.jks",
      "home/.ssh/config",
      "home/.gnupg/secring.gpg",
      ".npmrc",
      ".pypirc",
      ".netrc",
      ".git-credentials",
      "credentials.json",
    ]) {
      assert.equal(isSensitivePath(p), true, `${p} should be dropped`);
    }
  });

  it("KEEPS the .env template family — that is the declared-manifest signal", () => {
    // These carry required env KEY NAMES without values, and sextant
    // deliberately surfaces them (### Required env). Over-filtering here would
    // delete a real orientation fact to solve a problem those files don't have.
    for (const p of [".env.example", ".env.sample", "app/.env.template", ".env.dist", ".env.defaults"]) {
      assert.equal(isSensitivePath(p), false, `${p} should be kept`);
    }
  });

  it("keeps ordinary source, including files that merely mention env", () => {
    for (const p of ["lib/freshness.js", "src/env.ts", "src/environment/config.py", "README.md", "Makefile"]) {
      assert.equal(isSensitivePath(p), false, `${p} should be kept`);
    }
  });

  it("drops the whole file, not just the matched line", () => {
    // Line-level filtering would still have materialized the secret in the
    // before/after context of a neighbouring hit.
    const zoekt = require("../lib/zoekt");
    const json = {
      Result: {
        Files: [
          {
            FileName: ".env",
            LineMatches: [
              { LineNumber: 1, Line: Buffer.from("TOKEN=sk_live_secret").toString("base64") },
            ],
          },
          {
            FileName: "index.js",
            LineMatches: [
              { LineNumber: 2, Line: Buffer.from("const a = 1;").toString("base64") },
            ],
          },
        ],
      },
    };
    const out = zoekt._normalizeForTest(json, isSensitivePath);
    assert.equal(out.hits.length, 1);
    assert.equal(out.hits[0].path, "index.js");
    assert.equal(out.stats.sensitiveFilesDropped, 1);
    assert.ok(
      !JSON.stringify(out).includes("sk_live_secret"),
      "the secret must not appear anywhere in the returned object"
    );
  });
});

// ─── 3. a daemon must prove it serves THIS repo ─────────────────────────────

describe("zoekt daemon — identity, not liveness", () => {
  const zoekt = require("../lib/zoekt");
  const servesThisRoot = zoekt._daemonServesThisRootForTest;
  const hasProc = fs.existsSync(`/proc/${process.pid}/cmdline`);

  it("accepts a live daemon started with this root's index dir", (t) => {
    if (!hasProc) return t.skip("no /proc on this platform");
    // Our own PID's cmdline is `node --test ...`, i.e. NOT a zoekt process —
    // which is itself the recycled-PID case, asserted below. For the positive
    // case we assert against the real fleet daemon when one is live.
    const root = "/root/sextant";
    let df = null;
    try {
      df = JSON.parse(fs.readFileSync(path.join(root, ".planning/intel/zoekt/daemon.json"), "utf8"));
    } catch {
      return t.skip("no daemon.json on this machine");
    }
    let alive = true;
    try {
      process.kill(df.pid, 0);
    } catch {
      alive = false;
    }
    if (!alive) return t.skip("recorded daemon is not running");
    assert.equal(servesThisRoot(root, df.pid), true);
  });

  it("rejects a PID that is not a zoekt process at all (recycled PID)", (t) => {
    if (!hasProc) return t.skip("no /proc on this platform");
    // FAIL-pre for the whole class: the old code never asked this question. It
    // treated the PID check as a soft pre-filter and probed the port anyway, so
    // a reused port answered 200 and its contents were injected as fact.
    // Observed live: /root/manus-api-mcp recorded a DEAD pid on port 6075, now
    // owned by another repo's webserver, and searchFast returned 6 hits — every
    // one a sextant file.
    assert.equal(servesThisRoot("/root/sextant", process.pid), false);
  });

  it("rejects a zoekt process serving a DIFFERENT root", (t) => {
    if (!hasProc) return t.skip("no /proc on this platform");
    let df = null;
    try {
      df = JSON.parse(
        fs.readFileSync(path.join("/root/sextant", ".planning/intel/zoekt/daemon.json"), "utf8")
      );
      process.kill(df.pid, 0);
    } catch {
      return t.skip("no live daemon to borrow for the cross-root check");
    }
    // Same live zoekt process, asked on behalf of a different repo: its
    // -index argument names sextant's shard, not this one.
    assert.equal(servesThisRoot("/root/some-other-repo", df.pid), false);
  });
});

// ─── 4. the clamp never fabricates a path ───────────────────────────────────

describe("summary clamp — whole lines only", () => {
  // Shaped like the real failure: somaNotes' summary ended `- `api/__i` at
  // exactly 2200 chars with an ODD backtick count (79).
  const body =
    "## Codebase intelligence\n" +
    "\n" +
    "### Likely entry points\n" +
    "- `src/main.js` (js)\n" +
    "- `api/endpoints/__init__.py` (py) (heuristic)\n";

  it("FAIL-pre: the raw character clamp cuts mid-token inside a backtick", () => {
    const cut = clampChars(body, 80);
    const ticks = (cut.match(/`/g) || []).length;
    assert.equal(ticks % 2, 1, "reproduces the unbalanced backtick");
    assert.ok(!cut.endsWith("\n"), "reproduces the partial trailing line");
  });

  it("PASS-post: clampBlock ends on a complete line with balanced backticks", () => {
    const cut = clampBlock(body, 80);
    assert.equal((cut.match(/`/g) || []).length % 2, 0, "backticks balanced");
    assert.ok(cut.endsWith("\n"), "ends on a line boundary");
    for (const line of cut.split("\n").filter(Boolean)) {
      assert.ok(
        body.includes(line + "\n"),
        `every emitted line must be byte-identical to a source line: ${JSON.stringify(line)}`
      );
    }
    assert.ok(cut.length <= 80);
  });

  it("drops a heading whose body did not survive", () => {
    // An empty "### Likely entry points" asserts there are none — the
    // silent-absence inversion.
    const cut = clampBlock(body, 62);
    assert.ok(!/###[^\n]*\n?$/.test(cut.trimEnd()), `trailing heading left behind: ${JSON.stringify(cut)}`);
  });

  it("falls back within the line when a single line exceeds the budget", () => {
    // test/summary.test.js:301 pins this: a 3000-char line with no newline must
    // still produce output. An empty summary is worse than a truncated one.
    const cut = clampBlock("A".repeat(3000), 2200);
    assert.ok(cut.length > 0);
    assert.ok(cut.length <= 2200);
  });

  it("is a no-op under the cap", () => {
    assert.equal(clampBlock(body, 100000), body);
  });
});

// ─── 5. un-darking the orientation lanes (docs/035 #6, step 4) ──────────────

describe("status fingerprint — a big dirty tree must not be permanently stale", () => {
  let dir;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-bigdirty-"));
    const g = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    fs.writeFileSync(path.join(dir, "package.json"), '{"name":"bigdirty","version":"1.0.0"}');
    fs.writeFileSync(path.join(dir, "index.js"), "module.exports = { a: 1 };\n");
    g("init", "-q");
    g("config", "user.email", "t@t.t");
    g("config", "user.name", "t");
    g("add", "-A");
    g("-c", "commit.gpgsign=false", "commit", "-qm", "init");
    // A dirty file larger than STATUS_FILE_MAX_BYTES (2 MiB). Before the fix a
    // single one of these nulled the anchor for the WHOLE repo, and
    // checkFreshness turned a null anchor into `status_changed` FOREVER — no
    // rescan could clear it. Live cost: /root/somaNotes (20.4 MiB dirty) and
    // /root/open-interpreter-fork (392.9 MiB) were permanently content-stale,
    // which is 202 of 234 subagent-orientation skips fleet-wide.
    fs.writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(3 * 1024 * 1024, 7));
  });

  after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  it("produces a real status anchor instead of null", () => {
    const st = freshness.captureCurrentStateDetailed(dir);
    assert.ok(st.statusHash, "statusHash must not be null with an over-budget dirty file");
    assert.equal(typeof st.statusHash, "string");
    assert.ok(st.degradedFiles >= 1, "the over-budget file is fingerprinted in degraded mode");
  });

  it("the anchor is STABLE across reads (otherwise it is noise, not an anchor)", () => {
    const a = freshness.captureCurrentStateDetailed(dir).statusHash;
    const b = freshness.captureCurrentStateDetailed(dir).statusHash;
    assert.equal(a, b);
  });

  it("still detects a change to the over-budget file", () => {
    // Degraded mode is size+mtime, so it is weaker than a content hash — but it
    // must not be blind. A real edit changes at least the size here.
    const before = freshness.captureCurrentStateDetailed(dir).statusHash;
    fs.appendFileSync(path.join(dir, "big.bin"), Buffer.alloc(1024, 9));
    const after = freshness.captureCurrentStateDetailed(dir).statusHash;
    assert.notEqual(before, after);
  });

  it("nested sextant state is excluded from the fingerprint at any depth", () => {
    // Root-anchored exclusion only covered `.planning/` at the top level, so a
    // nested project's sextant state was hashed into the PARENT's anchor — on
    // somaNotes that was a 4.7 MiB zoekt shard, 5.0 MiB of a 20.4 MiB tree,
    // churning on every scan of the nested project.
    const before = freshness.captureCurrentStateDetailed(dir).statusHash;
    const nested = path.join(dir, "sub", ".planning", "intel");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "graph.db"), Buffer.alloc(64, 1));
    const after = freshness.captureCurrentStateDetailed(dir).statusHash;
    assert.equal(before, after, "a nested .planning/ write must not move the parent's anchor");
  });
});

describe("subagent orientation — the coherence gate must not silence the only lane", () => {
  it("yields for spawn paths hook-pretask cannot reach", () => {
    // 34 of 34 coherence_enabled skips were agentType "workflow-subagent", with
    // ZERO pretask events for them: the gate removed the only delivery and
    // substituted nothing.
    const src = fs.readFileSync(path.join(__dirname, "..", "commands", "hook-subagentstart.js"), "utf8");
    assert.match(src, /PRETASK_UNREACHABLE/, "the yield set must exist");
    assert.match(
      src,
      /coherence\.coherenceEnabled\(root\)\s*&&\s*!PRETASK_UNREACHABLE\.has\(data\.agent_type\)/,
      "the gate must be conditioned on pretask reachability"
    );
    assert.match(src, /new Set\(\["workflow-subagent"\]\)/, "workflow-subagent is the observed case");
  });
});

// ─── 6. subtraction groundwork (docs/035 step 6) ────────────────────────────

describe("MCP surface — measured, and its injected claim derived", () => {
  it("records an event for every tool call AND for the definition load", async () => {
    // FAIL-pre: `grep -c recordEvent mcp/server.js` was 0. The pull channel was
    // completely unmeasured, which is why nobody noticed a transcript census
    // finds ~1 sextant tool invocation against hundreds of definition loads.
    // Counting LOADS separately from CALLS is the point: 9 tool definitions are
    // paid for on every session that wires this server.
    const src = fs.readFileSync(path.join(__dirname, "..", "mcp", "server.js"), "utf8");
    assert.ok(/recordMcp\(/.test(src), "dispatch must record");
    assert.match(src, /recordMcp\("\(tools\/list\)"/, "definition loads are the denominator");
    assert.match(src, /mcp\.invoked/, "event name");
  });

  it("never bootstraps state in a directory that is not a sextant install", () => {
    // This server resolves its repo from process.cwd(). Recording against an
    // arbitrary cwd would CREATE .planning/intel there — the self-bootstrap
    // failure the 101 GB home-dir incident taught.
    const src = fs.readFileSync(path.join(__dirname, "..", "mcp", "server.js"), "utf8");
    assert.match(
      src,
      /existsSync\(path\.join\(root, "\.planning", "intel"\)\)\) return;/,
      "must write only when the state dir already exists"
    );
  });

  it("the injected MCP line is DERIVED from the registered tools, not hardcoded", () => {
    // It used to be a string literal naming four tools while the server exposed
    // nine — already incomplete, and outright false the moment any tool is
    // renamed or removed. A claim about a changeable surface must be read from
    // that surface.
    const server = require("../mcp/server");
    const orient = fs.readFileSync(path.join(__dirname, "..", "lib", "orient.js"), "utf8");
    assert.ok(Array.isArray(server.TOOL_NAMES) && server.TOOL_NAMES.length > 0);
    assert.match(orient, /TOOL_NAMES/, "orient must read the real tool list");
    assert.doesNotMatch(
      orient,
      /"This repo's MCP server exposes: sextant_search, sextant_explain, sextant_related, sextant_health\."/,
      "the hardcoded literal must be gone"
    );
    // Every tool the line can name must actually be registered.
    for (const t of ["sextant_search", "sextant_explain", "sextant_related", "sextant_health"]) {
      assert.ok(server.TOOL_NAMES.includes(t), `${t} must really exist to be claimed`);
    }
  });
});
