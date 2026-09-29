import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const [format, prompt, resumedSession, ...extraArgs] = process.argv.slice(2);
const sessionId = resumedSession || "fake-session-123";

// FAKE_EDIT_PATH may list several comma-separated files, simulating shell writes.
async function editFiles() {
  for (const path of (process.env.FAKE_EDIT_PATH || "").split(",").filter(Boolean)) {
    const editPath = resolve(process.cwd(), path);
    await mkdir(dirname(editPath), { recursive: true });
    await writeFile(
      editPath,
      process.env.FAKE_EDIT_CONTENT || "edited by fake agent\n",
      "utf8",
    );
  }
}

// FAKE_EDIT_FIRST writes before the delay, so a test can cancel mid-task.
if (process.env.FAKE_EDIT_FIRST) await editFiles();
const delay = Number(process.env.FAKE_AGENT_DELAY_MS || 0);
if (delay > 0) {
  await new Promise((resolve) => setTimeout(resolve, delay));
}
if (!process.env.FAKE_EDIT_FIRST) await editFiles();

const environmentReport = process.env.FAKE_REPORT_SHARELANE_ENV
  ? `\nENV ${JSON.stringify({
      taskId: process.env.SHARELANE_TASK_ID,
      parent: process.env.SHARELANE_PARENT,
      depth: process.env.SHARELANE_DEPTH,
    })}`
  : "";
const argsReport = process.env.FAKE_REPORT_ARGS
  ? `\nARGS ${JSON.stringify(extraArgs)}`
  : "";

if (format === "codex-jsonl") {
  console.log(JSON.stringify({ type: "thread.started", thread_id: sessionId }));
  console.log(
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: `Codex heard: ${prompt}${environmentReport}${argsReport}`,
      },
    }),
  );
  console.log(
    JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 12,
        cached_input_tokens: 3,
        output_tokens: 5,
        reasoning_output_tokens: 2,
      },
    }),
  );
} else if (format === "claude-json") {
  console.log(
    JSON.stringify({
      session_id: sessionId,
      result: `Claude heard: ${prompt}${environmentReport}`,
      usage: {
        input_tokens: 9,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 4,
        output_tokens: 6,
      },
    }),
  );
} else {
  console.error(`Unknown fake format: ${format}`);
  process.exitCode = 2;
}
