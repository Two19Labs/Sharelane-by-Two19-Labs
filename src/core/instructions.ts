import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const START_MARKER = "<!-- sharelane-context:start -->";
const END_MARKER = "<!-- sharelane-context:end -->";
const BLOCK = `${START_MARKER}
## ShareLane shared context

First time here: if \`.sharelane/ONBOARDING.md\` exists, follow it before other work. It sets ShareLane up for this project once, then is deleted.

Before project work, read \`.sharelane/context/MAP.md\` and then read only the context chunks relevant to the task. After meaningful work, update the affected chunks through ShareLane so the map, search index, and freshness status stay accurate.

Keep token overhead low: handle simple work directly, delegate only when another agent adds clear value, avoid rereading unchanged context or large logs, reuse sessions for follow-ups, and keep messages concise.

Before editing, claim the exact files or narrow path patterns through ShareLane with a short intent. Keep long-running claims alive with heartbeat and release them when finished. Delegated workers run in isolated Git worktrees; ShareLane saves their changes on task branches for review.
${END_MARKER}`;

function installBlock(path: string, heading: string): void {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : `${heading}\n`;
  const start = existing.indexOf(START_MARKER);
  const end = existing.indexOf(END_MARKER);
  let updated: string;

  if (start !== -1 && end !== -1 && end > start) {
    updated = `${existing.slice(0, start)}${BLOCK}${existing.slice(end + END_MARKER.length)}`;
  } else {
    updated = `${existing.trimEnd()}\n\n${BLOCK}\n`;
  }
  writeFileSync(path, updated, "utf8");
}

export function installAgentInstructions(projectRoot = process.cwd()): void {
  installBlock(join(projectRoot, "AGENTS.md"), "# Agent instructions");
  installBlock(join(projectRoot, "CLAUDE.md"), "# Claude Code instructions");
}

const runtimeIgnorePatterns = [
  ".sharelane/notes.txt",
  ".sharelane/journal/",
  ".sharelane/runs/",
  ".sharelane/tasks/",
  ".sharelane/later/",
  ".sharelane/sharelane.db",
  ".sharelane/sharelane.db-shm",
  ".sharelane/sharelane.db-wal",
  ".claude/settings.local.json",
  ".sharelane/ONBOARDING.md",
];

/**
 * Remove the ShareLane block from AGENTS.md and CLAUDE.md, deleting a file
 * that only held the heading `init` created. Returns the files it changed.
 */
export function removeAgentInstructions(projectRoot = process.cwd()): string[] {
  const changed: string[] = [];
  for (const [name, heading] of [
    ["AGENTS.md", "# Agent instructions"],
    ["CLAUDE.md", "# Claude Code instructions"],
  ] as const) {
    const path = join(projectRoot, name);
    if (!existsSync(path)) continue;
    const existing = readFileSync(path, "utf8");
    const start = existing.indexOf(START_MARKER);
    const end = existing.indexOf(END_MARKER);
    if (start === -1 || end < start) continue;
    const rest = `${existing.slice(0, start).trimEnd()}\n${existing.slice(end + END_MARKER.length).trimStart()}`.trim();
    if (rest === "" || rest === heading) rmSync(path);
    else writeFileSync(path, `${rest}\n`, "utf8");
    changed.push(name);
  }
  return changed;
}

/**
 * Remove ShareLane's ignore lines. The settings.local.json line stays while
 * that file exists, because it can hold the user's own private settings.
 */
export function removeRuntimeIgnores(projectRoot = process.cwd()): boolean {
  const path = join(projectRoot, ".gitignore");
  if (!existsSync(path)) return false;
  const existing = readFileSync(path, "utf8");
  const ours = new Set<string>(["# ShareLane local runtime", ...runtimeIgnorePatterns]);
  if (existsSync(join(projectRoot, ".claude", "settings.local.json"))) ours.delete(".claude/settings.local.json");
  const lines = existing.split(/\r?\n/);
  const kept = lines.filter((line) => !ours.has(line.trim()));
  if (kept.length === lines.length) return false;
  const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text === "") rmSync(path);
  else writeFileSync(path, `${text}\n`, "utf8");
  return true;
}

export function installRuntimeIgnores(projectRoot = process.cwd()): void {
  const path = join(projectRoot, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missing = runtimeIgnorePatterns.filter((pattern) => !lines.has(pattern));
  if (missing.length === 0) return;
  const separator = existing.trimEnd() ? "\n\n" : "";
  writeFileSync(
    path,
    `${existing.trimEnd()}${separator}# ShareLane local runtime\n${missing.join("\n")}\n`,
    "utf8",
  );
}
