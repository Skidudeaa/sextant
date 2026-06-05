---
title: Signal-expansion menu — what else sextant can consume from target codebases
status: researched
priority: high
feasibility: high
source: deep-research workflow (15 Opus researchers → 45 candidates → 39 passed the philosophy gate → ranked)
researched: 2026-06-04
method: 12 signal-family + 3 prior-art researchers → independent DESIGN_PHILOSOPHY kill-gate per candidate → composite ranking
companion: docs/ideas/006-next-targets-roadmap.md
---

# Signal-Expansion Menu — What Else Sextant Can Consume

> Answer to *"what other signals can we consume in target codebases?"* — produced by a
> deep-research fleet, with every candidate grounded in (a) cited prior art and (b)
> sextant's actual code (file:line), then run through an independent kill-gate against the
> hard constraints: **no embeddings · no LLM-in-pipeline · no semantic/LSP claims · no
> compiler/toolchain dependency · injected summary ≤2200 chars · every signal a FACT
> producible without inference · degrade loudly (go quiet, never guess).**
>
> 45 raw candidates → **39 survived the gate, 6 killed.** Kills are preserved because they
> are as instructive as the picks. **Kill-on-no-fixture applies:** any signal whose
> FAIL-pre/PASS-post case can't be manufactured on an existing corpus is *inert* and must
> not ship on faith.

## Bottom line

**Declared-manifest signals are the single highest-leverage new family.** Every member is a
verbatim transcription of something the author wrote down (package.json `scripts`/`exports`,
Makefile/CI targets, workspace globs, tsconfig `references`, `.env.example` keys, AGENTS.md
presence, config/schema anchors), so it carries **zero inference**, makes **zero semantic
claim**, and — decisively — the source file is **git-tracked**, so an edit moves HEAD or the
status-hash the freshness gate already watches. That is the categorical opposite of the
rejected raw-churn family, whose truth decayed on a wall-clock the gate is blind to.

The family closes the orientation axis sextant can most cleanly own and currently has nothing
for: **"how do I run / build / configure / start this"** — which agents hallucinate on every
unfamiliar repo. It slots into the **`— declared` tagging seam T1.1 just shipped** at
near-zero plumbing cost. The package.json `scripts` → Commands block is the single most
obvious next commit.

### The two discriminators (every ranking traces to these)

1. **The freshness gate is the primary discriminator, and it is binary.** A signal whose
   truth changes only when a git-tracked file changes (manifests, schema files, CODEOWNERS,
   co-change-on-new-commit) ages on exactly the HEAD+status-hash signals the gate watches →
   clean. A signal that decays on an unwatched wall-clock or a sliding commit window with
   HEAD frozen (raw churn, calendar-age, raw co-change counts) is structurally blind to the
   gate → killed or demoted.
2. **The hollow-verification test is the second gate.** Several high-benefit candidates die
   not on constraints but because their FAIL-pre/PASS-post proves *plumbing* not *benefit*,
   or the claimed fixture is empirically false on the actual corpus. Fixture-on-an-existing-
   corpus is the bright line between tier-1 and needs-fixture-first.

