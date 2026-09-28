---
title: Architecture
read-when: Understanding ShareLane components and data flow.
covers-files: ["src/**"]
updated-at: 2026-09-28T13:56:57.411Z
source-hash: 09f6ec50cd8231b0f55f6f344563d1950bed0a33bd26395e8ec3ebfc5c90c52e
---

# Architecture

ShareLane is a local MCP hub with two connected flows. Context requests go from the MCP server or CLI into the context core, which maintains small Markdown chunks, a generated map, SQLite records, FTS5 search, and a progress journal. Delegation requests go from MCP task tools into the task core, runner, and configuration-driven agent adapters.

A delegated task is persisted before a detached supervisor starts. The supervisor builds a context-rich first prompt, starts the selected CLI without a shell, normalizes its JSON output, stores the conversation and session ID, and writes a human-readable task file. Replies resume that saved CLI session. Status, wait, cancel, lineage limits, cycle rejection, orphan detection, and Windows process brokering make the lifecycle observable and safe.

Each agent still starts its own stdio MCP server in the project directory. SQLite WAL mode and a busy timeout let those processes share local state safely. Phase 2 is complete; requirement evidence is in docs/PHASE_2_AUDIT.md.
