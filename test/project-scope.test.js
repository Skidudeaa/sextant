const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  detectProjectScope,
  detectVendorSignal,
  vendoredPathsToIgnoreGlobs,
  TARBALL_NAME_RE,
  VENDORED_DIR_NAMES,
} = require("../lib/project-scope");

function makeTmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sextant-scope-"));
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function touch(p, content = "") {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, content);
}

// ─── Tarball-name regex ──────────────────────────────────────────

test("TARBALL_NAME_RE matches GitHub-tarball-extract naming", () => {
  // Real-world examples from the dogfooding feedback.
  assert.ok(TARBALL_NAME_RE.test("mbadolato-iTerm2-Color-Schemes-f279991"));
  // Other plausible patterns.
  assert.ok(TARBALL_NAME_RE.test("facebook-react-abc1234"));
  assert.ok(TARBALL_NAME_RE.test("paul-gauthier-aider-deadbeef"));
  assert.ok(TARBALL_NAME_RE.test("anthropics-anthropic-sdk-python-1234abcd"));
});

test("TARBALL_NAME_RE rejects regular project names", () => {
  // Should NOT match — these are normal directory names.
  assert.equal(TARBALL_NAME_RE.test("Sources"), false);
  assert.equal(TARBALL_NAME_RE.test("my-app"), false);  // no hash suffix
  assert.equal(TARBALL_NAME_RE.test("frontend-2024"), false);  // year, not hex
  assert.equal(TARBALL_NAME_RE.test("v1.0.0"), false);
  assert.equal(TARBALL_NAME_RE.test("packages"), false);
  assert.equal(TARBALL_NAME_RE.test("backend-py"), false);  // no hex
  assert.equal(TARBALL_NAME_RE.test("foo-bar-12345"), false);  // 5 hex chars (need 6+)
});

// ─── detectVendorSignal: each strong signal ──────────────────────

test("detectVendorSignal flags nested .git/ directory", () => {
  const root = makeTmpRoot();
  try {
    mkdirp(path.join(root, "vendored-repo", ".git"));
    touch(path.join(root, "vendored-repo", ".git", "HEAD"), "ref: refs/heads/main\n");

    const sig = detectVendorSignal(root, "vendored-repo");
    assert.ok(sig);
    assert.equal(sig.reason, "nested-git-repo");
  } finally {
    rmrf(root);
  }
});

test("detectVendorSignal does NOT flag .git/ that's just an empty dir without HEAD/refs", () => {
  // A bare .git/ directory without any contents shouldn't fire; could be a
  // build artifact or a hand-created stub. Real .git/ always has HEAD.
  const root = makeTmpRoot();
  try {
    mkdirp(path.join(root, "subdir", ".git"));
    // No HEAD, no refs/

    const sig = detectVendorSignal(root, "subdir");
    assert.equal(sig, null);
  } finally {
    rmrf(root);
  }
});

test("detectVendorSignal flags conventional vendor dirnames", () => {
  const root = makeTmpRoot();
  try {
    for (const name of VENDORED_DIR_NAMES) {
      mkdirp(path.join(root, name));
      const sig = detectVendorSignal(root, name);
      assert.ok(sig, `expected ${name} to be flagged`);
      assert.equal(sig.reason, "vendor-dirname");
    }
  } finally {
    rmrf(root);
  }
});

test("detectVendorSignal flags GitHub-tarball-extract naming", () => {
  const root = makeTmpRoot();
  try {
    mkdirp(path.join(root, "mbadolato-iTerm2-Color-Schemes-f279991"));

    const sig = detectVendorSignal(root, "mbadolato-iTerm2-Color-Schemes-f279991");
    assert.ok(sig);
    assert.equal(sig.reason, "tarball-name");
  } finally {
    rmrf(root);
  }
});

test("detectVendorSignal returns null for normal project subdirs", () => {
  const root = makeTmpRoot();
  try {
    mkdirp(path.join(root, "Sources"));
    mkdirp(path.join(root, "Tests"));
    mkdirp(path.join(root, "src"));
    mkdirp(path.join(root, "lib"));
    mkdirp(path.join(root, "frontend"));
    mkdirp(path.join(root, "packages"));

    for (const name of ["Sources", "Tests", "src", "lib", "frontend", "packages"]) {
      assert.equal(detectVendorSignal(root, name), null, `${name} should not be vendored`);
    }
  } finally {
    rmrf(root);
  }
});

// ─── detectProjectScope: integration ─────────────────────────────