Two structural facts shape *where* a signal can live:
- **Slot discipline protects the 2200-char budget.** The clamp truncates the LAST section
  *silently* (returns the cut, doesn't reject), so every summary-slot signal needs an
  explicit per-section N-cap and high line-order placement, or a new low-appended block
  quietly shoves entry-points/recent-commits off the cliff (a drift-loud micro-violation).
  Doctor / MCP-explain slots escape this entirely (terminal-only / unclamped JSON).
- **Graph-resident data sextant already has, unsurfaced, is the cheapest win class.**
  resolution-by-kind (`imports.kind` already written), public-API outline
  (`graph.queryExports` already exists), cross-package fan-in (kind column + workspace map
  already persisted), the workspace map itself (built-then-discarded at `resolver.js:188`) —
  the extraction is done; only the surfacing is missing.

---

## Tier 1 — build-worthy (each has a manufacturable FAIL-pre/PASS-post fixture)

### Authoritative project commands — "how do I run/build/test this"

- **`package.json scripts` → Commands block · composite 4.85 · summary · xs.** Twin of the
  shipped `entriesFromPackageBin`: one `Object.values(pkg.scripts)` read on an object already
  parsed twice (`summary.js:53/:284`). Verbatim transcription, identical epistemics to the
  bin consumer. FAIL-pre is live on self-eval today — `sextant summary` emits zero
  `### Commands` while `pkg.scripts` holds 6 discarded keys. Freshness-clean (package.json is
  tracked, not in the status-hash exclusion filter).
- **Makefile targets → Commands block · composite 4.3 · summary · small.** For Go/Rust/C/Make
  repos (no package.json scripts) the Makefile IS the command authority — *complementary*
  coverage, not overlap. Mirrors the `entriesFromPyprojectScripts` hand-parser (try/catch +
  line-loop + allowlist, no dep). *Honest framing: there is NO `### Commands` block today —
  this introduces it.* Guard the `VAR:=value` → phantom-target case with the build/test/
  lint/run allowlist (or `(?!=)`). A new Makefile fixture perturbs no eval baseline (none
  exist in `fixtures/`, self-repo has none → byte-identical).

### Configuration & cold-start surface

- **`.env.example` / `.env.sample` required-env keys · composite 4.7 · summary · small.**
  Answers the literal cold-start blocker "what must be configured to run this." Keys-only
  regex (capture group stops at `=`) so a value/secret is structurally never read
  (`JWT_SECRET=supersekret` → surfaces `JWT_SECRET`, never the value). Should-fix: route the
  glob through `cfg.gitignoreFilter` so only tracked example files are read.
- **Config/settings module recognition · composite 4.4 · summary · small.** Lands the agent
  on the settings owner (not a consumer) for any config/env task. Sibling of the shipped
  manifest entry-point tier (same `###` section, fileSet intersection, `TEST_PATH_RE`
  exclusion, per-row source tag). *Two load-bearing fixes:* (1) Tier-B (`BaseSettings`/
  `SettingsConfigDict` witness tokens) persists a new derived fact → bump `SCANNER_VERSION`
  (ship A+B together so the bump is atomic); (2) keep the row to a file-identity tag
  (`config.py (py) — settings`), NOT "where X is configured" (semantic creep).

### Authoritative "start here" / data-model anchors

- **`package.json exports`/`main`/`module` → authoritative entry-points · composite 4.7 ·
  summary · small.** Fills the gap T1.1 opened for *libraries* (no `bin`): the `exports` map
  is the most authoritative "start here" and is invisible today — the heuristic falls back to
  index.* barrels the T1.1 comment itself calls "not entry points." Guardrails: collect only
  string leaves with a real source ext (reject `.d.ts`), never expand `*` wildcards,
  `main`/`module` strictly lower precedence. Fixture: `fixtures/ts-esm-node16/` (no `exports`
  today) — PASS-post = `api.ts` tagged `— declared` AND `index.ts` flips `(heuristic)` →
  `— declared`.
- **Canonical schema files (schema.prisma / *.graphql / *.proto / openapi / schema.sql) ·
  composite 4.4 · summary · small.** The correct first file for any "change the data model /
  API contract" task, yet absent from orientation today (not an entry point, low fan-in so
  not a hotspot). Pure fs/fast-glob existence + anchored-basename match — these exts aren't in
  `isIndexable`, so a separate fs pass is genuinely required, not redundant. Cap/collapse the
  `*.proto` glob (a gRPC repo has many); pin insertion ABOVE Recent-changes so the clamp can't
  eat it.
