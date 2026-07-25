"use strict";

// Tests for lib/trajectory.js -- the offline benefit harness that replays real
// session transcripts to measure whether the agent opened what sextant surfaced.
// Coverage:
//   - classifyDetailSource maps every format-retrieval label to its source key
//   - parseRetrievalBlock extracts paths + sources (incl. textOnly, tool trailer)
//   - parseStaticBlock pulls file rows from a static summary
//   - extractEvents orders events + normalizes open paths to repo-relative
//   - analyzeSession computes coverage + first-touch on a known stream
//   - basename fallback matches an absolute open against a surfaced repo-rel path
//   - computeLift yields actual > null on a corpus engineered so query-relevance
//     genuinely predicts opens (the headline metric's lock)

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const traj = require("../lib/trajectory");

describe("classifyDetailSource", () => {
  it("maps each format-retrieval label to its canonical source", () => {
    assert.equal(traj.classifyDetailSource("exports foo, bar"), "exported_symbol");
    assert.equal(traj.classifyDetailSource("export match"), "exported_symbol");
    assert.equal(traj.classifyDetailSource("defines URI (in URI) L12"), "swift_decl_type");
    assert.equal(traj.classifyDetailSource("declares handle"), "swift_decl_other");
    assert.equal(traj.classifyDetailSource("re-exports X"), "reexport_chain");
    assert.equal(traj.classifyDetailSource("re-export chain"), "reexport_chain");
    assert.equal(traj.classifyDetailSource("path match: config"), "path_match");
    assert.equal(traj.classifyDetailSource("path match"), "path_match");
    // Only a zoekt excerpt / fan-in => live text evidence, no graph label.
    assert.equal(traj.classifyDetailSource("L42: const x = 1, fan-in: 3"), "text_only");
    assert.equal(traj.classifyDetailSource(""), "text_only");
    assert.equal(traj.classifyDetailSource(undefined), "text_only");
  });
});

describe("parseRetrievalBlock", () => {
  it("extracts paths with sources, ignores the header + tool reminder", () => {
    const block = [
      "<codebase-retrieval>",
      "### Relevant files",
      "- `lib/a.js` — exports foo",
      "- `lib/b.js` — L3: const bar = 1",
      "- `lib/c.js`", // textOnly variant: no detail
      "Use the `sextant_search` MCP tool for deeper code search.",
      "</codebase-retrieval>",
    ].join("\n");
    const files = traj.parseRetrievalBlock(block);
    assert.deepEqual(files, [
      // docs/025 Phase A: export rows now carry a `symbol`, zoekt rows a `line`.
      { path: "lib/a.js", source: "exported_symbol", symbol: "foo" },
      { path: "lib/b.js", source: "text_only", line: 3 },
      { path: "lib/c.js", source: "text_only" },
    ]);
  });

  it("captures the surfaced line (zoekt/swift) and symbol (export/decl), not path_match term", () => {
    const block = [
      "<codebase-retrieval>",
      "- `A.swift` — defines Widget (in UI) L44",
      "- `lib/b.js` — L12: return x",
      "- `lib/c.js` — path match: config", // filename term → NOT a symbol
      "- `lib/d.js` — re-exports Bar",
      "</codebase-retrieval>",
    ].join("\n");
    const files = traj.parseRetrievalBlock(block);
    assert.equal(files.find((f) => f.path === "A.swift").symbol, "Widget");
    assert.equal(files.find((f) => f.path === "A.swift").line, 44);
    assert.equal(files.find((f) => f.path === "lib/b.js").line, 12);
    assert.equal(files.find((f) => f.path === "lib/c.js").symbol, undefined);
    assert.equal(files.find((f) => f.path === "lib/d.js").symbol, "Bar");
  });
});

describe("parseStaticBlock", () => {
  it("pulls backticked file rows from a static summary", () => {
    const block = [
      "<codebase-intelligence>",
      "### Dependency hotspots (fan-in)",
      "- `lib/graph.js`: 25",
      "- `lib/cli.js`: 20",
      "### Recent changes (git)",
      "- 2026-06-06 `docs/handoff.md`",
      "### Module types (top)",
      "- **js**: 102", // no backticked file => skipped
      "</codebase-intelligence>",
    ].join("\n");
    const files = traj.parseStaticBlock(block).map((f) => f.path).sort();
    assert.deepEqual(files, ["docs/handoff.md", "lib/cli.js", "lib/graph.js"]);
    assert.ok(traj.parseStaticBlock(block).every((f) => f.source === "static_summary"));
  });
});

