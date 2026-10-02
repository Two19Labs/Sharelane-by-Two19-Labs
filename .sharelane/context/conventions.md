---
title: Project conventions
read-when: Following the project's coding, testing, documentation, or collaboration rules.
covers-files: ["AGENTS.md","CLAUDE.md","package.json","tsconfig.json"]
updated-at: 2026-10-02T14:50:32.294Z
source-hash: 7197ad1684873be44ab732e917fd783d029dfa75dadddf9b241cc98c665bd84b
---

# Project conventions

Explain each small step in plain language before doing it. Preserve other work, record lasting choices in docs/DECISIONS.md, and append a concise session handoff to GLOBAL_CONTEXT.md before finishing.

Keep multi-agent overhead marginal. Handle simple work directly; delegate only for clear specialization, independent review, parallelism, or an explicit request. When measurable, target roughly 25% or less fresh-token overhead versus a direct run; this remains guidance, and `budgetTokens` on delegate is the hard limit. Task status reports fresh input, cached input, and output separately.

Check remaining allowance with ShareLane's `usage` tool at checkpoints — between major steps, never in a loop. At or below 7% remaining in the lowest window (the owner's rule), stop starting new work, save, record a log_progress handoff, and (as a delegated worker) begin the final reply with `HANDOFF:`. "Could not tell" is never "fine".

Before editing, claim the exact project-relative files or narrow glob patterns with a concise intent. Heartbeat long-running manual claims and release them when finished; delegated supervisors heartbeat and release task claims automatically. Treat task branches as reviewable hand-backs: ShareLane does not auto-merge them into the owner's branch.

Read only the current snapshot and newest relevant work-log entry, then use the context map to open only relevant chunks or document sections. Avoid rereading unchanged files, old logs, full transcripts, repeated status polling, and large output dumps. Reuse task sessions for follow-ups and keep prompts, progress notes, handoffs, and final answers concise.

Use npm test for protocol and core tests, npm run typecheck for TypeScript, npm audit --audit-level=high for dependency checks, and npm run sharelane -- init for local setup, runtime Git ignores, the Claude edit guard and usage status line, and Antigravity wiring. Agent commands must use argument arrays with no shell.