- **Migration directories (count + latest-N) · composite 4.2 · summary · small.** A large
  unreviewed migrations dir, or the latest migration filename, tells the agent where schema
  risk concentrates and where new changes belong. Lexical sort == chronological is a filesystem
  fact (timestamp/sequence prefix), not date parsing. Ship the 4 dedicated-dir variants
  (Alembic `alembic/versions`, Rails `db/migrate`, Prisma `prisma/migrations`, Sequelize/Knex
  `migrations/`) in tier-1; Django's scattered `*/migrations/*.py` is the false-positive-prone
  variant → guarded follow-up. Apply `TEST_PATH_RE`.

### Monorepo axis (sextant has nothing here)

- **Workspace package map · composite 4.7 · multiple · medium.** In a 40-package monorepo the
  LLM cannot tell which package it's editing or where a sibling lives, and hallucinates
  cross-boundary import paths. The literal "small honest map" the philosophy demands. The
  npm/yarn map ALREADY exists, mtime-invalidated, at `resolver.js:136-191` (fg-glob + readJson,
  zero inference) and is computed-then-discarded. *Correction: only npm/yarn is reuse;
  pnpm/lerna/cargo/go.work are net-new hand-parsers — ship npm+pnpm first.* New monorepo
  fixture required.
- **Cross-package dependency edges (inter-workspace fan-in) · composite 4.5 · multiple ·
  medium.** The highest-value monorepo question — "if I touch this shared package, what
  breaks" — which file-level fan-in misses because the count is spread across hundreds of
  files. *Load-bearing extraction fix: do NOT filter `WHERE kind='workspace'` — a cross-package
  import written as a relative path (`require('../../db/...')`, common nx/turborepo style)
  resolves to `kind:'relative'` and would be silently dropped, an under-report on a blast-radius
  claim. Map both endpoints to owning package via longest-prefix match; count cross-package iff
  `pkg(from) != pkg(to)` regardless of kind.* Depends on the workspace map.
- **tsconfig `references` build-order DAG · composite 4.6 · multiple · medium.** In a composite
  TS monorepo "which packages does the one I'm editing feed into" is the first orientation
  question, and the file-import graph answers it only indirectly (misses build-only edges).
  Pure `JSON.parse` + `path.resolve` — the same primitives `loadTsConfig` already uses; the
  reexports table/BFS is the edge-storage template. *Ship the structural graph table FIRST
  (`sextant_related`/explain traversal); defer/budget-cap any summary row.*

### Conventions & declared context

- **AGENTS.md / CLAUDE.md / .cursor presence-and-pointer · composite 4.6 · multiple · xs.**
  The author's hand-declared conventions are the most authoritative orientation artifact in a
  repo, and sextant ignores them. Pure `fs.existsSync` over a fixed allowlist (AGENTS.md,
  CLAUDE.md, .cursorrules, `.cursor/rules/*.mdc`, `.github/copilot-instructions.md`,
  GEMINI.md), mirroring `detectSignals`. *Emit the line INSIDE the `detectSignals` block (high
  line-order) — the 2200 clamp silently truncates, so a low-appended line can shove
  entry-points off the cliff.* `fixtures/python-eval` has no AGENTS.md → real FAIL-pre/PASS-post.

### Cheap surfacing of data already in the graph

- **Resolution-by-kind provenance breakdown · composite 4.4 · multiple · xs.** One `GROUP BY`
  on `imports.kind` (already written). Tells the agent "resolution depends on tsconfig paths
  for 40% of edges" and makes a silent resolution drop *diagnosable* — a tsconfig-paths
  breakage shows as "tsconfig: 0", not a vague % dip. *Correction: the kind value-set is larger
  than expected (Python `local`, `asset`); derive the fixture's asserted counts by running the
  resolver on `fixtures/ts-esm-node16/`, not by hand.*
