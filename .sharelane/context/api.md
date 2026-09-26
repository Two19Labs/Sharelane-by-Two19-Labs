---
title: API and tools
read-when: Changing commands, MCP tools, integrations, or public interfaces.
covers-files: ["src/mcp/**","src/cli.ts"]
updated-at: 2026-09-26T20:50:48.713Z
source-hash: e30ff4ed13bf8a00fee45eefcefe510b88aa8e25d2a9954d547eeae569e68a7b
---

# API and tools

The MCP server exposes nine tools. Phase 0 tools are ping, whoami, note, and notes. Phase 1 adds context_map, read_chunk, update_chunk, search, and log_progress.

Run the development initializer with npm run sharelane -- init. It creates the context layout, database, and marked instruction blocks without overwriting existing chunks.
