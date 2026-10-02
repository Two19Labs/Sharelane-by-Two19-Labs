---
title: API and tools
read-when: Changing commands, MCP tools, integrations, or public interfaces.
covers-files: ["src/mcp/**","src/cli.ts"]
updated-at: 2026-10-02T14:50:19.606Z
source-hash: 4972af6897447c8ca9aedb938870e8c14134a1a25ba6b1e38d6e70fb262991d7
---

# API and tools

The MCP server exposes nineteen tools. Phase 0 provides ping, whoami, note, and notes. Phase 1 provides context_map, read_chunk, update_chunk, search, and log_progress. Phase 2 provides delegate, status, wait, reply, and cancel. Phase 3 provides claim, heartbeat, and release. Phase 5 provides usage and reassign.

delegate starts one of the configured agents — `claude`, `codex`, or `antigravity` (Antigravity CLI, `agy`) — and returns a task ID immediately. Use it for specialist, independent-review, parallel, or explicitly requested value, not as the default for simple work. Optional `scope` (1–50 project-relative files, folders, or globs) limits what the worker may change; optional `budgetTokens` caps fresh tokens (new input plus output) across all of the task's runs, warning at 80% and refusing further runs at 100%. status shows state, result, branch, scope, violations, total usage (runs, fresh input, cached input, output, budget), reassignments, and any handoff reason. wait returns at a final state, including `needs_reassignment`. reply resumes the saved session and re-claims the scope. cancel closes queued, running, or waiting work.

usage reports remaining allowance for the calling agent (or a named one): keep working, HAND OFF (at or below 7% in the lowest window), or could not tell — plus the current task's totals. Agents call it at checkpoints, never in a loop. reassign hands a `needs_reassignment` or failed task to another agent (named, or chosen automatically among agents with allowance left and outside the delegation chain), which continues on the same task branch from the handoff note.

claim accepts project-relative files or narrow glob patterns plus an intent and optional TTL. Conflicting active claims are refused with the holder and reason; a scoped task's claims must stay inside its scope. heartbeat extends the caller's claims; release drops selected or all caller claims, but a delegated task's scope stays claimed until the task ends. Pending task, collision, scope, handoff, and budget notices are appended to every successful tool reply.

Agent wiring: Claude reads `.mcp.json`; Codex uses its global `sharelane` MCP entry with ShareLane task variables forwarded via `-c mcp_servers.sharelane.env_vars=[...]`; Antigravity reads `.agents/mcp_config.json` and needs the global allow rule `mcp(sharelane/*)`. The MCP server uses `SHARELANE_WORKSPACE_ROOT` (set by the task worker) as its workspace when present.

The CLI supports npm run sharelane -- init for repeatable local setup and npm run sharelane -- run <agent> <prompt> for a synchronous adapter/runner check. Init writes context files, agent instructions, runtime Git ignores, the Claude edit guard and ShareLane usage status line in `.claude/settings.json` (leaving any other project status line alone), and Antigravity's `.agents/mcp_config.json` and `.agents/hooks.json`.
