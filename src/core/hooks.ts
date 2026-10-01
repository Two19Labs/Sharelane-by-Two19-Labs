import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const HOOK_NAME = "sharelane-claim-guard.mjs";
const HOOK_COMMAND = "${CLAUDE_PROJECT_DIR}/.claude/hooks/sharelane-claim-guard.mjs";

const HOOK_SOURCE = `#!/usr/bin/env node
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

function normalize(value) {
  return value.replaceAll("\\\\", "/").replace(/^\\.\\//, "");
}

function globExpression(pattern) {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] || "";
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        expression += ".*";
        index += 1;
      } else {
        expression += "[^/]*";
      }
    } else if (character === "?") {
      expression += "[^/]";
    } else if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end !== -1) {
        expression += pattern.slice(index, end + 1);
        index = end;
      } else {
        expression += "\\\\[";
      }
    } else {
      expression += character.replace(/[\\\\^$+?.()|{}[\\]]/g, "\\\\$&");
    }
  }
  return new RegExp(expression + "$", process.platform === "win32" ? "i" : "");
}

let input = "";
for await (const chunk of process.stdin) input += chunk;
const event = JSON.parse(input);
// Claude sends tool_input.file_path; Antigravity sends toolCall.args.TargetFile.
const antigravity = Boolean(event?.toolCall);
const filePath = antigravity ? event.toolCall.args?.TargetFile : event?.tool_input?.file_path;
const taskId = process.env.SHARELANE_TASK_ID;
const agent = process.env.SHARELANE_AGENT;
if (typeof filePath !== "string" || (!taskId && !agent)) process.exit(0);

// Antigravity runs hooks from .agents/, so prefer the workspace it reports.
const cwd = resolve(event.cwd || event.workspacePaths?.[0] || process.cwd());
const absolute = resolve(cwd, filePath);
const projectPath = normalize(relative(cwd, absolute));
if (isAbsolute(projectPath) || projectPath === ".." || projectPath.startsWith("../")) {
  block("ShareLane blocked an edit outside the delegated workspace.");
}

const projectRoot = process.env.SHARELANE_PROJECT_ROOT || cwd;
const databasePath = joinPath(projectRoot, ".sharelane", "sharelane.db");
if (!existsSync(databasePath)) process.exit(0);
const ownerKey = taskId ? "task:" + taskId : "agent:" + agent;
const database = new DatabaseSync(databasePath, { readOnly: true });
let scope;
if (taskId) {
  try {
    const row = database.prepare("SELECT scope_json FROM tasks WHERE id = ?").get(taskId);
    if (row && row.scope_json) scope = JSON.parse(row.scope_json);
  } catch {
    // Databases created before scoped delegation have no scope column.
  }
}
if (scope && !scope.some((pattern) => globExpression(normalize(pattern)).test(projectPath))) {
  database.close();
  block(
    "ShareLane blocked an edit to " + projectPath +
    " because it is outside this task's delegated scope (" + scope.join(", ") + ")."
  );
}
const claims = database.prepare(
  "SELECT path_pattern FROM claims WHERE owner_key = ? AND expires_at > ?"
).all(ownerKey, new Date().toISOString());
database.close();
const claimed = claims.some(({ path_pattern: pattern }) =>
  globExpression(normalize(pattern)).test(projectPath)
);
if (!claimed) {
  block(
    "ShareLane blocked an unclaimed edit to " + projectPath +
    ". Call the ShareLane claim tool for this file first."
  );
}

// Exit code 2 blocks in every supported CLI; Antigravity also reads a JSON decision.
function block(reason) {
  if (antigravity) console.log(JSON.stringify({ decision: "deny", reason }));
  console.error(reason);
  process.exit(2);
}

function joinPath(...parts) {
  return parts.join(process.platform === "win32" ? "\\\\" : "/");
}
`;

interface ClaudeSettings {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

export function installClaudeClaimHook(projectRoot = process.cwd()): void {
  const hookPath = join(projectRoot, ".claude", "hooks", HOOK_NAME);
  const settingsPath = join(projectRoot, ".claude", "settings.json");
  mkdirSync(dirname(hookPath), { recursive: true });
  writeFileSync(hookPath, HOOK_SOURCE, "utf8");

  let settings: ClaudeSettings = {};
  if (existsSync(settingsPath)) {
    const source = readFileSync(settingsPath, "utf8").trim();
    if (source) settings = JSON.parse(source) as ClaudeSettings;
  }
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const existing = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const withoutShareLane = existing.filter((group) => {
    const serialized = JSON.stringify(group);
    return !serialized.includes(HOOK_NAME);
  });
  hooks.PreToolUse = [
    ...withoutShareLane,
    {
      matcher: "Edit|Write",
      hooks: [{ type: "command", command: "node", args: [HOOK_COMMAND] }],
    },
  ];
  settings.hooks = hooks;
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const source = readFileSync(path, "utf8").trim();
  return source ? (JSON.parse(source) as Record<string, unknown>) : {};
}

/**
 * Connect Antigravity CLI through workspace files in .agents/: the ShareLane
 * MCP server and the shared edit guard as a PreToolUse hook. Existing servers
 * and hooks are preserved. Call after installClaudeClaimHook, which writes the
 * guard script. Antigravity also needs one global permission rule,
 * "mcp(sharelane/*)", because its permission rules are global-only.
 */
export function installAntigravityIntegration(projectRoot = process.cwd()): void {
  const directory = join(projectRoot, ".agents");
  mkdirSync(directory, { recursive: true });

  const mcpPath = join(directory, "mcp_config.json");
  const mcp = readJson(mcpPath);
  mcp.mcpServers = {
    ...(mcp.mcpServers as Record<string, unknown> | undefined),
    sharelane: {
      command: "node",
      args: ["node_modules/tsx/dist/cli.mjs", "src/mcp/server.ts"],
      env: { SHARELANE_AGENT: "antigravity" },
    },
  };
  writeFileSync(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`, "utf8");

  const hooksPath = join(directory, "hooks.json");
  const hooks = readJson(hooksPath);
  hooks["sharelane-claim-guard"] = {
    enabled: true,
    PreToolUse: [
      {
        matcher: "write_to_file|replace_file_content|multi_replace_file_content",
        // Antigravity runs workspace hooks from .agents/, hence the "../".
        hooks: [{ type: "command", command: `node ../.claude/hooks/${HOOK_NAME}` }],
      },
    ],
  };
  writeFileSync(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`, "utf8");
}
