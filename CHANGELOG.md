# Changelog

All notable changes to sextant are recorded here. Entries are ordered newest first.

## 2026-04-30

We diagnosed and fixed a cross-session correctness bug in sextant: each Claude Code session's MCP server held a process-global in-memory cache of `graph.db` that was never invalidated, so two concurrent sessions in the same project would silently diverge on `sextant_search` results — one serving its session-start snapshot indefinitely while the watcher updated disk for everyone else. The fix landed as commit `d22fb79`: `loadDb()` now stats `graph.db` on each call and evicts the cache when disk is strictly newer, while `persistDb()` bumps the cached mtime after its atomic rename so writers don't self-invalidate. 446 unit tests + 5 integration scripts + 19/19 eval cases still pass, with eval numbers byte-identical to baseline (the gate is a no-op for retrieval ranking). Still on the table and deliberately deferred: the bigger "stale should be absent, not warned" redesign at the `<codebase-intelligence>` injection layer — replacing the current ALERT-and-ship-anyway model with a freshness-vs-age distinction (git-log–based, not just elapsed time) that either auto-rescans synchronously, falls through to a silent "structural claims unavailable this turn" body, or returns fresh data — so the LLM never has stale numeric fields to misquote in the first place.
