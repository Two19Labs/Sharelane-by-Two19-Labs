import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "sharelane",
  version: "0.1.0",
});

server.registerTool(
  "ping",
  {
    description: "Check that ShareLane is reachable and return a greeting.",
    inputSchema: {
      name: z.string().min(1).describe("Name to greet"),
    },
  },
  async ({ name }) => ({
    content: [
      {
        type: "text",
        text: `pong from ShareLane, hello ${name}`,
      },
    ],
  }),
);

server.registerTool(
  "whoami",
  {
    description: "Return the name of the agent connected to ShareLane.",
  },
  async () => ({
    content: [
      {
        type: "text",
        text: process.env.SHARELANE_AGENT?.trim() || "unknown",
      },
    ],
  }),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error("ShareLane MCP server failed to start:", error);
  process.exitCode = 1;
});
