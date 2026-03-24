# Sextant TODOs

Items identified by full codebase review (2026-03-24).

## Performance

- [ ] **index.json O(N) serialization per flush** — `lib/intel.js:161-172` serializes entire index on every debounced flush (~5MB at 10k files). Consider storing index in SQLite alongside graph, or incremental format.

## Patterns / Refactoring

- [ ] **bin/intel.js is a 961-line God object** — 15+ subcommands in a single switch. Extract command handlers into `commands/` directory.

## Testing

- [ ] **Minimal test coverage** — `npm test` runs 5 bash test scripts (refresh, scoring, rg, watcher, corrupt recovery) + eval harness. Still no unit tests for extractors, resolver, graph, or summary modules.
