---
title: API and tools
read-when: Changing commands, MCP tools, integrations, or public interfaces.
covers-files: ["src/mcp/**","src/cli.ts"]
updated-at: 2026-10-03T06:05:07.386Z
source-hash: c238f9382debc4119c0ddc2d483bd868858ccddaa63e2a7f78b90a676bd238dd
---

# API and tools

The MCP server exposes twenty tools. Phase 0 provides ping, whoami, note, and notes. Phase 1 provides context_map, read_chunk, update_chunk, search, and log_progress. Phase 2 provides delegate, status, wait, reply, and cancel. Phase 3 provides claim, heartbeat, and release. Phase 5 provides usage and reassign. Phase 7 provides run_check.

delegate starts one of the configured agents — `claude`, `codex`, or `antigravity` (Antigravity CLI, `agy`) — and returns a task ID immediately. Use it for specialist, independent-review, parallel, or explicitly requested value, not as the default for simple work.
- Optional `scope` (1–50 project-relative files, folders, or globs) limits what the worker may change.
- Optional `budgetTokens` caps fresh tokens across all of the task's runs.

status shows state, branch, scope, violations, total usage, reassignments, and handoff reason. wait returns at a final state, including `needs_reassignment`. reply resumes the session and re-claims the scope. cancel closes queued, running, or waiting work.

usage reports remaining allowance: keep working, HAND OFF (at or below 7% in the lowest window), or could not tell. reassign hands a waiting or failed task to another agent on the same branch.

run_check `{name?}` lists or runs one owner-approved check from `.sharelane/checks.json`. The list is read from the project checkout (`SHARELANE_PROJECT_ROOT`), never the worker's worktree copy. The check runs without a shell in the caller's workspace (`SHARELANE_WORKSPACE_ROOT`), so it sees uncommitted edits, with a timeout and an 8 KB output tail. It is not a sandbox: tests execute project code. Claude workers' `--allowedTools` include `usage` and `run_check`.

claim, heartbeat, and release manage expiring file and glob claims; a scoped task's claims must stay inside its scope, and its scope stays claimed until it ends. Pending notices ride on every successful tool reply.

Agent wiring: Claude reads `.mcp.json`; Codex uses a global `sharelane` MCP entry with task variables forwarded via `-c mcp_servers.sharelane.env_vars=[...]`; Antigravity reads `.agents/mcp_config.json` and needs the global allow rule `mcp(sharelane/*)`. Generated configs launch `node <bin> mcp`, with a project-relative bin path.

CLI (the `sharelane` bin, or `npm run sharelane -- …` in this repo):
- `init [--yes]` detects claude, codex, and agy on PATH and wires each. It writes context, instructions, ignores, and `.sharelane/checks.json`, and prints Done / Skipped / Still to do. `--yes` lets it run `codex mcp add`.
- `mcp` runs the MCP stdio server.
- `dashboard [--port 4317] [--open]` serves the read-only dashboard, with a GET-only `/api/state`, `/api/tasks/<id>`, and `/api/tasks/<id>/log?offset=<n>`.
- `run <agent> <prompt>` runs one agent once, directly; it is not a delegated task.
