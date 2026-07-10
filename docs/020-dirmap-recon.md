# 020 — Directory-mapping recon results (the docs/019 probes)

Date: 2026-07-09, main @ 9f2d1eb. All four probes from `docs/019-directory-structure-track.md`
ran against real repos. Scripts: `docs/recon/019-dirmap/` (016 convention; relative
requires, so no resolution-miss pollution). Probe corpus: sextant (127 files),
somaNotes (1403), jan25 (495), defGen2 (112), vuejs/core shallow clone (525, true
pnpm monorepo — scanned in scratchpad), plus glasshud / open-interpreter-fork /
manus-api-mcp / cairn for probe 3 breadth.

**Verdict up front: GO for design.** Neither pre-registered kill criterion fired.
The flow signal is far stronger than feared, subproject detection is clean with
three existing guards, and the benefit headroom is real but modest and now has a
dated baseline. Design notes below are load-bearing — three of them were found by
the probes, not anticipated.

## Probe 1 — skeleton quality: PASS (5/5 recognizable)

`probe1-skeleton.js` generates a candidate Structure section from graph.db alone
(top-level dirs by file count, dominant module type, top directed flows; a
top-level dir expands to depth 2 when it holds ≥3 manifest-bearing subdirs).

| Repo | Bytes | Recognizable? |
|---|---|---|
| sextant | 305 | yes — test/lib/commands/fixtures/docs/scripts/bin/mcp is exactly the repo |
| somaNotes | 342 | yes — tests/static/services/api/ir/... matches the app's real shape |
| jan25 | 355 | yes — tests/services/archive/scripts/routes/infra/workers |
| defGen2 | 331 | yes — tests/analysis/location/api/sources/core |
| vue-core | 538 | yes — the expansion produced the real package list (runtime-core, compiler-core, reactivity, …) |

Kill check 1 ("arbitrary on ≥half the probe repos"): **not fired** — 0/5 arbitrary.

Found live: the expansion rule fired falsely on sextant's `fixtures/` (3 fixture
dirs carry manifests) until the probe-3 junk-hint filter was applied to it. With
the filter, vue-core's expansion is unchanged and sextant collapses to the honest
depth-1 view. **Design note D1: the monorepo-expansion rule MUST run the junk
filter first.**

## Probe 2 — flow signal: PASS (directed, not mush)

`probe2-flows.js`: dir→dir matrix from resolved internal imports; per-pair
asymmetry = |fwd−rev|/(fwd+rev); "directed mass share" = fraction of cross-dir
edge mass in pairs with asym ≥ 0.6.

| Repo | Cross-dir edges | Mass-weighted asym | Directed mass share |
|---|---|---|---|
| sextant | 192 | 1.000 | 100% |
| somaNotes | 1677 | 0.949 | 95.1% |
| jan25 | 771 | 0.769 | 69.4% |
| defGen2 | 165 | 0.976 | 100% |
| vue-core (between packages) | 433 | 0.926 | 98.4% |

Real architecture falls out: `api/ → services/` (somaNotes), `routes/ →
services/` (jan25), `runtime-core → reactivity` / `compiler-sfc → compiler-core`
(vue-core — the actual Vue dependency DAG). Two refinements from the data:

- **D2: exclude the `.` pseudo-dir from flow lines.** jan25's only mushy pairs
  (`routes/→.` asym 0.44, `services/→.` asym 0.15) all involve root-level files —
  root files are not a "direction," they're clutter.
- **D3: drop test-dir-SOURCED flows from the flow line.** `tests/ → X` is the
  highest-mass pair on every Python repo and carries zero architecture (tests
  import everything). The orientation value is in source→source flows. (Test flows
  stay in the underlying matrix — a dir-level `sextant explain` may still want them.)

## Probe 3 — subproject detection for mapping: PASS (FP 0 post-filter, 9 repos)

`probe3-subprojects.js`: every depth≤2 dir carrying a manifest, with judgment
context. 32 manifest-dirs found across 9 repos:

