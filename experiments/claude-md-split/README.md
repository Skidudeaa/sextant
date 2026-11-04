# CLAUDE.md split tools (2026-11-03)

- `split.js <plan.json> <outdir>` writes a core CLAUDE.md and `.claude/rules/*.md` from line ranges of the old file. It refuses unless every non-blank line lands in exactly one output and every `paths:` glob matches a tracked file. `{{D a-b}}` copies lines without owning them.
- `measure2.js <root> <old CLAUDE.md> <dir with new CLAUDE.md and .claude/rules> [days]` replays the repo's Claude Code transcripts through `commands/atoms.js:replayRepo` and prints per-request instruction characters and rule recall.
- `plan-*.json` are the plans used for defGen2 (5e461f5), somaNotes (ad3012194) and jan25 (b90d8c9d6). Their `source` field names a scratch copy; the original file is `git show <commit>~1:CLAUDE.md` in that repo. somaNotes was edited again after the plan (e3c454414, f65689c13).
