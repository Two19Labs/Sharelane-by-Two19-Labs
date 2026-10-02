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
import {
  claimPaths,
  heartbeatClaims,
  releaseClaims,
} from "../core/claims.js";
import { takePendingNotices } from "../core/notices.js";
import { describeScope } from "../core/scope.js";
import { checkQuota, describeQuota } from "../core/quota.js";
import { getAgentAdapter, loadAgentRegistry } from "../adapters/adapter.js";
import {
  cancelTask,
  delegateTask,
  describeUsage,
  reassignTask,
  getTask,
  replyToTask,
  waitForTask,
  type ShareLaneTask,
} from "../core/tasks.js";

// Delegated workers may start inside a scope folder; the worker exports the checkout root.
const workspaceRoot = process.env.SHARELANE_WORKSPACE_ROOT || process.cwd();
const projectRoot = process.env.SHARELANE_PROJECT_ROOT || workspaceRoot;
const currentAgent = process.env.SHARELANE_AGENT?.trim() || "unknown";
const currentTaskId = process.env.SHARELANE_TASK_ID?.trim() || undefined;

function toolReply(text: string, relatedTaskId?: string) {
  const notices = takePendingNotices({
    projectRoot,
    agent: currentAgent,
    taskId: currentTaskId,
    relatedTaskId,
  });
  const noticeText = notices.length
    ? `\n\nShareLane notices:\n${notices
        .map((notice) => `- [${notice.kind}] ${notice.message}`)
        .join("\n")}`
    : "";
  return { content: [{ type: "text" as const, text: `${text}${noticeText}` }] };
}

function taskStatusText(task: ShareLaneTask): string {
  const lines = [
    `Task ID: ${task.id}`,
    `Agent: ${task.agent}`,
    `Status: ${task.status}`,
  ];
  if (task.result) lines.push(`Result:\n${task.result}`);
  if (task.error) lines.push(`Error:\n${task.error}`);
  if (task.sessionId) lines.push(`Session: ${task.sessionId}`);
  if (task.branchName) lines.push(`Task branch: ${task.branchName}`);
  if (task.resultCommit) lines.push(`Result commit: ${task.resultCommit}`);
  if (task.changedFiles.length > 0) {
    lines.push(`Changed files: ${task.changedFiles.join(", ")}`);
  }
  lines.push(`Scope: ${describeScope(task.scope)}`);
  lines.push(`Usage: ${describeUsage(task)}`);
  if (task.reassignments > 0) lines.push(`Reassignments: ${task.reassignments}`);
  if (task.handoffReason) lines.push(`Handoff reason: ${task.handoffReason}`);
  if (task.status === "needs_reassignment") {
    lines.push("Next: call reassign with this task ID (optionally naming an agent).");
  }
  if (task.scopeViolations.length > 0) {
    lines.push(
      `Scope violations (kept off the task branch): ${task.scopeViolations.join(", ")}`,
    );
  }
  return lines.join("\n");
}

const server = new McpServer({
  name: "sharelane",
  version: "0.1.0",
});

server.registerTool(
  "ping",
  {
    description: "Check that ShareLane is reachable and return a greeting.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      name: z.string().min(1).describe("Name to greet"),
    },
  },
  async ({ name }) => toolReply(`pong from ShareLane, hello ${name}`),
);

server.registerTool(
  "whoami",
  {
    description: "Return the name of the agent connected to ShareLane.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => toolReply(currentAgent),
);

server.registerTool(
  "note",
  {
    description: "Append a note to this project's shared ShareLane notebook.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      text: z.string().trim().min(1).describe("Note to share with other agents"),
    },
  },
  async ({ text }) => {
    await appendNote(text, projectRoot);
    return toolReply(`Saved note: ${text}`);
  },
);

