const fs = require("fs");
const path = require("path");
const intel = require("../lib/intel");

// WHY: .mcp.json registers the sextant MCP server with Claude Code.
// Merges into existing file to avoid clobbering other MCP servers.
const SEXTANT_MCP_ENTRY = {
  type: "stdio",
  command: "sextant",
  args: ["mcp"],
};

function ensureMcpJson(root) {
  const p = path.join(root, ".mcp.json");
  let existing = {};
  if (fs.existsSync(p)) {
    try { existing = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  }
  if (existing?.mcpServers?.sextant) return; // already registered
  existing.mcpServers = existing.mcpServers || {};
  existing.mcpServers.sextant = SEXTANT_MCP_ENTRY;
  fs.writeFileSync(p, JSON.stringify(existing, null, 2) + "\n");
}

async function run(ctx) {
  for (const r of ctx.roots) {
    await intel.init(r);
    ensureMcpJson(r);
  }
}

module.exports = { run, ensureMcpJson };
