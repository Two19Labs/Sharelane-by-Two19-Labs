import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { collectDashboardState, collectTaskDetail, readTaskLog } from "./state.js";

export const DEFAULT_DASHBOARD_PORT = 4317;

const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
const assets: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
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

/**
 * Serve the read-only dashboard on this computer only. Requests must name
 * localhost or 127.0.0.1 in their Host header, which stops other websites
 * from reading task data through DNS rebinding.
 */
export async function startDashboard(options: {
  projectRoot?: string;
  port?: number;
} = {}): Promise<RunningDashboard> {
  const projectRoot = options.projectRoot ?? process.cwd();
  let port = options.port ?? DEFAULT_DASHBOARD_PORT;

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!allowedHosts.has(String(request.headers.host ?? "").toLowerCase())) {
      sendJson(response, 403, { error: "The ShareLane dashboard only answers requests for localhost." });
      return;
    }
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "The dashboard is read-only." });
      return;
    }
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    const asset = assets[url.pathname];
    if (asset) {
      send(response, 200, asset.type, readFileSync(`${publicDir}${asset.file}`));
      return;
    }
    if (url.pathname === "/api/state") {
      sendJson(response, 200, await collectDashboardState(projectRoot));
      return;
    }
    const taskMatch = /^\/api\/tasks\/([^/]+)(\/log)?$/.exec(url.pathname);
    if (taskMatch) {
      const taskId = taskMatch[1] ?? "";
      if (!taskIdPattern.test(taskId)) {
        sendJson(response, 404, { error: "Unknown task." });
        return;
      }
      try {
        if (taskMatch[2]) {
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
