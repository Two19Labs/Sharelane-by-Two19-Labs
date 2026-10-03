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

/** Write the shared edit-guard script that both Claude and Antigravity hooks run. */
export function installClaimGuardScript(projectRoot = process.cwd()): void {
  const hookPath = join(projectRoot, ".claude", "hooks", HOOK_NAME);
  mkdirSync(dirname(hookPath), { recursive: true });
  writeFileSync(hookPath, HOOK_SOURCE, "utf8");
}

export function installClaudeClaimHook(projectRoot = process.cwd()): void {
  const settingsPath = join(projectRoot, ".claude", "settings.json");
  installClaimGuardScript(projectRoot);

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

/** How an MCP client starts the ShareLane server (no shell is involved). */
export interface McpLauncher {
  command: string;
  args: string[];
}

/**
 * Register ShareLane in the project's .mcp.json for Claude Code, keeping any
 * other servers and settings already there.
 */
export function installClaudeMcpConfig(projectRoot: string, launcher: McpLauncher): void {
  const path = join(projectRoot, ".mcp.json");
  const config = readJson(path);
  config.mcpServers = {
    ...(config.mcpServers as Record<string, unknown> | undefined),
    sharelane: {
      type: "stdio",
      command: launcher.command,
      args: launcher.args,
      env: { SHARELANE_AGENT: "claude" },
    },
  };
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const source = readFileSync(path, "utf8").trim();
  return source ? (JSON.parse(source) as Record<string, unknown>) : {};
}

/**
 * Connect Antigravity CLI through workspace files in .agents/: the ShareLane
 * MCP server and the shared edit guard as a PreToolUse hook. Existing servers
 * and hooks are preserved. The guard script itself lives in .claude/hooks/ and
 * is written here too. Antigravity also needs one global permission rule,
 * "mcp(sharelane/*)", because its permission rules are global-only.
 */
export function installAntigravityIntegration(
  projectRoot: string,
  launcher: McpLauncher,
): void {
  const directory = join(projectRoot, ".agents");
  mkdirSync(directory, { recursive: true });
  installClaimGuardScript(projectRoot);

  const mcpPath = join(directory, "mcp_config.json");
  const mcp = readJson(mcpPath);
  mcp.mcpServers = {
    ...(mcp.mcpServers as Record<string, unknown> | undefined),
    sharelane: {
      command: launcher.command,
      args: launcher.args,
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

const STATUSLINE_NAME = "sharelane-statusline.mjs";

const STATUSLINE_SOURCE = `#!/usr/bin/env node
// ShareLane status line: saves Claude's account usage (rate_limits) so
// ShareLane can check quota without touching any login token, then shows the
// user's own status line from ~/.claude/settings.json unchanged.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

let input = "";
for await (const chunk of process.stdin) input += chunk;
let event = {};
try {
  event = JSON.parse(input);
} catch {
  // Show whatever the chained status line prints.
}

const limits = event && event.rate_limits;
if (limits && (limits.five_hour || limits.seven_day)) {
  try {
    const path =
      process.env.SHARELANE_CLAUDE_USAGE_FILE || join(homedir(), ".sharelane", "usage", "claude.json");
    mkdirSync(dirname(path), { recursive: true });
    const snapshot = {
      capturedAt: new Date().toISOString(),
      source: "statusline",
      five_hour: limits.five_hour || null,
      seven_day: limits.seven_day || null,
    };
    const temporary = path + "." + process.pid + ".tmp";
    writeFileSync(temporary, JSON.stringify(snapshot, null, 2) + "\\n", "utf8");
    renameSync(temporary, path);
  } catch {
    // A status line must never fail because of ShareLane.
  }
}

let chained = "";
try {
  const settings = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"));
  const command = settings && settings.statusLine && settings.statusLine.command;
  if (typeof command === "string" && !command.includes("${STATUSLINE_NAME}")) {
    // Run the user's own status line exactly as Claude Code would.
    const result = spawnSync(command, { shell: true, input, encoding: "utf8", timeout: 5000 });
    chained = (result.stdout || "").trimEnd();
  }
} catch {
  // No user status line.
}

if (chained) {
  console.log(chained);
} else {
  const used = (window) =>
    window && typeof window.used_percentage === "number" ? Math.round(window.used_percentage) + "%" : "?";
  const model = (event && event.model && event.model.display_name) || "Claude";
  console.log("[" + model + "] usage 5h " + used(limits && limits.five_hour) + " | week " + used(limits && limits.seven_day));
}
`;

/**
 * Install the token-free Claude usage snapshot as this project's status line.
 * An existing project status line that is not ShareLane's is left alone.
 * Returns false when it was left alone.
 */
export function installClaudeUsageStatusLine(projectRoot = process.cwd()): boolean {
  const scriptPath = join(projectRoot, ".claude", "hooks", STATUSLINE_NAME);
  const settingsPath = join(projectRoot, ".claude", "settings.json");
  mkdirSync(dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, STATUSLINE_SOURCE, "utf8");
  const settings = readJson(settingsPath);
  const existing = settings.statusLine as { command?: unknown } | undefined;
  if (existing && !String(existing.command ?? "").includes(STATUSLINE_NAME)) return false;
  settings.statusLine = { type: "command", command: `node .claude/hooks/${STATUSLINE_NAME}` };
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return true;
}