server.registerTool(
  "notes",
  {
    description: "Read all notes from this project's shared ShareLane notebook.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => toolReply(await readNotes(projectRoot)),
);

server.registerTool(
  "context_map",
  {
    description:
      "Read the generated map of this project's shared context and see which chunks are relevant or stale.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => toolReply(contextMap(workspaceRoot)),
);

server.registerTool(
  "read_chunk",
  {
    description:
      "Read one shared context chunk after choosing it from the context map.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      id: z
        .string()
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        .describe("Chunk id, such as architecture or api"),
    },
  },
  async ({ id }) => toolReply(readChunk(id, workspaceRoot)),
);

server.registerTool(
  "update_chunk",
  {
    description:
      "Create or update one context chunk. This also refreshes MAP.md and the full-text search index.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
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
    const chunk = updateChunk(
      { id, content, title, readWhen, coversFiles },
      workspaceRoot,
    );
    return toolReply(
      `Updated context chunk "${chunk.title}" (${chunk.id}). MAP.md and search index regenerated.`,
    );
  },
);

server.registerTool(
  "search",
  {
    description:
      "Full-text search across shared context chunks and progress journal entries.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      query: z.string().trim().min(1).describe("Words to find"),
      limit: z.number().int().min(1).max(20).optional().describe("Maximum results"),
    },
  },
  async ({ query, limit }) => {
    const results = searchMemory(query, limit, projectRoot);
    const text =
      results.length === 0
        ? `No shared context matched "${query}".`
        : results
            .map(
              (result, index) =>
                `${index + 1}. [${result.kind}:${result.reference}] ${result.title}\n${result.snippet}`,
            )
            .join("\n\n");
    return toolReply(text);
  },
);

server.registerTool(
  "claim",
  {
    description:
      "Claim project-relative files or narrow path patterns before editing. Overlapping active claims are refused.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      paths: z.array(z.string().trim().min(1)).min(1).max(50),
      intent: z.string().trim().min(1).describe("Short description of the planned edits"),
      ttlSeconds: z.number().int().min(30).max(86_400).optional(),
    },
  },
  async ({ paths, intent, ttlSeconds }) => {
    const claims = claimPaths({
      agent: currentAgent,
      taskId: currentTaskId,
      paths,
      intent,
      ttlSeconds,
      projectRoot,
    });
    return toolReply(
      `Claimed ${claims.map((claim) => claim.path).join(", ")} until ${claims[0]?.expiresAt}.`,
    );
  },
);

server.registerTool(
  "heartbeat",
  {
    description: "Extend this agent or task's active claims.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      ttlSeconds: z.number().int().min(30).max(86_400).optional(),
    },
  },
  async ({ ttlSeconds }) => {
    const count = heartbeatClaims({
      agent: currentAgent,
      taskId: currentTaskId,
      ttlSeconds,
      projectRoot,
    });
    return toolReply(`Refreshed ${count} active claim${count === 1 ? "" : "s"}.`);
  },
);

server.registerTool(
  "release",
  {
    description: "Release some or all claims held by this agent or delegated task.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      paths: z.array(z.string().trim().min(1)).max(50).optional(),
    },
  },
  async ({ paths }) => {
    // A delegated scope stays claimed until the task ends, even if the worker releases.
    const count = releaseClaims({
      agent: currentAgent,
      taskId: currentTaskId,
      paths,
      projectRoot,
      keepScope: true,
    });
    return toolReply(`Released ${count} claim${count === 1 ? "" : "s"}.`);
  },
);

server.registerTool(
  "delegate",
  {
    description:
      "Start a configured coding agent in the background and immediately return a task ID. Use delegation only when another agent adds specialist, review, parallel, or explicitly requested value.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      agent: z.string().trim().min(1).describe("Configured agent name"),
      task: z.string().trim().min(1).describe("Work for the agent to perform"),
      scope: z
        .array(z.string().trim().min(1))
        .min(1)
        .max(50)
        .optional()
        .describe(
          "Optional project-relative files, folders, or globs the worker may change, such as src/ui/**. Omit for whole-project access.",
        ),
    },
  },
  async ({ agent, task, scope }) => {
    const delegated = delegateTask({
      agent,
      prompt: task,
      projectRoot,
      sourceRoot: workspaceRoot,
      callerAgent: currentAgent,
      scope,
    });
    const warnings = delegated.duplicateWarnings?.length
      ? ` Warnings: ${delegated.duplicateWarnings.join(" ")}`
      : "";
    return toolReply(
      `Delegated to ${agent}. Task ID: ${delegated.id}. Status: ${delegated.status}. Scope: ${describeScope(delegated.scope)}.${warnings}`,
      delegated.id,
    );
  },
);

