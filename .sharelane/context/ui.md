---
title: User interface
read-when: Changing screens, interactions, dashboard behavior, the office view, visual design, or examples/calculator.
covers-files: ["examples/calculator/**","src/dashboard/**"]
updated-at: 2026-10-08T06:52:12.618Z
source-hash: cbae2a5bec79cf32e37089633e079c8f3f3d900ad24befa563d1ecc63b0b0c8e
---

# User interface

## ShareLane dashboard

`npx sharelane dashboard [--port 4317] [--open]` serves a local page. `src/dashboard/state.ts` collects the snapshot; `src/dashboard/server.ts` serves it with Node's `http` module; `src/dashboard/public/` holds `index.html`, `app.css` (colour role tokens, separately selected dark values for the OS setting and the theme toggle), `app.js` (Details view + polling every 2 s, paused while hidden), and `office.js` + `office.css` (the default Office view). A top switch toggles Office / Details (remembered in localStorage); `/#task=<id>` opens Details on that task.

### Office view (decisions 71–73)

- A pixel-art floor drawn in code on a canvas (world 30×18 tiles of 16 px, drawn at 2×; people and their chair backs at 3× via `withSprite`). No image files.
- Each agent is an employee. `primaryTask` + `modeFor` decide its state and where it walks (BFS on a blocked-tile grid): desk = working (monitor shows code) or paused (Zz); review board = completed with changed files in the last 6 h; meeting room = needs_reassignment / failed / orphaned in the last 6 h; sofa = allowance at handoff; lounge = free (wanders). On page load everyone starts in place; later changes are walked.
- All text is in DOM overlays (`#office-overlay`): an employee is a `<button>` with a speech bubble and name plate positioned in % of the world; signs; hotspots (your desk = assign, review board, mailbox = notices). The bottom hotbar repeats employees plus New task / Notices.
- The side panel (`#office-panel`) shows the lobby (team list, review board list with `git diff main...<branch>`, or notices) or one employee: status line, allowance meters, current task facts, controls, a composer, Conversation / Live output tabs, task history (click to focus another task), and a "give a new task" form. The skeleton is rebuilt only when the employee, focused task, or its status changes, so typing is never interrupted.
- Controls: Pause and Stop (running/queued), Resume or Resume with note (paused), Send follow-up (completed), Stop (needs_reassignment). Stop asks for confirmation.

### API

- `GET /api/state`, `GET /api/tasks/<id>`, `GET /api/tasks/<id>/log?offset=<n>` (`-1` = tail), `GET /api/session` (the control token).
- `POST /api/tasks` `{agent, prompt, scope?, budgetTokens?}` (caller `you`; scope is comma/line separated), `POST /api/tasks/<id>/{pause,resume,stop,reply}` (`resume` takes an optional `message`, `reply` a required one). A POST needs header `X-ShareLane-Token`, an `Origin` of this server, and `Content-Type: application/json`; failures are 403/415, task-state conflicts 409.
- Only `localhost`/`127.0.0.1` Host headers are answered. `startDashboard({ env })` passes an environment to task workers started from the page (used by tests).

### Rules

- Every status is an icon plus a label; the CSP forbids inline scripts and style attributes, so styles are set through the CSSOM (`element.style.cssText`). Render with text nodes only.
- Verify visually with headless Edge; a scripted DevTools-protocol helper can click buttons (used to prove Pause works end to end). Desktop Edge lays out at no less than about 500px wide.

## Calculator learning example

`examples/calculator/` is a self-contained plain HTML/CSS/JavaScript example created by the real Claude-to-Codex delegation demonstration. It opens directly from `index.html` without a server or build step. `calculator.js` holds the pure immutable state transitions and a UMD/CommonJS export, while `app.js` maps accessible button clicks and supported keyboard input to actions. Run its dependency-free tests from that folder with `node --test`.

`examples/calculator/CLAUDE_REVIEW.md` (2026-09-27) accepted it, with eight low-severity findings. The ones to know before touching `app.js`:
- `Enter` always means `=`, even when another button has focus;
- modifier key chords (such as zoom shortcuts) are swallowed;
- overflow can display `Infinity`;
- `app.js` has no automated coverage.

Unmerged task branches add a `power()` function (Codex) and an "Agents who worked on this" README section (Antigravity).
