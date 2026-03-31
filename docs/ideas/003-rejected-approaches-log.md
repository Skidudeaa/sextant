---
title: Rejected approaches log
status: researched
priority: high
feasibility: medium
source: agent-reflection
researched: 2026-03-31
---

# Rejected Approaches Log

## The Gap

The single biggest time sink in agent-assisted development: proposing an approach the user already tried and abandoned. Git history shows what was committed, not what was reverted or never merged. Conversation context dies when sessions end.

## Research Findings

### ADRs: the closest analog (and why they fail)

Architecture Decision Records (MADR format) explicitly document rejected alternatives with pros/cons. They're the most established practice.

**Why they get abandoned** (InfoQ, community research):
1. Documentation decay — drift out of sync, trust lost, writing stops
2. Perceived as overhead, not risk-reduction
3. Scope creep — "if every decision is architectural, no decision is architectural"
4. Workflow friction — requires leaving the code flow to write in a separate system
5. Status staleness — ADRs marked "Accepted" for systems completely replaced

**Key lesson**: Rejection records that live where engineers already work get maintained. Those requiring a context switch die within weeks.

### AI memory systems: what exists

| System | Capture | Retrieval | Staleness |
|--------|---------|-----------|-----------|
| Claude Code CLAUDE.md | Manual | Always loaded (hot) | Manual maintenance |
| Claude Code Auto Memory | Semi-auto (corrections) | Session-scoped | Auto Dream pruning |
| claude-mem plugin | Auto (tool usage, file changes) | Progressive disclosure | AI summarization |
| Windsurf Cascade | Semi-auto (corrections) | Workspace-scoped | Manual |
| Codified Context (arxiv) | Manual (660-line constitution) | Tiered (hot/specialist/cold) | Human-maintained |

**Key finding from Codified Context paper**: A 108,000-line C# system used structured tables documenting **known failure modes** with symptoms, causes, and fixes. After a UI sync failure was documented, the next feature "correctly applied the dual delivery pattern on the first implementation attempt." Infrastructure was 24.2% of the total codebase.

### The capture problem: the hard part

Three capture channels, in order of friction:

**1. Agent-detected (lowest friction)**
Detect rejection patterns in conversation: "no, don't do that", "we tried that", "that approach won't work." Claude Code's Auto Memory already captures corrections. The gap is *structured* capture — knowing that "don't use X on file Y because Z" is a different kind of memory.

**2. CLI command (medium friction)**
`sextant reject "description" --files lib/graph.js` — three lines of metadata. The minimum viable format:
```
What: [one-line description of rejected approach]
Files: [affected file paths]
Why: [one sentence]
```

**3. Git-extracted (batch, periodic)**

| Git Signal | Detection | Reliability |
|-----------|-----------|-------------|
| `git revert` commits | Message grep | High — explicit signal |
| Closed-without-merge PRs | `gh pr list --state closed` | High — GitHub API |
| Deleted unmerged branches | Branch comparison | Medium — cleanup noise |
| Revert-like commit messages | Grep "undo", "rollback" | Low — many false positives |

**Problem**: These tell you *what* was rejected but not *why*. The reasoning lives in PR comments, commit messages, or nowhere.

### Evidence from sextant's own history

Analysis of 27 commits found 10 concrete rejected approaches:

| What Was Tried | What Replaced It | Signal Source |
|---------------|-----------------|---------------|
| `index.json` dual storage with JSON.stringify | `graph.db` single source of truth | Commit `205f1e5` |
| Raw fan-in as primary file sort key | `bestAdjustedHitScore` with definition-site priority | EVAL_FINDINGS only |
| Static summary for all prompts | Query-aware classifier + graph-retrieve | Commit `0d28a0f` |
| Copy-deploy `refresh.js` per project | Global `sextant hook refresh` | Commit `bdf9a7c` |
| Shell interpolation `command -v ${bin}` | Safe `spawnSync("which", [bin])` | Commit `a487f07` |
| Hardcoded scoring constants per module | Shared `scoring-constants.js` | Commit `bdf9a7c` |
| ChunkHound (vector embeddings) | Zoekt trigram indexing | Memory only |
| `exact_symbol` at +25% | Raised to +40% | EVAL_FINDINGS only |

**Key conclusion**: Roughly half the useful rejection information exists only in human memory or CLAUDE.md prose, not in parseable git signals. This validates that automated capture alone is insufficient.

### Surfacing: when and how

**When**: Only when the agent is about to work on affected files. File-path-scoped retrieval, not global. The classifier already detects code-relevant prompts — rejections participate in the same `<codebase-retrieval>` pipeline.

