#!/usr/bin/env node
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

function normalize(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
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
        expression += "\\[";
      }
    } else {
      expression += character.replace(/[\\^$+?.()|{}[\]]/g, "\\$&");
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
  return parts.join(process.platform === "win32" ? "\\" : "/");
}
