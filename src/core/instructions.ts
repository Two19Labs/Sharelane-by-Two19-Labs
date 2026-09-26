import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const START_MARKER = "<!-- sharelane-context:start -->";
const END_MARKER = "<!-- sharelane-context:end -->";
const BLOCK = `${START_MARKER}
## ShareLane shared context

Before project work, read \`.sharelane/context/MAP.md\` and then read only the context chunks relevant to the task. After meaningful work, update the affected chunks through ShareLane so the map, search index, and freshness status stay accurate.
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
