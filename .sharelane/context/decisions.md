---
title: Project decisions
read-when: Understanding why a storage, context, testing, or agent-integration choice was made.
covers-files: ["docs/DECISIONS.md"]
updated-at: 2026-09-29T07:23:11.318Z
source-hash: a0e1419e74968e6b90248b01d39d57cfb64d63be13bb7688bac0f54c894dc1c6
---

# Project decisions

The complete append-only record is docs/DECISIONS.md. Phase 1 decisions choose built-in SQLite/FTS5, small capped context chunks, committed curated context, accurate MCP annotations, content fingerprints, and Node's test runner.

Phase 2 decisions 34–42 choose validated YAML adapters; shell-free argument spawning; normalized Claude/Codex results and ignored raw logs; persistent detached tasks and conversation messages; same-session replies; guarded cancellation; complete lineage with a depth limit of three and cycle rejection; a context-rich first worker prompt; read-only orphan reporting; a Windows CIM broker; and final wait synchronization for task files.

Decision 43 makes token-efficient orchestration the default: direct execution for simple work, value-gated delegation, a roughly 25% fresh-token overhead target when measurable, separate cache reporting, progressive context loading, and automatic warnings/budgets planned for Phase 5.

Phase 3 decisions 44–48 choose external temporary worktrees and reviewable task branches without auto-merge; automatic local commits and checkout cleanup; 15-minute claims with 30-second task heartbeats; conservative file/glob overlap refusal; advisory duplicate warnings at 60% prompt word overlap; a generated Claude edit-blocking hook plus Git fallback detection; and SQLite notices delivered on normal MCP replies.

Phase 4 decisions 49–53 choose an optional, normalized, persisted delegation scope (no scope keeps whole-project behavior); the scope as the task's atomically created claim, with out-of-scope claims refused; an adapter `{scopeArgs}` slot giving Claude `dontAsk` plus scoped Edit/Write rules and Codex a scope-rooted sandbox without temp-folder writes, plus Codex MCP task-variable forwarding; a scope check in the Claude hook and distinct `scope_violation` detection; and saving out-of-scope changes to a patch while keeping them off the task branch.

Phases 1–4 are complete. Phase 5 adds usage accounting, overhead budgets, quota reading, and handoffs.
