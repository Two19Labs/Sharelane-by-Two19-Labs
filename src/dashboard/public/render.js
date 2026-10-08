// Readable rendering for agent text and run logs. Everything is built as DOM
// nodes through the caller's h() helper; agent text is never parsed as HTML.

// ---------- Markdown (the subset agents actually write) ----------

/** Inline Markdown: `code`, **bold**, *italic*, and [links](url). */
export function inline(h, text) {
  const nodes = [];
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\([^)\s]+\))|(\*[^*\s][^*\n]*\*)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (match[1]) {
      nodes.push(h("code", { text: token.slice(1, -1) }));
    } else if (match[2]) {
      nodes.push(h("strong", {}, inline(h, token.slice(2, -2))));
    } else if (match[3]) {
      const [, label, url] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token) ?? [];
      // Web links open in a new tab; local file links (file://) only show their name.
      nodes.push(/^https?:\/\//i.test(url ?? "")
        ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, inline(h, label))
        : h("span", { class: "md-file", title: url }, inline(h, label)));
    } else {
      nodes.push(h("em", {}, inline(h, token.slice(1, -1))));
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const tableRow = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());

/** Block Markdown: paragraphs, headings, lists, code fences, quotes, tables, rules. */
export function markdown(h, text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) blocks.push(h("p", {}, inline(h, paragraph.join(" "))));
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = /^\s*```(\S*)/.exec(line);
    if (fence) {
      flush();
      const code = [];
      for (index += 1; index < lines.length && !/^\s*```/.test(lines[index]); index += 1) code.push(lines[index]);
      blocks.push(h("pre", { class: "md-code" }, h("code", { text: code.join("\n") })));
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { flush(); blocks.push(h(heading[1].length <= 2 ? "h4" : "h5", { class: "md-heading" }, inline(h, heading[2]))); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); blocks.push(h("hr", {})); continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[index + 1] ?? "") && (lines[index + 1] ?? "").includes("-")) {
      flush();
      const head = tableRow(line);
      const rows = [];
      for (index += 2; index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index]); index += 1) rows.push(tableRow(lines[index]));
      index -= 1;
      blocks.push(h("div", { class: "md-table" }, h("table", {},
        h("thead", {}, h("tr", {}, head.map((cell) => h("th", {}, inline(h, cell))))),
        h("tbody", {}, rows.map((row) => h("tr", {}, row.map((cell) => h("td", {}, inline(h, cell)))))))));
      continue;
    }
    const listItem = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (listItem) {
      flush();
      const ordered = /\d/.test(listItem[1]);
      const items = [];
      for (; index < lines.length; index += 1) {
        const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index]);
        if (item && /\d/.test(item[1]) === ordered) items.push(item[2]);
        else if (items.length && /^\s{2,}\S/.test(lines[index])) items[items.length - 1] += ` ${lines[index].trim()}`;
        else break;
      }
      index -= 1;
      blocks.push(h(ordered ? "ol" : "ul", {}, items.map((item) => h("li", {}, inline(h, item)))));
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flush();
      const quote = [];
      for (; index < lines.length && /^\s*>\s?/.test(lines[index]); index += 1) quote.push(lines[index].replace(/^\s*>\s?/, ""));
      index -= 1;
      blocks.push(h("blockquote", {}, markdown(h, quote.join("\n"))));
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return h("div", { class: "md" }, blocks);
}

// ---------- Run logs as a timeline ----------

const clip = (text, max = 4000) => (text && text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text ?? "");

function seconds(value) {
  if (!Number.isFinite(value)) return "";
  if (value < 60) return `${Math.round(value)} s`;
  return `${Math.floor(value / 60)} min ${Math.round(value % 60)} s`;
}

function summarizeInput(input) {
  if (!input || typeof input !== "object") return "";
  return input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? JSON.stringify(input).slice(0, 300);
}

/**
 * Turn a ShareLane run log into timeline events. Handles Claude (json and
 * stream-json), Codex (jsonl), and Antigravity (json); anything else is kept
 * as raw text so nothing is hidden.
 */
