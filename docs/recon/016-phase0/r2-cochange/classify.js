#!/usr/bin/env node
/**
 * Classifies co-change pairs as junk vs source, using sextant-style conventions:
 * - lockfiles: package-lock.json, yarn.lock, pnpm-lock.yaml, Cargo.lock, poetry.lock, Gemfile.lock
 * - docs/changelogs: *.md (README, CHANGELOG, docs/**), todos.md
 * - planning/state dirs: .planning/, docs/plans/
 * - generated/fixture data: *.json under docs/api_fixtures, *.lock, dist/, build/
 * - non-indexable per sextant conventions (roughly: not .js/.ts/.py/.swift/... source)
 *
 * Reports junk fraction of top-50 pairs pre-filter, and what remains post a
 * "simple filter" (exclude pairs where EITHER side is junk-classified).
 * Test-file pairs are explicitly kept (not junk) per task instructions.
 */

const fs = require('fs');
const path = require('path');

const JUNK_PATTERNS = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)Gemfile\.lock$/,
  /\.md$/i, // README, CHANGELOG, docs/*, todos.md, AGENTS.md, plans
  /(^|\/)\.planning\//,
  /(^|\/)docs\//,
  /(^|\/)todos\.md$/i,
  /\.json$/i, // fixture/generated data blobs (broad but matches observed junk in top pairs)
  /(^|\/)\.env(\.|$)/,
  /(^|\/)requirements\.txt$/,
  /\.pickle$/i,
  /\.pyc$/i,
  /(^|\/)__pycache__\//,
  /(^|\/)\.gitignore$/,
];

function isJunk(f) {
  return JUNK_PATTERNS.some((re) => re.test(f));
}

function isTestFile(f) {
  return /(^|\/)(tests?|__tests__)\//.test(f) || /(\.|_)test\.[a-z]+$/.test(f) || /(^|\/)test_[^/]+\.py$/.test(f);
}

function classifyPair(p) {
  const aJunk = isJunk(p.a);
  const bJunk = isJunk(p.b);
  return { aJunk, bJunk, anyJunk: aJunk || bJunk, bothSource: !aJunk && !bJunk };
}

function main() {
  const repoArg = process.argv[2];
  const jsonPath = path.resolve(repoArg);
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const top50 = data.top50;

  let junkCount = 0;
  const sourcePairs = [];
  const testPairs = [];
  for (const p of top50) {
    const c = classifyPair(p);
    if (c.anyJunk) junkCount++;
    else {
      sourcePairs.push(p);
      if (isTestFile(p.a) || isTestFile(p.b)) testPairs.push(p);
    }
  }

  console.log(`=== ${data.repo} ===`);
  console.log(`top50 pairs: ${top50.length}`);
  console.log(`junk-involved pairs: ${junkCount} (${((junkCount / top50.length) * 100).toFixed(0)}%)`);
  console.log(`source-only pairs (post-filter): ${sourcePairs.length} (${((sourcePairs.length / top50.length) * 100).toFixed(0)}%)`);
  console.log(`  of which involve a test file: ${testPairs.length}`);
  console.log(`\nSource-only pairs (post-filter), in original rank order:`);
  for (const p of sourcePairs) {
    console.log(`  count=${p.count.toString().padStart(3)} conf=${p.confidence.toFixed(2)}  ${p.a}  <->  ${p.b}`);
  }
}

main();
