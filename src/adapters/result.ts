import type { AgentOutputFormat } from "./adapter.js";

export interface AgentUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

export interface ParsedAgentOutput {
  finalMessage: string;
  sessionId: string;
  usage: AgentUsage;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseClaudeJson(stdout: string): ParsedAgentOutput {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("Claude returned no JSON output.");
  }

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    throw new Error("Claude returned invalid JSON output.");
  }

  const result = asObject(value);
  const usage = asObject(result?.usage) ?? {};
  const finalMessage = result?.result;
  const sessionId = result?.session_id;
  if (typeof finalMessage !== "string" || typeof sessionId !== "string") {
    throw new Error("Claude output is missing its result or session_id.");
  }

  return {
    finalMessage,
    sessionId,
    usage: {
      inputTokens: numberValue(usage.input_tokens),
      cachedInputTokens: numberValue(usage.cache_read_input_tokens),
      cacheWriteInputTokens: numberValue(usage.cache_creation_input_tokens),
      outputTokens: numberValue(usage.output_tokens),
    },
  };
}

function parseCodexJsonLines(stdout: string): ParsedAgentOutput {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    throw new Error("Codex returned no JSON output.");
  }

  let sessionId: string | undefined;
  let finalMessage: string | undefined;
  let usage: AgentUsage = {};

  for (const [index, line] of lines.entries()) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`Codex returned invalid JSON on output line ${index + 1}.`);
    }

    const event = asObject(value);
    if (event?.type === "thread.started" && typeof event.thread_id === "string") {
      sessionId = event.thread_id;
    }
    if (event?.type === "item.completed") {
      const item = asObject(event.item);
      if (item?.type === "agent_message" && typeof item.text === "string") {
        finalMessage = item.text;
      }
    }
    if (event?.type === "turn.completed") {
      const rawUsage = asObject(event.usage) ?? {};
      usage = {
        inputTokens: numberValue(rawUsage.input_tokens),
        cachedInputTokens: numberValue(rawUsage.cached_input_tokens),
        outputTokens: numberValue(rawUsage.output_tokens),
        reasoningOutputTokens: numberValue(rawUsage.reasoning_output_tokens),
      };
    }
  }

  if (!sessionId || finalMessage === undefined) {
    throw new Error("Codex output is missing its thread ID or final message.");
  }
  return { finalMessage, sessionId, usage };
}

export function parseAgentOutput(
  format: AgentOutputFormat,
  stdout: string,
): ParsedAgentOutput {
  return format === "claude-json"
    ? parseClaudeJson(stdout)
    : parseCodexJsonLines(stdout);
}