export function parseRunLog(text) {
  const events = [];
  const raw = [];
  let stderr = [];
  const push = (event) => events.push(event);
  const flushStderr = () => {
    if (stderr.length) push({ kind: "stderr", text: stderr.join("\n") });
    stderr = [];
  };
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let match;
    if ((match = /^ShareLane run: (.+)$/.exec(line))) { flushStderr(); push({ kind: "system", text: `Run started (${match[1]})` }); continue; }
    if ((match = /^Started: (.+)$/.exec(line))) { push({ kind: "time", at: match[1] }); continue; }
    if ((match = /^Finished: (.+)$/.exec(line))) { flushStderr(); push({ kind: "system", text: "Run finished", at: match[1] }); continue; }
    if ((match = /^Exit code: (.+)$/.exec(line))) {
      flushStderr();
      if (match[1].trim() !== "0") push({ kind: "error", text: `The agent exited with code ${match[1].trim()}.` });
      continue;
    }
    if (line.startsWith("[stderr] ")) { stderr.push(line.slice(9)); continue; }
    const payload = line.startsWith("[stdout] ") ? line.slice(9) : line;
    let data;
    try {
      data = payload.trim().startsWith("{") ? JSON.parse(payload) : undefined;
    } catch {
      data = undefined;
    }
    if (!data) { raw.push(payload); push({ kind: "text", text: payload }); continue; }
    raw.push(payload);
    flushStderr();
    handleJson(data, push);
  }
  flushStderr();
  // Merge consecutive plain-text lines into one block.
  const merged = [];
  for (const event of events) {
    const previous = merged[merged.length - 1];
    if (event.kind === "text" && previous?.kind === "text") previous.text += `\n${event.text}`;
    else merged.push({ ...event });
  }
  return { events: merged, raw: raw.join("\n") };
}

function handleJson(data, push) {
  // Claude Code --output-format json: one result object.
  if (data.type === "result" && ("result" in data || "is_error" in data)) {
    if (data.result) push({ kind: "message", text: data.result });
    for (const denial of data.permission_denials ?? []) {
      push({ kind: "tool", icon: "⛔", status: "blocked", title: `Not allowed: ${denial.tool_name}`, detail: summarizeInput(denial.tool_input) });
    }
    if (data.is_error) push({ kind: "error", text: data.result || "The run ended with an error." });
    push({ kind: "stats", items: [
      data.duration_ms ? `⏱ ${seconds(data.duration_ms / 1000)}` : "",
      data.num_turns ? `${data.num_turns} turns` : "",
      data.usage?.output_tokens ? `${data.usage.output_tokens.toLocaleString()} output tokens` : "",
      typeof data.total_cost_usd === "number" ? `$${data.total_cost_usd.toFixed(2)} at list price` : "",
    ].filter(Boolean) });
    return;
  }
  // Claude Code stream-json events.
  if (data.type === "system" && data.subtype === "init") { push({ kind: "system", text: `Session started${data.model ? ` · ${data.model}` : ""}` }); return; }
  if (data.type === "assistant" && Array.isArray(data.message?.content)) {
    for (const part of data.message.content) {
      if (part.type === "text" && part.text) push({ kind: "message", text: part.text });
      else if (part.type === "thinking" && part.thinking) push({ kind: "thinking", text: part.thinking });
      else if (part.type === "tool_use") push({ kind: "tool", icon: "⚙", title: part.name, detail: summarizeInput(part.input) });
    }
    return;
  }
  if (data.type === "user") return; // tool results echoed back; the tool card already shows the call
  // Antigravity --output-format json.
  if (typeof data.response === "string" && ("conversation_id" in data || "status" in data)) {
    if (data.response) push({ kind: "message", text: data.response });
    if (data.status && data.status !== "SUCCESS") push({ kind: "error", text: `Antigravity reported ${data.status}.` });
    push({ kind: "stats", items: [
      data.duration_seconds ? `⏱ ${seconds(data.duration_seconds)}` : "",
      data.num_turns ? `${data.num_turns} turn${data.num_turns === 1 ? "" : "s"}` : "",
      data.usage?.total_tokens ? `${data.usage.total_tokens.toLocaleString()} tokens` : "",
    ].filter(Boolean) });
    return;
  }
  // Codex exec --json events.
  if (data.type === "thread.started") { push({ kind: "system", text: "Conversation started" }); return; }
  if (data.type === "turn.started" || data.type === "item.started" || data.type === "item.updated") return;
  if (data.type === "turn.completed") {
    const usage = data.usage ?? {};
    push({ kind: "stats", items: [
      usage.input_tokens ? `${usage.input_tokens.toLocaleString()} input tokens` : "",
      usage.cached_input_tokens ? `${usage.cached_input_tokens.toLocaleString()} cached` : "",
      usage.output_tokens ? `${usage.output_tokens.toLocaleString()} output tokens` : "",
    ].filter(Boolean) });
    return;
  }
  if (data.type === "turn.failed" || data.type === "error") {
    push({ kind: "error", text: data.error?.message ?? data.message ?? "The run failed." });
    return;
  }
  if (data.type === "item.completed" && data.item) {
    const item = data.item;
    switch (item.type) {
      case "agent_message": push({ kind: "message", text: item.text }); return;
      case "reasoning": push({ kind: "thinking", text: item.text }); return;
      case "command_execution":
        push({ kind: "tool", icon: "›_", status: item.exit_code === 0 ? "ok" : item.exit_code == null ? "" : "failed",
          title: `Ran ${item.command}`, detail: clip(item.aggregated_output), note: item.exit_code == null ? "" : `exit ${item.exit_code}` });
        return;
      case "file_change":
        push({ kind: "tool", icon: "✎", title: "Changed files",
          detail: (item.changes ?? []).map((change) => `${change.kind ?? "edit"}  ${change.path}`).join("\n") });
        return;
      case "mcp_tool_call":
        push({ kind: "tool", icon: "⚙", status: item.status === "failed" ? "failed" : "", title: `${item.server ?? "tool"} · ${item.tool ?? ""}`, detail: clip(JSON.stringify(item.arguments ?? item.result ?? "", null, 2)) });
        return;
      case "web_search": push({ kind: "tool", icon: "⌕", title: "Searched the web", detail: item.query ?? "" }); return;
      case "todo_list":
        push({ kind: "tool", icon: "☑", title: "Plan", detail: (item.items ?? []).map((todo) => `${todo.completed ? "✓" : "○"} ${todo.text}`).join("\n") });
        return;
      case "error": push({ kind: "error", text: item.message ?? "Error" }); return;
      default: push({ kind: "tool", icon: "•", title: item.type ?? "event", detail: clip(JSON.stringify(item, null, 2)) });
    }
    return;
  }
  push({ kind: "json", text: clip(JSON.stringify(data, null, 2)) });
}

