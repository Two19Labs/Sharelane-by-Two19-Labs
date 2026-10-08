// ShareLane dashboard: polls the API and renders with text nodes only, so task
// prompts and agent output can never inject markup. The office view (office.js)
// is the default; the details view is the full tables-and-charts dashboard.
import { createOffice } from "./office.js";

const REFRESH_MS = 2000;
const SVG = "http://www.w3.org/2000/svg";

const view = {
  state: null,
  filter: "all",
  selected: null,
  tab: "output",
  log: { taskId: null, offset: -1, text: "", follow: true },
  detail: null,
  showUsageTable: false,
  lastOk: 0,
};

// ---------- small helpers ----------
function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") element.className = value;
    else if (key === "text") element.textContent = value;
    // The page's CSP blocks style attributes; setting styles through the CSSOM is allowed.
    else if (key === "style") element.style.cssText = value;
    else if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
    else element.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

function s(tag, attrs = {}, ...children) {
  const element = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "text") element.textContent = value;
    else element.setAttribute(key, String(value));
  }
  for (const child of children.flat()) if (child) element.append(child);
  return element;
}

const numberFormat = new Intl.NumberFormat();
const compactFormat = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const formatNumber = (value) => numberFormat.format(value ?? 0);
const formatCompact = (value) => compactFormat.format(value ?? 0);

function ago(iso) {
  if (!iso) return "";
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 0) return until(iso);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function until(iso) {
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `in ${hours} h ${minutes % 60} min`;
  return `in ${Math.round(hours / 24)} days`;
}

const shortId = (id) => (id ? id.replace(/^task-/, "").slice(0, 8) : "");

// Every status carries an icon and a label; color only reinforces them.
const taskStatus = {
  queued: { tone: "active", icon: "…", label: "Queued" },
  running: { tone: "active", icon: "▶", label: "Running" },
  completed: { tone: "good", icon: "✓", label: "Completed" },
  failed: { tone: "critical", icon: "✕", label: "Failed" },
  cancelled: { tone: "", icon: "–", label: "Cancelled" },
  orphaned: { tone: "serious", icon: "!", label: "Orphaned" },
  needs_reassignment: { tone: "warning", icon: "↪", label: "Needs handoff" },
  paused: { tone: "warning", icon: "❚❚", label: "Paused" },
};
const quotaStatus = {
  ok: { tone: "good", icon: "✓", label: "Keep working" },
  handoff: { tone: "critical", icon: "■", label: "Hand off" },
  unknown: { tone: "warning", icon: "?", label: "Can't tell" },
};
const noticeIcons = {
  handoff: ["warning", "↪"],
  scope_violation: ["serious", "!"],
  unclaimed_edit: ["serious", "!"],
  duplicate_task: ["warning", "≈"],
  budget_warning: ["warning", "◔"],
  budget_exhausted: ["critical", "■"],
  worktree_cleanup_failed: ["critical", "✕"],
};

function statusPill(info) {
  return h("span", { class: `status ${info.tone}` }, h("span", { class: "icon", "aria-hidden": "true", text: info.icon }), info.label);
}

const tooltip = document.getElementById("tooltip");
function showTip(event, text) {
  tooltip.textContent = text;
  tooltip.hidden = false;
  tooltip.style.left = `${Math.min(event.clientX + 12, window.innerWidth - tooltip.offsetWidth - 8)}px`;
  tooltip.style.top = `${event.clientY + 14}px`;
}
function hideTip() {
  tooltip.hidden = true;
}

// ---------- theme ----------
const themes = ["system", "light", "dark"];
let theme = "system";
try {
  theme = localStorage.getItem("sharelane-theme") || "system";
} catch {
  // Storage can be unavailable; the system theme still works.
}
function applyTheme() {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  document.getElementById("theme").textContent = `Theme: ${theme}`;
}
document.getElementById("theme").addEventListener("click", () => {
  theme = themes[(themes.indexOf(theme) + 1) % themes.length];
  try {
    localStorage.setItem("sharelane-theme", theme);
  } catch {
    // Not remembered, but still applied.
  }
  applyTheme();
});
applyTheme();

