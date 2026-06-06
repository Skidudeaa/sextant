---
title: Next-level yield synthesis — prove the benefit first, then extend the orientation family
status: synthesized
priority: high
feasibility: high
source: dynamic workflow (24 agents — 4 grounding · 5 lens generators · dedup/merge · 14 adversarial verifiers each reproducing the 006/007/008 kill-gate against live code)
synthesized: 2026-06-05
method: trajectory grounding → 5-lens candidate generation (shipped-seam · agent-pain · supervisor-adoption · compounding-ceiling · riskiest-assumption) → dedup/merge → per-candidate independent skeptic reproducing the kill-gate vs live code → composite ranking
companion: docs/ideas/006-next-targets-roadmap.md, docs/ideas/007-signal-expansion-menu.md, docs/ideas/008-iteration-review-findings.md
---

# Next-Level Yield Synthesis

> Answer to *"where are we headed, and what next-level yield do we absolutely need to unleash?"*
> 5 lenses generated yield candidates; each survivor was then handed to an independent skeptic
> that **reproduced** the blueprints' own kill-gate (grounding check, hard-constraint gate,
> kill-on-no-fixture/inert test, hollow-verification test) against the **live code** — not a
> reinterpretation, a reproduction. 14 candidates ranked by composite; the load-bearing
> **corrections** are preserved inline because they are the most valuable output.
>
> Every flip-the-backlog correction in this doc was re-verified by hand against the source after
> the workflow (file:line cited). Nothing here ships on workflow-faith.

## Where we're headed (the through-line)

The last six weeks are **one campaign with one thesis**, not a feature grab-bag:

> **Every byte injected into a Claude Code session must be a fact, or be visibly absent — never confidently stale.**

