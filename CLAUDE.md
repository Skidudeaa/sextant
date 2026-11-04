# CLAUDE.md

## Current state (2026-11-03)

Sextant, the codebase-orientation service, has been **hibernated since 2026-08-26** (`HIBERNATION.md`, docs/041). It is removed from every project on this machine and the `sextant` binary is unlinked. Run commands as `node /root/sextant/bin/intel.js <cmd>`.

Active work lives in two places:
- **Instruction compiler** (docs/052, handoff docs/053): `atoms compile --dry-run | replay | exposure` in `commands/atoms.js`. It splits CLAUDE.md files into atoms bound to the files they cite, so they can load as `.claude/rules/*.md` `paths` rules.
- **Jev lab** (docs/049, handoff docs/051): offline TypeSafe Jev experiments in `experiments/jev/`, the guard-trial hook `experiments/jev/guard-hook.js`, and the context ledger (`commands/ledger.js`, `ledger/registry.json`, docs/050).

At session start, read `JOURNAL.md` (tail plus `## GRAVEYARD`) and the latest handoff. Do not re-propose a graveyard item without stating what changed.

## Commands

```bash
node bin/intel.js atoms replay --roots /root/jan25,/root/defGen2 [--days N] [--json]
node bin/intel.js atoms compile --dry-run --roots /root/jan25
node bin/intel.js ledger census
node --test test/atoms.test.js test/command-conventions.test.js test/ledger.test.js
```

CommonJS, no build step. The full unit suite has 73 known failures (missing unmerged `lib/jev*` modules, the MCP tool-count test, `spawn sextant ENOENT`), so run targeted test files.

## Standing rules

- Do not `npm link` sextant. Do not delete `refs/archive/pre-push-protection-20261028`.
- somaNotes transcripts carry PHI: print aggregates only. Keep somaNotes out of hooks unless the owner says otherwise.
- jan25's `.claude/settings.local.json` holds plaintext MongoDB credentials. Never copy them anywhere.
- The `InstructionsLoaded` exposure hook in jan25, defGen2, theLongWay and sextant runs `node /root/sextant/bin/intel.js atoms exposure`. A checkout without `commands/atoms.js` breaks it in all four repos.
- The retrieval-era code (about 17k lines) stays in place. Ask the owner before removing working code.
- New `commands/*.js` export `{ run }` taking `ctx = { argv, roots, root }`. Hook commands that read `process.cwd()` must be whitelisted in `test/command-conventions.test.js`.

## Hook output channels

| Channel | Reaches |
|---|---|
| SessionStart / UserPromptSubmit stdout | Claude's context |
| PostToolUse plain stdout | Debug log only |
| PostToolUse `hookSpecificOutput.additionalContext` JSON (10k cap) | Claude's context |
| Hook stderr | Nobody |
| `statusLine` | The user only |

## Retrieval-era reference

`docs/ARCHITECTURE.md` holds the full description of the hibernated service: the pipeline (extractors, resolver, graph, intel, summary, retrieve, watcher, classifier, MCP server, freshness gate, telemetry, blast-radius lane, subagent orientation, the context-coherence arc), per-repo state in `.planning/intel/`, key design decisions, the eval harness and its baselines, and `init --codex` / `--kimi` wiring. Read the section for a module in `lib/`, `commands/`, `mcp/` or `scripts/` before editing it.

What not to add: embeddings or vector search, LLM calls in the retrieval pipeline, semantic (LSP-like) claims, summaries over 2200 chars, hook UI on stderr.