// ---------- sections ----------
function renderKpis(state) {
  const totals = state.totals;
  const tile = (label, value, sub, status) =>
    h("div", { class: "tile" },
      h("div", { class: "tile-label" }, status ? statusPill(status) : label),
      h("div", { class: "tile-value", text: value }),
      sub ? h("div", { class: "tile-sub", text: sub }) : null);
  document.getElementById("kpis").replaceChildren(
    tile("Active tasks", formatNumber(totals.activeTasks), totals.failedTasks ? `${totals.failedTasks} failed recently` : "queued or running"),
    tile("Waiting for handoff", formatNumber(totals.waitingTasks), totals.waitingTasks ? "use the reassign tool" : "none waiting",
      totals.waitingTasks ? { tone: "warning", icon: "↪", label: "Waiting for handoff" } : null),
    tile("Active claims", formatNumber(totals.activeClaims), "files or patterns owned right now"),
    tile("Fresh tokens", formatCompact(totals.freshTokens + totals.outputTokens),
      `new input ${formatCompact(totals.freshTokens)} · output ${formatCompact(totals.outputTokens)} · cached ${formatCompact(totals.cachedTokens)}`),
  );
}

function renderAgents(state) {
  const cards = state.agents.map((agent) => {
    const quota = agent.quota;
    const rows = quota.windows.map((window) => {
      const low = window.remainingPercent <= quota.threshold;
      return h("div", { class: "meter-row" },
        h("span", { text: window.name.replace(/^\w/, (c) => c.toUpperCase()) }),
        h("div", { class: `meter${quota.state === "unknown" ? " uncertain" : ""}`, role: "meter", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": window.remainingPercent,
          "aria-label": `${window.name} window: ${window.remainingPercent}% left`,
          onmousemove: (event) => showTip(event, `${window.remainingPercent}% left${window.resetsAt ? ` · resets ${until(window.resetsAt)}` : ""}`),
          onmouseleave: hideTip },
          h("div", { class: `meter-fill${low ? " low" : ""}`, style: `width:${Math.max(0, Math.min(100, window.remainingPercent))}%` }),
          h("div", { class: "meter-threshold", style: `left:calc(${quota.threshold}% - 1px)`, "aria-hidden": "true" })),
        h("span", { class: "num", text: quota.state === "unknown" ? `~${window.remainingPercent}%` : `${window.remainingPercent}% left` }));
    });
    return h("article", { class: "agent" },
      h("div", { class: "agent-head" },
        h("div", {}, h("div", { class: "agent-name", text: agent.displayName }), h("div", { class: "muted mono", text: agent.name })),
        statusPill(quotaStatus[quota.state] ?? quotaStatus.unknown)),
      rows.length ? rows : null,
      quota.reason ? h("p", { class: "reason", text: quota.reason }) : null,
      h("p", { class: "muted", text: [
        agent.activeTasks ? `${agent.activeTasks} active task${agent.activeTasks === 1 ? "" : "s"}` : "idle",
        `source: ${quota.source}${quota.observedAt ? `, ${ago(quota.observedAt)}` : ""}`,
      ].join(" · ") }));
  });
  document.getElementById("agents").replaceChildren(...cards);
}

const filters = [
  ["all", "All"],
  ["active", "Active"],
  ["waiting", "Needs handoff"],
  ["done", "Finished"],
];
function matchesFilter(task) {
  if (view.filter === "active") return ["queued", "running", "paused"].includes(task.status);
  if (view.filter === "waiting") return task.status === "needs_reassignment";
  if (view.filter === "done") return ["completed", "failed", "cancelled", "orphaned"].includes(task.status);
  return true;
}

function renderFilters() {
  document.getElementById("filters").replaceChildren(...filters.map(([key, label]) =>
    h("button", { class: "chip", type: "button", "aria-pressed": String(view.filter === key),
      onclick: () => { view.filter = key; render(); } }, label)));
}

function agentPath(task) {
  const path = task.lineage.length ? task.lineage : [task.callerAgent, task.agent].filter(Boolean);
  const parts = [];
  path.forEach((name, index) => {
    if (index) parts.push(h("span", { class: "path-arrow", "aria-hidden": "true", text: "→" }));
    parts.push(h("span", { text: name }));
  });
  return h("span", { "aria-label": `Agent path: ${path.join(" to ")}` }, parts);
}

