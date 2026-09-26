# ShareLane agent instructions

These instructions apply to every agent working anywhere in this repository.

## Before starting work

1. Read `GLOBAL_CONTEXT.md` to learn the latest project state and recent work.
2. If you need broader project context, read these files in order:
   1. `docs/HANDOFF.md`
   2. `docs/DESIGN.md`
   3. `docs/DECISIONS.md`
   4. `docs/IMPLEMENTATION_PLAN.md`
3. Check `git status` before editing. Existing changes may belong to the user or another agent; do not overwrite them.
4. Explain the next small step in plain language before doing it. This is a learning project for a nontechnical owner.

## While working

- Work in small, visible steps and verify each step before moving on.
- Preserve unrelated work and never silently discard another person's changes.
- Record lasting project choices in `docs/DECISIONS.md`. Never erase an old decision; mark it as replaced if it changes.
- Keep documentation synchronized when implementation changes make it inaccurate.
- Never put passwords, tokens, private keys, or other secrets in project documentation.

## Before finishing or handing off

Update `GLOBAL_CONTEXT.md` as the final project edit of every work session, even if the task is incomplete or blocked. Append one entry to **Agent work log** using its template. Include:

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
<!-- sharelane-context:end -->
