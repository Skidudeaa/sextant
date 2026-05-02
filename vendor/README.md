# Vendored binaries

Files in this directory are pre-built artifacts vendored into the repo to avoid
install-time downloads, native compilation, or large npm dependencies.

## tree-sitter-swift.wasm

- **Source**: https://github.com/alex-pinkus/tree-sitter-swift
- **Version**: 0.7.1 (release tag `0.7.1-pypi`)
- **License**: MIT (see upstream LICENSE)
- **Provenance**: Downloaded directly from the upstream GitHub release at
  https://github.com/alex-pinkus/tree-sitter-swift/releases/download/0.7.1-pypi/tree-sitter-swift.wasm
- **Note**: The `tree-sitter-wasms@0.1.13` npm package bundles a Swift WASM
  with the same version tag, but it's compiled against an older tree-sitter
  ABI that does NOT load with `web-tree-sitter` 0.26.x. Always pull from the
  upstream GitHub release, NOT from the npm package, until tree-sitter-wasms
  catches up.
- **AST notes**: in this grammar, `class`, `struct`, `actor`, `enum`, AND
  `extension` are all `class_declaration` nodes — discriminate via the
  `declaration_kind` field. Inheritance/conformance lives in `inheritance_specifier`
  children with the `inherits_from` field name (the grammar doesn't distinguish
  base-class from leading-protocol; that heuristic is ours).
- **Why vendored**: avoids pulling the 51 MB `tree-sitter-wasms` package (which
  bundles parsers for 50+ languages we don't need), avoids native compilation
  required by the `tree-sitter-swift` npm package, avoids install-time network
  for the GitHub release. Loaded at runtime by `web-tree-sitter`.

### Updating

To bump the Swift grammar version:

```bash
# Download from the upstream release
curl -L -o vendor/tree-sitter-swift.wasm \
  https://github.com/alex-pinkus/tree-sitter-swift/releases/download/<VERSION>/tree-sitter-swift.wasm

# Verify it loads
node -e "
  const Parser = require('web-tree-sitter');
  const { Parser, Language } = require('web-tree-sitter');
  Parser.init().then(async () => {
    const lang = await Language.load('vendor/tree-sitter-swift.wasm');
    const p = new Parser();
    p.setLanguage(lang);
    const tree = p.parse('class Foo {}');
    console.log('OK:', tree.rootNode.toString());
  });
"

# Update the version line in this README and bump SCANNER_VERSION in lib/freshness.js
# (since extractor output may differ between grammar versions)
```