function budgetMeter(task) {
  if (!task.budgetTokens) return null;
  const share = Math.min(100, (task.freshTokens / task.budgetTokens) * 100);
  return h("div", { class: "meter budget", role: "meter", "aria-valuenow": Math.round(share), "aria-valuemin": 0, "aria-valuemax": 100,
    "aria-label": `Budget used: ${Math.round(share)}%`,
    onmousemove: (event) => showTip(event, `Budget: ${formatNumber(task.freshTokens)} of ${formatNumber(task.budgetTokens)} fresh tokens`),
    onmouseleave: hideTip },
    h("div", { class: `meter-fill${share >= 100 ? " low" : ""}`, style: `width:${share}%` }));
}

function renderTasks(state) {
  const tasks = state.tasks.filter(matchesFilter);
  const container = document.getElementById("tasks");
  if (!tasks.length) {
    container.replaceChildren(h("p", { class: "empty", text: state.tasks.length ? "No tasks match this filter." : "No delegated tasks yet. Ask an agent to delegate something and it appears here." }));
    return;
  }
  const rows = tasks.map((task) => h("tr", { class: view.selected === task.id ? "selected" : "" },
    h("td", {}, statusPill(taskStatus[task.status] ?? { tone: "", icon: "?", label: task.status })),
    h("td", {},
      h("button", { class: "task-title", type: "button", onclick: () => selectTask(task.id), text: task.title || task.id }),
      h("div", { class: "muted", text: [shortId(task.id), `updated ${ago(task.updatedAt)}`, task.reassignments ? `handed off ${task.reassignments}×` : ""].filter(Boolean).join(" · ") }),
      task.handoffReason && task.status !== "completed" ? h("div", { class: "reason", text: task.handoffReason }) : null),
    h("td", {}, agentPath(task)),
    h("td", { class: "mono scope" }, (task.scope?.length ? task.scope : ["whole project"]).map((pattern) => h("div", { text: pattern }))),
    h("td", { class: "tokens num" },
      task.usage.runs ? `${formatCompact(task.usage.freshInputTokens)} new · ${formatCompact(task.usage.outputTokens)} out` : "—",
      task.usage.runs ? h("div", { class: "muted", text: `${formatCompact(task.usage.cachedInputTokens)} cached · ${task.usage.runs} run${task.usage.runs === 1 ? "" : "s"}` }) : null,
      budgetMeter(task))));
  container.replaceChildren(h("table", {},
    h("thead", {}, h("tr", {}, ["Status", "Task", "Agents", "Scope", "Tokens"].map((label) => h("th", { scope: "col", text: label })))),
    h("tbody", {}, rows)));
}

async function selectTask(taskId) {
  if (view.selected === taskId) {
    view.selected = null;
    view.detail = null;
  } else {
    view.selected = taskId;
    view.tab = "output";
    view.log = { taskId, offset: -1, text: "", follow: true };
    await loadDetail();
  }
  render();
}

async function loadDetail() {
  if (!view.selected) return;
  try {
    const response = await fetch(`/api/tasks/${encodeURIComponent(view.selected)}`);
    view.detail = response.ok ? await response.json() : null;
  } catch {
    // Keep the previous detail on a transient error.
  }
}

async function loadLog() {
  if (!view.selected || view.tab !== "output") return;
  try {
    const response = await fetch(`/api/tasks/${encodeURIComponent(view.selected)}/log?offset=${view.log.offset}`);
    if (!response.ok) return;
    const chunk = await response.json();
    if (chunk.text) view.log.text = (view.log.text + chunk.text).slice(-200_000);
    view.log.offset = chunk.nextOffset;
  } catch {
    // Retry on the next tick.
  }
}