function inject(ts, mode, content, cwd = "/repo") {
  return { type: "attachment", timestamp: ts, cwd, attachment: { content } };
}
function open(ts, tool, file_path) {
  return { type: "assistant", timestamp: ts, message: { content: [{ type: "tool_use", name: tool, input: { file_path } }] } };
}
// An Edit tool_use (assistant, carries id) + its result (user, toolUseResult
// keyed by tool_use_id) — the correlation analyzeRegions relies on.
function editUse(ts, id, file_path, old_string) {
  return { type: "assistant", timestamp: ts, message: { content: [{ type: "tool_use", id, name: "Edit", input: { file_path, old_string } }] } };
}
function editResult(ts, id, filePath, content, structuredPatch) {
  return {
    type: "user",
    timestamp: ts,
    message: { content: [{ type: "tool_result", tool_use_id: id }] },
    toolUseResult: { filePath, content, structuredPatch: structuredPatch || null },
  };
}

const REGION_JS = "function alpha() {\n  return 1;\n}\nfunction beta() {\n  const x = 2;\n  return x;\n}\n";

describe("analyzeRegions (docs/025 Phase A)", () => {
  it("scores an edit IN the surfaced region as in-region, a different region as headroom", () => {
    const recs = [
      // Surface lib/a.js at symbol `beta` (export row, no line).
      inject("t1", null, "<codebase-retrieval>\n- `lib/a.js` — exports beta\n"),
      // Agent edits inside beta().
      editUse("t2", "id1", "/repo/lib/a.js", "const x = 2;"),
      editResult("t3", "id1", "/repo/lib/a.js", REGION_JS, [{ newStart: 5, newLines: 1 }]),
      // Surface lib/b.js at line 5 (beta), but the agent edits alpha() instead.
      inject("t4", null, "<codebase-retrieval>\n- `lib/b.js` — L5: const x = 2\n"),
      editUse("t5", "id2", "/repo/lib/b.js", "return 1;"),
      editResult("t6", "id2", "/repo/lib/b.js", REGION_JS, [{ newStart: 2, newLines: 1 }]),
    ];
    const out = traj.analyzeRegions(recs, "/repo");
    assert.equal(out.scored, 2);
    assert.equal(out.hits, 1); // beta edit
    assert.equal(out.misses, 1); // alpha edit against surfaced beta = headroom
    assert.equal(out.bySource.exported_symbol.hits, 1);
    assert.equal(out.bySource.text_only.misses, 1);
  });

  it("does not score a file that was surfaced without any breadcrumb", () => {
    const recs = [
      inject("t1", null, "<codebase-retrieval>\n- `lib/a.js`\n"), // no line, no symbol
      editUse("t2", "id1", "/repo/lib/a.js", "const x = 2;"),
      editResult("t3", "id1", "/repo/lib/a.js", REGION_JS, [{ newStart: 5, newLines: 1 }]),
    ];
    assert.equal(traj.analyzeRegions(recs, "/repo").scored, 0);
  });

  it("only scores the FIRST edit of a surfaced file (no double count)", () => {
    const recs = [
      inject("t1", null, "<codebase-retrieval>\n- `lib/a.js` — exports beta\n"),
      editUse("t2", "id1", "/repo/lib/a.js", "const x = 2;"),
      editResult("t3", "id1", "/repo/lib/a.js", REGION_JS, [{ newStart: 5, newLines: 1 }]),
      editUse("t4", "id2", "/repo/lib/a.js", "return x;"),
      editResult("t5", "id2", "/repo/lib/a.js", REGION_JS, [{ newStart: 6, newLines: 1 }]),
    ];
    assert.equal(traj.analyzeRegions(recs, "/repo").scored, 1);
  });
});

