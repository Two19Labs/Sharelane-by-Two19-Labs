---
title: API and tools
read-when: Changing commands, MCP tools, integrations, or public interfaces.
covers-files: ["src/mcp/**","src/cli.ts","src/core/later.ts","src/core/uninstall.ts","bin/**","scripts/**"]
updated-at: 2026-10-21T20:11:46.836Z
source-hash: 31a8c358e8242744457a074ddf3fbdcc0d606a4f1f769287c70e8d9e33630e60
---

# API and tools

The MCP server exposes twenty tools. Phase 0 provides ping, whoami, note, and notes. Phase 1 provides context_map, read_chunk, update_chunk, search, and log_progress. Phase 2 provides delegate, status, wait, reply, and cancel. Phase 3 provides claim, heartbeat, and release. Phase 5 provides usage and reassign. Phase 7 provides run_check.

delegate starts one of the configured agents — `claude`, `codex`, or `antigravity` (Antigravity CLI, `agy`) — and returns a task ID immediately. Use it for specialist, independent-review, parallel, or explicitly requested value, not as the default for simple work.
- Optional `scope` (1–50 project-relative files, folders, or globs) limits what the worker may change.
- Optional `budgetTokens` caps fresh tokens across all of the task's runs.
- Optional `tier` (`fast` | `balanced` | `strong` | `auto` | `default`, decision 76): how hard the task is. The delegating agent should pick the cheapest tier it expects to succeed; omitted or `auto` guesses from the wording (`src/core/tiers.ts`), `default` keeps the agent's own model. Each adapter maps the tier to its own model or effort (`tiers` + `modelFlags` + a `{modelArgs}` slot in `agents.yaml`).

status shows state, branch, scope, model tier (and why), violations, total usage, reassignments, and handoff reason. wait returns at a final state, including `needs_reassignment`. reply resumes the session and re-claims the scope (refused once the conversation was ended from the dashboard). cancel closes queued, running, or waiting work.

usage reports remaining allowance: keep working, HAND OFF (at or below 7% in the lowest window), or could not tell. reassign hands a waiting or failed task to another agent on the same branch; the tier carries over and maps to the new agent's models.

run_check `{name?}` lists or runs one owner-approved check from `.sharelane/checks.json`. The list is read from the project checkout (`SHARELANE_PROJECT_ROOT`), never the worker's worktree copy. The check runs without a shell in the caller's workspace (`SHARELANE_WORKSPACE_ROOT`), so it sees uncommitted edits, with a timeout and an 8 KB output tail. It is not a sandbox: tests execute project code. Claude workers' `--allowedTools` include `usage` and `run_check`.

claim, heartbeat, and release manage expiring file and glob claims; a scoped task's claims must stay inside its scope, and its scope stays claimed until it ends. Pending notices ride on every successful tool reply.

Agent wiring: Claude reads `.mcp.json` (pre-approved in `.claude/settings.local.json`); Codex uses a global `sharelane` MCP entry with task variables forwarded via `-c mcp_servers.sharelane.env_vars=[...]`; Antigravity reads `.agents/mcp_config.json` and needs the global allow rule `mcp(sharelane/*)`. Generated configs launch `node <bin> mcp`, with a project-relative bin path when ShareLane is installed in the project.

CLI (the `sharelane` bin, or `npm run sharelane -- …` in this repo). `bin/sharelane.mjs` refuses Node older than 24 before loading anything (decision 83).
- `init [--no-global]` detects claude, codex, and agy on PATH, checks what is already configured, and wires what is missing, including the global Codex entry and Antigravity rule unless `--no-global` (decision 79; `--yes` is still accepted). Writes context, instructions, ignores, `.sharelane/checks.json`, and the one-time `.sharelane/ONBOARDING.md` (decision 80). Prints Done / Skipped / Still to do / When you share this repo, and warns when the folder is not a Git repo or has no commits.
- `mcp` runs the MCP stdio server.
- `dashboard [--port 4317] [--open]` serves the office dashboard; its HTTP API (reads, guarded controls, changes, previews) is described in the `ui` chunk.
- `run <agent> <prompt>` runs one agent once, directly; it is not a delegated task.
- `later ["prompt"] (--in 2h | --at 16:30 | --when-reset) [--background] [--session <id>]`, `later list`, `later cancel <id>` (`src/core/later.ts`, decision 81). Entries are `.sharelane/later/<id>.json`; a detached `later wait <id>` process polls the wall clock, then fires: window mode opens a terminal running `later run <id>` (Claude with inherited stdio), background mode runs `claude -p … --permission-mode acceptEdits` and logs to `<id>.log`.
- `uninstall [--global]` removes only what init added (`src/core/uninstall.ts`, decision 82).
- `--version`.

`scripts/smoke-install.mjs` packs and installs the package into a throwaway prefix and home and runs init, MCP, dashboard, later and uninstall; CI runs it on all three systems. It sets `CODEX_HOME`, because a real Codex on PATH ignores HOME on Windows.