server.registerTool(
  "status",
  {
    description: "Read the current state and result of a delegated task.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      taskId: z.string().trim().min(1).describe("Task ID returned by delegate"),
    },
  },
  async ({ taskId }) =>
    toolReply(taskStatusText(getTask(taskId, projectRoot)), taskId),
);

server.registerTool(
  "wait",
  {
    description:
      "Wait briefly for a delegated task to finish, or return its latest state when the timeout expires.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      taskId: z.string().trim().min(1).describe("Task ID returned by delegate"),
      timeoutSeconds: z
        .number()
        .int()
        .min(0)
        .max(30)
        .optional()
        .describe("Seconds to wait; defaults to 30"),
    },
  },
  async ({ taskId, timeoutSeconds }) => {
    const waited = await waitForTask(
      taskId,
      (timeoutSeconds ?? 30) * 1_000,
      projectRoot,
    );
    const prefix = waited.timedOut
      ? "Wait timed out; the task is still active.\n"
      : "Task reached a final state.\n";
    return toolReply(`${prefix}${taskStatusText(waited.task)}`, taskId);
  },
);

server.registerTool(
  "reply",
  {
    description:
      "Send a follow-up to a completed task by resuming the same agent session.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      taskId: z.string().trim().min(1).describe("Completed task ID"),
      message: z.string().trim().min(1).describe("Follow-up request"),
    },
  },
  async ({ taskId, message }) => {
    const task = replyToTask(taskId, message, { projectRoot });
    return toolReply(
      `Follow-up queued for ${task.id} in session ${task.sessionId}. Status: ${task.status}.`,
      taskId,
    );
  },
);

server.registerTool(
  "cancel",
  {
    description: "Cancel a queued or running delegated task.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      taskId: z.string().trim().min(1).describe("Active task ID"),
    },
  },
  async ({ taskId }) => {
    const task = cancelTask(taskId, projectRoot);
    return toolReply(`Cancelled ${task.id}. Status: ${task.status}.`, taskId);
  },
);

server.registerTool(
  "usage",
  {
    description:
      "Check remaining subscription allowance at a checkpoint (between major steps, not in a loop). Says keep working, HAND OFF (at or below 7% in the lowest window), or could not tell.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      agent: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("Configured agent to check; defaults to the calling agent"),
    },
  },
  async ({ agent }) => {
    const name = agent ?? currentAgent;
    const adapter = loadAgentRegistry().agents[name];
    const lines = [describeQuota(await checkQuota(name, adapter?.quota))];
    if (currentTaskId && !agent) {
      lines.push(`This task so far: ${describeUsage(getTask(currentTaskId, projectRoot))}`);
    }
    return toolReply(lines.join("\n"), currentTaskId);
  },
);

server.registerTool(
  "reassign",
  {
    description:
      "Hand a task that needs reassignment (or failed) to another agent, which continues on the same task branch from a handoff note. Omit agent to let ShareLane pick one with allowance left.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      taskId: z.string().trim().min(1).describe("Task waiting in needs_reassignment, or a failed task"),
      agent: z.string().trim().min(1).optional().describe("Agent to take over; defaults to automatic choice"),
    },
  },
  async ({ taskId, agent }) => {
    if (agent) getAgentAdapter(agent);
    const task = await reassignTask(taskId, { projectRoot, agent });
    return toolReply(
      `Reassigned ${task.id} to ${task.agent}. Status: ${task.status}. It continues on ${task.branchName ?? "the same workspace"}.`,
      taskId,
    );
  },
);

server.registerTool(
  "log_progress",
  {
    description:
      "Add a dated progress note to the shared journal so work can be searched and handed off.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      task: z.string().trim().min(1).describe("Task name or id"),
      note: z.string().trim().min(1).describe("Concise progress update"),
    },
  },
  async ({ task, note }) => {
    const entry = logProgress(task, note, currentAgent, projectRoot);
    return toolReply(
      `Logged progress for "${entry.task}" as ${entry.agent} at ${entry.createdAt}.`,
    );
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
