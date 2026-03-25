const fs = require("fs");
const path = require("path");
const intel = require("../lib/intel");

// WHY: .mcp.json registers the sextant MCP server with Claude Code.
// Written once on init if it doesn't exist; never overwritten to avoid
// clobbering user customizations to their MCP config.
const MCP_TEMPLATE = {
  mcpServers: {
    sextant: {
      type: "stdio",
      command: "sextant",
      args: ["mcp"],
    },
  },
};

function ensureMcpJson(root) {
  const p = path.join(root, ".mcp.json");
  if (fs.existsSync(p)) return;
  fs.writeFileSync(p, JSON.stringify(MCP_TEMPLATE, null, 2) + "\n");
}

async function run(ctx) {
  for (const r of ctx.roots) {
    await intel.init(r);
    ensureMcpJson(r);
  }
}

module.exports = { run, ensureMcpJson };
