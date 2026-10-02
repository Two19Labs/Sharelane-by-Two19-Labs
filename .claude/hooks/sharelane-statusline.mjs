#!/usr/bin/env node
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
    writeFileSync(temporary, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
    renameSync(temporary, path);
  } catch {
    // A status line must never fail because of ShareLane.
  }
}

let chained = "";
try {
  const settings = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"));
  const command = settings && settings.statusLine && settings.statusLine.command;
  if (typeof command === "string" && !command.includes("sharelane-statusline.mjs")) {
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
