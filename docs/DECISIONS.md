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

## Proposed — need your yes/no

| # | Proposal | Why | Status |
|---|---|---|---|
| P1 | MCP is the main way agents talk to ShareLane, with a `sharelane` command-line tool as a fallback for agents without MCP | Not every agent supports MCP, but nearly all can run commands | Open |
| P2 | No always-running background program: each agent starts its own copy of the hub, and the copies share one SQLite database | Nothing to start or crash; downside is the hub can only reply, not push alerts | Open |
| P3 | Storage: SQLite for live state + markdown files for context (readable, committed to git) | Safe for several agents at once; context stays human-readable | Open |
| P4 | Search: SQLite full-text search; no AI-based "semantic" search in v1 | Semantic search needs an API key or local model | Open |
| P5 | Conflict protection in layers: worktrees → name-on-it claims (that expire) → duplicate-task warnings → blocking hooks where the CLI allows → watcher that flags unclaimed edits | Agents can ignore instructions, so no single layer is enough | Open |
| P6 | Delegation depth limit of 3 | Stops loops while allowing normal chains | Open |
| P7 | Agents log progress after every step, so a handoff is always ready even after a sudden stop | Limits can hit mid-task | Open |
| P8 | Handoff threshold around 90% of quota | Leaves room to write the handoff | Open |

## Still undecided

- How a finished worker's copy (worktree) gets merged: automatically, or ask you first?
- Should `.sharelane/context/` be committed to git (shared with teammates) or kept private?
- How long a "name-on-it" claim lasts before it expires.
- Which similar tools exist already (e.g. MCP Agent Mail, Zen/PAL MCP) and how ShareLane is different. Check before launch.
