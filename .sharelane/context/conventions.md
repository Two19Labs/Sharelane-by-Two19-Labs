---
title: Project conventions
read-when: Following the project's coding, testing, documentation, or collaboration rules.
covers-files: ["AGENTS.md","CLAUDE.md","package.json","tsconfig.json",".github/**","src/core/instructions.ts","src/core/onboarding.ts"]
updated-at: 2026-10-20T09:07:57.241Z
source-hash: 47c04d815ede920da85a3afce85d62ba5bfdf54c89134284d32401c64b5d11b4
---

# Project conventions

Explain each small step in plain language before doing it. Preserve other work and record lasting choices in docs/DECISIONS.md. The maintainers' work log, handoff, implementation plan, phase audits and feature plans (`private/plans/`) live in `private/` (git-ignored, its own local Git repository, decision 77); when it exists, append a concise session entry to `private/GLOBAL_CONTEXT.md` before finishing and commit it there, never in the main repository.

Keep multi-agent overhead marginal. Handle simple work directly; delegate only for clear specialization, independent review, parallelism, or an explicit request. When measurable, target roughly 25% or less fresh-token overhead versus a direct run; this remains guidance, and `budgetTokens` on delegate is the hard limit. Task status reports fresh input, cached input, and output separately. Pick the cheapest model `tier` you expect to succeed when delegating.

Check remaining allowance with ShareLane's `usage` tool at checkpoints — between major steps, never in a loop. At or below 7% remaining in the lowest window (the owner's rule), stop starting new work, save, record a log_progress handoff, and (as a delegated worker) begin the final reply with `HANDOFF:`. "Could not tell" is never "fine". Delegated workers run approved checks with `run_check` instead of terminal commands.

Before editing, claim the exact project-relative files or narrow glob patterns with a concise intent. Heartbeat long-running manual claims and release them when finished; delegated supervisors heartbeat and release task claims automatically. Treat task branches as reviewable hand-backs: ShareLane does not auto-merge them into the owner's branch. Subagent work (for example Claude Code agents in `.claude/worktrees/`, which are git-ignored) is reviewed and merged by the orchestrator, not trusted blindly. Several agents may work in this folder at once: stage only your own hunks when committing.

Read only the current snapshot and newest relevant work-log entry, then use the context map to open only relevant chunks or document sections. Avoid rereading unchanged files, old logs, full transcripts, repeated status polling, and large output dumps. Reuse task sessions for follow-ups and keep prompts, progress notes, handoffs, and final answers concise.

Per-project setup (what `sharelane init` writes in user projects): the ShareLane block in AGENTS.md/CLAUDE.md (`src/core/instructions.ts`), runtime ignores, agent configs, and a one-time `.sharelane/ONBOARDING.md` playbook (`src/core/onboarding.ts`) while any starter chunk still holds `STARTER_PLACEHOLDER`. The block tells the first agent to follow it: claim it, write every starter chunk with coversFiles, propose checks (ask before writing checks.json), delete it. It is git-ignored so delegated worktrees never see it. Global agent settings (Codex MCP entry, Antigravity allow rule) are applied by default; `--no-global` opts out. Releases: `npm version patch`, `npm publish --auth-type=web` (an expired login shows as E404), `git push --follow-tags`, then a GitHub release, which mirrors to GitHub Packages as `@two19labs/sharelane`.

Checks: npm test (some tests spawn processes and are load-sensitive, so re-run before calling a failure real), npm run typecheck, npm audit, npm pack --dry-run (only bin/, src/, LICENSE, README.md), and npm run sharelane -- init. GitHub Actions (`.github/workflows/test.yml`) runs typecheck and tests on Windows, macOS, and Linux with Node 24 on every push and pull request. Run init with the full user PATH (VS Code terminals may lack claude/agy) so every agent is detected. The package is MIT, ships TypeScript run by tsx at runtime, and exposes the `sharelane` bin (init, mcp, dashboard, run). Agent and check commands always use argument arrays with no shell. On Windows, prefer file-writing tools over shell heredocs and sed for TypeScript, because they mangle backslashes and `\n`.
