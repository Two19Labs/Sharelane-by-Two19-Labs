---
title: Project decisions
read-when: Understanding why a storage, context, testing, or agent-integration choice was made.
covers-files: ["docs/DECISIONS.md"]
updated-at: 2026-10-03T06:05:45.600Z
source-hash: 84a89399a31e454f4f578226a5b5ea2465b6fc36a287c156e082229f8d914874
---

# Project decisions

The complete append-only record is docs/DECISIONS.md. Phase 1 decisions choose built-in SQLite/FTS5, small capped context chunks, committed curated context, accurate MCP annotations, content fingerprints, and Node's test runner.

Phase 2 decisions 34–42 choose validated YAML adapters; shell-free argument spawning; normalized results and ignored raw logs; persistent detached tasks and conversation messages; same-session replies; guarded cancellation; lineage with a depth limit of three and cycle rejection; a context-rich first worker prompt; read-only orphan reporting; a Windows CIM broker; and final wait synchronization for task files. Decision 43 makes token-efficient orchestration the default.

Phase 3 decisions 44–48 choose reviewable task branches without auto-merge, automatic local commits and cleanup, 15-minute claims with heartbeats, conservative overlap refusal and advisory duplicate warnings, edit blocking plus Git detection, and SQLite notices on MCP replies. Phase 4 decisions 49–53 choose an optional normalized delegation scope, claimed atomically; the `{scopeArgs}` adapter slot with Claude `dontAsk` rules and a scope-rooted Codex sandbox; a guard scope check with `scope_violation` detection; and patch-and-restore for out-of-scope changes.

Decisions 54–57 (2026-10-01) replace Gemini CLI with Antigravity CLI as the third agent, resolve npm `.cmd` launchers without a shell, and fix issues found by the first real three-agent run.

Phase 5 decisions 58–63 (2026-10-02): per-run usage accounting; the owner's 7% lowest-window handoff rule where "could not tell" is never "fine" (replacing P8); Claude quota from a status-line snapshot with a rate-limited token endpoint fallback, as the owner chose; save-first handoffs with automatic reassignment; per-task token budgets; and Antigravity's command permissions.

Phase 6 decisions 64–66 (2026-10-03): a dependency-free, local-only, read-only dashboard with a Host allow-list, strict CSP, and 2-second polling; snapshot-only quota, caching, and per-run attribution on the dashboard; and data-viz visual rules.

Phase 7 decisions 67–70 (2026-10-03):
- `run_check`: the owner-approved allow-list, prefilled from package.json, read from the project checkout and never a worker's copy. It is not a sandbox. It was chosen by the owner over delegating terminal commands to another agent.
- An npm package (`sharelane`, MIT, the owner's choice) shipping TypeScript run by tsx, with four commands.
- MCP configs launch `node <project-relative bin> mcp`, because `npx.cmd` cannot start without a shell. `init` never edits global configs without `--yes`.
- `init` detects and wires every installed agent CLI, and `npm.cmd`/`npx.cmd` are resolved without a shell.

Phases 1–6 are complete and the Phase 7 code is complete. Publishing (repository URL, `npm publish`, demo video) is the owner's step.
