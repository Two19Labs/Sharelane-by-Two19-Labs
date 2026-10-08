# ShareLane agent instructions

These instructions apply to every agent working anywhere in this repository.

## Before starting work

1. The maintainers keep a private work log in `private/` (ignored by Git, so it exists only on their machines). If `private/GLOBAL_CONTEXT.md` exists, read its **Current snapshot** and newest relevant work-log entry; read older entries only when the task needs that history.
2. If you need broader project context, use headings or search to read only the relevant sections of these files, in order:
   1. `private/HANDOFF.md` (if present)
   2. `docs/DESIGN.md`
   3. `docs/DECISIONS.md`
   4. `private/IMPLEMENTATION_PLAN.md` (if present)
3. Check `git status` before editing. Existing changes may belong to the user or another agent; do not overwrite them.
4. Explain the next small step in plain language before doing it.

## Token-efficiency policy

- Handle a simple task directly. Delegate only when another agent adds clear value through specialization, independent review, parallel work, or an explicit user request.
- When usage is measurable, aim to keep orchestration overhead to roughly 25% or less of the fresh tokens a direct run would need. This stays a target; for a hard limit, pass `budgetTokens` to `delegate`.
- Check remaining allowance with ShareLane's `usage` tool at checkpoints (between major steps, never in a loop). At or below 7% remaining, stop, save, and hand off.
- Report fresh input/output separately from cached context. Cached tokens are cheaper but still consume quota and should not hide an inefficient workflow.
- Start from the context map and load only relevant chunks or document sections. Do not reread unchanged files, old work logs, full transcripts, or large command output unless needed.
- Reuse the existing task session for follow-ups, avoid repeated status polling, and keep prompts, progress notes, handoffs, and final answers concise.

## While working

- Work in small, visible steps and verify each step before moving on.
- Preserve unrelated work and never silently discard another person's changes.
- Record lasting project choices in `docs/DECISIONS.md`. Never erase an old decision; mark it as replaced if it changes.
- Keep documentation synchronized when implementation changes make it inaccurate.
- Never put passwords, tokens, private keys, or other secrets in project documentation.

## Before finishing or handing off

If `private/GLOBAL_CONTEXT.md` exists, update it as the final project edit of every work session, even if the task is incomplete or blocked, and commit it in the `private/` repository (never in the main one). Append one entry to **Agent work log** using its template. Include:

- date and agent name;
- goal of the session;
- meaningful work completed;
- files added or changed;
- checks/tests run and their honest results;
- decisions added or changed;
- current state, blockers, and exact next step.

Keep entries concise. Record meaningful actions and outcomes, not hidden reasoning, full chat transcripts, or large command outputs. If no files changed, say so. If a check was not run, say so rather than implying that it passed.

After updating the context, make the planned Git checkpoint when appropriate. In the final reply, explain what changed in simple words and mention any check the user can try.

<!-- sharelane-context:start -->
## ShareLane shared context

Before project work, read `.sharelane/context/MAP.md` and then read only the context chunks relevant to the task. After meaningful work, update the affected chunks through ShareLane so the map, search index, and freshness status stay accurate.

Keep token overhead low: handle simple work directly, delegate only when another agent adds clear value, avoid rereading unchanged context or large logs, reuse sessions for follow-ups, and keep messages concise.

Before editing, claim the exact files or narrow path patterns through ShareLane with a short intent. Keep long-running claims alive with heartbeat and release them when finished. Delegated workers run in isolated Git worktrees; ShareLane saves their changes on task branches for review.
<!-- sharelane-context:end -->