function renderDetail() {
  const container = document.getElementById("detail");
  const detail = view.detail;
  if (!view.selected || !detail) {
    container.replaceChildren();
    return;
  }
  const task = detail.task;
  const tabs = [["output", "Live output"], ["conversation", "Conversation"]];
  if (detail.handoffNote) tabs.push(["handoff", "Handoff note"]);
  let body;
  if (view.tab === "output") {
    const pre = h("pre", { class: "log", "aria-label": "Agent output", text: view.log.text || "No output yet." });
    body = h("div", {},
      pre,
      h("div", { class: "log-tools" },
        h("span", { text: task.status === "running" || task.status === "queued" ? "Live — refreshes every 2 seconds" : "This run has finished" }),
        h("label", {}, h("input", { type: "checkbox", checked: view.log.follow, onchange: (event) => { view.log.follow = event.target.checked; } }), " Follow output")));
    if (view.log.follow) requestAnimationFrame(() => { pre.scrollTop = pre.scrollHeight; });
  } else if (view.tab === "conversation") {
    body = h("div", {}, detail.messages.map((message) => h("div", { class: "message" },
      h("h4", { text: `${message.role === "user" ? "Request" : "Agent reply"} · ${ago(message.createdAt)}` }),
      h("pre", { text: message.content.length > 4000 ? `${message.content.slice(0, 4000)}\n… (${formatNumber(message.content.length - 4000)} more characters in the task file)` : message.content }))));
  } else {
    body = h("pre", { class: "log", text: detail.handoffNote });
  }
  container.replaceChildren(h("section", { class: "detail", "aria-label": "Task detail" },
    h("div", { class: "detail-head" },
      h("div", {}, h("h3", { text: task.title || task.id }), h("p", { class: "muted mono", text: task.id })),
      h("button", { class: "ghost", type: "button", onclick: () => selectTask(task.id) }, "Close")),
    h("dl", { class: "facts" },
      h("dt", { text: "Status" }), h("dd", {}, statusPill(taskStatus[task.status] ?? { tone: "", icon: "?", label: task.status })),
      h("dt", { text: "Agents" }), h("dd", {}, agentPath(task)),
      h("dt", { text: "Branch" }), h("dd", { class: "mono", text: task.branchName ?? "direct workspace" }),
      h("dt", { text: "Changed" }), h("dd", { class: "mono", text: task.changedFiles.length ? task.changedFiles.join(", ") : "nothing yet" }),
      task.scopeViolations.length ? [h("dt", { text: "Kept off branch" }), h("dd", { class: "mono", text: task.scopeViolations.join(", ") })] : null,
      task.handoffReason ? [h("dt", { text: "Handoff" }), h("dd", { text: task.handoffReason })] : null,
      task.error ? [h("dt", { text: "Error" }), h("dd", { text: task.error })] : null,
      h("dt", { text: "Tokens" }), h("dd", { class: "num", text: `${formatNumber(task.usage.freshInputTokens)} new input · ${formatNumber(task.usage.outputTokens)} output · ${formatNumber(task.usage.cachedInputTokens)} cached · ${task.usage.runs} run(s)${task.budgetTokens ? ` · budget ${formatNumber(task.freshTokens)}/${formatNumber(task.budgetTokens)}` : ""}` })),
    h("div", { class: "tabs", role: "tablist" }, tabs.map(([key, label]) => h("button", {
      class: "tab", type: "button", role: "tab", "aria-selected": String(view.tab === key),
      onclick: async () => { view.tab = key; if (key === "output") await loadLog(); render(); } }, label))),
    body));
}

function renderClaims(state) {
  document.getElementById("claims-count").textContent = state.claims.length ? `${state.claims.length} active` : "";
  const items = state.claims.map((claim) => h("li", {},
    h("div", { class: "row" }, h("span", { class: "mono text", text: claim.path }), h("span", { class: "meta", text: `expires ${until(claim.expiresAt)}` })),
    h("div", { class: "meta", text: `${claim.agent}${claim.taskId ? ` · task ${shortId(claim.taskId)}` : ""} — ${claim.intent}` })));
  document.getElementById("claims").replaceChildren(...(items.length ? items : [h("li", { class: "meta", text: "Nobody is holding files right now." })]));
}

