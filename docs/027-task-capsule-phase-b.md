# 027 — Task Capsule (Phase B of the context-coherence arc)

Date: 2026-07-15. Branch `feat/region-outcome-substrate` (stacked on Phase A / docs/025).
Plan: `~/.claude/plans/prepare-for-integration-into-playful-rain.md` (roadmap row B).

## Why

Phase A's finding: sextant surfaces *files*, not regions — only 3.9% of injected rows
carry a region breadcrumb, which starves the region-outcome measurement. Phase B is the
answer: turn the flat "Relevant files" list into a **role-based, region-surfaced Task
Capsule**. This both improves orientation (roles > undifferentiated list) AND raises the
region-surfacing rate that powers the Phase-A instrument. It is the first *product* change
of the arc, so it ships **default-off** and is A/B'd against the flat block using Phase A's
region metrics ("default-off until it beats flat").

## Design

**Flag / A/B.** `SEXTANT_CAPSULE=1` env or `.codebase-intel.json` `capsule: true`. Off →
byte-identical flat block (holdback-style discipline; self-eval unaffected). On →
role-labeled capsule block. The persisted injected set (Phase A) carries region breadcrumbs
in both arms; capsule mode raises how many PRIMARY files carry a resolved region.

**Role-based workset** (`lib/workset.js:compileWorkset(files, db, opts)`): one role per
surfaced file, by priority, using signals already on the merged hit:
- **witnesses** — `isTestPath(path)` (reused from `retrieve.js`): tests/fixtures/specs.
- **primary** — a definitional signal (`exported_symbol` / `swift_decl_type` /
  `swift_decl_other` / `reexport_chain`) or a top-`PRIMARY_TOP` rank among non-tests.
  Region RESOLVED (`lib/regions.js`) and surfaced.
- **support** — everything else surfaced (path_match / text_only / lower rank).
- **hazards** — ANNOTATIONS, not a partition: surfaced files with fan-in ≥ `HAZARD_FANIN`
  (high blast surface) + a health note when import resolution < 90%.
- **unknowns** — ANNOTATIONS: surfaced files sextant can't resolve to a region (unsupported
  language). Omitted when empty. Honest about what it cannot verify (Principle 4).

**Capsule envelope** (`lib/capsule.js`): durable `.planning/intel/.capsule.<sessionKey>`:
`{ taskId, sessionId, createdAt, repo:{root,branch,head,statusHash}, intent:{text},
workset, servedClaims:[], touchedRegions:[], status }`. Repo fingerprint from
`freshness.captureCurrentState` + `git.getGitInfo`. `servedClaims`/`touchedRegions` are
Phase C/D stubs (present, empty). `taskId` derived from sessionKey (one capsule/session v1).

**Renderer** (`lib/format-capsule.js:formatCapsule`): role sections (PRIMARY / SUPPORT /
WITNESSES / HAZARDS / UNKNOWNS), primary rows carry `defines X (region L44–L52)`. Returns
`{text, files}` mirroring `formatRetrievalDetailed` so the Phase-A outcome substrate keeps
working (files = flattened surfaced set with region breadcrumbs). Char-capped, dropping
lower-priority roles first (unknowns→hazards→witnesses→support), PRIMARY never dropped.

**Wiring** (`hook-refresh.js`): on the ARMED path, when capsule mode is on AND the turn is
not content-stale, build+render the capsule and persist it; else the existing flat/textOnly
path unchanged. Content-stale never renders a capsule (structural claims withheld — same
silent-absence rule as every lane).

**MCP** (`mcp/server.js`): two new tools (facts-only, like `sextant_orient`):
- `sextant_focus(task)` — compile and return a role-based workset for a task (stateless,
  graph-retrieval driven). "Focus me on X."
- `sextant_task_status()` — report the most-recent persisted capsule for this repo: taskId,
  intent, repo fingerprint + whether still fresh, workset counts, status. Read-only v1.

## Ship discipline

Default-off (never degrades a normal install); never throws in the hook; content-stale →
no capsule; self-eval byte-identical; A/B via Phase A region metrics before any default-on.
Transitions (LOCATING/CHANGING/…) and served-claim population are Phase C/D — stubbed here.