- **Public API-surface outline (from exports already in graph.db) · composite 4.4 · summary ·
  small.** An agent seeing the public symbols of entry/hotspot files knows what each file offers
  without opening it. Cheaper than pitched: the fn already exists as `graph.queryExports`
  (`graph.js:428`) — just a call site in `writeSummaryMarkdown`. `test/summary.test.js` already
  seeds export rows → one-liner FAIL-pre/PASS-post. Filter the default/cjs-default row; silent
  on Swift (decls live in `swift_declarations`) — silence-on-unsupported is correct degrade
  behavior. N-cap names-only.
- **Logical/temporal co-change ("also changed with") lane · composite 4.3 · mcp-tool ·
  medium.** Answers "if I edit X, what else usually needs to change?" for files the **import
  graph cannot see** — independently reproduced on this repo: `summary.js↔watch.js` co-change
  8× with NO import edge either direction; `merge-results.js↔its test` 8× (the test-to-code
  edge idea-005 wants, which tests rarely import statically). Recovers hidden coupling AND test
  coverage in one signal. Reuses the `summary.js:194` git-log mechanism; `handleExplain` gains
  one `alsoChangedWith` field. **Freshness-clean** (co-change ages only when a new commit lands,
  moving HEAD — the discriminator vs rejected churn). *Non-negotiables: bump `SCHEMA_VERSION`
  (else it serves pre-checkout counts), cap mega-commit transaction size (this repo has
  38/29/21-file commits), and the fixture must pin a FROZEN commit range and assert
  relationship + `>=MIN_SUPPORT` + count==1-vs-absent, NOT exact magnitude.*

---

## Tier 2 — strong, second-order

- **CODEOWNERS declared review-routing map · `sextant_explain`.** Cleanest member of the
  ownership family (last-match-wins glob with the vendored `ignore` package, function-level
  lockable). Route to `sextant_explain` (per-file, unclamped JSON), NOT the summary — a
  multi-team map is unbounded and competes with hotspots for the 2200-char budget. Synthetic
  fixture required.
- **Git-derived recent-author / ownership (who-to-ask) + CODEOWNERS.** Opens the "who-to-ask"
  axis DESIGN_PHILOSOPHY names but sextant has no answer for. CODEOWNERS is the authoritative
  declared half; git-log author-mode the fallback. The hotspot lane must own its per-row git
  subprocess cost and degrade per-row; **never emit a contribution percentage** (implies a
  model).
- **Authorship concentration / bus-factor flag (single-author + high-fan-in).** Surfaces the
  dangerous quadrant no current signal captures. Manufacturable on self-corpus TODAY (125
  single-author vs 77 multi-author files). doctor-only (terminal, no char budget). Hard guard:
  the surfaced string stays descriptive ("1 author in history") and the count NEVER reaches
  `scoring.js`.
- **Live last-touched-by (per-file most-recent author).** Adds `%an` to the `summary.js:194`
  git-log. *Two verified extraction errors that are real edits: the boundary regex must become
  `/^(\d{9,})\|(.*)$/`, and the format string must be shell-quoted (`'%ct|%an'`) or `/bin/sh`
  treats `|` as a pipe.* Motivated by zero observed failures → tier2.
