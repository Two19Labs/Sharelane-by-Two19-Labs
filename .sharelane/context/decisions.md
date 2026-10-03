---
title: Project decisions
read-when: Understanding why a storage, context, testing, or agent-integration choice was made.
covers-files: ["docs/DECISIONS.md"]
updated-at: 2026-10-03T05:22:28.117Z
source-hash: 58887dc0340518bcc5fcc2eb19686695ce49751baaac1f1211c969cb5c17724d
---

# Project decisions

The complete append-only record is docs/DECISIONS.md. Phase 1 decisions choose built-in SQLite/FTS5, small capped context chunks, committed curated context, accurate MCP annotations, content fingerprints, and Node's test runner.

Phase 2 decisions 34–42 choose validated YAML adapters; shell-free argument spawning; normalized results and ignored raw logs; persistent detached tasks and conversation messages; same-session replies; guarded cancellation; lineage with a depth limit of three and cycle rejection; a context-rich first worker prompt; read-only orphan reporting; a Windows CIM broker; and final wait synchronization for task files. Decision 43 makes token-efficient orchestration the default.

Phase 3 decisions 44–48 choose reviewable task branches without auto-merge, automatic local commits and cleanup, 15-minute claims with heartbeats, conservative overlap refusal and advisory duplicate warnings, edit blocking plus Git detection, and SQLite notices on MCP replies. Phase 4 decisions 49–53 choose an optional normalized delegation scope, claimed atomically; the `{scopeArgs}` adapter slot with Claude `dontAsk` rules and a scope-rooted Codex sandbox; a guard scope check with `scope_violation` detection; and patch-and-restore for out-of-scope changes.

Decisions 54–57 (2026-10-01) replace Gemini CLI with Antigravity CLI as the third agent (configuration plus one parser, `.agents/` wiring, one global `mcp(sharelane/*)` allow rule, `workerNotes`), resolve npm `.cmd` launchers without a shell, and fix issues found by the first real three-agent run.

Phase 5 decisions 58–63 (2026-10-02):
- per-run usage accounting with per-CLI fresh-input normalization;
- the owner's 7% lowest-window handoff rule, where "could not tell" is never "fine" (replacing proposal P8);
- Claude quota from a token-free status-line snapshot with a rate-limited token endpoint fallback, as the owner chose;
- save-first handoffs with automatic reassignment;
- per-task token budgets;
- Antigravity's command permissions.

Phase 6 decisions 64–66 (2026-10-03):
- a dependency-free dashboard bound to 127.0.0.1, with a Host allow-list against DNS rebinding, GET-only and read-only, a strict self-only CSP, and text-node rendering; 2-second polling and byte-offset live output;
- dashboard quota from the saved Claude snapshot only, 30-second caching, and per-run token attribution with legacy usage shown;
- visual rules from the data-viz method: icon-plus-label statuses, a validated chart palette with a table view, selected dark colours, and faded meters for untrustworthy readings.

Phases 1–6 are complete. Phase 7 is more agents and launch.