/** Render timeline events from parseRunLog as a readable conversation. */
export function renderTimeline(h, { events, raw }, { agentName, ago }) {
  const out = [];
  let startedAt = "";
  for (const event of events) {
    switch (event.kind) {
      case "time": startedAt = event.at; break;
      case "system":
        out.push(h("div", { class: "tl-system" }, h("span", { text: event.text }),
          event.at || startedAt ? h("span", { class: "meta", text: ` · ${ago(event.at || startedAt)}` }) : null));
        startedAt = "";
        break;
      case "message":
        out.push(h("div", { class: "bubble-msg assistant" },
          h("div", { class: "meta", text: agentName }),
          markdown(h, event.text)));
        break;
      case "thinking":
        out.push(h("details", { class: "tl-card thinking" }, h("summary", {}, h("span", { class: "tl-icon", text: "💭" }), "Thinking"),
          h("div", { class: "tl-detail" }, markdown(h, event.text))));
        break;
      case "tool":
        out.push(h(event.detail ? "details" : "div", { class: `tl-card ${event.status ?? ""}` },
          h(event.detail ? "summary" : "div", { class: "tl-head" },
            h("span", { class: "tl-icon", text: event.icon ?? "⚙" }),
            h("span", { class: "tl-title", text: event.title }),
            event.note ? h("span", { class: "meta", text: event.note }) : null),
          event.detail ? h("pre", { class: "tl-detail", text: event.detail }) : null));
        break;
      case "stats":
        if (event.items.length) out.push(h("div", { class: "tl-stats" }, event.items.map((item) => h("span", { text: item }))));
        break;
      case "error":
        out.push(h("div", { class: "tl-error", role: "note" }, h("strong", { text: "Problem: " }), event.text));
        break;
      case "stderr":
        out.push(h("details", { class: "tl-card muted-card" }, h("summary", {}, h("span", { class: "tl-icon", text: "ⓘ" }), "Messages from the agent's program"),
          h("pre", { class: "tl-detail", text: clip(event.text) })));
        break;
      case "json":
        out.push(h("details", { class: "tl-card muted-card" }, h("summary", {}, h("span", { class: "tl-icon", text: "{}" }), "Data"), h("pre", { class: "tl-detail", text: event.text })));
        break;
      default:
        out.push(h("pre", { class: "tl-text", text: clip(event.text) }));
    }
  }
  if (raw) {
    out.push(h("details", { class: "tl-raw" }, h("summary", { text: "Show raw output" }), h("pre", { class: "log", text: clip(raw, 60000) })));
  }
  return out;
}
