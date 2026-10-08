import { realpathSync } from "node:fs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { createNotice } from "../../src/core/notices.js";

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

test("lists context tools, collision controls, and Phase 5 handoff tools", async () => {
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
      "claim",
      "heartbeat",
      "release",
      "delegate",
      "status",
      "wait",
      "reply",
      "cancel",
      "usage",
      "reassign",
      "log_progress",
      "run_check",
    ],
  );

  const tools = new Map(result.tools.map((tool) => [tool.name, tool]));
  assert.equal(tools.get("context_map")?.annotations?.readOnlyHint, true);
  assert.equal(tools.get("search")?.annotations?.openWorldHint, false);
  assert.equal(tools.get("update_chunk")?.annotations?.readOnlyHint, false);
  assert.equal(tools.get("update_chunk")?.annotations?.destructiveHint, true);
  assert.equal(tools.get("log_progress")?.annotations?.destructiveHint, false);
  assert.equal(tools.get("delegate")?.annotations?.readOnlyHint, false);
  assert.equal(tools.get("delegate")?.annotations?.destructiveHint, true);
  assert.equal(tools.get("status")?.annotations?.readOnlyHint, true);
  assert.equal(tools.get("wait")?.annotations?.readOnlyHint, true);
  assert.equal(tools.get("reply")?.annotations?.destructiveHint, true);
  assert.equal(tools.get("cancel")?.annotations?.destructiveHint, true);
  assert.equal(tools.get("claim")?.annotations?.destructiveHint, false);
  assert.equal(tools.get("heartbeat")?.annotations?.idempotentHint, true);
  assert.equal(tools.get("release")?.annotations?.idempotentHint, true);
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

test("claim tools work through MCP and pending notices ride on the next reply", async () => {
  const claimed = await client.callTool({
    name: "claim",
    arguments: { paths: ["src/mcp/server.ts"], intent: "exercise claims" },
  });
  assert.match(firstText(claimed), /Claimed src\/mcp\/server\.ts/);

  const heartbeat = await client.callTool({
    name: "heartbeat",
    arguments: {},
  });
  assert.match(firstText(heartbeat), /Refreshed 1 active claim/);

  createNotice({
    projectRoot,
    recipientAgent: "test-agent",
    kind: "test_notice",
    message: "A collision warning is waiting.",
  });
  const ping = await client.callTool({
    name: "ping",
    arguments: { name: "notice-check" },
  });
  assert.match(firstText(ping), /ShareLane notices:/);
  assert.match(firstText(ping), /A collision warning is waiting/);

  const released = await client.callTool({
    name: "release",
    arguments: {},
  });
  assert.match(firstText(released), /Released 1 claim/);
});

test("the usage tool reports allowance and never treats 'could not tell' as fine", async () => {
  const usage = await client.callTool({ name: "usage", arguments: { agent: "antigravity" } });
  assert.match(firstText(usage), /antigravity: could not tell \(not the same as fine\)/);
  assert.match(firstText(usage), /no programmatic usage reader/);

  const reassign = await client.callTool({ name: "reassign", arguments: { taskId: "task-missing" } });
  assert.equal(reassign.isError, true);
  assert.match(firstText(reassign), /Unknown task "task-missing"/);
});

test("run_check lists approved checks, runs one in the workspace, and refuses others", async () => {
  await mkdir(join(projectRoot, ".sharelane"), { recursive: true });
  await writeFile(
    join(projectRoot, ".sharelane", "checks.json"),
    JSON.stringify({
      version: 1,
      checks: { hello: { command: "node", args: ["-e", "console.log('checked ' + process.cwd())"] } },
    }),
    "utf8",
  );
  const listed = await client.callTool({ name: "run_check", arguments: {} });
  assert.match(firstText(listed), /Approved checks[\s\S]*- hello: node -e/);

  const ran = await client.callTool({ name: "run_check", arguments: { name: "hello" } });
  assert.notEqual(ran.isError, true);
  assert.match(firstText(ran), /Check hello .*PASSED with exit code 0/);
  assert.match(firstText(ran), /checked /);

  const refused = await client.callTool({ name: "run_check", arguments: { name: "deploy" } });
  assert.equal(refused.isError, true);
  assert.match(firstText(refused), /"deploy" is not an approved check[\s\S]*- hello/);
});

test("a delegated worker cannot approve its own checks by editing its worktree copy", async () => {
  const owner = await mkdtemp(join(tmpdir(), "sharelane-owner-"));
  const worker = await mkdtemp(join(tmpdir(), "sharelane-worker-"));
  const write = async (root: string, checks: object) => {
    await mkdir(join(root, ".sharelane"), { recursive: true });
    await writeFile(join(root, ".sharelane", "checks.json"), JSON.stringify({ version: 1, checks }), "utf8");
  };
  await write(owner, { hello: { command: "node", args: ["-e", "console.log('ran in ' + process.cwd())"] } });
  await write(worker, { evil: { command: "node", args: ["-e", "console.log('injected')"] } });
  const workerClient = new Client({ name: "sharelane-worker-test", version: "0.1.0" });
  await workerClient.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [tsxPath, serverPath],
      cwd: worker,
      env: {
        ...getDefaultEnvironment(),
        SHARELANE_AGENT: "test-agent",
        SHARELANE_PROJECT_ROOT: owner,
        SHARELANE_WORKSPACE_ROOT: worker,
      },
    }),
  );
  try {
    const injected = await workerClient.callTool({ name: "run_check", arguments: { name: "evil" } });
    assert.equal(injected.isError, true);
    assert.match(firstText(injected), /"evil" is not an approved check[\s\S]*- hello/);
    const approved = await workerClient.callTool({ name: "run_check", arguments: { name: "hello" } });
    assert.match(firstText(approved), /PASSED with exit code 0/);
    const ranIn = firstText(approved).toLowerCase();
    // macOS may report the real path (/private/var/...) of a /var/... temp folder.
    assert.ok([worker, realpathSync(worker)].some((path) => ranIn.includes(`ran in ${path}`.toLowerCase())), "runs in the worker's own worktree");
  } finally {
    await workerClient.close();
    await rm(owner, { recursive: true, force: true });
    await rm(worker, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
