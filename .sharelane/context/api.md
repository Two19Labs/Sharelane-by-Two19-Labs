---
title: API and tools
read-when: Changing commands, MCP tools, integrations, or public interfaces.
covers-files: ["src/mcp/**","src/cli.ts"]
updated-at: 2026-10-01T17:23:46.986Z
source-hash: 1f882b6d2345cc3b0fe568ebd3de0cdf3c9493b83e56ae2726be9ec3c66b4eb0
---

# API and tools

The MCP server exposes seventeen tools. Phase 0 provides ping, whoami, note, and notes. Phase 1 provides context_map, read_chunk, update_chunk, search, and log_progress. Phase 2 provides delegate, status, wait, reply, and cancel. Phase 3 provides claim, heartbeat, and release.

delegate starts one of the configured agents — `claude`, `codex`, or `antigravity` (Antigravity CLI, `agy`) — and returns a task ID immediately. It is intended for specialist, independent-review, parallel, or explicitly requested value, not as the default for simple work. Its optional `scope` (1–50 project-relative files, folders, or globs such as `src/ui/**`) limits what the worker may change; omitting it keeps whole-project access. The scope is claimed for the task, translated into the agent's CLI restrictions, enforced by the shared edit guard, and checked by Git. A scope overlapping another owner's claim refuses the delegation. status reads the latest state and result, wait pauses briefly for a final state, reply reuses the saved agent session (and re-claims the same scope), and cancel closes queued or running work.

claim accepts project-relative files or narrow glob patterns plus an intent and optional TTL. Conflicting active claims are refused with the holder and reason; a scoped task's claims must stay inside its scope. heartbeat extends the caller's claims; release drops selected or all caller claims, but a delegated task's scope stays claimed until the task ends. Pending task/collision/scope notices are appended to every successful tool reply. Task status includes its hand-back branch, result commit, changed files, scope, and any scope violations kept off the branch.

Agent wiring: Claude reads `.mcp.json`; Codex uses its global `sharelane` MCP entry, and the adapter forwards ShareLane task variables with `-c mcp_servers.sharelane.env_vars=[...]`; Antigravity reads `.agents/mcp_config.json` and needs the global allow rule `mcp(sharelane/*)` in `~/.gemini/antigravity-cli/settings.json`. The MCP server uses `SHARELANE_WORKSPACE_ROOT` (set by the task worker) as its workspace when present.

The CLI supports npm run sharelane -- init for repeatable local setup and npm run sharelane -- run <agent> <prompt> for a synchronous adapter/runner check. Init writes context files, agent instructions, runtime Git ignores, the Claude `PreToolUse` edit guard in `.claude/settings.json`, and Antigravity's `.agents/mcp_config.json` and `.agents/hooks.json` (the same guard script), merging with existing settings.
