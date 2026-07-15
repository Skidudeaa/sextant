"use strict";

// CLAIM LEDGER (docs/028 Phase C — the architectural inflection).
//
// Every structural fact sextant injects becomes an addressable CLAIM: a typed
// assertion (subject, predicate, provenance) stamped with the file fingerprint
// it was compiled against. On the NEXT hook event we re-check each claim we
// served this session against the current file on disk and, when one moved or
// vanished, emit a <sextant-context-delta> that RETRACTS the stale fact and
// (for a symbol) reports its new span. That is cache coherence for agent context:
// the agent holds a cached subset of repo claims, and sextant invalidates them
// when the source changes.
//
// v1 scope: single-session coherence, served claims embedded in the per-session
// capsule (lib/capsule.js servedClaims). Cross-session / multi-agent recorded claims
// (a shared store) is the Phase F graduation — deltas here land only at the next
// eligible hook (no push channel), per the recon constraint. Facts only; never
// throws.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const regionsLib = require("./regions");

// Claim checks run on hook paths. Bound each source snapshot so a replaced or
// growing file cannot turn one coherence check into an unbounded allocation.
// Files above the cap are unverifiable and therefore produce no retraction.
const CLAIM_FILE_MAX_BYTES = 2 * 1024 * 1024;

// Provenance taxonomy (the epistemic firewall, vision §13): a claim's authority
// is TYPED, never conflated. direct = AST/graph-derived definition; heuristic =
// filename inference; live_text = a zoekt/text match, not a structural assertion.
function provenanceOf(source) {
  switch (source) {
    case "exported_symbol":
    case "swift_decl_type":
    case "swift_decl_other":
    case "reexport_chain":
      return "direct";
    case "path_match":
      return "heuristic";
    default:
      return "live_text"; // text_only / unknown
  }
}

