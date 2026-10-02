---
title: Project decisions
read-when: Understanding why a storage, context, testing, or agent-integration choice was made.
covers-files: ["docs/DECISIONS.md"]
updated-at: 2026-10-02T14:50:23.143Z
source-hash: cc49c6f0ead31a6fdf2e25a752cd6648a6eff8b83bd0ceab85d67c44a2bd05da
---

# Project decisions

The complete append-only record is docs/DECISIONS.md. Phase 1 decisions choose built-in SQLite/FTS5, small capped context chunks, committed curated context, accurate MCP annotations, content fingerprints, and Node's test runner.

Phase 2 decisions 34–42 choose validated YAML adapters; shell-free argument spawning; normalized results and ignored raw logs; persistent detached tasks and conversation messages; same-session replies; guarded cancellation; lineage with a depth limit of three and cycle rejection; a context-rich first worker prompt; read-only orphan reporting; a Windows CIM broker; and final wait synchronization for task files. Decision 43 makes token-efficient orchestration the default.

Phase 3 decisions 44–48 choose reviewable task branches without auto-merge, automatic local commits and cleanup, 15-minute claims with heartbeats, conservative overlap refusal and advisory duplicate warnings, edit blocking plus Git detection, and SQLite notices on MCP replies. Phase 4 decisions 49–53 choose an optional normalized delegation scope, claimed atomically; the `{scopeArgs}` adapter slot with Claude `dontAsk` rules and a scope-rooted Codex sandbox; a guard scope check with `scope_violation` detection; and patch-and-restore for out-of-scope changes.

Decisions 54–57 (2026-10-01) replace Gemini CLI with Antigravity CLI as the third agent (configuration plus one parser, `.agents/` wiring, one global `mcp(sharelane/*)` allow rule, `workerNotes`), resolve npm `.cmd` launchers without a shell, and fix issues found by the first real three-agent run.

Phase 5 decisions 58–63 (2026-10-02): per-run usage accounting with per-CLI fresh-input normalization and the schema-v5 table rebuild; the owner's 7% lowest-window handoff rule with fail-safe "could not tell" semantics and adapter-named quota readers (replacing proposal P8); Claude quota from a token-free status-line snapshot with the OAuth usage endpoint as a rate-limited fallback — narrowing the "never touches auth tokens" rule for this one read-only check, as the owner chose; pre-run checkpoints, save-first handoff notes, and automatic reassignment outside the delegation chain (at most twice) with a manual reassign tool; optional per-task fresh-token budgets enforced between runs; and Antigravity's command permissions set at the owner's request while headless workers stay file-only.

Phases 1–5 are complete. Phase 6 is the dashboard.
