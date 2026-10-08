import assert from "node:assert/strict";
import { test } from "node:test";

type TimelineEvent = { kind: string; text?: string; title?: string; status?: string; detail?: string; items?: string[] };
const renderPath = new URL("../../src/dashboard/public/render.js", import.meta.url).href;
const { parseRunLog } = (await import(renderPath)) as {
  parseRunLog: (text: string) => { events: TimelineEvent[]; raw: string };
};

const kinds = (events: TimelineEvent[]) => events.map((event) => event.kind);

test("a Claude json run becomes a message, blocked actions, and run stats", () => {
  const log = [
    "ShareLane run: claude",
    "Started: 2026-10-08T07:36:32.340Z",
    "",
    `[stdout] ${JSON.stringify({
      type: "result", result: "I built **tic-tac-toe**.", num_turns: 13, duration_ms: 127470,
      total_cost_usd: 0.5, usage: { output_tokens: 5019 },
      permission_denials: [{ tool_name: "PowerShell", tool_input: { command: "node --check game.js" } }],
    })}`,
    "Finished: 2026-10-08T07:38:45.585Z",
    "Exit code: 0",
  ].join("\n");
  const { events, raw } = parseRunLog(log);
  assert.deepEqual(kinds(events), ["system", "time", "message", "tool", "stats", "system"]);
  assert.equal(events[2]?.text, "I built **tic-tac-toe**.");
  assert.equal(events[3]?.status, "blocked");
  assert.equal(events[3]?.detail, "node --check game.js");
  assert.deepEqual(events[4]?.items, ["⏱ 2 min 7 s", "13 turns", "5,019 output tokens", "$0.50 at list price"]);
  assert.match(raw, /"type":"result"/, "the raw output stays available");
});

test("Codex events become commands, file changes, messages, and usage; failures are flagged", () => {
  const lines = [
    { type: "thread.started", thread_id: "t1" },
    { type: "item.completed", item: { type: "reasoning", text: "Plan the change" } },
    { type: "item.completed", item: { type: "command_execution", command: "npm test", aggregated_output: "ok", exit_code: 1 } },
    { type: "item.completed", item: { type: "file_change", changes: [{ path: "src/a.ts", kind: "update" }] } },
    { type: "item.completed", item: { type: "agent_message", text: "Done." } },
    { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } },
  ].map((event) => `[stdout] ${JSON.stringify(event)}`);
  const { events } = parseRunLog(["ShareLane run: codex", ...lines, "[stderr] warning: something", "Exit code: 2"].join("\n"));
  assert.deepEqual(kinds(events), ["system", "system", "thinking", "tool", "tool", "message", "stats", "stderr", "error"]);
  assert.equal(events[3]?.title, "Ran npm test");
  assert.equal(events[3]?.status, "failed");
  assert.equal(events[4]?.detail, "update  src/a.ts");
  assert.match(events[8]?.text ?? "", /exited with code 2/);
});

test("an Antigravity run and unknown output are both kept readable", () => {
  const { events } = parseRunLog([
    `[stdout] ${JSON.stringify({ conversation_id: "c1", status: "SUCCESS", response: "Built the racing game.", duration_seconds: 213.5, num_turns: 1, usage: { total_tokens: 144269 } })}`,
    "plain line one",
    "plain line two",
    "[stdout] {not json",
  ].join("\n"));
  assert.deepEqual(kinds(events), ["message", "stats", "text"]);
  assert.deepEqual(events[1]?.items, ["⏱ 3 min 34 s", "1 turn", "144,269 tokens"]);
  assert.equal(events[2]?.text, "plain line one\nplain line two\n{not json");
});