function renderNotices(state) {
  const items = state.notices.map((notice) => {
    const [tone, icon] = noticeIcons[notice.kind] ?? ["", "i"];
    return h("li", {},
      h("div", { class: "row" },
        statusPill({ tone, icon, label: notice.kind.replaceAll("_", " ") }),
        h("span", { class: "meta", text: `${ago(notice.createdAt)} · ${notice.delivered ? "delivered" : "waiting"}` })),
      h("div", { class: "text", text: notice.message }));
  });
  document.getElementById("notices").replaceChildren(...(items.length ? items : [h("li", { class: "meta", text: "No notices." })]));
}

function renderProgress(state) {
  const items = state.progress.map((entry) => h("li", {},
    h("div", { class: "row" }, h("strong", { text: entry.agent }), h("span", { class: "meta", text: ago(entry.createdAt) })),
    h("div", { class: "text", text: entry.note }),
    h("div", { class: "meta mono", text: entry.task })));
  document.getElementById("progress").replaceChildren(...(items.length ? items : [h("li", { class: "meta", text: "No progress notes yet." })]));
}

const usageSeries = [
  ["freshInputTokens", "New input", "var(--series-1)"],
  ["outputTokens", "Output", "var(--series-2)"],
  ["cachedInputTokens", "Cached input", "var(--series-3)"],
];
function renderUsage(state) {
  const container = document.getElementById("usage");
  const toggle = document.getElementById("usage-toggle");
  toggle.textContent = view.showUsageTable ? "Show chart" : "Show table";
  toggle.setAttribute("aria-pressed", String(view.showUsageTable));
  const rows = state.usageByAgent;
  if (!rows.length) {
    container.replaceChildren(h("p", { class: "empty", text: "No runs recorded yet. Token use appears after the next delegated task." }));
    return;
  }
  if (view.showUsageTable) {
    container.replaceChildren(h("table", {},
      h("thead", {}, h("tr", {}, ["Agent", "Runs", ...usageSeries.map(([, label]) => label)].map((label) => h("th", { scope: "col", text: label })))),
      h("tbody", {}, rows.map((row) => h("tr", {},
        h("td", { text: row.agent }), h("td", { class: "num", text: formatNumber(row.runs) }),
        usageSeries.map(([key]) => h("td", { class: "num", text: formatNumber(row[key]) })))))));
    return;
  }
  const max = Math.max(...rows.map((row) => usageSeries.reduce((total, [key]) => total + row[key], 0)), 1);
  container.replaceChildren(
    h("div", { class: "legend" }, usageSeries.map(([, label, color]) => h("span", {}, h("span", { class: "swatch", style: `background:${color}` }), label))),
    h("div", { class: "bars" }, rows.map((row) => {
      const total = usageSeries.reduce((sum, [key]) => sum + row[key], 0);
      return h("div", { class: "bar-row" },
        h("span", { class: "bar-label", text: row.agent }),
        h("div", { class: "bar-track", role: "img", "aria-label": `${row.agent}: ${usageSeries.map(([key, label]) => `${label} ${formatNumber(row[key])}`).join(", ")}` },
          usageSeries.filter(([key]) => row[key] > 0).map(([key, label, color]) => h("div", {
            class: "bar-seg", style: `width:${(row[key] / max) * 82}%;background:${color}`,
            onmousemove: (event) => showTip(event, `${row.agent} · ${label}: ${formatNumber(row[key])} tokens (${row.runs} run${row.runs === 1 ? "" : "s"})`),
            onmouseleave: hideTip })),
          h("span", { class: "bar-total num", text: formatCompact(total) })));
    })));
}

