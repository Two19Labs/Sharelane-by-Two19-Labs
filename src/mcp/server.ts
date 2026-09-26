import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { appendNote, readNotes } from "../core/notes.js";

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

server.registerTool(
  "note",
  {
    description: "Append a note to this project's shared ShareLane notebook.",
    inputSchema: {
      text: z.string().trim().min(1).describe("Note to share with other agents"),
    },
  },
  async ({ text }) => {
    await appendNote(text);

    return {
      content: [
        {
          type: "text",
          text: `Saved note: ${text}`,
        },
      ],
    };
  },
);

server.registerTool(
  "notes",
  {
    description: "Read all notes from this project's shared ShareLane notebook.",
  },
  async () => ({
    content: [
      {
        type: "text",
        text: await readNotes(),
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
