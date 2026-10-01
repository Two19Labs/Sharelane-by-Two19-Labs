---
title: Architecture
read-when: Understanding ShareLane components and data flow.
covers-files: ["src/**"]
updated-at: 2026-10-01T17:23:47.895Z
source-hash: c8206bced5e434d045949c047aa2b54112e1e6c911821903046ce328229a80ce
---

# Architecture

ShareLane is a local MCP hub with two connected flows. Context requests go from the MCP server or CLI into the context core, which maintains small Markdown chunks, a generated map, SQLite records, FTS5 search, and a progress journal. Delegation requests go from MCP task tools into the task core, runner, and configuration-driven agent adapters (`src/adapters/agents.yaml`: Claude Code, Codex, Antigravity CLI). Adding an agent is configuration plus, if its output format is new, one parser in `src/adapters/result.ts`. Adapters may add `workerNotes` to a new task's instructions (Antigravity is told not to run commands, because a refused command ends its headless turn).

A delegated task is persisted before a detached supervisor starts. For a Git-backed project, ShareLane first creates an external temporary worktree on a unique `sharelane/task-*` branch, linking the project's `node_modules`. The supervisor builds a focused first prompt containing the context map, claim rules, scope rules, worker notes, and token-efficiency rules, then starts the selected CLI without a shell inside that isolated checkout; on Windows an npm `.cmd` launcher is resolved to `node <script>` so no shell is needed. It normalizes JSON output, stores the conversation/session, commits remaining worker changes, records the result branch/commit/files, unlinks the dependency link, and removes the temporary checkout. Replies recreate the same task branch (clearing any leftover folder) and resume the saved CLI session. Status, wait, cancel, lineage limits, cycle rejection, orphan detection, and Windows process brokering make the lifecycle observable and safe.

Collision prevention is layered. SQLite claims assign project-relative files or globs to an agent/task, reject conservative overlaps, expire after 15 minutes by default, refresh through explicit or automatic heartbeat, and release at task termination. Similar active prompts create advisory duplicate notices. One generated guard script blocks unclaimed built-in edits for both Claude (`PreToolUse` `Edit|Write`) and Antigravity (`.agents/hooks.json` `PreToolUse` on its file tools); a Git watcher plus final diff flags unclaimed changes from Codex, shell commands, or unsupported tools. ShareLane's own `.sharelane/context/**` updates are never flagged. SQLite notices are appended to every successful MCP reply because separate stdio hubs cannot push alerts.

Scoped permissions (`src/core/scope.ts`) reuse every layer. A normalized scope is stored on the task and claimed atomically with it; the worker cannot claim outside it or release it early. The adapter's `{scopeArgs}` slot turns it into CLI restrictions: Claude runs with `dontAsk` plus `Edit/Write(pattern)` allow rules; Codex runs its workspace-write sandbox rooted at the scope folder without temp-folder writes; Antigravity relies on the guard hook. Finalization saves out-of-scope changes to a patch file and restores those paths before committing, so the task branch only ever carries in-scope work.

The efficiency path is progressive: simple work stays with the orchestrator; useful delegated work begins with only the map; workers open only relevant chunks and files and keep outputs concise. SQLite WAL mode and a busy timeout let the per-agent stdio MCP servers share local state safely.
