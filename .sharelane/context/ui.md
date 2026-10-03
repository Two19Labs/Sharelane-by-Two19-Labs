---
title: User interface
read-when: Changing screens, interactions, dashboard behavior, visual design, or examples/calculator.
covers-files: ["examples/calculator/**","src/dashboard/**"]
updated-at: 2026-10-03T05:21:46.069Z
source-hash: 02f7b365aa2bca67b262ae936b8df01868b49f48c3d47ebe87024022a8721e12
---

# User interface

## ShareLane dashboard (Phase 6)

`npm run sharelane -- dashboard [--port 4317] [--open]` serves a read-only local page. `src/dashboard/state.ts` collects the snapshot; `src/dashboard/server.ts` serves it with Node's `http` module; `src/dashboard/public/` holds `index.html`, `app.css` (colour role tokens, separately selected dark values for the OS setting and the theme toggle), and `app.js` (renders with text nodes only; polls `/api/state` every 2 s and pauses when hidden).

- Sections: headline tiles; agent cards with allowance meters and the 7% marker (faded with "~" when the reading is too old); a task table (status pill, request, agent path, scope, tokens, budget meter) with a detail panel (facts, live output by byte offset, conversation, handoff note); claims with countdowns; notices; progress notes; tokens by agent (a stacked bar using validated categorical slots 1–3, plus a table view); and a context-map SVG graph (MAP → chunks → covered files, with stale flags).
- Rules: every status is an icon plus a label; text uses ink tokens, never series colours; the CSP forbids inline scripts and style attributes, so styles are set through the CSSOM (`element.style.cssText`). `/#task=<id>` opens a task directly.
- API: `GET /api/state`, `GET /api/tasks/<id>`, `GET /api/tasks/<id>/log?offset=<n>` (`-1` = tail). Only `localhost`/`127.0.0.1` Host headers are answered; everything is GET-only.
- Verify visually with headless Edge (`msedge --headless=new --screenshot`); desktop Edge lays out at no less than about 500px wide.

Later phases plan a VS Code panel and an animated office view.

## Calculator learning example

`examples/calculator/` is a self-contained plain HTML/CSS/JavaScript example created by the real Claude-to-Codex delegation demonstration. It opens directly from `index.html` without a server or build step. `calculator.js` holds the pure immutable state transitions and a UMD/CommonJS export, while `app.js` maps accessible button clicks and supported keyboard input to actions. Run its dependency-free tests from that folder with `node --test`.

`examples/calculator/CLAUDE_REVIEW.md` (2026-09-27) accepted it, with eight low-severity findings. The ones to know before touching `app.js`:
- `Enter` always means `=`, even when another button has focus;
- modifier key chords (such as zoom shortcuts) are swallowed;
- overflow can display `Infinity`;
- `app.js` has no automated coverage.

Unmerged task branches add a `power()` function (Codex) and an "Agents who worked on this" README section (Antigravity).