describe("extractEvents", () => {
  it("orders events by timestamp and normalizes opens to repo-relative", () => {
    const recs = [
      inject("2026-01-01T00:00:01Z", null,
        "<codebase-retrieval>\n### Relevant files\n- `lib/a.js` — exports foo\n"),
      open("2026-01-01T00:00:02Z", "Read", "/repo/lib/a.js"),
      open("2026-01-01T00:00:03Z", "Bash", "/repo/whatever"), // not an open tool
      open("2026-01-01T00:00:04Z", "Edit", "/repo/lib/b.js"),
    ];
    const { events, cwd } = traj.extractEvents(recs);
    assert.equal(cwd, "/repo");
    const kinds = events.map((e) => `${e.kind}:${e.path || e.mode}`);
    assert.deepEqual(kinds, ["inject:retrieval", "open:lib/a.js", "open:lib/b.js"]);
  });

  it("does not record Bash/Grep/etc as opens", () => {
    const recs = [open("t", "Bash", "/repo/x"), open("t", "Grep", "/repo/y")];
    const { events } = traj.extractEvents(recs);
    assert.equal(events.length, 0);
  });
});

describe("analyzeSession", () => {
  it("computes coverage and first-touch rank on a known stream", () => {
    const recs = [
      inject("t1", null,
        "<codebase-retrieval>\n### Relevant files\n- `lib/a.js` — exports foo\n- `lib/b.js` — path match: b\n- `lib/c.js`\n"),
      open("t2", "Read", "/repo/lib/x.js"), // not surfaced (rank-1 open, miss)
      open("t3", "Read", "/repo/lib/a.js"), // surfaced, rank 2 => first-touch rank 2
      open("t4", "Read", "/repo/lib/b.js"), // surfaced too
    ];
    const { events } = traj.extractEvents(recs);
    const r = traj.analyzeSession(events);
    // 2 of 3 surfaced files opened
    assert.equal(r.retrieval.surfaced, 3);
    assert.equal(r.retrieval.surfacedOpened, 2);
    // first surfaced hit is the 2nd open after injection
    assert.deepEqual(r.retrieval.firstTouchRanks, [2]);
    // per-source attribution preserved
    assert.equal(r.retrieval.bySource.exported_symbol.opened, 1);
    assert.equal(r.retrieval.bySource.path_match.opened, 1);
    assert.equal(r.retrieval.bySource.text_only.opened, 0); // c.js never opened
  });

  it("matches an absolute open outside cwd against a surfaced repo-rel path by path suffix", () => {
    const recs = [
      inject("t1", null, "<codebase-retrieval>\n### Relevant files\n- `lib/a.js` — exports foo\n"),
      // opened via a path NOT under cwd (e.g. symlinked checkout) -> suffix fallback
      open("t2", "Read", "/other/place/lib/a.js"),
    ];
    const { events } = traj.extractEvents(recs);
    const r = traj.analyzeSession(events);
    assert.equal(r.retrieval.surfacedOpened, 1);
  });

  it("does NOT match a same-basename file in a different directory (no basename fallback)", () => {
    // Old basename matching counted lib/config.js as opened when the agent
    // opened config/config.js — a different file — inflating coverage on both
    // the actual and the permutation-null arm. Suffix matching kills that.
    const recs = [
      inject("t1", null, "<codebase-retrieval>\n### Relevant files\n- `lib/config.js` — exports loadRepoConfig\n"),
      open("t2", "Read", "/repo/config/config.js"),
    ];
    const { events } = traj.extractEvents(recs, { sessionCwd: "/repo" });
    const r = traj.analyzeSession(events);
    assert.equal(r.retrieval.surfacedOpened, 0, "same basename, different dir must be a miss");
    assert.deepEqual(r.retrieval.firstTouchRanks, [], "first-touch must not match by basename either");
  });
});

