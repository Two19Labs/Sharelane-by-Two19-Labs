---
title: Project conventions
read-when: Following the project's coding, testing, documentation, or collaboration rules.
covers-files: ["AGENTS.md","CLAUDE.md","package.json","tsconfig.json"]
updated-at: 2026-09-28T14:47:04.249Z
source-hash: 20b2269baa5cb1a6194c61b5c4e118832613428218d1afe0d5bf86afe40c51aa
---

# Project conventions

Explain each small step in plain language before doing it. Preserve other work, record lasting choices in docs/DECISIONS.md, and append a concise session handoff to GLOBAL_CONTEXT.md before finishing.

Keep multi-agent overhead marginal. Handle simple work directly; delegate only for clear specialization, independent review, parallelism, or an explicit request. When measurable, target roughly 25% or less fresh-token overhead versus a direct run and report fresh input/output separately from cache reads/writes. This is a workflow target until Phase 5 adds cumulative accounting, warnings, and hard budgets.

Before editing, claim the exact project-relative files or narrow glob patterns with a concise intent. Heartbeat long-running manual claims and release them when finished; delegated supervisors heartbeat and release task claims automatically. Treat task branches as reviewable hand-backs: ShareLane does not auto-merge them into the owner's branch.

Read only the current snapshot and newest relevant work-log entry, then use the context map to open only relevant chunks or document sections. Avoid rereading unchanged files, old logs, full transcripts, repeated status polling, and large output dumps. Reuse task sessions for follow-ups and keep prompts, progress notes, handoffs, and final answers concise.

Use npm test for protocol and core tests, npm run typecheck for TypeScript, npm audit --audit-level=high for dependency checks, and npm run sharelane -- init for local setup, runtime Git ignores, and Claude hook installation. Agent commands must use argument arrays with no shell.
