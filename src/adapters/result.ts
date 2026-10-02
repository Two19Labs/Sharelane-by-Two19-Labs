import type { AgentOutputFormat } from "./adapter.js";

export interface AgentUsage {
  inputTokens?: number;
  /** Input tokens processed fresh (not read from cache), comparable across CLIs. */
  freshInputTokens?: number;
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

function sum(...values: unknown[]): number | undefined {
  const numbers = values.map(numberValue);
  return numbers.every((value) => value === undefined)
    ? undefined
    : numbers.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function difference(total: unknown, part: unknown): number | undefined {
  const whole = numberValue(total);
  return whole === undefined ? undefined : Math.max(0, whole - (numberValue(part) ?? 0));
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
      // Claude's input_tokens already excludes cache reads; cache writes are fresh work.
      freshInputTokens: sum(usage.input_tokens, usage.cache_creation_input_tokens),
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
        // Codex counts cached tokens inside input_tokens.
        freshInputTokens: difference(rawUsage.input_tokens, rawUsage.cached_input_tokens),
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

function parseAntigravityJson(stdout: string): ParsedAgentOutput {
  // Antigravity writes one JSON object to stdout; its logs go to stderr.
  const start = stdout.search(/^\{/m);
  if (start === -1) throw new Error("Antigravity returned no JSON output.");

  let value: unknown;
  try {
    value = JSON.parse(stdout.slice(start));
  } catch {
    throw new Error("Antigravity returned invalid JSON output.");
  }

  const result = asObject(value);
  const response = result?.response;
  const sessionId = result?.conversation_id;
  if (result?.status !== "SUCCESS") {
    const detail = typeof response === "string" && response.trim() ? `: ${response.trim()}` : "";
    throw new Error(`Antigravity finished with status ${String(result?.status)}${detail}`);
  }
  if (typeof response !== "string" || typeof sessionId !== "string") {
    throw new Error("Antigravity output is missing its response or conversation_id.");
  }

  // Headless mode silently refuses actions that would need approval; say so.
  const denied = Array.isArray(result?.denied_actions)
    ? result.denied_actions
        .map((action) => asObject(action)?.display_name)
        .filter((name): name is string => typeof name === "string")
    : [];
  const note = denied.length
    ? `\n\n[ShareLane: Antigravity was not permitted to run: ${[...new Set(denied)].join(", ")}]`
    : "";

  const usage = asObject(result?.usage) ?? {};
  return {
    finalMessage: `${response.trimEnd()}${note}`,
    sessionId,
    usage: {
      inputTokens: numberValue(usage.input_tokens),
      // Antigravity counts cache reads inside input_tokens.
      freshInputTokens: difference(usage.input_tokens, usage.cache_read_tokens),
      cachedInputTokens: numberValue(usage.cache_read_tokens),
      outputTokens: numberValue(usage.output_tokens),
      reasoningOutputTokens: numberValue(usage.thinking_tokens),
    },
  };
}

export function parseAgentOutput(
  format: AgentOutputFormat,
  stdout: string,
): ParsedAgentOutput {
  if (format === "claude-json") return parseClaudeJson(stdout);
  if (format === "antigravity-json") return parseAntigravityJson(stdout);
  return parseCodexJsonLines(stdout);
}
