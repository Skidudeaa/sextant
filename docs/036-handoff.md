# 036 — Session handoff: docs/035 frontier research, sequencing steps 0–7 complete

Date: 2026-07-27. Branch `main` @ `fcda0aa` — **committed AND pushed**, tree clean.
19 commits since `8ec9f3d`.

Canonical doc: **`docs/035-frontiers.md`**. Read it before continuing; this handoff is
the map, that doc is the record. Every sequencing step is now struck through with its
verdict inline, including the ones that were *refuted while being executed*.

## What this session did

Ran a 19-agent research pass (`docs/035`), then executed its full recommended
sequencing. Method throughout: **reproduce the FAIL-pre by DRIVING it before changing
anything**, then mutation-check the test that locks the fix.

| step | outcome |
|---|---|
| 0 | `benefitDeltaGate` on all three deltas; `coherence:false`; 4 stale eval sites; 2 CLAUDE.md overclaims |
| 1 | Four honesty defects: non-git permanent blackout, `.env` in the zoekt corpus, cross-repo index poisoning, mid-token clamp |
| 2 | `retrieval.turn_outcome` at all four exits; `surfacedBySource` denominator; `sid` contamination; pooling dominance guard |
| 3 | **Allocation question adjudicated** — plus the follow-up split that saved the best section from eviction |
| 4 | Status fingerprint degrades instead of nulling; nested `.planning/` excluded; coherence gate yields for `workflow-subagent` |
| 5 | NL→export-token bridge (Layer 5) |
| 6 | MCP pull channel instrumented; **nothing deleted** — two deletion claims refuted |
| 7 | Batch extraction wired: **20.67s → 4.09s (5.05×)**, graph byte-identical |
| + | **zoekt disk-fill closed** — incident found still live; 22 GiB reclaimed, three gaps fixed |

Final gates: unit **1355/1355**, integration green, self-eval **21/21 byte-identical**
(MRR 0.904 / nDCG 0.909 / lift +0.015), hook eval 21/21, python fixture 8/8,
Vapor external PASS both paths.

## The plan was wrong in five places, and that was the most valuable output

1. **`entry_points` was NOT the eviction candidate.** Its 2.0% aggregate averaged
   `declared` at **21.1%** (the highest-earning section shipped) with `heuristic` at
   **0.1%** (n=749, ~113× below the null). Wholesale eviction — the literal step-3
   recommendation — would have deleted the best rows. Shipped the split instead:
   filename guesses are no longer rendered; manifest `bin` and Swift `@main` stay.
2. **`reexports` is 348 rows across 4 repos**, not "19 rows, one repo". The doc's
   figure was somaNotes alone. KEEP.
3. **`swift_relations` is 128 rows across 3 repos**, not 92. Zero production readers
   confirmed, extraction confirmed separable — but deletion still rejected, because
   `docs/ideas/009 #8` rates *consuming* it as the cheap pathfinder for the
   symbol-level blast-radius trilogy.
4. **`source` on `path_miss` is inert.** A miss is by construction an open of a file we
   did NOT surface (`classifyOpen` returns `source:null`), so the field could only ever
   be null. The denominator had to come from the injection side: `surfacedBySource`.
5. **Step 7 was S, not M.** `AST_CACHE_MAX=100` does not force a phase split of
   `indexOneFileUnlocked`; windowing at ≤ the cache bound suffices.

## ⚠ READ FIRST — the zoekt disk-fill incident was STILL LIVE

Found while checking global hook wiring at the very end of the session, and it is the most
operationally urgent thing here.

**`/root/.planning` held 22 GiB**, and `zoekt-webserver` **pid 235807 had been alive since
2026-07-18** serving it on port 6079. The daemon was started **2026-07-19 — nine days AFTER**
the 2026-07-10 guards that were supposed to make this impossible. Cleaned on this machine:
daemon killed, directory removed, **37G → 59G free** (`graph.db`, `telemetry.jsonl`,
`history.json` backed up first).

### Why the July guards did not hold — three gaps, closed in `fcda0aa`

1. **`checkIndexSizeCap` is cleanup, not prevention.** It runs AFTER `zoekt-index` writes its
   shards, and only on a BUILD — so an index that grew under older code is served forever,
   because nothing re-examines an index this code did not create. `ensureWebserver` now
   re-checks the cap **before spawning**.
