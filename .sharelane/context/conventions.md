---
title: Project conventions
read-when: Following the project's coding, testing, documentation, or collaboration rules.
covers-files: ["AGENTS.md","CLAUDE.md","package.json","tsconfig.json"]
updated-at: 2026-10-03T06:05:19.132Z
source-hash: 39e4d970049854f31fc53f7678f710347846f8d7c943738b5f326b191fd28855
---

# Project conventions

Explain each small step in plain language before doing it. Preserve other work, record lasting choices in docs/DECISIONS.md, and append a concise session handoff to GLOBAL_CONTEXT.md before finishing.

Keep multi-agent overhead marginal. Handle simple work directly; delegate only for clear specialization, independent review, parallelism, or an explicit request. When measurable, target roughly 25% or less fresh-token overhead versus a direct run; this remains guidance, and `budgetTokens` on delegate is the hard limit. Task status reports fresh input, cached input, and output separately.

Check remaining allowance with ShareLane's `usage` tool at checkpoints — between major steps, never in a loop. At or below 7% remaining in the lowest window (the owner's rule), stop starting new work, save, record a log_progress handoff, and (as a delegated worker) begin the final reply with `HANDOFF:`. "Could not tell" is never "fine". Delegated workers run approved checks with `run_check` instead of terminal commands.

Before editing, claim the exact project-relative files or narrow glob patterns with a concise intent. Heartbeat long-running manual claims and release them when finished; delegated supervisors heartbeat and release task claims automatically. Treat task branches as reviewable hand-backs: ShareLane does not auto-merge them into the owner's branch. Subagent work (for example Claude Code agents in `.claude/worktrees/`, which are git-ignored) is reviewed and merged by the orchestrator, not trusted blindly.

Read only the current snapshot and newest relevant work-log entry, then use the context map to open only relevant chunks or document sections. Avoid rereading unchanged files, old logs, full transcripts, repeated status polling, and large output dumps. Reuse task sessions for follow-ups and keep prompts, progress notes, handoffs, and final answers concise.

Checks: npm test (70 tests; some spawn processes and are load-sensitive, so re-run before calling a failure real), npm run typecheck, npm audit, npm pack --dry-run (only bin/, src/, LICENSE, README.md), and npm run sharelane -- init. Run init with the full user PATH (VS Code terminals may lack claude/agy) so every agent is detected. The package is MIT, ships TypeScript run by tsx at runtime, and exposes the `sharelane` bin (init, mcp, dashboard, run). Agent and check commands always use argument arrays with no shell. On Windows, prefer file-writing tools over shell heredocs and sed for TypeScript, because they mangle backslashes and `\n`.
