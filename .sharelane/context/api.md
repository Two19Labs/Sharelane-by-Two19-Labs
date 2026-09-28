---
title: API and tools
read-when: Changing commands, MCP tools, integrations, or public interfaces.
covers-files: ["src/mcp/**","src/cli.ts"]
updated-at: 2026-09-28T14:18:43.584Z
source-hash: 7dbbd206d654c25b181b268e0c87141cfe18b409b19f166e154f0d5a6c03a877
---

# API and tools

The MCP server exposes fourteen tools. Phase 0 provides ping, whoami, note, and notes. Phase 1 provides context_map, read_chunk, update_chunk, search, and log_progress. Phase 2 provides delegate, status, wait, reply, and cancel.

delegate returns a task ID immediately and is intended for specialist, independent-review, parallel, or explicitly requested value—not as the default for simple work. status reads the latest state and result, wait pauses briefly for a final state, reply reuses the saved agent session, and cancel closes queued or running work. Reusing reply avoids paying to rebuild a new conversation, and final wait results refresh the readable task Markdown before returning.

The CLI supports npm run sharelane -- init for repeatable local setup and npm run sharelane -- run <agent> <prompt> for a synchronous adapter/runner check.
