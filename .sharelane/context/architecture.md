---
title: Architecture
read-when: Understanding ShareLane components and data flow.
covers-files: ["src/**"]
updated-at: 2026-09-28T14:47:01.983Z
source-hash: 678ee8a9ed9aadeb66f97caf59e613ac63a490f877bbc1d187e1a014d73cd67d
---

# Architecture

ShareLane is a local MCP hub with two connected flows. Context requests go from the MCP server or CLI into the context core, which maintains small Markdown chunks, a generated map, SQLite records, FTS5 search, and a progress journal. Delegation requests go from MCP task tools into the task core, runner, and configuration-driven agent adapters.

A delegated task is persisted before a detached supervisor starts. For a Git-backed project, ShareLane first creates an external temporary worktree on a unique `sharelane/task-*` branch. The supervisor builds a focused first prompt containing the context map, claim rules, and token-efficiency rules, then starts the selected CLI without a shell inside that isolated checkout. It normalizes JSON output, stores the conversation/session, commits remaining worker changes, records the result branch/commit/files, and removes the temporary checkout. Replies recreate the same task branch and resume the saved CLI session. Status, wait, cancel, lineage limits, cycle rejection, orphan detection, and Windows process brokering make the lifecycle observable and safe.

Collision prevention is layered. SQLite claims assign project-relative files or globs to an agent/task, reject conservative overlaps, expire after 15 minutes by default, refresh through explicit or automatic heartbeat, and release at task termination. Similar active prompts create advisory duplicate notices. A generated Claude `PreToolUse` hook blocks unclaimed `Edit`/`Write` calls; a Git watcher plus final diff flags unclaimed changes from Codex, shell commands, or unsupported tools. SQLite notices are appended to every successful MCP reply because separate stdio hubs cannot push alerts.

The efficiency path is progressive: simple work stays with the orchestrator; useful delegated work begins with only the map; workers open only relevant chunks and files, avoid rereading unchanged material, and keep outputs concise. Each agent still starts its own stdio MCP server in the project directory. SQLite WAL mode and a busy timeout let those processes share local state safely.