- **Real packages (survive all filters)**: somaNotes `packages/dark-roast` (8
  files), open-interpreter-fork `cc-sidecar` (28), vue-core's 12 `packages/*` +
  5 `packages-private/*` (private dev packages, but genuinely the repo's layout).
- **Junk (every one catchable by an existing guard)**: sextant's 4 `fixtures/*`
  (junk-hint), jan25 `vendor/syncedlyrics` (junk-hint + nested-git + 0 indexed),
  glasshud's 7 nested SDK/platform trees (nested-git or 0 indexed files),
  manus-api-mcp `examples/webhook-receiver` (junk-hint + 0 indexed).

**D4: the mapping guard is the triplet** junk-path hint + nested-git + indexed-
files>0. Post-filter false positives on this sample: **0/32**. The polyglot fear
that killed the *exclusion* use (project-scope.js) never materialized for the
*mapping* use — every polyglot manifest here was a fixture or a vendored tree.

Known miss (accepted): cairn `frontend/` is a real package but has 0 indexed
files (graph coverage, not detection) — the indexed-files guard suppresses it.
That is silent-absence behaving correctly: the map never claims structure the
graph didn't index.

## Probe 4 — benefit hypothesis: grounded; headroom real but modest

`probe4-benefit.js` replays real session transcripts (`lib/trajectory.js`
parsing): per session with ≥3 opens and ≥2 edits, does the FIRST opened file's
top-level dir match the modal dir of the session's edits (its worksite)?

Baseline (2026-07-09, 93 session files, 33 scored — rolling-window caveat, cite
with date):

- **Wrong-dir-start rate 39.4% overall (13/33)** — but first-touch rank median 1,
  p90 4: agents find the worksite dir within ~4 opens on their own.
- **The gradient is the finding**: somaNotes (1403 files, 33 top dirs) 59%
  wrong-start; defGen2 (13 dirs) 50% (n=2); glasshud (**1** top dir) 0%.
  Dir-level misorientation exists exactly where there are directories to be
  wrong about — confirming 019's "wrong-starting-file in large repos" class.

Honest framing: wrong-start is an upper bound (opening an entry point before
editing services/ is legitimate navigation), and the p90=4 recovery means the
measurable trajectory delta will be small. The stronger value claims — monorepo
skeleton and blast-radius digestibility — aren't captured by this number.

**Pre-registered metrics for the build** (decided now, per 019 probe 4):
1. **Primary**: wrong-dir-start rate + dir-level first-touch rank on broad repos
   (≥10 top-level dirs), via this probe re-run on post-ship sessions. Success =
   wrong-start rate on broad repos drops vs the 2026-07-09 baseline above.
2. **Secondary**: blast-radius rollup form — once blast-radius open-attribution
   (docs/017 lever #1) exists, compare note open-rates with/without dir rollups.

## Byte budget (kill check 2): PASS with conditions

Gross section cost 305–355 bytes (538 monorepo). Kill criterion was ">~300 bytes
without displacing a weaker section" — a displacement exists:

- **Module types (top)** costs 89–95 bytes and is fully subsumed (per-dir
  dominant type + counts carry strictly more information). **D5: Structure
  replaces Module types.** Net cost ≈ 210–260 bytes.
- Sextant's summary runs 1819/2200 — fits with ~170 bytes to spare. somaNotes
  already sits at 2228 (clamped): on cap-bound repos the clamp needs a priority
  decision (design question, not recon; candidates: tighten rows — drop the word
  "files", cap at 6 rows — or let Structure outrank Public API's last entries).
- Monorepo variant (538 gross) needs tightening: strip the expanded parent
  prefix from rows (group under one `packages/:` header) ≈ −100 bytes.

## Kill-criteria summary

| Criterion | Result |
|---|---|
| Skeleton arbitrary on ≥half probe repos | NOT FIRED — 0/5 |
| >~300B without a displaceable weaker section | NOT FIRED — Module types displaces; net ~210–260B |
| (separate) dir-rollup-in-blast-radius form | No kill signal — flows 69–100% directed; rollup is meaningful at same byte cost |

## What the design phase inherits

- D1 junk-filter before monorepo expansion; D2 no `.` in flow lines; D3 no
  test-sourced flows in the summary flow line; D4 mapping guard triplet;
  D5 Structure displaces Module types.
- Candidate forms, in value order per this recon: (a) summary Structure section
  (all repos, biggest on broad/monorepo ones), (b) blast-radius dir rollups
  (depends on 017 lever #1 for measurement), (c) `sextant explain <dir>/`
  dir-level queries (cheap once aggregation exists), (d) per-package health
  (monorepo-only, defer until a real monorepo is dogfooded).
- Metrics pre-registered above; baseline snapshot lives in this doc.
