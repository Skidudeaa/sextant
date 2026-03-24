---
status: pending
priority: p3
issue_id: "004"
tags: [code-review, reliability]
dependencies: []
---

# graph.db Lacks Atomic Write Despite Corrupt-DB Recovery

## Problem Statement

Commits `a487f07` added atomic writes (tmp+rename) for `summary.md` and `index.json`, and corrupt-DB recovery for `graph.db`. However, `graph.db` itself is still written non-atomically via direct `fs.promises.writeFile`. A crash or power loss during write would corrupt the file, requiring the recovery path to rebuild from scratch. Atomic write would prevent the corruption in the first place.

## Findings

### Finding 1: persistDb writes directly (architecture, agent-native)

**Location**: `lib/graph.js:110`

```js
await fs.promises.writeFile(p, Buffer.from(db.export()));
```

The SQLite binary blob can be several hundred KB. A partial write produces a corrupt `.db` file that triggers the recovery path (lines 88-96), which discards the entire graph and rebuilds from the index.

### Finding 2: history.json also writes non-atomically (architecture)

**Location**: `lib/history.js:51`

Lower priority — history.json is small and non-critical. Corruption just loses sparkline data.

## Proposed Solutions

### Option A: Apply tmp+rename pattern to persistDb (Recommended)

Same pattern already used for `index.json` and `summary.md`:

```js
const tmp = p + ".tmp";
await fs.promises.writeFile(tmp, Buffer.from(db.export()));
await fs.promises.rename(tmp, p);
```

**Pros**: Prevents corruption, consistent with other state files
**Cons**: One extra syscall per persist (negligible)
**Effort**: Small (5 min)
**Risk**: None

## Acceptance Criteria

- [ ] `graph.db` written via tmp+rename pattern
- [ ] Corrupt DB recovery still works if tmp file exists from prior crash

## Work Log

| Date | Action | Notes |
|------|--------|-------|
| 2026-03-24 | Created | Identified by architecture-strategist, agent-native-reviewer |
