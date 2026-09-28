---
title: API and tools
read-when: Changing commands, MCP tools, integrations, or public interfaces.
covers-files: ["src/mcp/**","src/cli.ts"]
updated-at: 2026-09-28T14:47:02.739Z
source-hash: 4b9b704f441712cb35c0f04caa1a35f158716c234a8a967de741dcc4e59d80f7
---

# API and tools

The MCP server exposes seventeen tools. Phase 0 provides ping, whoami, note, and notes. Phase 1 provides context_map, read_chunk, update_chunk, search, and log_progress. Phase 2 provides delegate, status, wait, reply, and cancel. Phase 3 provides claim, heartbeat, and release.

delegate returns a task ID immediately and is intended for specialist, independent-review, parallel, or explicitly requested value—not as the default for simple work. status reads the latest state and result, wait pauses briefly for a final state, reply reuses the saved agent session, and cancel closes queued or running work. Reusing reply avoids paying to rebuild a new conversation, and final wait results refresh the readable task Markdown before returning.

claim accepts project-relative files or narrow glob patterns plus an intent and optional TTL. Conflicting active claims are refused with the holder and reason; heartbeat extends the caller's claims; release drops selected or all caller claims. Pending task/collision notices are appended to every successful tool reply. Task status includes its hand-back branch, result commit, and changed files.

The CLI supports npm run sharelane -- init for repeatable local setup and npm run sharelane -- run <agent> <prompt> for a synchronous adapter/runner check. Init also merges a project Claude `PreToolUse` edit guard into `.claude/settings.json` without replacing existing hooks and adds missing local-runtime paths to `.gitignore`.
