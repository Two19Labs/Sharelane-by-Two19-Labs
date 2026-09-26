import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  contextMap,
  logProgress,
  searchMemory,
} from "../core/memory.js";
import { readChunk, updateChunk } from "../core/context.js";
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

server.registerTool(
  "context_map",
  {
    description:
      "Read the generated map of this project's shared context and see which chunks are relevant or stale.",
  },
  async () => ({
    content: [{ type: "text", text: contextMap() }],
  }),
);

server.registerTool(
  "read_chunk",
  {
    description:
      "Read one shared context chunk after choosing it from the context map.",
    inputSchema: {
      id: z
        .string()
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        .describe("Chunk id, such as architecture or api"),
    },
  },
  async ({ id }) => ({
    content: [{ type: "text", text: readChunk(id) }],
  }),
);

server.registerTool(
  "update_chunk",
  {
    description:
      "Create or update one context chunk. This also refreshes MAP.md and the full-text search index.",
    inputSchema: {
      id: z
        .string()
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        .describe("Stable lowercase chunk id"),
      content: z.string().describe("Markdown body for the chunk"),
      title: z.string().trim().min(1).optional().describe("Human-readable title"),
      readWhen: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("When another agent should read this chunk"),
      coversFiles: z
        .array(z.string().trim().min(1))
        .optional()
        .describe("Project-relative files or glob patterns covered by the chunk"),
    },
  },
  async ({ id, content, title, readWhen, coversFiles }) => {
    const chunk = updateChunk({ id, content, title, readWhen, coversFiles });
    return {
      content: [
        {
          type: "text",
          text: `Updated context chunk "${chunk.title}" (${chunk.id}). MAP.md and search index regenerated.`,
        },
      ],
    };
  },
);

server.registerTool(
  "search",
  {
    description:
      "Full-text search across shared context chunks and progress journal entries.",
    inputSchema: {
      query: z.string().trim().min(1).describe("Words to find"),
      limit: z.number().int().min(1).max(20).optional().describe("Maximum results"),
    },
  },
  async ({ query, limit }) => {
    const results = searchMemory(query, limit);
    const text =
      results.length === 0
        ? `No shared context matched "${query}".`
        : results
            .map(
              (result, index) =>
                `${index + 1}. [${result.kind}:${result.reference}] ${result.title}\n${result.snippet}`,
            )
            .join("\n\n");
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "log_progress",
  {
    description:
      "Add a dated progress note to the shared journal so work can be searched and handed off.",
    inputSchema: {
      task: z.string().trim().min(1).describe("Task name or id"),
      note: z.string().trim().min(1).describe("Concise progress update"),
    },
  },
  async ({ task, note }) => {
    const entry = logProgress(task, note);
    return {
      content: [
        {
          type: "text",
          text: `Logged progress for "${entry.task}" as ${entry.agent} at ${entry.createdAt}.`,
        },
      ],
    };
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error("ShareLane MCP server failed to start:", error);
  process.exitCode = 1;
});
