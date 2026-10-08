---
title: User interface
read-when: Changing screens, interactions, dashboard behavior, the office view, visual design, or examples/calculator.
covers-files: ["examples/calculator/**","src/dashboard/**"]
updated-at: 2026-10-08T17:24:48.672Z
source-hash: 8e9c13baff78144900a1e767da2379f3c8087b474cefb0e8c1e4365db83c0926
---

# User interface

## ShareLane dashboard

`npx sharelane dashboard [--port 4317] [--open]` serves a local page. `src/dashboard/state.ts` collects the snapshot; `src/dashboard/server.ts` serves it with Node's `http` module; `src/dashboard/public/` holds `index.html`, `app.css` (colour role tokens, separately selected dark values for the OS setting and the theme toggle), `app.js` (Details view + polling every 2 s, paused while hidden), `office.js` + `office.css` (the default Office view), and `render.js` (readable agent text). A top switch toggles Office / Details (remembered in localStorage); `/#task=<id>` opens Details on that task.

### Office view (decisions 71–76)

- A pixel-art floor drawn in code on a canvas (world 30×18 tiles of 16 px, drawn at 2×; people and their chair backs at 3× via `withSprite`). No image files.
- The world and the hotbar fill the window: they share `--world-w` (`office.css`), the widest 5:3 size that still fits the height. The HUD counters sit inside the world frame; the project name opens the team overview.
- One employee per task the office shows (`showsInOffice`: running/queued/paused, recent needs or failures, recent completed-with-changes, and not dismissed), keyed by task ID and named by `taskLabel` + the agent ("UI Claude"); an agent with none keeps one idle employee (`agent:<name>`). `syncEmployees` reuses employees of the same agent (`rekey`) before hiring at the door; extras get `leaving` and are removed at the door. Desks are assigned per employee (8 slots, all drawn). Extra workers of one agent keep its shirt with their own hair.
- `modeFor` decides each state and where it walks (BFS on a blocked-tile grid): desk = working (monitor shows code) or paused (Zz); review board = completed with changed files in the last 6 h (spots spaced so plates do not overlap); meeting room = needs_reassignment / failed / orphaned in the last 6 h; sofa = allowance at handoff; lounge = free (wanders). On page load everyone starts in place; later changes are walked.
- All text is in DOM overlays (`#office-overlay`): an employee is a `<button>` with a speech bubble and name plate positioned in % of the world; signs; hotspots (your desk = assign, review board, mailbox = notices). The bottom hotbar repeats employees plus New task / Notices.
- Clicking opens a modal pop-up (`<dialog id="office-dialog">` holding `#office-panel`; Close, Esc, or a backdrop click closes it and clears the selection). It shows a lobby view (team, review board with Check output and Done per task, notices) or one employee: status line, allowance meters, current (or, for an idle employee, latest) task facts, controls, a composer, Conversation / Live output / Changes & output tabs, task history, and a "give a new task" form. The skeleton is rebuilt only when the employee, focused task, or its status changes, so typing is never interrupted; scroll boxes are kept between refreshes (`scrollBox`, `updateKeepingScroll`).
- Controls: Pause and Stop (running/queued), Resume or Resume with note (paused), Send follow-up (completed, unless the chat was ended), Stop (needs_reassignment), **Check output** (any task with a branch), and for finished tasks **Done → lounge** and **End chat** (asks for confirmation; so does Stop).
- Models (decision 76): the assign form has a **Model** picker (Auto, Fast, Balanced, Strong, or the agent's own default; sent as `tier`). Task facts show "Tier · model (reason)" from `modelTier`, `modelLabel`, and `modelTierReason`; the Live output timeline starts with the run's `Model:` line.
- Conversation: chat bubbles ("You asked" / "Follow-up" / the agent's name) with Markdown rendered. Live output: `parseRunLog` turns the raw run log (Claude json and stream-json, Codex jsonl, Antigravity json) into a timeline — run started/finished and model lines, agent messages, thinking, tool cards (commands with exit codes, file changes, blocked actions in red), stats chips (time, turns, tokens, cost), problems, collapsed stderr — with the raw output kept under "Show raw output". Changes & output: the agent's report (Markdown), files changed with +/− counts and colour-coded per-file diffs, a Preview button for HTML files, and the `git diff` / `git merge` commands.
- `render.js` builds everything with `h()`; agent text is never parsed as HTML. Web links open in a new tab; `file://` links show only their label. It is unit-tested in `test/dashboard/render.test.ts`.

### API

- `GET /api/state`, `GET /api/tasks/<id>`, `GET /api/tasks/<id>/log?offset=<n>` (`-1` = tail), `GET /api/session` (the control token).
- `GET /api/tasks/<id>/changes` (`collectTaskChanges`: read-only `git diff` base..branch with validated refs, patch cut at 400 KB) and `GET /preview/<id>/<path>` (`readTaskBranchFile` via `git show`; served with `sandbox allow-scripts` and `connect-src 'none'`, so agent pages get an opaque origin and cannot reach the API).
- `POST /api/tasks` `{agent, prompt, scope?, budgetTokens?, tier?}` (caller `you`; scope is comma/line separated; tier is fast/balanced/strong/auto/default), `POST /api/tasks/<id>/{pause,resume,stop,reply,dismiss}` (`resume` takes an optional `message`, `reply` a required one, `dismiss` an optional `endConversation`). A POST needs header `X-ShareLane-Token`, an `Origin` of this server, and `Content-Type: application/json`; failures are 403/415, task-state conflicts 409.
- Only `localhost`/`127.0.0.1` Host headers are answered. `startDashboard({ env })` passes an environment to task workers started from the page (used by tests). Restart the dashboard after server changes; page files are read per request.

### Rules

- Every status is an icon plus a label; the CSP forbids inline scripts and style attributes, so styles are set through the CSSOM (`element.style.cssText`). Render with text nodes only.
- Verify visually with headless Edge; a scripted DevTools-protocol helper can click buttons (used to prove Pause, Check output, and Done work end to end). Desktop Edge lays out at no less than about 500px wide.

## Calculator learning example

`examples/calculator/` is a self-contained plain HTML/CSS/JavaScript example created by the real Claude-to-Codex delegation demonstration. It opens directly from `index.html` without a server or build step. `calculator.js` holds the pure immutable state transitions and a UMD/CommonJS export, while `app.js` maps accessible button clicks and supported keyboard input to actions. Run its dependency-free tests from that folder with `node --test`.

`examples/calculator/CLAUDE_REVIEW.md` (2026-09-27) accepted it, with eight low-severity findings. The ones to know before touching `app.js`:
- `Enter` always means `=`, even when another button has focus;
- modifier key chords (such as zoom shortcuts) are swallowed;
- overflow can display `Infinity`;
- `app.js` has no automated coverage.

Unmerged task branches add a `power()` function (Codex) and an "Agents who worked on this" README section (Antigravity).
