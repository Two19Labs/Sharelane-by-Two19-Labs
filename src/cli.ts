#!/usr/bin/env node

import { initializeContext, relativeContextPath } from "./core/context.js";
import { installAgentInstructions } from "./core/instructions.js";

function usage(): string {
  return [
    "ShareLane",
    "",
    "Usage:",
    "  npm run sharelane -- init",
    "",
    "Commands:",
    "  init   Create the shared context map, starter chunks, database, and agent instructions.",
  ].join("\n");
}

function run(): void {
  const [command, ...extra] = process.argv.slice(2);
  if (command !== "init" || extra.length > 0) {
    console.log(usage());
    process.exitCode = command ? 1 : 0;
    return;
  }

  const projectRoot = process.cwd();
  const result = initializeContext(projectRoot);
  installAgentInstructions(projectRoot);
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
  console.log("Updated agent instructions: AGENTS.md, CLAUDE.md");
}

try {
  run();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ShareLane init failed: ${message}`);
  process.exitCode = 1;
}