2. **Nothing consulted actual free space.** The caps are per-repo, so 20 repos at the 2 GiB cap
   is 40 GiB of fully "compliant" growth, and the corpus pre-check was **non-git only** — a
   large git repo had no pre-check at all. New `zoekt-scope.checkDiskHeadroom` refuses when free
   space is under a **5 GiB floor** (`zoektMinFreeBytes`, `0` opts out) or when this build's own
   estimated corpus would breach it. Wired on **both** paths, before the indexer runs.
3. **`mcp/server.js` adopted `process.cwd()` with no root guard — this was the door.** CLAUDE.md
   justifies the strict marker requirement for hooks and the watcher *precisely because they
   adopt cwd without the user naming it*; MCP does the same and was exempt. An MCP session with
   `cwd=$HOME` reached `search()` → `ensureWebserver()`. `ensureInit` now calls
   `checkRoot(cwd, {requireMarker:true})` before `intel.init`.

Locked by `test/zoekt-disk-guard.test.js` (10 cases, mutation-checked). The wiring assertions
check **order**, not just presence: the floor must sit after the corpus estimate and before the
indexer, and the MCP guard before `intel.init` creates any state.

### The code fix does NOT clean existing debris — check every machine

```bash
du -sh ~/.planning 2>/dev/null                  # should be absent
ps aux | grep zoekt-webserver | grep -v grep    # any -index outside a project?
```

If either shows something: `kill` the pid, `rm -rf` the directory. Nothing legitimate has `$HOME`
as a root.

### Machine state changed outside git (redo on other machines)

- `/root/.planning` removed, pid 235807 killed — **22 GiB reclaimed**
- `~/.claude/settings.json` deduped: `sextant hook sessionstart` and `hook refresh` were each
  registered **twice** (one matcher-less, one `*`), so both fired twice per event. Backup at
  `scratchpad/settings.json.bak`. Global hook wiring is safe now (the root guard hard-refuses
  `$HOME`) but per-repo `.claude/settings.json` remains the intended shape.
- All 11 fleet watchers restarted onto current code after the SCHEMA_VERSION 3→4 bump.
- Holdback enabled at 50% on a 6th repo (`open-interpreter-fork`); source of truth is
  `~/.claude/sextant-fleet-roots`.

## Landmines for whoever picks this up

- **`recordScanState` without a real rescan creates a FALSE FRESH.** I hit this while
  probing step 4: it made a repo assert fresh against a stale graph. Fixed by running a
  real scan. Never use it to "clear" staleness.
- **A naive `git status --porcelain` probe undercounts dirty bytes ~200×** because it
  reports untracked DIRECTORIES as one entry. Use `freshness.getCurrentStatusPaths` and
  expand. This is why the step-4 numbers looked wrong on first measurement.
- **Your shell inherits `SEXTANT_HOLDBACK_PCT=50`** from this repo's `.claude/settings.json`.
  Any bash probe of another repo's holdback config is therefore invalid unless you
  `env -u` it. `.claude/settings.json` env is applied by Claude Code, not by your shell.
- **The eval dataset must stay OUTSIDE the corpus.** It now lives at
  `fixtures/python-eval-dataset.json`. It used to be inside `fixtures/python-eval/`,
  where its own case notes were indexed and competed with the source under test — a long
  note repeating "flag" pushed the dataset into the top-3 for query `flag` and broke
  `py-flag-001`. Keep case notes short; the rationale belongs in docs/tests.
- **`git add` aborts the ENTIRE add on the first bad pathspec.** `98997cf` is a
  rename-only commit carrying a message describing the whole change; `88538a1` holds the
  actual content. Squash the pair if you care.
- **No watcher restart is needed for `e64b4af`** — the change is inside `scan()`, not the
  watcher's `indexOneFileUnlocked` path, and no schema or summary shape moved. (All 11
  fleet watchers were already restarted earlier this session after the SCHEMA_VERSION 3→4
  bump, which DID require it.)

## State of the instruments

Everything shipped in steps 2–6 is an instrument that now needs **elapsed time**, not
more code:

