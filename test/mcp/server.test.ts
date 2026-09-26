import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = fileURLToPath(
  new URL("../../src/mcp/server.ts", import.meta.url),
);
const tsxPath = fileURLToPath(
  new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url),
);

let client: Client;
let projectRoot: string;

function firstText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  assert(Array.isArray(result.content), "Expected tool content to be an array");

  const firstContent: unknown = result.content[0];
  assert(
    typeof firstContent === "object" && firstContent !== null,
    "Expected the tool to return content",
  );
  assert("type" in firstContent, "Expected tool content to have a type");
  assert.equal(firstContent.type, "text");
  assert("text" in firstContent, "Expected text content to contain text");
  if (typeof firstContent.text !== "string") {
    assert.fail("Expected tool text to be a string");
  }

  return firstContent.text;
}

before(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "sharelane-test-"));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxPath, serverPath],
    cwd: projectRoot,
    env: {
      ...getDefaultEnvironment(),
      SHARELANE_AGENT: "test-agent",
    },
  });

  client = new Client({ name: "sharelane-test", version: "0.1.0" });
  await client.connect(transport);
});

after(async () => {
  await client.close();
  await rm(projectRoot, { recursive: true, force: true });
});

test("lists all tools through Phase 1", async () => {
  const result = await client.listTools();
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    [
      "ping",
      "whoami",
      "note",
      "notes",
      "context_map",
      "read_chunk",
      "update_chunk",
      "search",
      "log_progress",
    ],
  );

  const tools = new Map(result.tools.map((tool) => [tool.name, tool]));
  assert.equal(tools.get("context_map")?.annotations?.readOnlyHint, true);
  assert.equal(tools.get("search")?.annotations?.openWorldHint, false);
  assert.equal(tools.get("update_chunk")?.annotations?.readOnlyHint, false);
  assert.equal(tools.get("update_chunk")?.annotations?.destructiveHint, true);
  assert.equal(tools.get("log_progress")?.annotations?.destructiveHint, false);
});

test("ping and whoami return the expected values", async () => {
  const ping = await client.callTool({
    name: "ping",
    arguments: { name: "Manthan" },
  });
  const whoami = await client.callTool({ name: "whoami", arguments: {} });

  assert.equal(firstText(ping), "pong from ShareLane, hello Manthan");
  assert.equal(firstText(whoami), "test-agent");
});

test("note writes shared state that notes reads back", async () => {
  const empty = await client.callTool({ name: "notes", arguments: {} });
  assert.equal(firstText(empty), "No shared notes yet.");

  const saved = await client.callTool({
    name: "note",
    arguments: { text: "Claude left this for Codex." },
  });
  assert.equal(firstText(saved), "Saved note: Claude left this for Codex.");

  const notes = await client.callTool({ name: "notes", arguments: {} });
  assert.equal(firstText(notes), "Claude left this for Codex.");

  const fileContents = await readFile(
    join(projectRoot, ".sharelane", "notes.txt"),
    "utf8",
  );
  assert.equal(fileContents, "Claude left this for Codex.\n");
});

test("Phase 1 context tools update, read, search, and journal shared memory", async () => {
  const map = await client.callTool({ name: "context_map", arguments: {} });
  assert.match(firstText(map), /# ShareLane context map/);

  const updated = await client.callTool({
    name: "update_chunk",
    arguments: {
      id: "architecture",
      content: "# Architecture\n\nThe MCP pipeline uses a silver compass.",
      title: "Architecture",
      readWhen: "Working on MCP message flow.",
      coversFiles: ["src/mcp/**"],
    },
  });
  assert.match(firstText(updated), /MAP\.md and search index regenerated/);

  const chunk = await client.callTool({
    name: "read_chunk",
    arguments: { id: "architecture" },
  });
  assert.match(firstText(chunk), /silver compass/);

  const search = await client.callTool({
    name: "search",
    arguments: { query: "silver compass" },
  });
  assert.match(firstText(search), /chunk:architecture/);

  const progress = await client.callTool({
    name: "log_progress",
    arguments: {
      task: "mcp-test",
      note: "Verified the amber journal marker.",
    },
  });
  assert.match(firstText(progress), /as test-agent/);

  const journalSearch = await client.callTool({
    name: "search",
    arguments: { query: "amber journal" },
  });
  assert.match(firstText(journalSearch), /journal:journal\//);
});

test("update_chunk returns the compaction message through MCP at the size cap", async () => {
  const result = await client.callTool({
    name: "update_chunk",
    arguments: {
      id: "architecture",
      content: "x".repeat(12_001),
    },
  });

  assert.equal(result.isError, true);
  assert.match(firstText(result), /compact this first/i);
});
