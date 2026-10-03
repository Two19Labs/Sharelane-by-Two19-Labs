import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { stringify } from "yaml";
import { claimPaths } from "../../src/core/claims.js";
import { openDatabase } from "../../src/core/database.js";
import { createNotice } from "../../src/core/notices.js";
import { logProgress } from "../../src/core/memory.js";
import { delegateTask, getTask, waitForTask } from "../../src/core/tasks.js";
import { startDashboard, type RunningDashboard } from "../../src/dashboard/server.js";
import { clearDashboardCache, collectDashboardState, readTaskLog } from "../../src/dashboard/state.js";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake-agent.mjs");

let projectRoot: string;
let taskId: string;
let dashboard: RunningDashboard;
const previousConfig = process.env.SHARELANE_AGENTS_CONFIG;

before(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "sharelane-dashboard-"));
  const configPath = join(projectRoot, "agents.yaml");
  await writeFile(
    configPath,
    stringify({
      version: 1,
      agents: {
        fake: {
          displayName: "Fake Agent",
          command: process.execPath,
          run: { args: [fixturePath, "codex-jsonl", "{prompt}"] },
          resume: { args: [fixturePath, "codex-jsonl", "{prompt}", "{session}"] },
          output: "codex-jsonl",
          instructionsFile: "AGENTS.md",
        },
      },
    }),
    "utf8",
  );
  process.env.SHARELANE_AGENTS_CONFIG = configPath;
  const delegated = delegateTask({
    agent: "fake",
    callerAgent: "test",
    prompt: "Build the dashboard demo\nwith a second line",
    projectRoot,
    env: { SHARELANE_AGENTS_CONFIG: configPath },
  });
  taskId = delegated.id;
  await waitForTask(taskId, 15_000, projectRoot);
  claimPaths({ agent: "claude", paths: ["src/ui/**"], intent: "polish the page", projectRoot });
  createNotice({ projectRoot, recipientAgent: "claude", kind: "handoff", message: "A task was handed over." });
  logProgress(taskId, "Halfway there", "fake", projectRoot);
  clearDashboardCache();
  dashboard = await startDashboard({ projectRoot, port: 0 });
});

after(async () => {
  await dashboard.close();
  if (previousConfig === undefined) delete process.env.SHARELANE_AGENTS_CONFIG;
  else process.env.SHARELANE_AGENTS_CONFIG = previousConfig;
  await rm(projectRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function get(path: string, headers: Record<string, string> = {}, method = "GET") {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const outgoing = request(
      { host: "127.0.0.1", port: dashboard.port, path, method, headers: { host: `localhost:${dashboard.port}`, ...headers } },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

test("the dashboard snapshot shows tasks, agents, claims, notices, progress, and per-agent tokens", async () => {
  const state = await collectDashboardState(projectRoot);
  assert.equal(state.tasks.length, 1);
  const [task] = state.tasks;
  assert.equal(task?.title, "Build the dashboard demo");
  assert.equal(task?.status, "completed");
  assert.deepEqual(task?.lineage, ["test", "fake"]);
  assert.equal(task?.usage.runs, 1);
  assert.deepEqual(state.usageByAgent, [
    { agent: "fake", runs: 1, freshInputTokens: 9, cachedInputTokens: 3, outputTokens: 5 },
  ]);
  assert.equal(state.agents[0]?.name, "fake");
  assert.equal(state.agents[0]?.quota.state, "unknown");
  assert.equal(state.claims[0]?.path, "src/ui/**");
  assert.equal(state.notices[0]?.kind, "handoff");
  assert.equal(state.progress[0]?.note, "Halfway there");
  assert.equal(state.totals.activeClaims, 1);
});

test("looking at the dashboard never delivers notices or changes anything", async () => {
  await collectDashboardState(projectRoot);
  await get("/api/state");
  const database = openDatabase(projectRoot);
  try {
    const pending = database.prepare("SELECT COUNT(*) AS count FROM notices WHERE delivered_at IS NULL").get() as { count: number };
    assert.equal(pending.count, 1, "the notice must still be waiting for its agent");
  } finally {
    database.close();
  }
});

test("older tasks without a run log still show their recorded usage", () => {
  const database = openDatabase(projectRoot);
  try {
    // Make it look like a pre-v5 task: no run log, and usage saved without freshInputTokens.
    database.prepare("DELETE FROM task_runs WHERE task_id = ?").run(taskId);
    database
      .prepare("UPDATE tasks SET usage_json = json_remove(usage_json, '$.freshInputTokens') WHERE id = ?")
      .run(taskId);
  } finally {
    database.close();
  }
  const usage = getTask(taskId, projectRoot).totalUsage;
  assert.equal(usage.runs, 1);
  assert.equal(usage.outputTokens, 5);
  assert.equal(usage.freshInputTokens, 12, "an unknown CLI counts its whole input as fresh");
});

test("live output is read in pieces from a byte offset", () => {
  const first = readTaskLog(taskId, -1, projectRoot);
  assert.match(first.text, /ShareLane run: fake/);
  assert.equal(readTaskLog(taskId, first.nextOffset, projectRoot).text, "");
  appendFileSync(getTask(taskId, projectRoot).logPath, "new output line\n");
  const next = readTaskLog(taskId, first.nextOffset, projectRoot);
  assert.equal(next.text, "new output line\n");
});

test("the server is local-only, read-only, and strict about what it serves", async () => {
  const page = await get("/");
  assert.equal(page.status, 200);
  assert.match(page.body, /<title>ShareLane dashboard<\/title>/);
  assert.match(String(page.headers["content-security-policy"]), /script-src 'self'/);
  assert.match(String(page.headers["content-security-policy"]), /frame-ancestors 'none'/);

  const state = await get("/api/state");
  assert.equal(state.status, 200);
  assert.equal(JSON.parse(state.body).tasks[0].id, taskId);

  assert.equal((await get("/api/state", { host: "evil.example" })).status, 403, "DNS-rebinding host refused");
  assert.equal((await get("/api/state", {}, "POST")).status, 405);
  assert.equal((await get("/api/tasks/..%2F..%2Fsecrets/log")).status, 404);
  assert.equal((await get("/api/tasks/task-00000000-0000-0000-0000-000000000000")).status, 404);
  assert.equal((await get("/nope")).status, 404);

  const detail = JSON.parse((await get(`/api/tasks/${taskId}`)).body);
  assert.equal(detail.task.id, taskId);
  assert.equal(detail.messages[0].role, "user");
  const log = JSON.parse((await get(`/api/tasks/${taskId}/log?offset=-1`)).body);
  assert.match(log.text, /ShareLane run: fake/);
});
