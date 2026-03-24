"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { resolveImport, clearCaches } = require("../lib/resolver");

let tmpDir;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-resolver-"));

  // Create file structure:
  // foo.js
  // bar/index.js
  // style.css
  // utils/helper.ts
  // src/components/Button.tsx
  fs.writeFileSync(path.join(tmpDir, "foo.js"), "module.exports = {};");
  fs.mkdirSync(path.join(tmpDir, "bar"));
  fs.writeFileSync(path.join(tmpDir, "bar", "index.js"), "module.exports = {};");
  fs.writeFileSync(path.join(tmpDir, "style.css"), "body {}");
  fs.mkdirSync(path.join(tmpDir, "utils"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "utils", "helper.ts"), "export const x = 1;");
  fs.mkdirSync(path.join(tmpDir, "src", "components"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "src", "components", "Button.tsx"), "export default () => {}");
}

function cleanup() {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearCaches(tmpDir);
  }
}

describe("resolver - JS relative imports", () => {
  before(setup);
  after(cleanup);

  it("./foo resolves to foo.js", () => {
    const result = resolveImport(tmpDir, "app.js", "./foo");
    assert.equal(result.resolved, "foo.js");
    assert.equal(result.kind, "relative");
  });

  it("./bar resolves to bar/index.js (directory index)", () => {
    const result = resolveImport(tmpDir, "app.js", "./bar");
    assert.equal(result.resolved, "bar/index.js");
    assert.equal(result.kind, "relative");
  });

  it("./utils/helper resolves to utils/helper.ts", () => {
    const result = resolveImport(tmpDir, "app.js", "./utils/helper");
    assert.equal(result.resolved, "utils/helper.ts");
    assert.equal(result.kind, "relative");
  });

  it("./nonexistent returns unresolved", () => {
    const result = resolveImport(tmpDir, "app.js", "./nonexistent");
    assert.equal(result.resolved, null);
    assert.equal(result.kind, "unresolved");
  });
});

describe("resolver - external and node: imports", () => {
  before(setup);
  after(cleanup);

  it("react returns external", () => {
    const result = resolveImport(tmpDir, "app.js", "react");
    assert.equal(result.resolved, null);
    assert.equal(result.kind, "external");
  });

  it("node:fs returns external", () => {
    const result = resolveImport(tmpDir, "app.js", "node:fs");
    assert.equal(result.resolved, null);
    assert.equal(result.kind, "external");
  });

  it("@babel/parser returns external", () => {
    const result = resolveImport(tmpDir, "app.js", "@babel/parser");
    assert.equal(result.resolved, null);
    assert.equal(result.kind, "external");
  });
});

describe("resolver - asset imports", () => {
  before(setup);
  after(cleanup);

  it("./style.css returns asset kind", () => {
    const result = resolveImport(tmpDir, "app.js", "./style.css");
    assert.equal(result.kind, "asset");
    // The css file exists, so it should resolve
    assert.equal(result.resolved, "style.css");
  });

  it("./icon.png returns asset kind (unresolved file)", () => {
    const result = resolveImport(tmpDir, "app.js", "./icon.png");
    assert.equal(result.kind, "asset");
    assert.equal(result.resolved, null);
  });
});

describe("resolver - tsconfig paths", () => {
  let tsTmpDir;

  before(() => {
    tsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-tsconfig-"));
    // Create tsconfig.json with paths
    fs.writeFileSync(
      path.join(tsTmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@utils/*": ["src/utils/*"],
            "@components/*": ["src/components/*"],
          },
        },
      })
    );
    fs.mkdirSync(path.join(tsTmpDir, "src", "utils"), { recursive: true });
    fs.mkdirSync(path.join(tsTmpDir, "src", "components"), { recursive: true });
    fs.writeFileSync(path.join(tsTmpDir, "src", "utils", "format.ts"), "export const f = 1;");
    fs.writeFileSync(path.join(tsTmpDir, "src", "components", "Box.tsx"), "export default () => {}");
  });

  after(() => {
    if (tsTmpDir) {
      fs.rmSync(tsTmpDir, { recursive: true, force: true });
      clearCaches(tsTmpDir);
    }
  });

  it("@utils/format resolves via tsconfig paths", () => {
    const result = resolveImport(tsTmpDir, "app.ts", "@utils/format");
    assert.equal(result.resolved, "src/utils/format.ts");
    assert.equal(result.kind, "tsconfig");
  });

  it("@components/Box resolves via tsconfig paths", () => {
    const result = resolveImport(tsTmpDir, "app.ts", "@components/Box");
    assert.equal(result.resolved, "src/components/Box.tsx");
    assert.equal(result.kind, "tsconfig");
  });
});

describe("resolver - Python imports", () => {
  let pyTmpDir;

  before(() => {
    pyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-pyresolver-"));
    // Create Python package structure:
    // mypkg/__init__.py
    // mypkg/utils.py
    // mypkg/sub/__init__.py
    // mypkg/sub/helper.py
    // standalone.py
    fs.mkdirSync(path.join(pyTmpDir, "mypkg", "sub"), { recursive: true });
    fs.writeFileSync(path.join(pyTmpDir, "mypkg", "__init__.py"), "");
    fs.writeFileSync(path.join(pyTmpDir, "mypkg", "utils.py"), "def helper(): pass");
    fs.writeFileSync(path.join(pyTmpDir, "mypkg", "sub", "__init__.py"), "");
    fs.writeFileSync(path.join(pyTmpDir, "mypkg", "sub", "helper.py"), "def h(): pass");
    fs.writeFileSync(path.join(pyTmpDir, "standalone.py"), "x = 1");
  });

  after(() => {
    if (pyTmpDir) {
      fs.rmSync(pyTmpDir, { recursive: true, force: true });
      clearCaches(pyTmpDir);
    }
  });

  it("relative .utils from mypkg/main.py", () => {
    const result = resolveImport(pyTmpDir, "mypkg/main.py", ".utils");
    assert.equal(result.resolved, "mypkg/utils.py");
    assert.equal(result.kind, "relative");
  });

  it("external os import", () => {
    const result = resolveImport(pyTmpDir, "mypkg/main.py", "os");
    assert.equal(result.resolved, null);
    assert.equal(result.kind, "external");
  });

  it("local package mypkg resolves to __init__.py", () => {
    const result = resolveImport(pyTmpDir, "app.py", "mypkg");
    assert.equal(result.resolved, "mypkg/__init__.py");
    assert.equal(result.kind, "local");
  });

  it("local package mypkg.utils resolves to mypkg/utils.py", () => {
    const result = resolveImport(pyTmpDir, "app.py", "mypkg.utils");
    assert.equal(result.resolved, "mypkg/utils.py");
    assert.equal(result.kind, "local");
  });

  it("double-dot relative ..core from mypkg/sub/helper.py", () => {
    // from mypkg/sub/helper.py, .. goes to mypkg/
    // But specifier is just ".." (bare dots) -> looks for __init__.py
    const result = resolveImport(pyTmpDir, "mypkg/sub/helper.py", "..");
    assert.equal(result.resolved, "mypkg/__init__.py");
    assert.equal(result.kind, "relative");
  });
});

describe("resolver - edge cases", () => {
  before(setup);
  after(cleanup);

  it("empty specifier returns unresolved", () => {
    const result = resolveImport(tmpDir, "app.js", "");
    assert.equal(result.kind, "unresolved");
  });
});