The arc moved from *"rank retrieval better"* (early-May resolver / NL-recall / def-over-barrel
work) to *"make the production hook path provably honest"* — the lane agents hit on **every**
prompt. T1.2 closed the biggest hole (the freshness gate was wired only into the static-summary
branch; the busiest lane leaked stale `fan-in: N` unchecked). T1.3 built the telemetry
denominator **first, on purpose** (the A4 NL-recall gap shipped silent for months for lack of a
metric). T1.4 then extended honesty from **structure** → **declared-manifest facts** ("how do I
run / build / configure this"), the orientation axis sextant can own with **zero inference**.

Two reusable **seams** now exist that the whole backlog plugs into cheaply:
1. The `— declared` manifest-tag seam in `lib/summary.js` (`pushDeclared` + `### Commands` /
   `### Required env` blocks).
2. The T1.3 telemetry denominator.

The backlog is now about **extending those seams**, not inventing mechanism — with exactly two
deliberate structural investments behind the cheap surfacings (**symbol-level** and **co-change**
blast radius) forming a symbol→file→package **blast-radius trilogy**.

## Bottom line

The codebase reality check found the load-bearing fact behind everything else:

> **Nothing in sextant observes whether an injected path is ever opened or edited.**

Every metric is an **offline fixture proxy** (MRR / nDCG / graphLiftNDCG / empty-injection-rate).
`STRATEGY.md` admits it: graphLiftNDCG is **+0.008 (neutral) on the home corpus, +0.086 on one
external fixture, zero real-session measurement anywhere**. Sextant can prove **no-regression**;
it has **never proven benefit**. That is the hollow-verification trap, structural.

So **the single most important target is the benefit-proof substrate** — the *denominator for the
entire eval-invisible orientation family* (Makefile commands, schema anchors, public-API outline,
co-change, blast-radius), all of which "move no scoreboard number by construction." It flips
kill-on-no-fixture from a **brake** into an **accelerator**. **Four of five lenses independently
converged on it** — the strongest convergence signal in the set.

---

## The ranking

Composite = benefit×3 + leverage×2 + feasibility×2 + evidence×2 + philosophy×2 (max 55).
`novelty`: **new** = not in 006/007/008 · **re-ranked** = in the menu, priority changed by what
shipped since.

| # | Composite | Move | Effort | Novelty | Class |
|---|-----------|------|--------|---------|-------|
| 1 | **48** | Outcome-telemetry substrate (injected-path open-rate) | M | new | maintainer→unlocks all |
| 2 | 45 | Schema/contract file anchors | S | re-ranked | agent-visible |
| 3 | 45 | Co-change "also changed with" lane | M | re-ranked | agent-visible |
| 4 | 43 | Resolution-by-kind provenance breakdown | S | re-ranked | supervisor-visible |
| 5 | 43 | Loud staleness on the statusline | S | re-ranked | supervisor-visible |
| 6 | 42 | Public-API outline (entry/hotspot files) | XS | re-ranked | agent-visible |
| 7 | 42 | Makefile → Commands block | S | re-ranked | agent-visible |
| 8 | 42 | swift_relations MCP conformance consumer | S | re-ranked | agent-visible |
| 9 | 42 | Ownership "who-to-ask" lane | S | new | supervisor-visible |
| 10 | 41 | Extend freshness gate to CLI/MCP `retrieve()` | S–M | re-ranked | agent-visible |
| 11 | 41 | Symbol-level blast radius | L | re-ranked | agent-visible |
| 12 | 36 | Session-trajectory harness (offline JSONL) | M | re-ranked | unproven |
| 13 | 36 | Monorepo package-context line | S | re-ranked | agent-visible |
| 14 | 30 | Live multi-turn freshness repro | M | **killed** | already exists |

---

## Tier 1 — the unlock + the cheap provable wins

### 1. Outcome-telemetry substrate · composite 48 · **THE UNLOCK**
*Lenses converged: compounding-ceiling, agent-pain, supervisor-adoption, shipped-seam (4/5).*

A **PostToolUse hook** matches `tool_input.file_path` against the per-session last-injected set,
emitting `retrieval.path_hit` / `retrieval.path_miss` to the JSONL sink T1.3 already built;
`sextant telemetry` reports an injected-path open-rate. It is the **only** honest proof surface
for the entire eval-invisible 006/007 orientation family — today every one of those signals ships
on faith.

**Verified corrections (fold in from day one, or the framing is dishonest):**
- An uncontrolled open-rate is a **correlation with no baseline** — the agent often opens the
  canonical file regardless of injection. It needs a **per-turn injection-OFF holdback arm** to be
  a benefit number. Ship v1 as *"the loop is wired,"* not *"benefit proven."*
- A single aggregate rate **cannot attribute** the open to Makefile-vs-schema-vs-blast-radius.
  **Record `{path, source}`, not bare relpaths** (source = the `graphSignal`/label), or
  per-signal measurability collapses to per-loop measurability.

**Proof.** Unit-drive the PostToolUse hook with a fixture session: assert a `path_hit` is recorded
when a Read targets an injected path tagged with its source, and `path_miss` otherwise.
**Effort.** Medium. **Depends on.** T1.3 JSONL sink (shipped).

### 2. Schema / contract file anchors · composite 45 · agent-visible
For any "change the data model / edit the API contract" task the correct first file is
`schema.prisma` / `*.graphql` / `*.proto` / `openapi.yaml` / `schema.sql` — invisible in
orientation today (not an entry point; low fan-in keeps them out of hotspots). A
`### Schema/Contracts` anchor block stops the agent spelunking resolvers/models.

**Verified corrections.** These exts are **not** in `isIndexable`, so this is a genuinely **new
fast-glob pass**, not a pure call-site twin — the most expensive of the "cheap" tier. Migration-dir
anchors (007:119-125) are a **separate readdir+lexical-sort op**, *not* "one pass, two signals"
— pitch them as adjacent follow-up. Placement **above Recent-changes** is non-negotiable on large
multi-section repos (the 2200 clamp truncates the last section silently; self-eval is only
1270/2200 today, so the risk is latent, not live).

### 3. Co-change "also changed with" lane · composite 45 · agent-visible · **new fact-class**
*Lens: compounding-ceiling.*

The import graph captures **static** coupling (A imports B); it is blind to **behavioral** coupling
(a route + its test, a schema + its migration, a config + its cross-language consumer that always
move together with no import edge). Surfacing "files that historically change alongside this one" in
`sextant_explain` gives the real blast radius — the thing that most often bites. This is a whole
**new fact-class** no import-graph polish can reach.

**Verified correction (flips the existing todos.md item).** `getRecentGitFiles` is called at
**render-time** (`lib/summary.js:380`, `lib/cli.js:237`), reading `git log` fresh every invocation,
**never persisting to graph.db** (confirmed; the function is git/fs-only per the comment at
`summary.js:618`). A co-change lane built the same way (compute at `sextant_explain` call-time) is
**freshness-clean WITHOUT any SCHEMA_VERSION bump** — there is no cached count to go stale post-
checkout. The bump is required **only if** you *materialize* pairs into graph.db for the <50ms hook
path. **Decide storage first** (live-compute = no bump, fits the render-time pattern; materialized =
bump, enables hook-fast-path). The hard half is **not** recovering pairs (easy) — it is the
`MIN_SUPPORT` threshold + mega-commit transaction cap + frozen-range fixture (assert relationship +
ordering, **never magnitude** — the agent measured 6 co-changes where 007 claimed 8; the drift is
real). That discipline is the entire reason this survives where its killed raw-count sibling did not.

### 4. Resolution-by-kind provenance breakdown · composite 43 · supervisor-visible
A sub-90% resolution dip (which disables the *entire* graph-boost lane) shows as one vague
percentage today. Breaking it down by import kind (`relative 100% · tsconfig 0% · workspace 100%`)
names *which mechanism* broke — a tsconfig-paths breakage reads as "tsconfig: 0" — and tells the
agent its map is untrustworthy for *exactly* the aliased/workspace edges that are missing.

**Verified corrections.** `computeResolutionStats` returns only
`localTotal/localResolved/resolutionPct/topMisses` — **no per-kind breakdown**; this is a new
`GROUP BY`, not a free surfacing. It is **NOT lockable on any existing fixture**: every committed
fixture is single-kind / 100% resolution, so none can produce the "tsconfig: 0" diagnostic the
feature is *about*. A real FAIL-pre/PASS-post needs a **new fixture with an unhonored tsconfig-paths
import** (007:285 already prescribes it). Realizable kind set is
`relative|local|tsconfig|workspace|root|unresolved`; `asset`/`external` are `is_external=1` and can
never appear under the `is_external=0` filter — drop them from any asserted set.

### 5. Loud staleness on the statusline · composite 43 · supervisor-visible
Kills the contradictory **"green ◆ 100% while Claude's injection is blacked out"** state on the one
surface the human sees — the inverse of the freshness gate's whole purpose. Drive it from the same
`contentChanged` provenance the hook stamps so statusline and injection agree by construction.

**Verified corrections.** Gating *strictly* on `contentChanged` (the required cry-wolf guard — never
version/schema bumps) only kills the **content-stale slice** of the contradiction; version-bump /
`check_failed` blackouts (`freshness.blackout_turn`, `lib/cli.js:151`) still render green. That is
the honest framing — content-stale is the dangerous case (files actually moved), so the slice is
worth it. The sentinel must be written at **both** injection sites (the retrieval hook **and** the
static-summary `applyFreshnessGate` path) — the most common blackout is the SessionStart static
summary, and wiring only the refresh hook leaves it green.

### 6. Public-API outline · composite 42 · agent-visible · cheapest
Surfacing the public symbols of each entry-point/hotspot file ("`exports: createSummary, …`") lets
the agent know what a file offers **before opening it**. Extraction is 100% paid for —
`graph.queryExports` exists at `lib/graph.js:428` (exported :983) — so it is one call site in
`writeSummaryMarkdown`.

**Verified corrections.** The home-corpus FAIL-pre **cannot** anchor on the entry-point row: the
sole declared entry point `bin/intel.js` has **zero exports** (CLI dispatcher, no `module.exports` —
confirmed). Anchor it on the **hotspot block** (`lib/graph.js`/`lib/cli.js`/`lib/intel.js` all have
export rows). Honest status: its only stated benefit-proof is the **unbuilt** outcome-telemetry
substrate (#1) — so it is *cheapest-plumbing-only-payoff-deferred*, not *cheapest-fully-paid-for*.

### 7. Makefile → Commands block · composite 42 · agent-visible
Closes "how do I run/build/test this" for Go/Rust/C/Make repos where the Makefile *is* the command
authority. A second producer feeding the already-shipped `### Commands` renderer.

**Verified corrections.** **Not purely complementary** — polyglot repos have *both* a Makefile and
`package.json scripts`, and the renderer emits a single `### Commands` heading. Specify the
**dual-source merge contract** (dedupe-by-name / source-prefix `make build` vs `npm test` / N-cap
contention against the 8-command max) — that, not the phantom-target trap, is the real design
decision. Prefer a `build|test|lint|run` allowlist over a phantom-target blocklist (real Makefile
grammar has pattern rules `%.o:`, double-colon, multi-target lines, `.PHONY:`, target-specific vars).

---

## Tier 2 — the blast-radius trilogy (de-risk before you commit days)

### 8. swift_relations MCP conformance consumer · composite 42 · the cheap pathfinder
Sextant extracts, persists, and triple-indexes Swift `extends`/`conforms_to` edges on **every**
scan and **zero production code reads them** (`findRelationsByTarget`, `lib/graph.js:908`/:1009 —
confirmed: all callers are in `test/graph-swift.test.js`). Wiring it into a deliberate MCP surface
answers "what implements Middleware / who extends Application." **Strategic value:** this is the
**cheap pathfinder that validates the relation-altitude pattern BEFORE** the heavy symbol-level
schema bump (#11). If it shows no benefit, that is a **kill signal for the expensive trilogy** —
saving days. Consume what is stored before extracting more.

**Verified corrections.** Not "empty results pre" — the text path already returns 49 Middleware-
named files. The real win is the **structured/authoritative** answer (each edge labeled
`conforms_to`/`extends`, tagged direct/heuristic, keyed by the conforming *type*) **+ recall of
non-name-matching conformers** (e.g. `Authenticator.swift`, a real direct conformer the text path
only surfaces incidentally). graphLiftNDCG is the **wrong** metric (the MCP tool isn't eval-scored)
— prove via an **MCP-handler unit test** asserting the kind+confidence conformer set (FAIL-pre: tool
absent). `sextant_related` is file-keyed (`neighbors()`), so a symbol-keyed branch / new
`sextant_relations` tool is the actual cost center → small-to-medium, not "only call sites."

### 11. Symbol-level blast radius · composite 41 · the heavy structural investment
"This export is imported **by name** in 3 files; the module by 9." File-level fan-in overstates
blast radius for a barrel/util and understates it for a hot symbol in a low-fan-in file. The one
heavy investment that changes *what kind of question* sextant answers. **Sequence it after #8.**

**Verified correction (flips the existing T2.1 item).** The JS side is **not** parse-then-discard:
the preferred path `lib/extractors/js_ast_imports.js` reads **only** `node.source.value` and **never
touches `node.specifiers`** (confirmed at the `ImportDeclaration` branch) — the named bindings are
not parsed-then-discarded, they are **never parsed at all** and must be **added** to the Babel walk.
Only the **Python** half is genuinely parse-then-discard (`python_ast.py:237-244` captures
name+asname; `python.js:normalizeImports` folds it to `{specifier,kind}`). So the JS work is larger
than "thread it through" — reinforcing the **large** effort and the dependency on #8 as pathfinder.
Gate acceptance on a **symbol-coverage health metric** (fraction of import edges with concrete
symbol names) in `doctor`, and make the `*`-namespace fallback **loud**, so file-level fallback
degrades visibly. "Sharpens def-vs-consumer scoring" is an unproven hypothesis — not a shipped
benefit. SCHEMA_VERSION bump → batch deliberately.

---

## Tier 3 — honesty completeness & new axes

### 10. Extend the freshness gate to CLI/MCP `retrieve()` · composite 41
`CLAUDE.md` claims freshness gates "every injection point," but **`lib/retrieve.js` and MCP
`sextant_search` have zero freshness/`contentStale` references** (confirmed). The MCP path is the
**deliberate high-trust surface** — the agent calling `sextant_search` to orient is the one most
likely to act on stale `fan-in: N` after a checkout. Closes the last asymmetry in the honesty thesis.

**Verified correction.** Not a flag-reuse job — `format-retrieval.js`'s `textOnly` operates on the
hook's **markdown**; `retrieve()` returns a **structured JSON object** and MCP emits its own compact
JSON. This needs **new suppression logic on the JSON shape in two places** (an API-shape decision:
drop fields vs emit `null` + a stale flag — callers of `sextant retrieve --json` may depend on it).
Reclassify **small → small-to-medium**. Reusable parts are `freshness.checkFreshness`/`contentChanged`
+ the hook test harness — not `textOnly`.

### 9. Ownership "who-to-ask" lane · composite 42 · new axis
The supervisor's recurring question — "who do I ask about this" — has zero answer today. CODEOWNERS
(verbatim, git-tracked → freshness-clean) + git-recency authorship fallback in `sextant_explain`.
A distribution hook for team leads.

**Verified correction.** `DESIGN_PHILOSOPHY` does **not** pre-bless this axis (zero hits for
who/ask/owner/team; Principle 1 = entry points / hotspots / health / recent change). This is a
**proposed new axis** that must earn its place against anti-goals minimalism — lead with the
compounding-with-blast-radius + distribution arguments, not a false mandate. git-recency is an
ownership **proxy**: the label must read **`recent-author`, never `owner`** everywhere (collapsing
them is itself a degrade-don't-guess violation). CODEOWNERS-vs-recent-author is the whole honesty
story.

---

## Killed / downgraded (the kills are as useful as the picks)

- **Live multi-turn freshness repro (composite 30 — KILLED, already exists).** The harness this
  proposed to build **already exists** at `test/hook-refresh-freshness.test.js` sections (iv)/(v)
  (added in `674a0cb` with the leak fixes; named as the lock in 008): it spawns the hook via
  `spawnSync`+stdin JSON, simulates the between-turn git change, and asserts the STALE marker
  survives same-session dedupe (verified present at lines 398-452). The **genuinely uncovered**
  holes are different: (a) a **stale→fresh transition** (no test exercises re-scan clearing the
  marker mid-session), and (b) the **static-summary lane's** multi-turn freshness (only the
  retrieval lane is locked). Scope future work to those two; the retrieval-lane dedupe is done.

- **Session-trajectory harness (composite 36 — DOWNGRADED, headline metric degenerate).** The
  pitched headline — hallucinated-path rate — is **~0 in real sessions** (across 101 Reads in the
  dogfooded transcripts, zero targeted an absent path; the agent Globs/LS before Reading). The
  instrument reads 0.000 before *and* after sextant — structurally blind, the same trap as issue #2.
  **Reframe around orientation-latency / first-touch precision** (did the agent open the injected
  file *first* vs after N exploratory Reads — a populated distribution); keep hallucinated-path as a
  **tripwire** (alert if it ever exceeds 0), not the benefit number. Complements #1 (live = in-field,
  offline replay = before-merge).

- **Monorepo "you are in package X" (composite 36 — DOWNGRADED, partly infeasible).** sextant's root
  is `process.cwd()`/`--root` (the monorepo root where `.planning/intel/` lives); there is **no
  per-invocation sub-package scoping**, so it **cannot** know "which package am I in" and cannot
  re-scope the manifest signals. The feasible feature is a root-level **child enumeration**
  ("`Workspace: N packages (a, b, …)`") — real orientation, smaller claim — which is already 007's
  workspace-map item, not net-new. Only `package.json workspaces` (npm/yarn) is parsed; pnpm needs a
  net-new YAML parser.

**Hard constraints held throughout:** no candidate proposes embeddings / vector search / LLM-in-
pipeline / semantic-LSP claims / compiler-backed Swift / summaries >2200 chars. Every survivor adds
a structural fact producible without inference, or an honest withholding.

---

## Recommended sequencing

0. **Outcome-telemetry substrate (#1)** — `{path, source}` tagging + a per-turn holdback arm. *The
   unlock. Do this first, or everything below ships on faith.*
1. **Cheap manifest-seam continuation** — schema anchors (#2), Makefile (#7), public-API (#6),
   resolution-by-kind (#4) — now *provable* via #1.
2. **Honesty completeness** — extend the gate to CLI/MCP `retrieve()` (#10) + loud statusline (#5).
3. **Co-change lane (#3)** — decide live-compute (no bump) vs materialized first; the new fact-class.
4. **swift_relations consumer (#8)** as cheap pathfinder → **only if it pays off** → **symbol-level
   blast radius (#11)** (large, schema bump, batch).
5. **Ownership lane (#9)** as a deliberate new-axis commitment (CODEOWNERS first; `recent-author`
   label discipline).

## Honest uncertainty

The deepest one is unchanged and is exactly why #1 leads: **sextant's core benefit has never been
measured on real agent behavior.** The scoreboard is self-referential (neutral on the home corpus,
positive on one external fixture). Until the outcome substrate exists, every orientation signal in
Tiers 1-3 is a no-regression claim, not a benefit claim. Treat each as **kill-on-no-fixture**: if
the FAIL-pre case can't be manufactured on an existing corpus (or a feasible new one), it is inert
and must not ship on faith.
