# Sextant TODOs

Items identified by full codebase review (2026-03-24).

## Performance

- [x] **index.json O(N) serialization per flush** — Resolved: migrated index storage into graph.db SQLite. graph.db is now the single source of truth for file metadata, imports, and exports. Legacy index.json is auto-migrated on init and renamed to index.json.migrated.

## Patterns / Refactoring

- [ ] **bin/intel.js is a 961-line God object** — 15+ subcommands in a single switch. Extract command handlers into `commands/` directory.

## Testing

- [ ] **Minimal test coverage** — `npm test` runs 5 bash test scripts (refresh, scoring, rg, watcher, corrupt recovery) + eval harness. Still no unit tests for extractors, resolver, graph, or summary modules.
