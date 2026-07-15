"use strict";

// ANTI-SPRAWL CONTROLLER (docs/030 Phase E).
//
// The user's ORIGINAL complaint: coding agents proliferate scripts/files instead
// of extending what exists. When an agent creates a NEW source file, sextant
// surfaces the existing files whose names/symbols already match — so "add a
// parallel implementation" becomes a visible choice, not a default. Non-blocking,
// once-per-path, factual. Whether it REDUCES sprawl is measured two ways: live
// (did the agent open a suggested existing file? — scored via the blast-radius
// open-attribution lane, source "sprawl_match") and offline (analyzeSprawlHistory
// mines git for source files created then abandoned — the baseline the nudge
// aims to lower). Never throws.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { isIndexable, normalizeRelPath } = require("./utils");
const { isTestPath } = require("./retrieve");

function typeOf(relPath) {
  const i = String(relPath || "").lastIndexOf(".");
  return i >= 0 ? relPath.slice(i + 1).toLowerCase() : "";
}

// Tokenize a filename stem: split on separators AND camelCase; keep >=3-char
// alphabetic tokens (drop noise like "js", numbers).
function stemTokens(relPath) {
  const base = path.basename(String(relPath || ""));
  const stem = base.replace(/\.[^.]+$/, "");
  return [
    ...new Set(
      stem
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .split(/[^A-Za-z]+/)
        .map((t) => t.toLowerCase())
        .filter((t) => t.length >= 3)
    ),
  ];
}

// A new source file = indexable AND not yet in the graph (the watcher hasn't
// indexed it; at PostToolUse time a just-Written file is typically absent).
function isNewSourceFile(graph, db, relPath) {
  try {
    return isIndexable(relPath) && !graph.getFileMeta(db, relPath);
  } catch {
    return false;
  }
}

// Existing files whose name-tokens or exported symbols match the new file —
// candidates it might be duplicating. Excludes the new file itself and tests.
// Returns [{path, reason}] (top 3).
function findExistingMatches(graph, db, relPath, content) {
  try {
    const terms = new Set(stemTokens(relPath));
    if (typeof content === "string" && content) {
      try {
        const { extractExports } = require("./extractor");
        for (const e of extractExports(content, typeOf(relPath))) {
          if (e && !e.from && e.name && e.name.length >= 3 && e.name !== "default") terms.add(e.name);
        }
      } catch {}
    }
    const termList = [...terms];
    if (!termList.length) return [];
    const gr = require("./graph-retrieve").graphRetrieve(db, termList, { maxResults: 8 });
    const self = normalizeRelPath(relPath);
    const out = [];
    for (const f of (gr && gr.files) || []) {
      if (!f || typeof f.path !== "string") continue;
      if (f.path === self || f.path === relPath) continue;
      if (isTestPath(f.path)) continue;
      out.push({ path: f.path, reason: f.hitType || "match" });
      if (out.length >= 3) break;
    }
    return out;
  } catch {
    return [];
  }
}

// Factual note (facts + one soft framing line — not an imperative). The channel
// discounts command-shaped text; "these already exist" survives that posture.
function composeSprawlNote(relPath, matches) {
  const list = matches.map((m) => m.path).join(", ");
  return (
    `New file added: ${relPath}. Existing indexed files with matching names or symbols: ${list}. ` +
    `If one of these already covers this, extending it avoids a parallel implementation.`
  );
}

// OFFLINE sprawl baseline (the KILL-criterion instrument): mine git history for
// source files ADDED and later DELETED within `withinCommits` commits — the
// create-then-abandon rate the nudge aims to reduce. Deterministic, read-only.
function analyzeSprawlHistory(rootAbs, opts = {}) {
  const withinCommits = opts.withinCommits || 10;
  const maxCommits = opts.maxCommits || 2000;
  const empty = { addedSourceFiles: 0, abandonedWithin: 0, abandonRate: null, withinCommits, examples: [] };
  try {
    // Oldest→newest list of commits with their added/deleted source files.
    const out = spawnSync(
      "git",
      ["log", "--reverse", `-n${maxCommits}`, "--no-merges", "--diff-filter=AD", "--name-status", "--format=@@%H"],
      { cwd: rootAbs, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
    );
    if (out.status !== 0 || !out.stdout) return empty;

    // Build a per-file event list: { path, addIdx, delIdx } by commit index.
    const added = new Map(); // path → commit index of its (latest) addition
    const events = []; // { path, type: 'A'|'D', idx }
    let idx = -1;
    for (const line of out.stdout.split("\n")) {
      if (line.startsWith("@@")) {
        idx++;
        continue;
      }
      const m = /^([AD])\t(.+)$/.exec(line);
      if (!m) continue;
      const type = m[1];
      const p = m[2].trim();
      if (!isIndexable(p) || isTestPath(p)) continue;
      events.push({ path: p, type, idx });
    }

    let addedCount = 0;
    let abandoned = 0;
    const examples = [];
    for (const ev of events) {
      if (ev.type === "A") {
        added.set(ev.path, ev.idx);
        addedCount++;
      } else if (ev.type === "D") {
        const addIdx = added.get(ev.path);
        if (addIdx != null && ev.idx - addIdx <= withinCommits) {
          abandoned++;
          if (examples.length < 10) examples.push({ path: ev.path, lifespanCommits: ev.idx - addIdx });
        }
        added.delete(ev.path);
      }
    }
    return {
      addedSourceFiles: addedCount,
      abandonedWithin: abandoned,
      abandonRate: addedCount ? +(abandoned / addedCount).toFixed(3) : null,
      withinCommits,
      examples,
    };
  } catch {
    return empty;
  }
}

module.exports = {
  stemTokens,
  isNewSourceFile,
  findExistingMatches,
  composeSprawlNote,
  analyzeSprawlHistory,
};
