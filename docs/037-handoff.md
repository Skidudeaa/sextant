# 037 — Session handoff: client-aware orientation (attribution, Kimi wiring, era windows)

Date: 2026-08-02/03. Branch `main` @ `338e92e` — **committed AND pushed**, tree clean.
3 commits since `655eed4`.

## What this session did

Started from a pooled fleet telemetry read (`sextant telemetry --roots-file
~/.claude/sextant-fleet-roots`) that flipped a standing assumption: the MCP tool
surface is **client-bimodal, not repo-bimodal**. Cross-referencing three session-log
formats (Claude Code JSONL, Codex rollouts, Kimi Code wire logs) found Codex made 934
confirmed tool calls since 07-27 (80% `sextant_search`), Claude Code made 2 in 86
sessions (its hooks orient it — zero calls is success), and Kimi Code loaded the 9
tool definitions ~282 times while calling **zero** (994 Grep calls in the same logs).
User direction: don't evict Kimi on ~1 week of usage — enable it, then re-measure.

Planned and shipped four tracks:

| track | outcome |
|---|---|
| A | Client attribution: `client` field on every telemetry row (`SEXTANT_CLIENT` env for hook lanes, MCP `initialize` `clientInfo.name` for tool calls). Per-client MCP split in `sextant telemetry`. `647b880` |
| B | `sextant init --kimi`: global `~/.kimi-code/config.toml` `[[hooks]]` UserPromptSubmit entry, gated by `SEXTANT_REQUIRE_STATE` (root-guard opt-in — the load-bearing new piece, since a global hook fires in every repo Kimi visits). AGENTS.md managed section → v2 (versioned marker, all 9 tools, client-neutral). `45bec4e` |
| C | `sextant telemetry --since/--until`: absolute era windows, because the 07-30 classifier gate changed retrieval treatment composition (fire-rate 78.5%→28.4%) and the armed-vs-holdback delta must not be quoted across that boundary. `338e92e` |
| D | MCP verdict procedure (~08-20): no code, just the decision rule updated for per-client reads |

Verified: unit 1386/1386, eval 21/21 byte-identical, every new guard mutation-checked.
E2E-verified Kimi wiring in **two modes** against a scratch repo: headless `kimi -p`
and a tmux-driven **interactive shell session** — both fired the hook, both produced
`client:"kimi"` telemetry rows, and the interactive wire log showed the actual
`<hook_result hook_event="UserPromptSubmit">` block with sextant's orientation inside.

## Open — resume here

1. ~~**Confirm real Kimi wiring on somaNotes/defGen2.**~~ **CONFIRMED 2026-08-07:**
   398 `client:"kimi"` rows in somaNotes telemetry, 63 in defGen2 (hook fires end-to-end
   after restarts on 08-05+). Details in `todos.md` under the MCP verdict item.
   (Original concern, now moot: the Kimi process open at wiring time raced the
   config load and started hookless — restarts since then picked up the hook.)
2. ~~**2-week re-measure (feeds the 08-20 MCP verdict).**~~ **FIRST READ DONE 2026-08-07:**
   Kimi Grep-vs-`mcp__sextant__*` moved 994:2 → 917:8 (~4× better, still hook-dominated);
   Codex sustains (13.82 calls/load). Full numbers in `todos.md` under "MCP tool-surface
   reach verdict" and in memory `project_mcp_reach_verdict_2026_08_20.md`. Final verdict
   still ~08-20, leaning keep.
3. **Benefit-delta era boundary.** Clean causal accrual for the armed-vs-holdback
   delta starts 2026-07-30 (the classifier gate ship date). Read with:
   `node bin/intel.js telemetry --roots-file ~/.claude/sextant-fleet-roots --include-old --since 2026-07-30T12:00:00Z`
   Quote the windowed delta once post-era n clears the 30/30 floors — not the cron
   banner's all-time number. Baseline recorded in `todos.md`: all-time turn-level
   delta was −5.7 pts, CI spans zero, directional only.
4. ~~**Kimi's AGENTS.md changes are per-repo, not in this repo.**~~ **DONE 2026-08-07:**
   committed in their own repos — `somaNotes` @ `eb9d37b`, `defGen2` @ `ad48cf6`
   (scoped to `AGENTS.md` only; both repos have unrelated WIP left untouched).

## Landmines for whoever resumes

- **Kimi's hook loader has no retry.** If a `~/.kimi-code/config.toml` edit lands
  while a Kimi process is starting, that process can silently run hookless for its
  entire lifetime. No error, no log line — the only symptom is telemetry silence.
  Always restart Kimi fully after any `sextant init --kimi` run or manual config
  edit, and prefer verifying with a fresh session over trusting an already-open one.
- **`git checkout <file>` during mutation-testing wipes uncommitted real edits too**
  — this bit the session twice (queued as a global CLAUDE.md learning via
  `/reflect`). Apply and revert mutations with targeted `Edit` calls instead.
- Full technical detail (exact TOML block, root-guard gate code, AGENTS.md v2
  upgrade logic, era-window implementation) is in the three commit messages
  (`647b880`, `45bec4e`, `338e92e`) and `CHANGELOG.md`'s 2026-08-02 entry — read
  those before re-deriving anything.
