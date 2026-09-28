---
title: Architecture
read-when: Understanding ShareLane components and data flow.
covers-files: ["src/**"]
updated-at: 2026-09-28T14:18:42.733Z
source-hash: 0abb309e3890340c68461e6cb932a6f3d3af885ee57d7bd63ef42b9e717a9765
---

# Architecture

ShareLane is a local MCP hub with two connected flows. Context requests go from the MCP server or CLI into the context core, which maintains small Markdown chunks, a generated map, SQLite records, FTS5 search, and a progress journal. Delegation requests go from MCP task tools into the task core, runner, and configuration-driven agent adapters.

A delegated task is persisted before a detached supervisor starts. The supervisor builds a focused first prompt containing the context map and token-efficiency rules, starts the selected CLI without a shell, normalizes its JSON output, stores the conversation and session ID, and writes a human-readable task file. Replies resume that saved CLI session. Status, wait, cancel, lineage limits, cycle rejection, orphan detection, and Windows process brokering make the lifecycle observable and safe.

The efficiency path is progressive: simple work stays with the orchestrator; useful delegated work begins with only the map; workers open only relevant chunks and files, avoid rereading unchanged material, and keep outputs concise. Each agent still starts its own stdio MCP server in the project directory. SQLite WAL mode and a busy timeout let those processes share local state safely.
