#!/usr/bin/env node

import { initializeContext, relativeContextPath } from "./core/context.js";
import {
  installAgentInstructions,
  installRuntimeIgnores,
} from "./core/instructions.js";
import {
  installAntigravityIntegration,
  installClaudeClaimHook,
  installClaudeUsageStatusLine,
} from "./core/hooks.js";
import { runAgent } from "./core/runner.js";

function usage(): string {
  return [
    "ShareLane",
    "",
    "Usage:",
    "  npm run sharelane -- init",
    "  npm run sharelane -- run <agent> <prompt>",
    "",
    "Commands:",
    "  init   Create the shared context map, starter chunks, database, and agent instructions.",
    "  run    Ask one configured agent to do a task and wait for its answer.",
  ].join("\n");
}

async function run(): Promise<void> {
  const [command, ...extra] = process.argv.slice(2);
  if (command === "run") {
    const [agent, ...promptParts] = extra;
    const prompt = promptParts.join(" ").trim();
    if (!agent || !prompt) {
      throw new Error("run needs an agent name and a prompt.");
    }
    const result = await runAgent({ agent, prompt });
    console.log(result.finalMessage);
    console.log(`Session: ${result.sessionId}`);
    console.log(`Log: ${relativeContextPath(result.logPath, process.cwd())}`);
    return;
  }

  if (command !== "init" || extra.length > 0) {
    console.log(usage());
    process.exitCode = command ? 1 : 0;
    return;
  }

  const projectRoot = process.cwd();
  const result = initializeContext(projectRoot);
  installAgentInstructions(projectRoot);
  installRuntimeIgnores(projectRoot);
  installClaudeClaimHook(projectRoot);
  installAntigravityIntegration(projectRoot);
  const statusLineInstalled = installClaudeUsageStatusLine(projectRoot);
  // Rebuild once more in case an existing chunk covers an instruction file.
  initializeContext(projectRoot);

  console.log("ShareLane context is ready.");
  console.log(`Map: ${relativeContextPath(result.mapPath, projectRoot)}`);
  console.log(`Database: ${relativeContextPath(result.databasePath, projectRoot)}`);
  console.log(
    result.createdChunks.length > 0
      ? `Created chunks: ${result.createdChunks.join(", ")}`
      : "Starter chunks already existed; none were overwritten.",
  );
  console.log("Updated agent instructions and local-runtime Git ignores.");
  console.log("Installed Claude edit guard: .claude/settings.json");
  console.log(
    statusLineInstalled
      ? "Installed Claude usage status line (chains to your own): .claude/settings.json"
      : "Left your project status line alone; Claude quota will use the usage-endpoint fallback.",
  );
  console.log("Connected Antigravity CLI and its edit guard: .agents/mcp_config.json, .agents/hooks.json");
  console.log("Antigravity also needs permissions.allow \"mcp(sharelane/*)\" in ~/.gemini/antigravity-cli/settings.json.");
}

try {
  await run();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ShareLane failed: ${message}`);
  process.exitCode = 1;
}