describe("computeLift", () => {
  it("yields actual > null when query-relevance genuinely predicts opens", () => {
    // Three sessions in one repo. Each surfaces its OWN session-specific file plus
    // a shared hub.js, and opens exactly those two. Perfect query-relevance: the
    // session-specific file is always opened. A null that swaps in another
    // session's surfaced set still scores on the shared hub.js (a real plausible
    // file) but MISSES that session's specific file -> null lands strictly
    // between 0 and actual. This is the realistic shape (null > 0, like the real
    // corpus's 3.49%), and lift must exceed 1.
    const mk = (own) => traj.extractEvents([
      inject("t1", null, `<codebase-retrieval>\n### Relevant files\n- \`${own}\`\n- \`lib/hub.js\`\n`),
      open("t2", "Read", `/repo/${own}`),
      open("t3", "Read", "/repo/lib/hub.js"),
    ]).events;
    const sessions = [
      { repo: "R", events: mk("lib/a.js") },
      { repo: "R", events: mk("lib/b.js") },
      { repo: "R", events: mk("lib/c.js") },
    ];
    const lift = traj.computeLift(sessions, "retrieval", { K: 200, seed: 7 });
    assert.equal(lift.actualPct, 100); // every surfaced file opened
    assert.ok(lift.nullPct > 0 && lift.nullPct < lift.actualPct,
      `null must be strictly between 0 and actual, got ${lift.nullPct}`);
    assert.ok(lift.lift > 1.5, `lift should be >1.5, got ${lift.lift}`);
  });

  it("is deterministic for a fixed seed", () => {
    const mk = (s, o) => traj.extractEvents([
      inject("t1", null, `<codebase-retrieval>\n### Relevant files\n- \`${s}\`\n`),
      open("t2", "Read", `/repo/${o}`),
    ]).events;
    const sessions = [
      { repo: "R", events: mk("a.js", "a.js") },
      { repo: "R", events: mk("b.js", "x.js") },
    ];
    const a = traj.computeLift(sessions, "retrieval", { K: 50, seed: 99 });
    const b = traj.computeLift(sessions, "retrieval", { K: 50, seed: 99 });
    assert.deepEqual(a, b);
  });
});

// ---------------------------------------------------------------------------
// REPO FILTER (docs/033 Tier 1 #2)
//
// repoOf returns Claude Code's MANGLED project dir (`-root-sextant`), so a
// `===` comparison against the natural `--repo sextant` matched nothing and
// buildReport rendered a confident 0-of-0 report while the corpus held 150
// sessions. These lock the suffix matcher and its refusals.
// ---------------------------------------------------------------------------
describe("repoMatches (docs/033)", () => {
  const { repoMatches } = require("../lib/trajectory");

  it("matches the bare repo name against a mangled project dir", () => {
    assert.equal(repoMatches("-root-sextant", "sextant"), true);
    assert.equal(repoMatches("-root-somaNotes", "somaNotes"), true);
  });

  it("matches path-shaped and raw-dir queries", () => {
    assert.equal(repoMatches("-root-sextant", "root/sextant"), true);
    assert.equal(repoMatches("-root-sextant", "/root/sextant"), true);
    assert.equal(repoMatches("-root-sextant", "-root-sextant"), true);
  });

  it("is case-insensitive", () => {
    assert.equal(repoMatches("-root-somaNotes", "somanotes"), true);
  });

  it("does not match on a bare substring — the boundary must be a separator", () => {
    // "extant" is a suffix of "sextant" but not a path segment of it.
    assert.equal(repoMatches("-root-sextant", "extant"), false);
    assert.equal(repoMatches("-root-sextant", "sex"), false);
    assert.equal(repoMatches("-root-sextant-memory", "sextant"), false);
  });

  it("refuses empty and non-string queries instead of matching everything", () => {
    assert.equal(repoMatches("-root-sextant", ""), false);
    assert.equal(repoMatches("-root-sextant", "/"), false);
    assert.equal(repoMatches("-root-sextant", null), false);
    assert.equal(repoMatches(null, "sextant"), false);
  });
});

describe("listRepos + buildReport filter (docs/033)", () => {
  const traj = require("../lib/trajectory");
  const fsx = require("fs");
  const osx = require("os");
  const pathx = require("path");

  it("lists project dirs holding transcripts, and the filter reaches them", () => {
    const root = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "traj-repo-"));
    try {
      for (const dir of ["-root-sextant", "-root-other"]) {
        fsx.mkdirSync(pathx.join(root, dir), { recursive: true });
        fsx.writeFileSync(pathx.join(root, dir, "s.jsonl"), "");
      }
      assert.deepEqual(traj.listRepos(root), ["-root-other", "-root-sextant"]);
      // The natural query must now reach exactly one project.
      const matched = traj.listRepos(root).filter((n) => traj.repoMatches(n, "sextant"));
      assert.deepEqual(matched, ["-root-sextant"]);
      // And buildReport must scan it rather than reporting 0-of-0.
      assert.equal(traj.buildReport(root, { repo: "sextant" }).sessionsScanned, 1);
      assert.equal(traj.buildReport(root, { repo: "nope" }).sessionsScanned, 0);
    } finally {
      fsx.rmSync(root, { recursive: true, force: true });
    }
  });
});
