import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAgentOutput } from "../../src/adapters/result.js";

test("normalizes Claude JSON output", () => {
  const result = parseAgentOutput(
    "claude-json",
    JSON.stringify({
      session_id: "claude-session",
      result: "Finished from Claude",
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
        output_tokens: 4,
      },
    }),
  );
  assert.equal(result.sessionId, "claude-session");
  assert.equal(result.finalMessage, "Finished from Claude");
  assert.deepEqual(result.usage, {
    inputTokens: 10,
    cachedInputTokens: 3,
    cacheWriteInputTokens: 2,
    outputTokens: 4,
  });
});

test("normalizes Codex JSON-lines output", () => {
  const output = [
    { type: "thread.started", thread_id: "codex-thread" },
    {
      type: "item.completed",
      item: { type: "agent_message", text: "Finished from Codex" },
    },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 20,
        cached_input_tokens: 7,
        output_tokens: 8,
        reasoning_output_tokens: 5,
      },
    },
  ].map((event) => JSON.stringify(event)).join("\n");
  const result = parseAgentOutput("codex-jsonl", output);
  assert.equal(result.sessionId, "codex-thread");
  assert.equal(result.finalMessage, "Finished from Codex");
  assert.deepEqual(result.usage, {
    inputTokens: 20,
    cachedInputTokens: 7,
    outputTokens: 8,
    reasoningOutputTokens: 5,
  });
});