function sameFileStat(a, b) {
  return Boolean(
    a && b &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

function missingSnapshot(abs, relPath) {
  try {
    const parent = path.dirname(abs);
    const parentBefore = fs.lstatSync(parent, { bigint: true });
    try {
      fs.lstatSync(abs, { bigint: true });
      return { kind: "unstable", path: relPath };
    } catch (error) {
      if (!error || error.code !== "ENOENT") return { kind: "unstable", path: relPath };
    }
    const parentAfter = fs.lstatSync(parent, { bigint: true });
    if (!sameFileStat(parentBefore, parentAfter)) return { kind: "unstable", path: relPath };
    return { kind: "missing", path: relPath, parent, parentStat: parentAfter };
  } catch {
    return { kind: "unstable", path: relPath };
  }
}

// One descriptor-stable bounded byte generation. Hashing, definition lookup,
// extractor presence, and region resolution all consume this exact `content`
// value; no downstream helper is allowed to reopen the path.
function snapshotFile(rootAbs, relPath) {
  const abs = path.join(rootAbs, relPath);
  let fd = null;
  try {
    let pathBefore;
    try {
      pathBefore = fs.lstatSync(abs, { bigint: true });
    } catch (error) {
      return error && error.code === "ENOENT"
        ? missingSnapshot(abs, relPath)
        : { kind: "unstable", path: relPath };
    }
    if (!pathBefore.isFile()) {
      return { kind: "not-file", path: relPath, pathStat: pathBefore };
    }
    if (pathBefore.size > BigInt(CLAIM_FILE_MAX_BYTES)) {
      return { kind: "unstable", path: relPath };
    }

    const noFollow = fs.constants.O_NOFOLLOW || 0;
    fd = fs.openSync(abs, fs.constants.O_RDONLY | noFollow);
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || !sameFileStat(pathBefore, before)) {
      return { kind: "unstable", path: relPath };
    }
    const limit = Number(before.size) + 1;
    const bytes = Buffer.allocUnsafe(limit);
    let total = 0;
    while (total < limit) {
      const read = fs.readSync(fd, bytes, total, limit - total, total);
      if (!read) break;
      total += read;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const pathAfter = fs.lstatSync(abs, { bigint: true });
    if (
      total > CLAIM_FILE_MAX_BYTES ||
      BigInt(total) !== after.size ||
      !sameFileStat(before, after) ||
      !sameFileStat(after, pathAfter)
    ) {
      return { kind: "unstable", path: relPath };
    }
    const exact = Buffer.from(bytes.subarray(0, total));
    return {
      kind: "file",
      path: relPath,
      pathStat: pathAfter,
      bytes: exact,
      content: exact.toString("utf8"),
      hash: crypto.createHash("sha1").update(exact).digest("hex").slice(0, 16),
    };
  } catch {
    return { kind: "unstable", path: relPath };
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function verifySnapshot(rootAbs, snapshot) {
  if (!snapshot || !snapshot.kind || typeof snapshot.path !== "string") return false;
  const abs = path.join(rootAbs, snapshot.path);
  try {
    if (snapshot.kind === "missing") {
      try {
        fs.lstatSync(abs, { bigint: true });
        return false;
      } catch (error) {
        if (!error || error.code !== "ENOENT") return false;
      }
      return sameFileStat(snapshot.parentStat, fs.lstatSync(snapshot.parent, { bigint: true }));
    }
    if (snapshot.kind === "file" || snapshot.kind === "not-file") {
      return sameFileStat(snapshot.pathStat, fs.lstatSync(abs, { bigint: true }));
    }
    return false;
  } catch {
    return false;
  }
}

function hashFile(rootAbs, relPath) {
  const snapshot = snapshotFile(rootAbs, relPath);
  return snapshot.kind === "file" && verifySnapshot(rootAbs, snapshot)
    ? snapshot.hash
    : "";
}

function claimId(row) {
  return "c_" + crypto
    .createHash("sha1")
    .update(`${row.path}|${row.symbol || ""}|${row.line || ""}`)
    .digest("hex")
    .slice(0, 10);
}

// Mint claims from the rows actually SERVED to the agent (the persisted injected
// set / capsule files: {path, source, line?, symbol?, region?}). Each claim
// carries the source file's content hash at serve time — the invalidation anchor.
function mintClaims(rootAbs, rows, opts = {}) {
  const nowMs = typeof opts.nowMs === "number" ? opts.nowMs : Date.now();
  const snapshots = new Map();
  const pending = [];
  for (const r of rows || []) {
    if (!r || typeof r.path !== "string") continue;
    let snapshot = snapshots.get(r.path);
    if (!snapshot) {
      snapshot = snapshotFile(rootAbs, r.path);
      snapshots.set(r.path, snapshot);
    }
    // Never persist a claim anchored to missing, over-bound, or unstable
    // bytes. A later hook would otherwise interpret the empty/transient hash as
    // a real generation and manufacture a retraction.
    if (snapshot.kind !== "file") continue;
    pending.push({ snapshot, claim: {
      id: claimId(r),
      subject: {
        path: r.path,
        symbol: r.symbol || null,
        region: r.region || null,
        line: typeof r.line === "number" ? r.line : null,
      },
      predicate: r.symbol ? "defines" : r.region ? "region_at" : "relevant",
      provenance: provenanceOf(r.source),
      // Keep the concrete surfacing signal as well as the coarse provenance.
      // Re-derivation needs to know which extractor can authoritatively answer
      // whether a symbol still exists (for example swift_decl_type vs a text
      // match). Additive for older persisted capsules, which may omit it.
      source: typeof r.source === "string" ? r.source : null,
      fileHash: snapshot.hash,
      servedAt: nowMs,
    } });
  }
  const stable = new Map();
  for (const [relPath, snapshot] of snapshots) {
    stable.set(relPath, snapshot.kind === "file" && verifySnapshot(rootAbs, snapshot));
  }
  return pending
    .filter(({ claim }) => stable.get(claim.subject.path) === true)
    .map(({ claim }) => claim);
}

// Return the line number of the first definition/export anchor that names the
// symbol. These patterns deliberately cover every direct fact class minted by
// the workset: JS/TS declarations, Python definitions, Swift declarations, and
// CommonJS named-export assignments. A matched declaration with no resolvable
// scope still gives us an honest one-line span; it must never be mistaken for a
// removed symbol merely because scope-finder does not parse that language/form.
function definitionLine(content, relPath, symbol) {
  if (typeof content !== "string" || !symbol) return null;
  const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ext = regionsLib.extOf(relPath);
  const defForms = [];
  if (["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"].includes(ext)) {
    // JS/TS declarations. The repeatable prefix accepts combinations such as
    // `export default abstract class` and `export declare interface`.
    defForms.push(
      new RegExp(
        `^\\s*(?:(?:export|default|declare|abstract|async)\\s+)*` +
        `(?:function\\*?\\s+|class\\s+|interface\\s+|type\\s+|enum\\s+|namespace\\s+|` +
        `const\\s+|let\\s+|var\\s+)${esc}\\b`
      ),
      // `foo = function` / `foo: (` (assigned/arrow/method)
      new RegExp(`^\\s*${esc}\\s*[:=]\\s*(?:async\\s+)?(?:function|\\(|[A-Za-z_$])`),
      // CommonJS named exports. `module.exports.foo` is intentionally separate
      // from the extractor's `exports.foo` support: both are common in the wild.
      new RegExp(`^\\s*(?:module\\.)?exports\\.${esc}\\s*=`),
      new RegExp(`^\\s*(?:module\\.)?exports\\[\\s*["']${esc}["']\\s*\\]\\s*=`)
    );
  } else if (ext === "py") {
    defForms.push(new RegExp(`^\\s*(?:async\\s+)?(?:def|class)\\s+${esc}\\b`));
  } else if (ext === "swift") {
    // Access/control/concurrency modifiers may precede the declaration keyword;
    // attributes commonly live on their own prior line.
    defForms.push(
      new RegExp(
        `^\\s*(?:@[A-Za-z_][A-Za-z0-9_.]*(?:\\([^)]*\\))?\\s+)*` +
        `(?:(?:public|private|fileprivate|internal|open|package|final|indirect|` +
        `nonisolated|isolated|distributed|static|mutating|nonmutating|override|required|` +
        `convenience|lazy)\\s+)*(?:struct|class|protocol|enum|actor|extension|typealias|func|let|var)\\s+${esc}\\b`
      )
    );
  } else {
    return null;
  }
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (defForms.some((re) => re.test(lines[i]))) return i + 1;
  }
  // `module.exports` chains are sometimes line-wrapped. Babel's CJS export
  // walker owns `exports.foo` but not `module.exports.foo`, so retain a narrow
  // multiline fallback before concluding the named export disappeared.
  if (["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"].includes(ext)) {
    const cjs = new RegExp(
      `(?:^|\\n)[\\t ]*(?:module\\s*\\.\\s*)?exports\\s*` +
      `(?:\\.\\s*${esc}|\\[\\s*["']${esc}["']\\s*\\])\\s*=`,
      "m"
    );
    const match = cjs.exec(content);
    if (match) {
      const statementIndex = content[match.index] === "\n" ? match.index + 1 : match.index;
      let line = 1;
      for (let i = 0; i < statementIndex; i++) if (content[i] === "\n") line++;
      return line;
    }
  }
  return null;
}

function minimalRegion(symbol, line, kind = "def") {
  return { name: symbol, kind, startLine: line, endLine: line };
}

function hasIdentifierToken(content, symbol) {
  if (typeof content !== "string" || !symbol) return false;
  const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9_$])${esc}(?![A-Za-z0-9_$])`).test(content);
}

// Prefer the repository's real extractors when a declaration was not directly
// locatable. `present` means the fact still exists but its span is unavailable;
// `absent` is authoritative enough to retract it; `unknown` must degrade to a
// CHANGED claim rather than a false INVALIDATED one.
function extractedSymbolPresence(content, relPath, symbol, source) {
  const ext = regionsLib.extOf(relPath);
  try {
    if (["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"].includes(ext)) {
      // Export/re-export claims are exactly the facts the JS/TS extractor owns.
      // The AST helper preserves its null-on-parse-failure contract, which lets
      // us distinguish authoritative absence from an inconclusive parse. Regex
      // fallback may still prove presence, but never removal.
      if (source === "exported_symbol" || source === "reexport_chain") {
        const astExports = require("./extractors/js_ast_exports").extractExportsAST(content, relPath);
        if (Array.isArray(astExports)) {
          if (astExports.some((e) => e && e.name === symbol)) return "present";
          // The export walker intentionally does not model every exotic CJS
          // assignment. Literal absence of the identifier is still proof of
          // removal; a remaining token makes the negative result inconclusive.
          return hasIdentifierToken(content, symbol) ? "unknown" : "absent";
        }
        const fallbackExports = require("./extractor").extractExports(content, ext);
        if (fallbackExports.some((e) => e && e.name === symbol)) return "present";
        return hasIdentifierToken(content, symbol) ? "unknown" : "absent";
      }
      return "unknown";
    }

    if (ext === "swift") {
      const swift = require("./extractors").forExtension("swift");
      if (swift && typeof swift.isReady === "function" && swift.isReady()) {
        const before = typeof swift.getCounters === "function" ? swift.getCounters() : null;
        const decls = require("./extractor").extractDeclarations(content, ext);
        if (decls.some((d) => d && d.name === symbol)) return "present";
        const after = typeof swift.getCounters === "function" ? swift.getCounters() : null;
        if (
          before && after &&
          after.filesParsedOk > before.filesParsedOk &&
          after.filesParseErrors === before.filesParseErrors &&
          after.filesUnsupportedConstructs === before.filesUnsupportedConstructs
        ) {
          return "absent";
        }
        return "unknown";
      }
      // Parser initialization is asynchronous in a hook process. For claims
      // known to come from the Swift declaration index, literal absence of the
      // identifier still proves removal. If the token remains in an unsupported
      // declaration form (or merely as a use), the result is inconclusive and
      // must degrade to CHANGED rather than a false retraction.
      if (source === "swift_decl_type" || source === "swift_decl_other") {
        return hasIdentifierToken(content, symbol) ? "unknown" : "absent";
      }
      return "unknown";
    }

    if (ext === "py") {
      // Python direct exported-symbol claims are normally top-level def/class
      // facts. Without an AST result, only literal identifier absence proves
      // removal; otherwise retain the conservative CHANGED fallback.
      if (source === "exported_symbol") {
        return hasIdentifierToken(content, symbol) ? "unknown" : "absent";
      }
      return "unknown";
    }
  } catch {
    return "unknown";
  }
  return "unknown";
}

// Capsules written before `source` was added still carry the coarser direct
// provenance. Recover the only authoritative source family for the file type so
// true removals keep invalidating across an in-place upgrade.
function claimSourceForRederivation(claim) {
  if (claim && typeof claim.source === "string" && claim.source) return claim.source;
  if (!claim || claim.provenance !== "direct" || !claim.subject) return null;
  const ext = regionsLib.extOf(claim.subject.path);
  if (ext === "swift") return "swift_decl_other";
  if (["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "py"].includes(ext)) {
    return "exported_symbol";
  }
  return null;
}

// Locate a symbol's DEFINITION region in the current file (used to re-derive a
// moved span). Real declaration syntax → line → scope-finder region, with a
// one-line fallback for forms scope-finder does not model (Swift, TS type forms,
// CommonJS assignments). null means only "span unavailable"; diffClaims decides
// separately whether extraction proves the symbol was actually removed.
function locateSymbolRegionInContent(relPath, symbol, content) {
  if (!symbol) return null;
  const line = definitionLine(content, relPath, symbol);
  if (line == null) return null;
  const region = regionsLib.resolveRegionInContent(relPath, content, line, { allowSpawn: false });
  if (region && region.name === symbol) return region;
  return minimalRegion(symbol, line);
}

function locateSymbolRegion(rootAbs, relPath, symbol) {
  const snapshot = snapshotFile(rootAbs, relPath);
  if (snapshot.kind !== "file") return null;
  const region = locateSymbolRegionInContent(relPath, symbol, snapshot.content);
  return verifySnapshot(rootAbs, snapshot) ? region : null;
}

function spanStr(region, line) {
  if (region && Number.isFinite(region.startLine)) {
    return Number.isFinite(region.endLine) && region.endLine !== region.startLine
      ? `L${region.startLine}–${region.endLine}`
      : `L${region.startLine}`;
  }
  return Number.isFinite(line) ? `L${line}` : "?";
}

// Re-check prior served claims against the current repo. Returns
// { unchanged, changed, invalidated }. A claim whose source file is byte-identical
// to serve time is unchanged (cheap hash gate); a changed file triggers re-
// derivation — a moved symbol span → changed(from→to), a vanished symbol → invalidated.
function diffClaims(rootAbs, priorClaims) {
  const out = { unchanged: [], changed: [], invalidated: [], unknown: [] };
  const byPath = new Map();
  const staged = [];
  for (const c of priorClaims || []) {
    if (!c || !c.subject || typeof c.subject.path !== "string") continue;
    if (!byPath.has(c.subject.path)) byPath.set(c.subject.path, []);
    byPath.get(c.subject.path).push(c);
  }

  for (const [relPath, claims] of byPath) {
    const snapshot = snapshotFile(rootAbs, relPath);
    const local = { unchanged: [], changed: [], invalidated: [] };

    if (snapshot.kind === "missing") {
      for (const claim of claims) local.invalidated.push({ claim, reason: "file_removed" });
    } else if (snapshot.kind === "file") {
      for (const c of claims) {
        if (snapshot.hash === c.fileHash) {
          local.unchanged.push(c);
          continue;
        }
        // File changed since served → re-derive from the SAME bytes that made
        // snapshot.hash. Reopening here would mix generations.
        if (c.subject.symbol) {
          const loc = locateSymbolRegionInContent(
            c.subject.path,
            c.subject.symbol,
            snapshot.content
          );
          if (!loc) {
            const presence = extractedSymbolPresence(
              snapshot.content,
              c.subject.path,
              c.subject.symbol,
              claimSourceForRederivation(c)
            );
            if (presence === "absent") {
              local.invalidated.push({ claim: c, reason: "symbol_removed" });
            } else {
              // The extractor still sees the symbol, or no authoritative
              // extractor owns this claim form. Losing a span is not evidence
              // of removal; degrade to a coarse CHANGED fact.
              local.changed.push({
                claim: c,
                from: spanStr(c.subject.region, c.subject.line),
                to: presence === "present" ? "present (span unavailable)" : "span unavailable",
                reason: "span_unresolved",
              });
            }
            continue;
          }
          const from = spanStr(c.subject.region, c.subject.line);
          const to = spanStr(loc, loc.startLine);
          if (from !== to) local.changed.push({ claim: c, from, to });
          else local.unchanged.push(c); // bytes moved elsewhere; span held
        } else {
          local.changed.push({ claim: c, from: "as served", to: "file changed" });
        }
      }
    }

    staged.push({ claims, snapshot, local });
  }

  // Final whole-diff evidence pass: an early path can move while claims for a
  // later path are being re-derived. Do not publish any staged finding until
  // every path has had its inode/ctime/path evidence checked at the return
  // boundary.
  for (const { claims, snapshot, local } of staged) {
    if (
      (snapshot.kind !== "file" && snapshot.kind !== "missing") ||
      !verifySnapshot(rootAbs, snapshot)
    ) {
      for (const claim of claims) out.unknown.push({ claim, reason: "file_unstable" });
    } else {
      out.unchanged.push(...local.unchanged);
      out.changed.push(...local.changed);
      out.invalidated.push(...local.invalidated);
    }
  }
  return out;
}

// Render the inner text of a <sextant-context-delta> (facts only, no imperatives
// — the orient/subagent discipline). Returns "" when there's nothing to retract.
function renderContextDelta(diff) {
  if (!diff || (!diff.changed.length && !diff.invalidated.length)) return "";
  const lines = ["Since this task was last oriented, sextant re-checked the facts it gave you:"];
  if (diff.invalidated.length) {
    lines.push("INVALIDATED (no longer holds):");
    for (const x of diff.invalidated.slice(0, 10)) {
      const s = x.claim.subject;
      if (x.reason === "symbol_removed") {
        lines.push(`- ${s.path}: ${s.symbol} — definition no longer found (file changed)`);
      } else {
        lines.push(`- ${s.path} — file removed since served`);
      }
    }
  }
  if (diff.changed.length) {
    lines.push("CHANGED (re-derived):");
    for (const x of diff.changed.slice(0, 10)) {
      const s = x.claim.subject;
      if (s.symbol) lines.push(`- ${s.path}: ${s.symbol} span ${x.from} → ${x.to}`);
      else lines.push(`- ${s.path} — changed since served`);
    }
  }
  return lines.join("\n");
}

module.exports = {
  provenanceOf,
  hashFile,
  claimId,
  mintClaims,
  locateSymbolRegion,
  diffClaims,
  renderContextDelta,
};
