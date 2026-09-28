---
title: Project decisions
read-when: Understanding why a storage, context, testing, or agent-integration choice was made.
covers-files: ["docs/DECISIONS.md"]
updated-at: 2026-09-28T14:47:05.038Z
source-hash: c6c15e895c4a3f6c0b7d37b7146593aad2be39603f8d93cd5c1ec07f7ed7ca3c
---

# Project decisions

The complete append-only record is docs/DECISIONS.md. Phase 1 decisions choose built-in SQLite/FTS5, small capped context chunks, committed curated context, accurate MCP annotations, content fingerprints, and Node's test runner.

Phase 2 decisions 34–42 choose validated YAML adapters; shell-free argument spawning; normalized Claude/Codex results and ignored raw logs; persistent detached tasks and conversation messages; same-session replies; guarded cancellation; complete lineage with a depth limit of three and cycle rejection; a context-rich first worker prompt; read-only orphan reporting; a Windows CIM broker; and final wait synchronization for task files.

Decision 43 makes token-efficient orchestration the default: direct execution for simple work, value-gated delegation, a roughly 25% fresh-token overhead target when measurable, separate cache reporting, progressive context loading, and automatic warnings/budgets planned for Phase 5.

Phase 3 decisions 44–48 choose external temporary worktrees and reviewable task branches without auto-merge; automatic local commits and checkout cleanup; 15-minute claims with 30-second task heartbeats; conservative file/glob overlap refusal; advisory duplicate warnings at 60% prompt word overlap; a generated Claude edit-blocking hook plus Git fallback detection; and SQLite notices delivered on normal MCP replies.

Phases 1, 2, and 3 are complete. Phase 4 adds scoped permissions on top of the Phase 3 isolation and detection layers.
