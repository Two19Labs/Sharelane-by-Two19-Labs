import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./database.js";
import { patternWithinScope } from "./scope.js";

export const DEFAULT_CLAIM_TTL_SECONDS = 15 * 60;

export interface ShareLaneClaim {
  id: string;
  ownerKey: string;
  agent: string;
  taskId?: string;
  path: string;
  intent: string;
  createdAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

interface ClaimRow {
  id: string;
  owner_key: string;
  agent: string;
  task_id: string | null;
  path_pattern: string;
  intent: string;
  created_at: string;
  heartbeat_at: string;
  expires_at: string;
}

function fromRow(row: ClaimRow): ShareLaneClaim {
  return {
    id: row.id,
    ownerKey: row.owner_key,
    agent: row.agent,
    taskId: row.task_id ?? undefined,
    path: row.path_pattern,
    intent: row.intent,
    createdAt: row.created_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
  };
}

export function claimOwnerKey(agent: string, taskId?: string): string {
  return taskId ? `task:${taskId}` : `agent:${agent.trim() || "unknown"}`;
}

export function normalizeClaimPath(input: string): string {
  const value = input.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!value || value.startsWith("/") || /^[A-Za-z]:\//.test(value)) {
    throw new Error(`Claim paths must be project-relative: "${input}".`);
  }
  const parts = value.split("/").filter((part) => part && part !== ".");
  if (parts.includes("..")) {
    throw new Error(`Claim paths cannot leave the project: "${input}".`);
  }
  const normalized = parts.join("/").replace(/\/{2,}/g, "/");
  if (!normalized) throw new Error(`Claim path "${input}" is empty.`);
  return normalized;
}

function hasGlob(pattern: string): boolean {
  return /[*?[]/.test(pattern);
}

function comparable(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function globExpression(pattern: string): RegExp {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
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
      expression += character.replace(/[\\^$+?.()|{}]/g, "\\$&");
    }
  }
  return new RegExp(`${expression}$`, process.platform === "win32" ? "i" : "");
}

export function claimMatchesPath(pattern: string, path: string): boolean {
  const normalizedPattern = normalizeClaimPath(pattern);
  const normalizedPath = normalizeClaimPath(path);
  return hasGlob(normalizedPattern)
    ? globExpression(normalizedPattern).test(normalizedPath)
    : comparable(normalizedPattern) === comparable(normalizedPath);
}

