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

test("lists all Phase 0 tools", async () => {
  const result = await client.listTools();
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    ["ping", "whoami", "note", "notes"],
  );
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
