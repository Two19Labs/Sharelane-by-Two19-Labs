---
title: API and tools
read-when: Changing commands, MCP tools, integrations, or public interfaces.
covers-files: ["src/mcp/**","src/cli.ts"]
updated-at: 2026-09-28T13:56:58.270Z
source-hash: a3f6ada68f3f11e6eef2bdef06d94711e2da44ed24a61fc6a9041dd6c43f9ae3
---

# API and tools

The MCP server exposes fourteen tools. Phase 0 provides ping, whoami, note, and notes. Phase 1 provides context_map, read_chunk, update_chunk, search, and log_progress. Phase 2 provides delegate, status, wait, reply, and cancel.

delegate returns a task ID immediately. status reads the latest state and result, wait pauses briefly for a final state, reply queues a follow-up in the saved agent session, and cancel closes queued or running work. Final wait results refresh the readable task Markdown before returning.

The CLI supports npm run sharelane -- init for repeatable local setup and npm run sharelane -- run <agent> <prompt> for a synchronous adapter/runner check.