function staticPrefix(pattern: string): string {
  const firstGlob = pattern.search(/[*?[]/);
  const prefix = firstGlob === -1 ? pattern : pattern.slice(0, firstGlob);
  return prefix.replace(/\/$/, "");
}

export function claimPatternsOverlap(left: string, right: string): boolean {
  const first = normalizeClaimPath(left);
  const second = normalizeClaimPath(right);
  if (comparable(first) === comparable(second)) return true;
  if (!hasGlob(first) && !hasGlob(second)) return false;
  if (!hasGlob(first)) return claimMatchesPath(second, first);
  if (!hasGlob(second)) return claimMatchesPath(first, second);
  const firstPrefix = staticPrefix(first);
  const secondPrefix = staticPrefix(second);
  if (!firstPrefix || !secondPrefix) return true;
  const comparableFirst = comparable(firstPrefix);
  const comparableSecond = comparable(secondPrefix);
  return (
    comparableFirst === comparableSecond ||
    comparableFirst.startsWith(`${comparableSecond}/`) ||
    comparableSecond.startsWith(`${comparableFirst}/`)
  );
}

function expiresAt(ttlSeconds: number): string {
  const bounded = Math.max(30, Math.min(ttlSeconds, 24 * 60 * 60));
  return new Date(Date.now() + bounded * 1_000).toISOString();
}

export interface ClaimInput {
  agent: string;
  paths: string[];
  intent: string;
  projectRoot?: string;
  taskId?: string;
  ttlSeconds?: number;
}

function taskScope(database: DatabaseSync, taskId: string): string[] | undefined {
  const row = database
    .prepare("SELECT scope_json FROM tasks WHERE id = ?")
    .get(taskId) as { scope_json: string | null } | undefined;
  return row?.scope_json ? (JSON.parse(row.scope_json) as string[]) : undefined;
}

/**
 * Insert claims using an already-open database inside the caller's transaction.
 * Refuses paths that overlap another owner or leave the task's delegated scope.
 */
export function claimPathsInTransaction(
  database: DatabaseSync,
  input: ClaimInput,
): ShareLaneClaim[] {
  const paths = [...new Set(input.paths.map(normalizeClaimPath))];
  if (paths.length === 0) throw new Error("claim needs at least one path.");
  const agent = input.agent.trim() || "unknown";
  const intent = input.intent.trim();
  if (!intent) throw new Error("claim needs a short intent.");
  const ownerKey = claimOwnerKey(agent, input.taskId);
  const now = new Date().toISOString();
  const expiry = expiresAt(input.ttlSeconds ?? DEFAULT_CLAIM_TTL_SECONDS);

  const scope = input.taskId ? taskScope(database, input.taskId) : undefined;
  if (scope) {
    const outside = paths.find((path) => !patternWithinScope(scope, path));
    if (outside) {
      throw new Error(
        `Claim refused: "${outside}" is outside this task's delegated scope (${scope.join(", ")}).`,
      );
    }
  }

  database.prepare("DELETE FROM claims WHERE expires_at <= ?").run(now);
  const active = database
    .prepare(
      `SELECT id, owner_key, agent, task_id, path_pattern, intent,
        created_at, heartbeat_at, expires_at
       FROM claims WHERE owner_key <> ? AND expires_at > ?`,
    )
    .all(ownerKey, now) as unknown as ClaimRow[];
  for (const path of paths) {
    const conflict = active.find((claim) =>
      claimPatternsOverlap(path, claim.path_pattern),
    );
    if (conflict) {
      const holder = conflict.task_id
        ? `${conflict.agent} on ${conflict.task_id}`
        : conflict.agent;
      throw new Error(
        `Claim refused: "${path}" overlaps "${conflict.path_pattern}", held by ${holder} for ${conflict.intent} until ${conflict.expires_at}.`,
      );
    }
  }

  const removeExisting = database.prepare(
    "DELETE FROM claims WHERE owner_key = ? AND path_pattern = ?",
  );
  const insert = database.prepare(
    `INSERT INTO claims (
      id, owner_key, agent, task_id, path_pattern, intent,
      created_at, heartbeat_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return paths.map((path) => {
    removeExisting.run(ownerKey, path);
    const claim: ShareLaneClaim = {
      id: `claim-${randomUUID()}`,
      ownerKey,
      agent,
      taskId: input.taskId,
      path,
      intent,
      createdAt: now,
      heartbeatAt: now,
      expiresAt: expiry,
    };
    insert.run(
      claim.id,
      claim.ownerKey,
      claim.agent,
      claim.taskId ?? null,
      claim.path,
      claim.intent,
      claim.createdAt,
      claim.heartbeatAt,
      claim.expiresAt,
    );
    return claim;
  });
}

export function claimPaths(input: ClaimInput): ShareLaneClaim[] {
  const database = openDatabase(input.projectRoot ?? process.cwd());
  try {
    database.exec("BEGIN IMMEDIATE");
    const claims = claimPathsInTransaction(database, input);
    database.exec("COMMIT");
    return claims;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original error.
    }
    throw error;
  } finally {
    database.close();
  }
}

/** Read-only pre-check: throw if another owner already holds an overlapping claim. */
export function assertPathsUnclaimed(paths: string[], projectRoot = process.cwd()): void {
  const active = listActiveClaims(projectRoot);
  for (const path of paths) {
    const conflict = active.find((claim) => claimPatternsOverlap(path, claim.path));
    if (conflict) {
      const holder = conflict.taskId
        ? `${conflict.agent} on ${conflict.taskId}`
        : conflict.agent;
      throw new Error(
        `Scope refused: "${path}" overlaps "${conflict.path}", held by ${holder} for ${conflict.intent} until ${conflict.expiresAt}. Release or narrow that claim first.`,
      );
    }
  }
}

export function heartbeatClaims(input: {
  agent: string;
  projectRoot?: string;
  taskId?: string;
  ttlSeconds?: number;
}): number {
  const projectRoot = input.projectRoot ?? process.cwd();
  const ownerKey = claimOwnerKey(input.agent, input.taskId);
  const now = new Date().toISOString();
  const expiry = expiresAt(input.ttlSeconds ?? DEFAULT_CLAIM_TTL_SECONDS);
  const database = openDatabase(projectRoot);
  try {
    database.prepare("DELETE FROM claims WHERE expires_at <= ?").run(now);
    const result = database
      .prepare(
        `UPDATE claims SET heartbeat_at = ?, expires_at = ?
         WHERE owner_key = ?`,
      )
      .run(now, expiry, ownerKey);
    return Number(result.changes);
  } finally {
    database.close();
  }
}

export function releaseClaims(input: {
  agent: string;
  projectRoot?: string;
  taskId?: string;
  paths?: string[];
  /** Keep a task's delegated-scope claims (used when a worker releases its own claims). */
  keepScope?: boolean;
}): number {
  const projectRoot = input.projectRoot ?? process.cwd();
  const ownerKey = claimOwnerKey(input.agent, input.taskId);
  const paths = input.paths?.map(normalizeClaimPath);
  const database = openDatabase(projectRoot);
  try {
    const kept =
      input.keepScope && input.taskId ? (taskScope(database, input.taskId) ?? []) : [];
    const keptClause = kept.length
      ? ` AND path_pattern NOT IN (${kept.map(() => "?").join(", ")})`
      : "";
    if (!paths || paths.length === 0) {
      return Number(
        database
          .prepare(`DELETE FROM claims WHERE owner_key = ?${keptClause}`)
          .run(ownerKey, ...kept).changes,
      );
    }
    const placeholders = paths.map(() => "?").join(", ");
    return Number(
      database
        .prepare(
          `DELETE FROM claims WHERE owner_key = ? AND path_pattern IN (${placeholders})${keptClause}`,
        )
        .run(ownerKey, ...paths, ...kept).changes,
    );
  } finally {
    database.close();
  }
}

export function listActiveClaims(
  projectRoot = process.cwd(),
): ShareLaneClaim[] {
  const now = new Date().toISOString();
  const database = openDatabase(projectRoot);
  try {
    database.prepare("DELETE FROM claims WHERE expires_at <= ?").run(now);
    const rows = database
      .prepare(
        `SELECT id, owner_key, agent, task_id, path_pattern, intent,
          created_at, heartbeat_at, expires_at
         FROM claims WHERE expires_at > ? ORDER BY created_at`,
      )
      .all(now) as unknown as ClaimRow[];
    return rows.map(fromRow);
  } finally {
    database.close();
  }
}

export function isPathClaimedBy(input: {
  agent: string;
  path: string;
  projectRoot?: string;
  taskId?: string;
}): boolean {
  const ownerKey = claimOwnerKey(input.agent, input.taskId);
  return listActiveClaims(input.projectRoot).some(
    (claim) =>
      claim.ownerKey === ownerKey && claimMatchesPath(claim.path, input.path),
  );
}