- **Public-surface authority boost (exported-via-manifest symbol outranks internal namesake).**
  Serves the "a public symbol outranks an internal one" refinement; +8% (== `PYTHON_PUBLIC_BOOST`)
  breaks a near-tie without `FAN_IN_SUPPRESSION` impact. Extraction is half-new (the `exports`
  map's subpath/wildcard shapes need a small source-back-mapping resolver). Wire the new
  fixture into a *running* harness (`ts-esm-node16/eval-dataset.json` is run by no gate today).
- **GraphQL SDL operation roots (type Query/Mutation/Subscription fields).** "What
  queries/mutations exist" from the contract, not by hunting resolvers. `.graphql/.gql` aren't
  indexable → standalone filesystem glob (a feature: qualifies for the stale-body whitelist).
  Per-section field cap. New fixture required.
- **ORM model anchor files (manifest-confirmed framework + canonical filename).** Two-key
  AND-gate (declared dependency + canonical filename) avoids false-positiving a plain
  `models.py`. *Load-bearing correction: key-2 reads `graph.allFilePaths` → this is GRAPH state,
  so it must go in the fresh body ONLY, never `buildStaleBody`* (a checkout deleting `models.py`
  must not still list it). The negative case (present, no django dep → absent) is the anti-guess
  guard.
- **README section-heading map ("where things are documented").** Complements entry-points
  (code start) with docs start. Neutral label ("Documented sections (README)") — a stale README
  listing sections for deleted code emits a true-fact-about-the-doc that reads as a
  false-fact-about-the-code. The code-fence-toggle guard is the no-inference linchpin → must be
  function-level unit-locked.
- **Doc-tree topology line in `sextant doctor`.** A supervisor sees instantly whether
  contributor/onboarding docs exist; missing CONTRIBUTING is a real who-to-ask gap. `existsSync`
  + one fast-glob, doctor-only. Fixture asserts SHAPE, not a hardcoded count that self-invalidates
  on any doc add.

---

## Tier 3 — opportunistic / thin

- **`files` allowlist + publish-scope tag (doctor).** Freshness-clean but low-leverage and
  provable only on a synthetic fixture; a diagnostic with no MRR/nDCG delta. The absent-`files`
  branch must go quiet ("publish boundary: undeclared") rather than reconstruct npm tarball
  semantics.
- **Author-debt markers (TODO/FIXME/HACK/XXX), counts only.** Survives every constraint but
  marginal and non-orientation; this repo's indexed source has 0 context-markers, python-eval 0,
  Vapor 8 incidental. Feeds a summary line not retrieval → no ranking FAIL-pre possible;
  synthetic-fixture + count-unit-test only. needs-fixture-first; do not over-invest.
- **Declared-but-unimported external dependency (doctor info row).** Only the NEGATIVE is
  manufacturable today (declared−imported == [] on self-eval, verified). The rendered row must
  be a neutral checkable fact ("N declared deps with no import statement"), explicitly NOT
  "candidate dead weight" (a dep can be a CLI tool, build plugin, type-only, or config-loaded).
- **ADR / decision-record enumeration.** Clears constraints but the claimed fixture is false as
  specified (every record opens with `---` frontmatter, so "read line 1" emits `---`). The
  corrected extraction (parse `title:` or skip to first `# `) is still inference-free but must be
  re-grounded first. Low yield — most repos have no `docs/adr/`.

---

## Killed (the kills are as useful as the picks)

- **Raw-count co-change (recomputed at scan).** The stability claim is NOT reproducible — ran
  the proposal's own drop-most-recent-20%-of-commits invariant across four extraction variants:
  top-3 raw-count pairs are NOT rank-identical in any variant. Raw co-change IS a fast-moving
  tally — churn's failure mode over pairs. The MIN_SUPPORT + frozen-range MCP lane (tier-1) is
  the surviving sibling.
- **Git temporal coupling as pitched (`scoring.js↔scoring-constants.js` fixture).** The fixture
  is false: `scoring.js:6` literally `require('./scoring-constants')` — it IS an import edge that
  `sextant_related` already returns, so FAIL-pre is wrong (it PASSES pre-change, the
  hollow-verification trap). The signal is sound; only this candidate's fixture is dead. Use an
  empirically-located no-import co-change pair (`summary.js↔watch.js`).
- **HEAD-relative code stability/age (ordinal).** Defeats the freshness objection (ordinal ≠
  wall-clock) but not the *second* churn objection: it cannot separate "canonical commodity"
  from "abandoned/dead" — both tag `stable`. Annotation-only → no eval case moves; benefit is
  asserted-from-mechanism. Per kill-on-no-fixture: kill absent a real dogfooded miss.
- **Graph-centrality (PageRank) replacing raw fan-in count.** Survives constraints but the
  benefit is unverified — visible ONLY in hotspot-list ordering, an assertion type no eval
  measures (in retrieval, fan-in is a suppressed secondary tiebreaker behind exact-symbol +40%
  / def-site +25%). A fragile ranking-order assertion by the project's own standard. Demand a
  committed FAIL-pre/PASS-post on pinned Vapor FIRST.
- **Bundler/transpiler alias-config (on the "depresses resolution %" premise).** Empirically
  false: a bare aliased specifier (`@components/Button`) resolves to `kind:external`
  (`resolver.js:535`) and `computeResolutionStats` counts only `is_external=0`, so unhonored
  aliases NEVER depress local-resolution %. The presence-note ("you have a vite alias config
  sextant cannot honor") is philosophically sound and tier2-worthy once re-grounded with a
  fixture asserting kind+count transitions — never "resolution % rises."

---

## How this pairs with the 006 roadmap

1. **Direct extension of shipped T1.1.** The entire declared-manifest tier-1 cluster
   (scripts/exports/Makefile/CI Commands block, workspace map, `.env.example`, config-module,
   schema-files, AGENTS.md) reuses the exact `normalizeManifestTarget`/`pushDeclared`/
   `— declared`-tag seam T1.1 built — these are the natural **T1.4/T1.5 continuation**, lowest
   risk because they are bin-twins of code already in `main`. **package.json scripts is the
   single most obvious next commit.**
2. **Supersedes idea-005 and extends idea-001 via co-change.** The "also changed with" lane
   delivers the test-to-code edge idea-005 wanted AND a behavioral blast-radius lane idea-001's
   transitive-import approach cannot represent (config↔code, doc↔code, sibling-no-import) — in
   ONE signal, anchored to `scanned_head` so it inherits the freshness model for free. Fold
   idea-005 into this lane rather than building a separate test-to-code mapper.
3. **Feeds T2.1 symbol-blast-radius with package granularity.** Cross-package fan-in is the
   monorepo rollup of the same blast-radius question T2.1 attacks at symbol granularity — they
   are complementary altitudes (symbol → file → package) and should share the longest-prefix
   package-attribution helper the workspace map exposes.
4. **The telemetry denominator (T1.3) gates the eval-invisible signals.** Most summary/doctor
   signals here move no MRR/nDCG number (they're orientation, not ranking), so the only honest
   proof they help is the empty-injection / orientation-usefulness telemetry T1.3 built —
   exactly why 006 says "build the denominator first."

## Recommended sequencing

1. **package.json `scripts` Commands block (xs)** + **AGENTS.md presence (xs)** +
   **`.env.example` keys (small)** — the T1.1 continuation; real fixtures in hand, byte-identical
   self-eval, lowest risk.
2. **Makefile Commands block (small)** + **schema-file anchors (small)** + **resolution-by-kind
   (xs)** + **public-API outline (small)** — independent summary/doctor surfacing of facts (or
   already-graph-resident data).
3. **Co-change "also changed with" lane (medium)** — the idea-005-superseding blast-radius work;
   carries a `SCHEMA_VERSION` bump, so batch deliberately.
4. **Workspace map → cross-package fan-in (medium ×2)** — the monorepo pairing for T2.1; needs a
   new monorepo fixture.
5. **Config-module recognition (small, `SCANNER_VERSION` bump)** + **tsconfig references DAG
   (medium)** — schema/version-bumping items, batched.
6. **Tier-2 ownership family** as a deliberate new commitment (CODEOWNERS → `sextant_explain`
   first), with the hard guard that no social count ever reaches `scoring.js`.

**Honest uncertainty.** Most of these signals are orientation, not ranking — they move no
self-eval/Vapor scoreboard number by construction. Their proof is a presence/absence fixture
plus the T1.3 telemetry denominator, never a graphLiftNDCG claim. Treat every one as
kill-on-no-fixture: if the FAIL-pre case can't be built on an existing corpus (self-eval JS /
Vapor Swift / python-eval / a new dedicated fixture), it is inert and should not ship on faith.
