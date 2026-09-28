# ShareLane — Decisions

Every decision made so far, and why. Add new ones at the bottom of the right table; never delete old ones. If a decision changes, mark the old one **Replaced by #N**.

- **Decided** = agreed by Manthan.
- **Proposed** = suggested by Claude and written into the design, but not yet confirmed. Needs a yes/no.

## Decided (2026-09-26)

| # | Decision | Why |
|---|---|---|
| 1 | Build our own hub rather than wiring agents together by hand (e.g. only Codex's built-in MCP server) | Want one tool that does routing, memory and safety together, and that others can use |
| 2 | **Any agent can orchestrate.** The orchestrator is whichever agent you're chatting with, chosen per task | Not a Claude-only tool; Codex or Gemini must be able to lead too |
| 3 | **Agent-neutral.** Any agentic coding CLI can be added; adding one should be config, not new code | Main goal of the project; makes it useful to everyone |
| 4 | **Subscription-only.** Agents run through their official CLIs with the user's own login. No API keys; ShareLane never touches login tokens | All of Manthan's agents are on subscriptions; keeps it within each vendor's terms |
| 5 | **Open source**, with content made around it. Personal use, no reselling | Multi-agent context loss is a common problem |
| 6 | **Memory is per project**, stored in the project (`.sharelane/`) | Each project has its own context |
| 7 | **Context is structured**: a short map + small topic chunks + task files + search, loaded only when needed. No giant single file | Avoid agents reading thousands of lines / hundreds of thousands of tokens |
| 8 | **Visual map of the context**, so every agent (and you) can see where each kind of context lives | Agents should know where to look |
| 9 | **Delegation is async**: returns a task ID straight away, the worker runs in the background | Long tasks would otherwise time out; you keep chatting with the orchestrator |
| 10 | **Git worktrees** for workers, so each has its own copy of the project | Strongest protection against agents overwriting each other |
| 11 | **Hub detects and stops conflicts** (two agents on the same files or the same task) | Agents editing the same files at once is a core risk |
| 12 | **Loop-safe delegation** (Claude → Codex → Claude can't go on forever) | Two-way delegation makes loops possible |
| 13 | **Permissions scoped per delegation/session** (e.g. "Codex may only touch the UI files") | Give each worker only the access its job needs |
| 14 | **Log usage** for every run, per agent | Every call counts against a subscription limit |
| 15 | **Agents check their own quota and write a handoff before running out**; another agent takes over. Reuse Manthan's existing quota-check approach from another project | Manthan has already built quota self-checks for Codex and Claude. (Corrects Claude's earlier wrong claim that agents can't see their quota.) |
| 16 | **Dashboard** to track all agents' activity and chats: local web page first, VS Code extension later | You need to see what background workers are doing |
| 17 | **Animated office view** (agents as characters at desks) as a later fun layer | Easier to understand at a glance; good for content |
| 18 | **Name: ShareLane.** npm package `sharelane` (was free on 2026-09-26) | Manthan's choice |
| 19 | **TypeScript on Node** | Manthan: "any language, easiest is best." Best-supported MCP toolkit; easy one-line install for users |
| 20 | **Not terminal-only.** The orchestrator can be a VS Code panel or a terminal; workers run in the background | Manthan works in VS Code |
| 21 | Gemini CLI may be installed on this machine | Manthan gave the go-ahead; planned for phase 7 |
| 22 | **Record and understand before building**; build in small phases, each explained, each with a "done when" check | This is a learning project |
| 23 | **Use Node's native ES modules**, with TypeScript's matching `NodeNext` module rules | Keeps ShareLane on one modern module system and matches the MCP SDK ecosystem |
| 24 | Agent MCP configurations identify their caller with the `SHARELANE_AGENT` environment variable; `whoami()` returns `unknown` when it is absent | A project-prefixed name avoids collisions and gives every adapter one simple, shared convention |
| 25 | Treat `.sharelane/notes.txt` as local runtime state and ignore it in Git; this does not decide whether future `.sharelane/context/` files are committed | Temporary shared notes should not create repository noise, while the context-sharing policy is still an open question |
| 26 | Keep a repository-level `GLOBAL_CONTEXT.md` work ledger, and use `AGENTS.md` to require compatible agents to read it before work and append a concise handoff before finishing | Future agents need one persistent, human-readable record of completed work, checks, current state, and the exact next step; concise entries avoid turning it into an expensive transcript |
| 27 | Use Node 24's built-in `node:sqlite` module, with WAL mode and a 5-second busy timeout, instead of adding `better-sqlite3` | A local probe proved that this Node build includes SQLite 3.53.3 with FTS5; the built-in module meets Phase 1 needs without another native dependency |
| 28 | Store each context chunk's metadata in a small ShareLane frontmatter header, with `covers-files` represented as a JSON string array; make `sharelane init` repeatable and protect existing chunk content | The files remain ordinary readable Markdown, no YAML dependency is needed, and rerunning setup is safe in an established project |
| 29 | Limit each chunk body to 12,000 characters and reject larger `update_chunk` calls with “compact this first” | This is roughly a few thousand tokens: large enough for useful topic context but small enough to preserve progressive disclosure |
| 30 | Commit `.sharelane/context/` Markdown files to Git, while keeping the SQLite database, WAL files, raw journal, and legacy notes local and ignored | The useful curated context should travel with the project and remain reviewable in diffs; replaceable indexes and noisy runtime logs should not create Git churn |
| 31 | Give every MCP tool accurate safety annotations, and pre-approve only the trusted local `sharelane` server in Codex's server-specific configuration | Codex otherwise blocks unattended MCP calls under its `never` global approval policy; the narrow server setting enables ShareLane without weakening approval rules for commands or other servers |
| 32 | Save a SHA-256 fingerprint of every chunk's covered file contents when the chunk is updated; retain the Git-timestamp check as a fallback for older chunks | Content fingerprints avoid falsely marking context stale when source and context are committed together, while still detecting committed, uncommitted, and newly created file changes |
| 33 | Use Node's built-in `node:test` runner during the early phases instead of adding Vitest | The built-in runner already supports the protocol, temporary-project, and multi-process tests ShareLane needs, so another development dependency would not yet provide enough value |
| 34 | Describe agent commands in `src/adapters/agents.yaml`, parse it with the `yaml` package, validate it with Zod, and always spawn argument arrays with no shell | YAML keeps adding an agent configuration-only; a maintained parser avoids a fragile home-grown subset; argument arrays prevent prompts containing quotes or shell symbols from becoming commands |
| 35 | Normalize Claude JSON and Codex JSON-lines output into one internal result, and keep raw run logs under ignored `.sharelane/runs/` | The rest of ShareLane can treat agents alike while local raw evidence remains available for debugging without creating Git noise |
| 36 | Persist delegated tasks in SQLite plus human-readable local files under ignored `.sharelane/tasks/`, and launch a detached ShareLane supervisor for each task | The caller gets a task ID immediately; the supervisor can still record the agent's completion, failure, session, usage, and log after the calling tool has returned |
| 37 | Store task conversation messages separately, and make `reply` resume the saved CLI session on the same task ID; guard final state changes in SQLite so cancellation wins races | Follow-ups retain the worker's context and remain easy to inspect, while a near-simultaneous worker exit cannot incorrectly overwrite a user's cancellation |
| 38 | Track the complete agent path for each task, allow at most three delegated levels, and reject a target already present in that path | A readable lineage makes both direct and indirect delegation loops detectable while still allowing useful short delegation chains; this accepts proposal P6 for Phase 2 |
| 39 | Prepend each new delegated session with its task ID, focused worker instructions, and the current generated context map; do not repeat that wrapper for resumed replies | A worker begins with enough project orientation to choose relevant context without loading everything, while follow-ups benefit from the context already held by the resumed CLI session |
| 40 | If an active task's detached supervisor PID no longer exists, report it as `orphaned` without mutating state during `status`/`wait`; allow explicit `cancel` to close it, and watch quick supervisor exits while the launcher is alive | A process killed by the operating system must not leave callers waiting forever, while read-only task inspection must remain truthfully side-effect free |
| 41 | On Windows, launch production task supervisors through the local CIM process broker under the current user; pass only executable paths, task ID, project root, and adapter-config path, while keeping direct detached spawn elsewhere and in custom-environment tests | Codex tears down descendants when its headless process exits even if Node marks them detached; the Windows broker creates the supervisor outside that tree while preserving the user's PATH, profile, and subscription-login files, without putting the delegated prompt into a shell command |
| 42 | Before `wait` returns a persisted final task state, refresh that task's human-readable Markdown file from the database; keep virtual orphan checks read-only | SQLite is the authority, but callers and people should not observe “completed” from `wait` while the readable task file still briefly says “running”; rewriting only persisted final states closes that race without turning orphan inspection into a mutation |
| 43 | Use token-efficient orchestration by default: do simple work directly; delegate only for clear specialist, review, parallel, or user-requested value; aim for roughly 25% or less fresh-token overhead versus a direct run; report cache separately; and add automatic warnings/budgets in Phase 5 | The calculator proof showed that repeated context and tool turns can make multi-agent processing much larger than the underlying task. A quantified target plus progressive disclosure and session reuse keeps today’s workflow disciplined, while Phase 5 will provide reliable cross-vendor measurement and enforcement |
| 44 | Run each Git-backed delegated task in a temporary external worktree on a unique `sharelane/task-*` branch; commit remaining edits, remove the checkout, and hand the branch/commit back without automatically merging | Isolation prevents physical overwrite, an automatic local commit makes cleanup recoverable, and review-before-merge is safer than silently changing the owner's branch |
| 45 | Give claims a 15-minute default TTL, refresh task claims automatically every 30 seconds, expose explicit `heartbeat`, and release claims at task termination | Live work keeps ownership with little prompt overhead, while crashed workers stop blocking others within a bounded time |
| 46 | Refuse conservative overlaps between claimed files/globs, and warn at 60% or greater word-set overlap between a new prompt and active tasks | Claims must favor safety when glob intersection is uncertain; prompt similarity is advisory because wording alone is not reliable enough to reject useful work |
| 47 | Install a shareable Claude `PreToolUse` guard for `Edit|Write`, and pair it with task Git polling plus a final diff for every agent | Claude's built-in edits can be blocked before execution, while detection still covers shell writes, Codex, and agents without compatible hooks |
| 48 | Persist collision notices in SQLite and append pending relevant notices to every successful ShareLane MCP reply | Separate stdio hub processes cannot push alerts, so the next normal tool call is the reliable delivery point |

## Proposed — need your yes/no

| # | Proposal | Why | Status |
|---|---|---|---|
| P1 | MCP is the main way agents talk to ShareLane, with a `sharelane` command-line tool as a fallback for agents without MCP | Not every agent supports MCP, but nearly all can run commands | Open |
| P2 | No always-running background program: each agent starts its own copy of the hub, and the copies share one SQLite database | Nothing to start or crash; downside is the hub can only reply, not push alerts | Open |
| P3 | Storage: SQLite for live state + markdown files for context (readable, committed to git) | Safe for several agents at once; context stays human-readable | Open |
| P4 | Search: SQLite full-text search; no AI-based "semantic" search in v1 | Semantic search needs an API key or local model | Open |
| P5 | Conflict protection in layers: worktrees → name-on-it claims (that expire) → duplicate-task warnings → blocking hooks where the CLI allows → watcher that flags unclaimed edits | Agents can ignore instructions, so no single layer is enough | Accepted and implemented by decisions 44–48 |
| P6 | Delegation depth limit of 3 | Stops loops while allowing normal chains | Accepted and implemented by decision 38 |
| P7 | Agents log progress after every step, so a handoff is always ready even after a sudden stop | Limits can hit mid-task | Open |
| P8 | Handoff threshold around 90% of quota | Leaves room to write the handoff | Open |

## Still undecided

- ~~How a finished worker's copy (worktree) gets merged: automatically, or ask you first?~~ Resolved by decision 44: preserve a reviewable task branch and never auto-merge.
- ~~Should `.sharelane/context/` be committed to git (shared with teammates) or kept private?~~ Resolved by decision 30: commit it.
- ~~How long a "name-on-it" claim lasts before it expires.~~ Resolved by decision 45: 15 minutes by default, with heartbeat extension.
- Which similar tools exist already (e.g. MCP Agent Mail, Zen/PAL MCP) and how ShareLane is different. Check before launch.
