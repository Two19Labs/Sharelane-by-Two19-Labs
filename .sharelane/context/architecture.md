---
title: Architecture
read-when: Understanding ShareLane components and data flow.
covers-files: ["src/**"]
updated-at: 2026-09-26T20:50:48.371Z
source-hash: 7df7e0b8c1147d52af58878440039bfd23e233447ceb4ae85f82162e78f8b895
---

# Architecture

ShareLane is a local MCP hub for shared agent context. Each agent starts its own stdio MCP server in the project directory. The server delegates behavior to reusable core modules.

Phase 1 flow: MCP or CLI request ? context core ? human-readable Markdown chunks plus one local SQLite database. MAP.md is generated from chunk headers; FTS5 indexes chunks and journal notes. WAL mode and a busy timeout let separate server processes safely share the database.
