"use strict";

// Atomic commit marker binding summary.md bytes to one persisted graph
// generation and its repository freshness anchors. graph.db and summary.md are
// separate files, so checking either one alone permits a mixed H0/H1 read while
// a scan or watcher publishes the other.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MANIFEST_NAME = ".summary-manifest.json";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function manifestPath(root) {
  return path.join(root, ".planning", "intel", MANIFEST_NAME);
}

function validManifest(value) {
  return !!(
    value &&
    value.schemaVersion === 1 &&
    typeof value.graphGeneration === "string" &&
    value.graphGeneration.length > 0 &&
    typeof value.head === "string" &&
    typeof value.statusHash === "string" &&
    /^[0-9a-f]{64}$/.test(value.summaryHash || "")
  );
}

async function writeManifest(root, rawSummary, { db, graph, expectedGraphBinding = null }) {
  const target = manifestPath(root);
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    const dbBinding = graphBindingFromDb(db, graph);
    if (expectedGraphBinding && !sameGraphBinding(expectedGraphBinding, dbBinding)) return false;
    // When a verified renderer supplies its generation, stamp exactly that
    // immutable token rather than re-reading a potentially mutable db object
    // field-by-field after the publication fence.
    const binding = expectedGraphBinding || dbBinding;
    const manifest = {
      schemaVersion: 1,
      graphGeneration: binding.graphGeneration,
      head: binding.head,
      statusHash: binding.statusHash,
      summaryHash: sha256(Buffer.from(rawSummary, "utf8")),
      createdAt: Date.now(),
    };
    if (!validManifest(manifest)) return false;
    await fs.promises.writeFile(tmp, JSON.stringify(manifest), { flag: "wx" });
    await fs.promises.rename(tmp, target);
    return true;
  } catch {
    try { await fs.promises.rm(tmp, { force: true }); } catch {}
    return false;
  }
}

// Read manifest-summary-manifest. An atomic manifest rename is the publication
// boundary; identical outer reads plus the content hash prove the returned
// bytes belong to that exact committed generation.
function readBoundSummary(root) {
  try {
    const target = manifestPath(root);
    const summaryPath = path.join(root, ".planning", "intel", "summary.md");
    const before = fs.readFileSync(target, "utf8");
    const manifest = JSON.parse(before);
    if (!validManifest(manifest)) return null;
    const rawSummary = fs.readFileSync(summaryPath, "utf8");
    const after = fs.readFileSync(target, "utf8");
    if (before !== after) return null;
    if (sha256(Buffer.from(rawSummary, "utf8")) !== manifest.summaryHash) return null;
    return { manifest, rawSummary, manifestBytes: before };
  } catch {
    return null;
  }
}

function matchesFreshness(bound, result) {
  if (!bound || !result || result.fresh !== true || !result.validatedRepo) return false;
  const manifest = bound.manifest;
  return (
    manifest.graphGeneration === result.graphGeneration &&
    manifest.head === (result.validatedRepo.head ?? "") &&
    manifest.statusHash === (result.validatedRepo.statusHash ?? "")
  );
}

async function readGraphBinding(root) {
  try {
    const graph = require("./graph");
    return await graph.readPersistedGraphBinding(root);
  } catch {
    return null;
  }
}

function matchesGraphBinding(bound, graphBinding) {
  if (!bound || !graphBinding) return false;
  const manifest = bound.manifest;
  return (
    manifest.graphGeneration === graphBinding.graphGeneration &&
    manifest.head === graphBinding.head &&
    manifest.statusHash === graphBinding.statusHash
  );
}

function sameGraphBinding(left, right) {
  return !!(
    left && right &&
    left.graphGeneration && left.graphGeneration === right.graphGeneration &&
    left.head === right.head && left.statusHash === right.statusHash
  );
}

function graphBindingFromDb(db, graph) {
  return {
    graphGeneration: graph.getMetaValue(db, "graph_generation") || "",
    head: graph.getMetaValue(db, "scanned_head") || "",
    statusHash: graph.getMetaValue(db, "scanned_status_hash") || "",
  };
}

function matchesRepoBinding(binding, repoState) {
  return !!(
    binding && repoState &&
    binding.head && binding.head === repoState.head &&
    binding.statusHash && binding.statusHash === repoState.statusHash
  );
}

// Render only from one immutable capture of every repository-live summary
// input. A second capture around the pure render detects a changed input even
// when the coarse HEAD/status fingerprint has returned to its original value
// (the package.json temporary-edit/restore ABA). Graph and repository anchors
// fence the same interval. Null means fail closed: callers must not publish.
async function renderVerifiedSummary(root, { db, graph }) {
  try {
    const freshness = require("./freshness");
    const summary = require("./summary");
    const initial = Object.freeze(graphBindingFromDb(db, graph));
    if (!initial.graphGeneration || !initial.head || !initial.statusHash) return null;
    if (!sameGraphBinding(initial, await readGraphBinding(root))) return null;

    const repoBefore = freshness.captureCurrentState(root);
    if (!matchesRepoBinding(initial, repoBefore)) return null;

    const inputs = summary.captureSummaryInputs(root, { db, graph });
    const rawSummary = summary.writeSummaryMarkdown(root, { db, graph, inputs });
    const verificationInputs = summary.captureSummaryInputs(root, { db, graph });
    const repoAfter = freshness.captureCurrentState(root);
    const graphAfter = await readGraphBinding(root);
    if (
      !summary.sameSummaryInputs(inputs, verificationInputs) ||
      !matchesRepoBinding(initial, repoAfter) ||
      !sameGraphBinding(initial, graphAfter)
    ) return null;

    return { rawSummary, graphBinding: initial };
  } catch {
    return null;
  }
}

// Final publication fence, called after summary.md's atomic rename and before
// the manifest commit marker. If either substrate moved, the old manifest no
// longer authenticates the new bytes and readers fail closed until retry.
async function verifiedSummaryStillCurrent(root, graphBinding) {
  try {
    const freshness = require("./freshness");
    return (
      sameGraphBinding(graphBinding, await readGraphBinding(root)) &&
      matchesRepoBinding(graphBinding, freshness.captureCurrentState(root))
    );
  } catch {
    return false;
  }
}

// Repair a missing/corrupt manifest by regenerating the markdown from the
// currently persisted graph, never by blessing arbitrary existing bytes. The
// graph token is checked on both sides of the summary rename; any concurrent
// graph publication leaves the result unbound and a later turn retries.
async function repairBoundSummary(root) {
  const target = path.join(root, ".planning", "intel", "summary.md");
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.repair.tmp`;
  try {
    const graph = require("./graph");
    const db = await graph.loadDb(root);
    const prepared = await renderVerifiedSummary(root, { db, graph });
    if (!prepared) return false;
    await fs.promises.writeFile(tmp, prepared.rawSummary, { flag: "wx" });
    await fs.promises.rename(tmp, target);
    if (!await verifiedSummaryStillCurrent(root, prepared.graphBinding)) return false;
    return writeManifest(root, prepared.rawSummary, {
      db,
      graph,
      expectedGraphBinding: prepared.graphBinding,
    });
  } catch {
    try { await fs.promises.rm(tmp, { force: true }); } catch {}
    return false;
  }
}

module.exports = {
  MANIFEST_NAME,
  manifestPath,
  writeManifest,
  readBoundSummary,
  matchesFreshness,
  readGraphBinding,
  matchesGraphBinding,
  renderVerifiedSummary,
  verifiedSummaryStillCurrent,
  repairBoundSummary,
};