**Rejection fatigue**: Not all rejections should be hot. Tiered approach:
- **Hot**: Rejections affecting actively-edited files (surface in retrieval)
- **Cold**: Historical, queryable on demand via MCP
- **Expired**: Files substantially rewritten since rejection

**TTL**: Auto-flag when referenced files change >50% of lines. Hard TTL of 90-180 days. Manual invalidation command.

### What won't work (research consensus)

1. Requiring manual writes without prompting — dies within weeks
2. Separate documentation system outside the dev workflow — must be in `.planning/intel/`
3. Surfacing all rejections on every prompt — creates fatigue
4. Auto-generating without human confirmation — false positives poison the system
5. No expiry mechanism — stale rejections constrain valid approaches

### Existing tools: nothing solves this directly

Factory.ai's lint-based approach codifies anti-patterns as failing rules — works for codifiable patterns but not design-level rejections. ArchUnit/NetArchTest encode structural constraints but not decision reasoning. No tool specifically tracks "rejected approaches" for AI agents.

## Recommended Design for Sextant

### Storage

`rejections` table in `graph.db` (extends existing SQLite schema):

```sql
CREATE TABLE IF NOT EXISTS rejections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  description TEXT NOT NULL,
  reason TEXT NOT NULL,
  files TEXT,          -- JSON array of affected file paths
  symbols TEXT,        -- JSON array of affected symbols
  source TEXT,         -- "manual" | "agent" | "git-revert" | "git-pr"
  status TEXT DEFAULT 'active',  -- "active" | "stale" | "expired"
  created_at TEXT,
  expires_at TEXT,
  source_commit TEXT,  -- git SHA if extracted from history
  source_pr TEXT       -- PR number if extracted from GitHub
);
CREATE INDEX idx_rejections_status ON rejections(status);
```

File paths in `files` field are cross-referenced against the existing `files` table for staleness detection.

### Capture (three channels)

**Channel 1: CLI command**
```bash
sextant reject "shared SQLite connection pool" \
  --files lib/graph.js,lib/intel.js \
  --why "WAL + concurrent writes = SQLITE_BUSY"
```

**Channel 2: Agent-assisted**
When the hook detects the user rejecting an approach, offer to log it. The agent calls `sextant reject` via the MCP tool.

**Channel 3: Git scan**
During `sextant scan`, detect `git revert` commits. Create draft rejections with `source: git-revert` and `status: active`. Extract affected files from the reverted diff, commit message as description.

### Retrieval

New function in `graph.js`:

```javascript
function findRejectionsForFiles(db, filePaths) {
  // Query rejections table where any file in the JSON array
  // matches the given paths. Return active rejections only.
}
```

Called from `hook-refresh.js` when the classifier extracts file paths from the prompt. Injected as a section in `<codebase-retrieval>`:

```markdown
### Rejected approaches (lib/graph.js)
- **Shared SQLite connection pool** — WAL + concurrent writes = SQLITE_BUSY. Keep per-root isolation. (2026-03-30)
```

### Staleness

During `sextant scan` or `updateFile`, compare rejection file paths against current file metadata. If a referenced file has changed >50% of lines since the rejection was created (compare `size_bytes` or use a simple heuristic), auto-update status to `stale`.

### MCP tools

- `sextant_reject` — create a rejection record
- `sextant_rejections` — query rejections for given files

### Build sequence

1. Add `rejections` table to graph.js schema (`ensureSchema`)
2. Add `insertRejection()`, `findRejectionsForFiles()`, `updateRejectionStatus()` to graph.js
3. Add `commands/reject.js` CLI command
4. Add rejection retrieval to `hook-refresh.js` pipeline
5. Add `sextant_reject` and `sextant_rejections` MCP tools
6. Add git-revert scanning to `sextant scan`
7. Add staleness detection to `updateFile` flow
8. Tests: rejection CRUD, retrieval by file path, staleness detection

### Open questions

1. Should rejections be per-project or global? (Per-project in graph.db is the natural choice, but some rejections are cross-project — "never use embeddings for code search")
2. How aggressive should auto-expiry be? (Too aggressive = useful rejections disappear. Too conservative = stale rejections block valid approaches)
3. Should the agent be able to create rejections autonomously, or require user confirmation? (Research says: require confirmation to prevent false positives)

## Sources

- ADR GitHub, MADR Template, Martin Fowler's ADR bliki
- InfoQ: Has Your ADR Lost Its Purpose?
- Codified Context paper (arxiv 2602.20478)
- MemCoder: Structured Memory for Code Agents (arxiv 2603.13258)
- Mem0: Production-Ready AI Agent Memory (arxiv 2504.19413)
- Claude Code Memory and Auto Dream documentation
- Factory.ai: Using Linters to Direct Agents
- Rust RFC, React RFC, Go Proposal processes
- Farnam Street: Decision Journal methodology