- **`retrieval.turn_outcome`** — the funnel exists but has only a handful of real turns.
  Per-source rates read 0.0% because the only scored turns so far are CLI probes.
- **`mcp.invoked`** — needs 30 days before any defer/cut decision. Baseline to beat:
  **1 `sextant_search` call in ~600 transcripts / 28,800 tool_use records.**
- **Holdback A/B** — enabled at 50% on **6 repos** (sextant, jan25, somaNotes, glasshud,
  defGen2, open-interpreter-fork; source of truth `~/.claude/sextant-fleet-roots`). The
  pooled gate still reads `CONFOUNDED` (TVD 0.79 → 0.625 within the hour). **That is a
  TIME problem, not a config problem**: armed turns are historical, holdback turns only
  exist where the flag has had time to fire. Clearing 0.5 is necessary but NOT sufficient
  — at the observed fleet turn hit-rate a 2× lift still needs ~712 turns/arm.

Check in ~2 weeks:

```bash
cd /root/sextant
node bin/intel.js telemetry --roots-file ~/.claude/sextant-fleet-roots
node bin/intel.js eval-trajectory        # per-section rates, with real n
```

## Decided — do NOT re-litigate

- **Phases D–F: KEEP DORMANT.** Maintainer's call, 2026-07-27. Code stays, flags stay
  off. docs/034's "code left dormant… do not delete it" stands; step 0 already removed
  the only measured harm (34 silenced workflow-subagent spawns) with a one-line flag
  flip; residual cost is one `fs.existsSync` per file-tool PostToolUse. Revisit only if a
  second repo enrolls and the lanes still emit nothing.
- **`swift_relations` and `reexports`: KEEP.** See above.
- **The static lane's raw coverage may not be cited without its lift.** Static is 12.5%
  coverage at **1.11×** lift (essentially chance — the recency-correlation trap);
  retrieval is 3.1% at **1.71×**. They measure different things and both are right:
  static covers more opens, retrieval causes more of the ones it covers.

## Open, ranked

1. **The `deltaAtVolume` residual** is done, but three independent re-implementations of
   the volume gate still exist (two renderers + the cron). They now share
   `benefitDeltaGate`; if you add a fourth consumer, read the gate, don't re-derive it.
2. **`sextant_relations` MCP consumer** (`docs/ideas/009 #8`) — the cheap pathfinder that
   would justify keeping `swift_relations`, and whose failure is the kill signal for the
   symbol-level blast-radius trilogy. 128 rows across 3 repos are already stored and
   indexed on every scan.
3. **Codex parity has zero doctor coverage** (completeness critic): 7 fleet repos carry
   `.codex/hooks.json`, but `~/.codex/config.toml` trusts only 4 — three are silently
   dark for the untrusted-hook reason CLAUDE.md itself documents.
4. **No distribution/upgrade mechanism.** `which sextant` resolves through the npm global
   symlink to the live working tree, so all 20 repos execute uncommitted code and any
   version bump invalidates them the instant a file is saved. A `sextant --version` plus a
   packaged install path is a prerequisite for treating the fleet as a controlled
   experiment population.
5. **`entry_points` per-section null.** The 5.6×-below-null finding compares against the
   aggregate static null, not an entry-points-specific one. The gap is large enough that a
   per-section null is unlikely to reverse it, but it would sharpen the claim.

## Process notes worth keeping

- **A background task's output file existing is NOT completion.** A 0-byte output plus a
  journal carrying only `started` records means it is still RUNNING. I declared the
  step-6 verification workflow "terminated early, no findings" while it was 30 minutes
  into real work; it later returned the session's most valuable finding (the Swift ALERT
  had zero test coverage at two injection surfaces, both behind bare `catch {}`).
- **Mutation-check every test that locks a fix.** Three tests in this session passed
  against the mutated code on first write — the export-token leak guard (twice), and the
  Python per-item isolation. Each was hollow verification until the fixture was rebuilt to
  make the guard bite.
- **Agent findings are claims.** The step-6 fleet corroborated two numbers exactly and
  overstated a third ("with a fully green suite" — the mutation actually fails 2 existing
  cases, though both live in the file a deletion would rewrite).
