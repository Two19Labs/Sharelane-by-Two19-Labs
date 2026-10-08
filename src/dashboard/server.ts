import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { extname } from "node:path";
import {
  collectDashboardState,
  collectTaskChanges,
  collectTaskDetail,
  readTaskBranchFile,
  readTaskLog,
} from "./state.js";

/** Content types for previewing a task's files; anything else is served as text. */
const previewTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
import { cancelTask, delegateTask, pauseTask, replyToTask, resumeTask } from "../core/tasks.js";

export const DEFAULT_DASHBOARD_PORT = 4317;

const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
const assets: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/office.js": { file: "office.js", type: "text/javascript; charset=utf-8" },
  "/office.css": { file: "office.css", type: "text/css; charset=utf-8" },
};
const taskIdPattern = /^task-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const securityHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

function send(response: ServerResponse, status: number, type: string, body: string | Buffer): void {
  response.writeHead(status, { ...securityHeaders, "Content-Type": type });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, "application/json; charset=utf-8", JSON.stringify(value));
}

export interface RunningDashboard {
  url: string;
  port: number;
  close: () => Promise<void>;
}

const MAX_BODY_BYTES = 64 * 1024;

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large.");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object.");
  return value as Record<string, unknown>;
}

function optionalText(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`"${key}" must be text.`);
  return value.trim() || undefined;
}

function requiredText(body: Record<string, unknown>, key: string): string {
  const value = optionalText(body, key);
  if (!value) throw new Error(`"${key}" is required.`);
  return value;
}

/**
 * Serve the dashboard on this computer only. Requests must name localhost or
 * 127.0.0.1 in their Host header, which stops other websites from reading
 * task data through DNS rebinding. Controls (POST) also need this server's
 * random token, which only a same-origin page can read, plus a JSON content
 * type and a matching Origin, so another website cannot drive the agents.
 */
export async function startDashboard(options: {
  projectRoot?: string;
  port?: number;
  /** Environment for task workers started from the page (tests use this). */
  env?: NodeJS.ProcessEnv;
} = {}): Promise<RunningDashboard> {
  const projectRoot = options.projectRoot ?? process.cwd();
  let port = options.port ?? DEFAULT_DASHBOARD_PORT;
  const controlToken = randomBytes(24).toString("hex");
  const tokenMatches = (value: string | string[] | undefined): boolean => {
    const given = Buffer.from(typeof value === "string" ? value : "");
    const expected = Buffer.from(controlToken);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const handleControl = async (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    allowedHosts: Set<string>,
  ): Promise<void> => {
    const origin = String(request.headers.origin ?? "").toLowerCase();
    if (
      !allowedHosts.has(origin.replace(/^http:\/\//, "")) ||
      !tokenMatches(request.headers["x-sharelane-token"])
    ) {
      sendJson(response, 403, { error: "Controls only work from the ShareLane page itself." });
      return;
    }
    if (!/^application\/json\b/i.test(String(request.headers["content-type"] ?? ""))) {
      sendJson(response, 415, { error: "Send controls as JSON." });
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    try {
      if (url.pathname === "/api/tasks") {
        const budget = body.budgetTokens;
        if (budget !== undefined && (typeof budget !== "number" || !Number.isInteger(budget) || budget <= 0)) {
          throw new Error('"budgetTokens" must be a positive whole number.');
        }
        const scope = optionalText(body, "scope")
          ?.split(/[\n,]+/)
          .map((pattern) => pattern.trim())
          .filter(Boolean);
        const task = delegateTask({
          agent: requiredText(body, "agent"),
          prompt: requiredText(body, "prompt"),
          callerAgent: "you",
          scope: scope && scope.length > 0 ? scope : undefined,
          budgetTokens: budget as number | undefined,
          projectRoot,
          env: options.env,
        });
        sendJson(response, 200, { taskId: task.id, status: task.status });
        return;
      }
      const match = /^\/api\/tasks\/([^/]+)\/(pause|resume|stop|reply)$/.exec(url.pathname);
      const taskId = match?.[1] ?? "";
      if (!match || !taskIdPattern.test(taskId)) {
        sendJson(response, 404, { error: "Not found." });
        return;
      }
      const action = match[2];
      const task =
        action === "pause"
          ? pauseTask(taskId, projectRoot)
          : action === "stop"
            ? cancelTask(taskId, projectRoot)
            : action === "resume"
              ? resumeTask(taskId, optionalText(body, "message"), { projectRoot, env: options.env })
              : replyToTask(taskId, requiredText(body, "message"), { projectRoot, env: options.env });
      sendJson(response, 200, { taskId: task.id, status: task.status });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, /Unknown task/.test(message) ? 404 : 409, { error: message });
    }
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!allowedHosts.has(String(request.headers.host ?? "").toLowerCase())) {
      sendJson(response, 403, { error: "The ShareLane dashboard only answers requests for localhost." });
      return;
    }
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    if (request.method === "POST") {
      await handleControl(request, response, url, allowedHosts);
      return;
    }
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Only GET and POST are supported." });
      return;
    }
    if (url.pathname === "/api/session") {
      sendJson(response, 200, { token: controlToken });
      return;
    }
    const asset = assets[url.pathname];
    if (asset) {
      send(response, 200, asset.type, readFileSync(`${publicDir}${asset.file}`));
      return;
    }
    if (url.pathname === "/api/state") {
      sendJson(response, 200, await collectDashboardState(projectRoot));
      return;
    }
    const previewMatch = /^\/preview\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (previewMatch) {
      const taskId = previewMatch[1] ?? "";
      let path = "";
      try {
        path = decodeURIComponent(previewMatch[2] ?? "");
      } catch {
        path = "";
      }
      const file = taskIdPattern.test(taskId) ? readTaskBranchFile(taskId, path, projectRoot) : undefined;
      if (!file) {
        send(response, 404, "text/plain; charset=utf-8", "That file is not on this task's branch.");
        return;
      }
      // Agent-written pages run in a sandbox with an opaque origin, so they can
      // never read the control token or call the dashboard's API.
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "sandbox allow-scripts allow-modals allow-pointer-lock; default-src 'self' 'unsafe-inline' data: blob:; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        "Content-Type": previewTypes[extname(path).toLowerCase()] ?? "text/plain; charset=utf-8",
      });
      response.end(file);
      return;
    }
    const taskMatch = /^\/api\/tasks\/([^/]+)(\/log|\/changes)?$/.exec(url.pathname);
    if (taskMatch) {
      const taskId = taskMatch[1] ?? "";
      if (!taskIdPattern.test(taskId)) {
        sendJson(response, 404, { error: "Unknown task." });
        return;
      }
      try {
        if (taskMatch[2] === "/changes") {
          sendJson(response, 200, collectTaskChanges(taskId, projectRoot));
        } else if (taskMatch[2]) {
          const offset = Number(url.searchParams.get("offset") ?? "-1");
          sendJson(response, 200, readTaskLog(taskId, Number.isFinite(offset) ? offset : -1, projectRoot));
        } else {
          sendJson(response, 200, collectTaskDetail(taskId, projectRoot));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, /Unknown task/.test(message) ? 404 : 500, { error: message });
      }
      return;
    }
    sendJson(response, 404, { error: "Not found." });
  };

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://localhost:${port}/`,
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
