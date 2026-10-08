import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
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
const workerEnv: NodeJS.ProcessEnv = {};
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
          // Tiers without a {modelArgs} slot: the run is labelled but the fake gets no extra flags.
          tiers: { fast: { model: "tiny" }, strong: { model: "huge" } },
          output: "codex-jsonl",
          instructionsFile: "AGENTS.md",
        },
      },
    }),
    "utf8",
  );
  process.env.SHARELANE_AGENTS_CONFIG = configPath;
  workerEnv.SHARELANE_AGENTS_CONFIG = configPath;
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
  dashboard = await startDashboard({ projectRoot, port: 0, env: workerEnv });
});

after(async () => {
  await dashboard.close();
  if (previousConfig === undefined) delete process.env.SHARELANE_AGENTS_CONFIG;
  else process.env.SHARELANE_AGENTS_CONFIG = previousConfig;
  await rm(projectRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function get(path: string, headers: Record<string, string> = {}, method = "GET", body?: string) {
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
    outgoing.end(body);
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
  assert.equal((await get("/api/state", {}, "POST")).status, 403, "controls need the page token");
  assert.equal((await get("/api/state", {}, "DELETE")).status, 405);
  assert.equal((await get("/office.js")).status, 200);
  assert.equal((await get("/office.css")).status, 200);
  assert.equal((await get("/api/tasks/..%2F..%2Fsecrets/log")).status, 404);
  assert.equal((await get("/api/tasks/task-00000000-0000-0000-0000-000000000000")).status, 404);
  assert.equal((await get("/nope")).status, 404);

  const detail = JSON.parse((await get(`/api/tasks/${taskId}`)).body);
  assert.equal(detail.task.id, taskId);
  assert.equal(detail.messages[0].role, "user");
  const log = JSON.parse((await get(`/api/tasks/${taskId}/log?offset=-1`)).body);
  assert.match(log.text, /ShareLane run: fake/);

  // This project is not a Git repository, so there is no branch to compare or preview.
  const changes = JSON.parse((await get(`/api/tasks/${taskId}/changes`)).body);
  assert.equal(changes.available, false);
  assert.match(changes.reason, /no task branch/);
  assert.match(changes.report, /Codex heard/, "the agent's own report is still shown");
  assert.equal((await get(`/preview/${taskId}/index.html`)).status, 404);
  assert.equal((await get(`/preview/${taskId}/..%2F..%2Fpackage.json`)).status, 404);
  assert.equal((await get("/preview/not-a-task/index.html")).status, 404);
});

test("controls need the page's token and origin, then assign, pause, resume, reply to, and stop tasks", async () => {
  const token = JSON.parse((await get("/api/session")).body).token as string;
  assert.match(token, /^[0-9a-f]{48}$/);
  const origin = `http://localhost:${dashboard.port}`;
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const response = await get(path, { "content-type": "application/json", origin, "x-sharelane-token": token, ...headers }, "POST", JSON.stringify(body));
    return { status: response.status, body: JSON.parse(response.body) as { taskId?: string; status?: string; error?: string } };
  };

  assert.equal((await post(`/api/tasks/${taskId}/stop`, {}, { "x-sharelane-token": "wrong" })).status, 403);
  assert.equal((await post(`/api/tasks/${taskId}/stop`, {}, { origin: "http://evil.example" })).status, 403, "another website is refused");
  assert.equal((await post(`/api/tasks/${taskId}/stop`, {}, { "content-type": "text/plain" })).status, 415, "a simple form post is refused");
  assert.equal((await post("/api/tasks", { agent: "fake", prompt: "x", budgetTokens: -5 })).status, 409);
  assert.equal((await post(`/api/tasks/${taskId}/stop`, {})).status, 409, "a completed task cannot be stopped");

  workerEnv.FAKE_AGENT_DELAY_MS = "5000";
  let slowId = "";
  try {
    assert.equal((await post("/api/tasks", { agent: "fake", prompt: "x", tier: "huge" })).status, 409, "unknown tiers are refused");
    const assigned = await post("/api/tasks", { agent: "fake", prompt: "slow office work", budgetTokens: 100000, tier: "fast" });
    assert.equal(assigned.status, 200, assigned.body.error ?? "");
    slowId = assigned.body.taskId ?? "";
    assert.equal(getTask(slowId, projectRoot).callerAgent, "you");
    assert.equal(getTask(slowId, projectRoot).modelTier, "fast");
    assert.equal(getTask(slowId, projectRoot).modelTierReason, "chosen by you");
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !(getTask(slowId, projectRoot).status === "running" && getTask(slowId, projectRoot).agentPid)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const paused = await post(`/api/tasks/${slowId}/pause`, {});
    assert.equal(paused.body.status, "paused", paused.body.error ?? "");
  } finally {
    delete workerEnv.FAKE_AGENT_DELAY_MS;
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(getTask(slowId, projectRoot).status, "paused", "a paused task stays paused");
  assert.equal((await post(`/api/tasks/${slowId}/pause`, {})).status, 409);

  const resumed = await post(`/api/tasks/${slowId}/resume`, { message: "Also add a changelog line." });
  assert.equal(resumed.status, 200, resumed.body.error ?? "");
  const finished = await waitForTask(slowId, 30_000, projectRoot);
  assert.equal(finished.task.status, "completed", finished.task.error ?? "");
  assert.match(finished.task.result ?? "", /You were paused partway through this task/);
  assert.match(finished.task.result ?? "", /The task:\nslow office work/, "a fresh run gets the original request again");
  assert.match(finished.task.result ?? "", /Also add a changelog line\./);
  assert.match(readFileSync(finished.task.logPath, "utf8"), /^Model: tiny$/m, "the resumed run keeps the task's tier");
  const shown = (JSON.parse((await get("/api/state")).body).tasks as Array<{ id: string; modelLabel: string }>).find((task) => task.id === slowId);
  assert.equal(shown?.modelLabel, "tiny");

  const replied = await post(`/api/tasks/${slowId}/reply`, { message: "thanks" });
  assert.equal(replied.status, 200, replied.body.error ?? "");
  assert.equal((await waitForTask(slowId, 30_000, projectRoot)).task.result, "Codex heard: thanks");

  // Review board: "Done" sends them to the lounge but a follow-up brings them back;
  // "End chat" closes the conversation for good.
  assert.equal((await post(`/api/tasks/${slowId}/dismiss`, {})).status, 200);
  assert.ok(getTask(slowId, projectRoot).dismissedAt);
  assert.equal(getTask(slowId, projectRoot).conversationClosedAt, undefined);
  assert.equal((await post(`/api/tasks/${slowId}/reply`, { message: "one more thing" })).status, 200);
  assert.equal(getTask(slowId, projectRoot).dismissedAt, undefined, "a follow-up puts them back to work");
  await waitForTask(slowId, 30_000, projectRoot);
  assert.equal((await post(`/api/tasks/${slowId}/dismiss`, { endConversation: true })).status, 200);
  assert.ok(getTask(slowId, projectRoot).conversationClosedAt);
  const refused = await post(`/api/tasks/${slowId}/reply`, { message: "are you there?" });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error ?? "", /conversation .* was ended/);
});
