import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHECKS_PATH } from "./checks.js";
import { getShareLanePaths } from "./database.js";
import { unwrittenStarterChunks } from "./context.js";

export const ONBOARDING_FILE = "ONBOARDING.md";

const checksPath = CHECKS_PATH.replaceAll("\\", "/");

const PLAYBOOK = `# ShareLane onboarding (one time)

ShareLane was just set up in this project. Before the user's first task, spend a few minutes making it useful here, then delete this file. Delegated ShareLane workers: ignore this file.

## 1. Make sure only one agent does it

Claim \`.sharelane/${ONBOARDING_FILE}\` with ShareLane's \`claim\` tool (intent: "ShareLane onboarding"). If the claim is refused, another agent is already doing it: skip this file and do the user's task. Otherwise tell the user in one line that you are setting ShareLane up for this project first.

## 2. Learn the project cheaply

Read the README, the package manifests (package.json, pyproject.toml, Cargo.toml, go.mod, and so on), the top two levels of the folder tree, CI config, and any instructions in AGENTS.md or CLAUDE.md outside the ShareLane block. Open source files only to confirm entry points and how the main parts connect. Skip dependencies, build output, lock files and generated files.

## 3. Write the shared context

For each starter chunk (\`architecture\`, \`ui\`, \`api\`, \`data\`, \`conventions\`, \`decisions\`), call ShareLane's \`update_chunk\` tool with:

- \`content\`: the facts another agent needs before touching that area: where things live, how parts connect, the commands to run, and gotchas. Prefer short bullet lists and file paths; aim for under 2,000 characters per chunk.
- \`coversFiles\`: narrow globs of the files the chunk describes, so ShareLane can flag the chunk as stale when they change.
- \`readWhen\`: one line saying when an agent should read it.

If a chunk does not apply (for example, no user interface), write "Not applicable to this project:" and one line saying why. Never leave the placeholder text. Add a chunk for each large area that does not fit the starters (for example \`auth\`, \`billing\`, \`infra\`), one per area rather than one per file.

Write facts only: do not invent decisions or intentions. No secrets, tokens or personal data; name environment variables without their values.

## 4. Propose approved checks

Find the project's test, lint, typecheck and build commands. Show the user the list and ask before adding any to \`${checksPath}\`: agents may run those commands without asking. Never add deploy, publish, release, database migration, or anything that deletes data or costs money. Format:

\`\`\`json
{ "version": 1, "checks": { "test": { "command": "npm", "args": ["test"], "timeoutSeconds": 600 } } }
\`\`\`

## 5. Finish

Delete \`.sharelane/${ONBOARDING_FILE}\`, release your claim, and tell the user in a few lines which chunks you wrote, which checks you added or proposed, and anything you could not work out. Then continue with what they asked.
`;

/**
 * Leave a one-time playbook for the first agent while any starter chunk is
 * still unwritten. It is git-ignored, so delegated worktrees never see it.
 */
export function installOnboarding(projectRoot = process.cwd()): "created" | "pending" | "none" {
  if (unwrittenStarterChunks(projectRoot).length === 0) return "none";
  const path = join(getShareLanePaths(projectRoot).shareLaneDir, ONBOARDING_FILE);
  if (existsSync(path)) return "pending";
  writeFileSync(path, PLAYBOOK, "utf8");
  return "created";
}
