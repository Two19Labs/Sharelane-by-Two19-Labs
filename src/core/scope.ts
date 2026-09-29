import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { claimMatchesPath, normalizeClaimPath } from "./claims.js";

export const MAX_SCOPE_PATTERNS = 50;

function hasGlob(pattern: string): boolean {
  return /[*?[]/.test(pattern);
}

function comparable(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

/**
 * Turn caller-supplied scope entries into project-relative claim patterns.
 * A trailing slash or an existing directory means "everything inside it".
 * Returns undefined when no scope was requested (backward-compatible default).
 */
export function normalizeScope(
  input: string[] | undefined,
  projectRoot = process.cwd(),
): string[] | undefined {
  if (input === undefined) return undefined;
  if (input.length === 0) {
    throw new Error("scope needs at least one project-relative path or glob.");
  }
  if (input.length > MAX_SCOPE_PATTERNS) {
    throw new Error(`scope accepts at most ${MAX_SCOPE_PATTERNS} entries.`);
  }
  const patterns = input.map((entry) => {
    const normalized = normalizeClaimPath(entry);
    if (hasGlob(normalized)) return normalized;
    const directory = /[\\/]\s*$/.test(entry) || isDirectory(join(projectRoot, normalized));
    return directory ? `${normalized}/**` : normalized;
  });
  const unique = new Map<string, string>();
  for (const pattern of patterns) unique.set(comparable(pattern), pattern);
  return [...unique.values()];
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

/** True when a concrete project-relative file path is inside the scope. */
export function pathInScope(scope: string[], path: string): boolean {
  return scope.some((pattern) => claimMatchesPath(pattern, path));
}

/**
 * True when a claim (file or glob) cannot reach outside the scope.
 * Glob claims are accepted only when they equal a scope pattern or sit under a
 * `dir/**` scope, which keeps the check conservative and easy to explain.
 */
export function patternWithinScope(scope: string[], claim: string): boolean {
  const pattern = normalizeClaimPath(claim);
  if (!hasGlob(pattern)) return pathInScope(scope, pattern);
  return scope.some((entry) => {
    if (comparable(entry) === comparable(pattern) || entry === "**") return true;
    if (!entry.endsWith("/**") || hasGlob(entry.slice(0, -3))) return false;
    return comparable(pattern).startsWith(comparable(entry.slice(0, -2)));
  });
}

/**
 * The directories a scope lives in, project-relative ("" is the project root).
 * Nested directories are folded into their parents. Used to point sandboxed
 * CLIs at the narrowest writable folders.
 */
export function scopeDirectories(scope: string[]): string[] {
  const directories = scope.map((pattern) => {
    const firstGlob = pattern.search(/[*?[]/);
    const staticPart = firstGlob === -1 ? pattern : pattern.slice(0, firstGlob);
    const lastSlash = staticPart.lastIndexOf("/");
    if (firstGlob !== -1 && staticPart.endsWith("/")) return staticPart.slice(0, -1);
    return lastSlash === -1 ? "" : staticPart.slice(0, lastSlash);
  });
  const sorted = [...new Set(directories)].sort((a, b) => a.length - b.length);
  const kept: string[] = [];
  for (const directory of sorted) {
    const covered = kept.some(
      (parent) =>
        parent === "" ||
        comparable(directory) === comparable(parent) ||
        comparable(directory).startsWith(`${comparable(parent)}/`),
    );
    if (!covered) kept.push(directory);
  }
  return kept;
}

export function describeScope(scope: string[] | undefined): string {
  return scope?.length ? scope.join(", ") : "whole project (no explicit scope)";
}
