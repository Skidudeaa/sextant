const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const intel = require("../lib/intel");
const { deriveSessionKey } = require("../lib/session");
const { stripUnsafeXmlTags, renderStatusLine, readStdinJson } = require("../lib/cli");

async function run() {
  const root = process.cwd();
  const summaryPath = path.join(root, ".planning", "intel", "summary.md");

  const data = await readStdinJson();

  if (!fs.existsSync(summaryPath)) process.exit(0);

  const summary = fs.readFileSync(summaryPath, "utf8").trim();
  if (!summary) process.exit(0);

  // Per-session dedupe: derive session key from hook payload or env
  const sessionKey = deriveSessionKey(data);

  const cachePath = path.join(
    root,
    ".planning",
    "intel",
    `.last_injected_hash.${sessionKey}`
  );

  const h = crypto.createHash("sha256").update(summary).digest("hex");
  const last = fs.existsSync(cachePath)
    ? fs.readFileSync(cachePath, "utf8").trim()
    : "";

  // Only inject if changed since last injection for this session
  const changed = last !== h;

  // stderr → status line visible to user on every prompt
  try {
    const health = await intel.health(root);
    process.stderr.write(renderStatusLine(health, changed, root) + "\n");
  } catch {}

  if (!changed) process.exit(0);

  fs.writeFileSync(cachePath, h);

  // stdout → Claude context (only when changed)
  const safeRefresh = stripUnsafeXmlTags(summary);
  process.stdout.write(
    `<codebase-intelligence>\n(refreshed: ${new Date().toISOString()})\n${safeRefresh}\n</codebase-intelligence>`
  );
  process.exit(0);
}

module.exports = { run };
