"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { isEntryPoint, isIndexable, fileTypeHeuristic } = require("../lib/utils");

// ─── isEntryPoint: existing JS/Python coverage stays green ─────────

test("isEntryPoint: JS/TS canonical names", () => {
  assert.equal(isEntryPoint("src/index.ts"), true);
  assert.equal(isEntryPoint("src/main.tsx"), true);
  assert.equal(isEntryPoint("app/router.js"), true);
  assert.equal(isEntryPoint("lib/routes.mjs"), true);
});

test("isEntryPoint: Python canonical names", () => {
  assert.equal(isEntryPoint("project/__init__.py"), true);
  assert.equal(isEntryPoint("project/__main__.py"), true);
  assert.equal(isEntryPoint("project/wsgi.py"), true);
  assert.equal(isEntryPoint("project/asgi.py"), true);
});

test("isEntryPoint: test/fixture/example paths excluded", () => {
  assert.equal(isEntryPoint("tests/main.ts"), false);
  assert.equal(isEntryPoint("test/main.ts"), false);
  assert.equal(isEntryPoint("__tests__/index.js"), false);
  assert.equal(isEntryPoint("examples/index.js"), false);
  assert.equal(isEntryPoint("fixtures/app.js"), false);
});

// ─── Swift entry-point heuristics (new) ────────────────────────────

test("isEntryPoint: Swift main.swift", () => {
  assert.equal(isEntryPoint("main.swift"), true);
  assert.equal(isEntryPoint("Sources/MyApp/main.swift"), true);
  assert.equal(isEntryPoint("Sources/Foo/Bar/main.swift"), true);
});

test("isEntryPoint: Swift AppDelegate.swift", () => {
  assert.equal(isEntryPoint("AppDelegate.swift"), true);
  assert.equal(isEntryPoint("Sources/Lifecycle/AppDelegate.swift"), true);
});

test("isEntryPoint: SwiftUI <Type>App.swift convention", () => {
  // The dogfooding case — this is what we want to hit.
  assert.equal(isEntryPoint("Sources/thomasamosson/main/MyApp.swift"), true);
  assert.equal(isEntryPoint("MyApp.swift"), true);
  assert.equal(isEntryPoint("Sources/Foo/RootApp.swift"), true);
});

test("isEntryPoint: Swift entry-points excluded under tests/fixtures", () => {
  // Same path-exclusion rules apply uniformly to Swift.
  assert.equal(isEntryPoint("Tests/MyAppTests.swift"), false);
  assert.equal(isEntryPoint("tests/main.swift"), false);
  assert.equal(isEntryPoint("examples/SomeApp.swift"), false);
  assert.equal(isEntryPoint("fixtures/AppDelegate.swift"), false);
});

test("isEntryPoint: Swift non-entry files are not falsely flagged", () => {
  // Lowercase initial — doesn't match the `[A-Z]\w*App\.swift` form.
  assert.equal(isEntryPoint("Sources/Models/userApp.swift"), false);
  // No "App" suffix.
  assert.equal(isEntryPoint("Sources/Models/User.swift"), false);
  // Trailing word makes it not the canonical AppDelegate.
  assert.equal(isEntryPoint("Sources/AppDelegateProtocol.swift"), false);
});

// ─── isIndexable / fileTypeHeuristic: Swift coverage stays correct ─

test("isIndexable accepts .swift files outside excluded dirs", () => {
  assert.equal(isIndexable("Sources/MyApp/main.swift"), true);
  // Defensive blacklist matches /<excluded>/ (nested) — top-level cases are
  // handled by fast-glob's ignore globs.  These assertions verify the
  // defensive layer specifically.
  assert.equal(isIndexable("lib/node_modules/foo.swift"), false);
  assert.equal(isIndexable("foo/.git/objects/x.swift"), false);
});

test("fileTypeHeuristic recognizes .swift", () => {
  assert.equal(fileTypeHeuristic("Sources/MyApp/main.swift"), "swift");
  assert.equal(fileTypeHeuristic("MyApp.swift"), "swift");
});