function renderMap(state) {
  const container = document.getElementById("map");
  const chunks = state.context;
  if (!chunks.length) {
    container.replaceChildren(h("p", { class: "empty", text: "No context chunks yet. Run npm run sharelane -- init." }));
    return;
  }
  const rowHeight = 46;
  const height = Math.max(chunks.length * rowHeight + 16, 120);
  const rootY = height / 2;
  const svg = s("svg", { viewBox: `0 0 760 ${height}`, role: "img", "aria-label": `Context map with ${chunks.length} chunks` });
  const rootNode = s("g", { class: "node root" },
    s("rect", { x: 8, y: rootY - 18, width: 110, height: 36, rx: 8 }),
    s("text", { x: 63, y: rootY + 4, "text-anchor": "middle", text: "MAP.md" }));
  chunks.forEach((chunk, index) => {
    const y = 8 + index * rowHeight + rowHeight / 2;
    svg.append(s("path", { class: "link", d: `M118 ${rootY} C 170 ${rootY}, 170 ${y}, 222 ${y}` }));
    const files = chunk.coversFiles.length ? chunk.coversFiles.join(", ") : "(no files)";
    const shown = files.length > 34 ? `${files.slice(0, 33)}…` : files;
    svg.append(s("path", { class: "link", d: `M442 ${y} L 470 ${y}` }));
    const group = s("g", { class: "node" },
      s("title", { text: `${chunk.title} — read when: ${chunk.readWhen}\nCovers: ${files}\nUpdated ${chunk.updatedAt}${chunk.stale ? "\nStale: covered files changed since this chunk was updated" : ""}` }),
      s("rect", { x: 222, y: y - 17, width: 220, height: 34, rx: 8 }),
      s("circle", { cx: 240, cy: y, r: 8, class: chunk.stale ? "badge-stale" : "badge-good" }),
      s("text", { x: 240, y: y + 3.5, "text-anchor": "middle", class: `badge-text${chunk.stale ? " dark" : ""}`, text: chunk.stale ? "!" : "✓" }),
      s("text", { x: 256, y: y + 4, text: `${chunk.title}${chunk.stale ? " · stale" : ""}` }),
      s("text", { x: 478, y: y + 4, class: "file", text: shown }));
    svg.append(group);
  });
  svg.append(rootNode);
  container.replaceChildren(svg);
}

function renderLive() {
  const live = document.getElementById("live");
  const fresh = Date.now() - view.lastOk < REFRESH_MS * 3;
  live.classList.toggle("offline", !fresh);
  live.textContent = fresh ? `Live · updated ${ago(view.state?.generatedAt)}` : "Disconnected — retrying";
}

function render() {
  const state = view.state;
  if (!state) return;
  document.getElementById("project").textContent = `${state.project.name} · ${state.project.root}`;
  renderKpis(state);
  renderAgents(state);
  renderFilters();
  renderTasks(state);
  renderDetail();
  renderClaims(state);
  renderNotices(state);
  renderProgress(state);
  renderUsage(state);
  renderMap(state);
  renderLive();
}

document.getElementById("usage-toggle").addEventListener("click", () => {
  view.showUsageTable = !view.showUsageTable;
  render();
});

const office = createOffice({ h, ago, until, formatNumber, formatCompact, statusPill, taskStatus });
office.onChange(() => tick());

let page = "office";
try {
  page = localStorage.getItem("sharelane-view") || "office";
} catch {
  // Storage can be unavailable; the office is the default.
}
function showPage(next) {
  page = next;
  try {
    localStorage.setItem("sharelane-view", page);
  } catch {
    // Not remembered, but still shown.
  }
  document.getElementById("details-view").hidden = page !== "details";
  document.getElementById("view-office").setAttribute("aria-pressed", String(page === "office"));
  document.getElementById("view-details").setAttribute("aria-pressed", String(page === "details"));
  office.setActive(page === "office");
}
document.getElementById("view-office").addEventListener("click", () => showPage("office"));
document.getElementById("view-details").addEventListener("click", () => showPage("details"));

async function tick() {
  if (document.hidden) return;
  try {
    const response = await fetch("/api/state");
    if (!response.ok) throw new Error(String(response.status));
    view.state = await response.json();
    view.lastOk = Date.now();
    await office.update(view.state);
    if (view.selected) {
      await loadDetail();
      await loadLog();
    }
  } catch {
    // renderLive shows the disconnected state.
  }
  render();
  renderLive();
}

// A link like /#task=<id> opens that task's detail straight away.
const linked = /^#task=(task-[0-9a-f-]+)$/.exec(location.hash);
if (linked) {
  page = "details";
  view.selected = linked[1];
  view.log = { taskId: linked[1], offset: -1, text: "", follow: true };
}

showPage(page);
tick();
setInterval(tick, REFRESH_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
