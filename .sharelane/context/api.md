---
title: API and tools
read-when: Changing commands, MCP tools, integrations, or public interfaces.
covers-files: ["src/mcp/**","src/cli.ts"]
updated-at: 2026-09-29T07:23:06.148Z
source-hash: f2eb1d99c8518d96b7b1d028c5643424c0ff9c90d12630455e80c45ff12d0fde
---

# API and tools

The MCP server exposes seventeen tools. Phase 0 provides ping, whoami, note, and notes. Phase 1 provides context_map, read_chunk, update_chunk, search, and log_progress. Phase 2 provides delegate, status, wait, reply, and cancel. Phase 3 provides claim, heartbeat, and release.

delegate returns a task ID immediately and is intended for specialist, independent-review, parallel, or explicitly requested value—not as the default for simple work. Its optional `scope` (1–50 project-relative files, folders, or globs such as `src/ui/**`) limits what the worker may change; omitting it keeps whole-project access. The scope is claimed for the task, translated into the agent's CLI restrictions, enforced by the Claude hook, and checked by Git. A scope overlapping another owner's claim refuses the delegation. status reads the latest state and result, wait pauses briefly for a final state, reply reuses the saved agent session (and re-claims the same scope), and cancel closes queued or running work. Reusing reply avoids paying to rebuild a new conversation, and final wait results refresh the readable task Markdown before returning.

claim accepts project-relative files or narrow glob patterns plus an intent and optional TTL. Conflicting active claims are refused with the holder and reason; a scoped task's claims must stay inside its scope. heartbeat extends the caller's claims; release drops selected or all caller claims. Pending task/collision/scope notices are appended to every successful tool reply. Task status includes its hand-back branch, result commit, changed files, scope, and any scope violations kept off the branch.

The MCP server uses `SHARELANE_WORKSPACE_ROOT` (set by the task worker) as its workspace when present, so a Codex worker started inside a scope folder still sees the checkout's context. The Codex adapter forwards ShareLane task variables to its MCP server with `-c mcp_servers.sharelane.env_vars=[...]`.

The CLI supports npm run sharelane -- init for repeatable local setup and npm run sharelane -- run <agent> <prompt> for a synchronous adapter/runner check. Init also merges a project Claude `PreToolUse` edit guard (claims plus scope) into `.claude/settings.json` without replacing existing hooks and adds missing local-runtime paths to `.gitignore`.