test("detectProjectScope finds the user's reported case (Swift app + 3 vendored subtrees)", () => {
  const root = makeTmpRoot();
  try {
    // Real project files.
    touch(path.join(root, "Package.swift"), "// swift-tools-version:5.5\n");
    mkdirp(path.join(root, "Sources", "thomasamosson", "main"));
    touch(path.join(root, "Sources", "thomasamosson", "main", "MyApp.swift"));

    // Vendored subtree 1: cloned MCP servers (has .git/).
    mkdirp(path.join(root, "mcp-servers-repo", ".git"));
    touch(path.join(root, "mcp-servers-repo", ".git", "HEAD"), "ref: refs/heads/main\n");
    touch(path.join(root, "mcp-servers-repo", "pyproject.toml"));

    // Vendored subtree 2: another mcp servers dir, but only with a manifest
    // (no .git/). v1 conservative detection won't catch this — user must
    // list it manually. Document the gap.
    mkdirp(path.join(root, "mcp-servers"));
    touch(path.join(root, "mcp-servers", "pyproject.toml"));

    // Vendored subtree 3: tarball-extract naming.
    mkdirp(path.join(root, "mbadolato-iTerm2-Color-Schemes-f279991"));
    touch(path.join(root, "mbadolato-iTerm2-Color-Schemes-f279991", "README.md"));

    const { vendoredPaths, signals } = detectProjectScope(root);

    // The two strong-signal cases are caught.
    assert.ok(vendoredPaths.includes("mcp-servers-repo"), "should catch nested git repo");
    assert.ok(
      vendoredPaths.includes("mbadolato-iTerm2-Color-Schemes-f279991"),
      "should catch tarball naming"
    );

    // The manifest-only case is NOT auto-caught (conservative v1).
    assert.equal(
      vendoredPaths.includes("mcp-servers"),
      false,
      "manifest-only subdir not caught by strong signals"
    );

    // Real project dirs not flagged.
    assert.equal(vendoredPaths.includes("Sources"), false);

    // Signals carry reasons.
    const reasonByPath = Object.fromEntries(signals.map((s) => [s.path, s.reason]));
    assert.equal(reasonByPath["mcp-servers-repo"], "nested-git-repo");
    assert.equal(reasonByPath["mbadolato-iTerm2-Color-Schemes-f279991"], "tarball-name");
  } finally {
    rmrf(root);
  }
});

test("detectProjectScope skips dot-dirs and standard build output", () => {
  const root = makeTmpRoot();
  try {
    // These should never get checked, regardless of contents.
    mkdirp(path.join(root, ".git"));
    mkdirp(path.join(root, ".planning"));
    mkdirp(path.join(root, "node_modules", "vendor"));  // even if name matches!
    mkdirp(path.join(root, "dist"));
    mkdirp(path.join(root, "build"));

    const { vendoredPaths } = detectProjectScope(root);

    assert.equal(vendoredPaths.length, 0, "no false positives from dot-dirs/build dirs");
  } finally {
    rmrf(root);
  }
});

test("detectProjectScope returns empty for an empty/missing root", () => {
  // Missing root.
  const { vendoredPaths, signals } = detectProjectScope("/nonexistent-path-zzz-yyy");
  assert.deepEqual(vendoredPaths, []);
  assert.deepEqual(signals, []);

  // Empty root.
  const root = makeTmpRoot();
  try {
    const out = detectProjectScope(root);
    assert.deepEqual(out.vendoredPaths, []);
  } finally {
    rmrf(root);
  }
});

test("detectProjectScope produces stable, sorted output", () => {
  const root = makeTmpRoot();
  try {
    // Create in deliberately unsorted order.
    mkdirp(path.join(root, "vendor"));
    mkdirp(path.join(root, "Pods"));
    mkdirp(path.join(root, "Carthage"));

    const { vendoredPaths } = detectProjectScope(root);
    // Lexicographic sort.
    assert.deepEqual(vendoredPaths, ["Carthage", "Pods", "vendor"]);
  } finally {
    rmrf(root);
  }
});

// ─── vendoredPathsToIgnoreGlobs ──────────────────────────────────

test("vendoredPathsToIgnoreGlobs produces fast-glob ignore patterns", () => {
  const globs = vendoredPathsToIgnoreGlobs(["mcp-servers-repo", "Pods"]);
  assert.deepEqual(globs, ["**/mcp-servers-repo/**", "**/Pods/**"]);
});

test("vendoredPathsToIgnoreGlobs handles empty input", () => {
  assert.deepEqual(vendoredPathsToIgnoreGlobs([]), []);
});
