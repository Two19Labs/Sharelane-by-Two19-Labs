// End-to-end install check, as a new user would see it: pack the package as
// npm would publish it, install it globally into a throwaway prefix and home,
// then run init, the MCP server, the dashboard, later and uninstall in a new
// Git project. Fake `claude` and `agy` CLIs stand in for real agents.
// Run: node scripts/smoke-install.mjs   (CI runs it on Windows, macOS, Linux)
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const windows = process.platform === "win32";
const repo = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "sharelane-smoke-"));
const home = join(scratch, "home");
const prefix = join(scratch, "prefix");
const fakeBin = join(scratch, "fake-bin");
const project = join(scratch, "project");
for (const dir of [home, join(home, ".codex"), prefix, fakeBin, project]) mkdirSync(dir, { recursive: true });

for (const agent of ["claude", "agy"]) {
  if (windows) writeFileSync(join(fakeBin, `${agent}.cmd`), "@echo off\r\n");
  else {
    writeFileSync(join(fakeBin, agent), "#!/bin/sh\n");
    chmodSync(join(fakeBin, agent), 0o755);
  }
}

const globalBin = windows ? prefix : join(prefix, "bin");
const basePath = process.env.PATH ?? process.env.Path ?? "";
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|home|userprofile|codex_home)$/i.test(key)));
Object.assign(env, {
  PATH: [globalBin, fakeBin, basePath].join(delimiter),
  HOME: home,
  USERPROFILE: home,
  // A real Codex on PATH ignores HOME/USERPROFILE on Windows; this keeps it off
  // the user's own config.
  CODEX_HOME: join(home, ".codex"),
  npm_config_prefix: prefix,
  npm_config_cache: join(scratch, "npm-cache"),
  npm_config_fund: "false",
  npm_config_audit: "false",
  SHARELANE_CLAUDE_USAGE_ENDPOINT: "0",
});

function step(name) {
  console.log(`\n== ${name}`);
}
function check(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`ok: ${message}`);
}
// npm and the installed `sharelane` shim are .cmd files on Windows, which need a shell.
function sh(command, args, cwd = project) {
  return execFileSync(command, args, { cwd, env, encoding: "utf8", shell: windows, stdio: ["ignore", "pipe", "pipe"] });
}

try {
  step("pack and install globally");
  const packed = JSON.parse(sh("npm", ["pack", "--json", "--pack-destination", scratch], repo))[0];
  sh("npm", ["install", "-g", join(scratch, packed.filename)], scratch);
  const root = sh("npm", ["root", "-g"], scratch).trim();
  const binScript = join(root, "sharelane", "bin", "sharelane.mjs");
  check(existsSync(binScript), "package installed into the global prefix");
  const version = sh("sharelane", ["--version"]).trim();
  check(version === JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version, `sharelane --version prints ${version}`);

  step("init in a new Git project");
  const git = (...args) => execFileSync("git", args, { cwd: project, env, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-q", "--allow-empty", "-m", "init");
  const init = sh("sharelane", ["init"]);
  console.log(init);
  check(/Still to do:\r?\n- Nothing\./.test(init), "init leaves nothing for the user to do");
  for (const file of [".mcp.json", ".agents/mcp_config.json", ".sharelane/context/MAP.md", ".sharelane/ONBOARDING.md", "AGENTS.md", "CLAUDE.md"]) {
    check(existsSync(join(project, file)), `${file} was created`);
  }

  step("MCP server starts from the installed package");
  const tools = await new Promise((resolveTools, reject) => {
    const child = spawn(process.execPath, [binScript, "mcp"], { cwd: project, env: { ...env, SHARELANE_AGENT: "claude" } });
    const timer = setTimeout(() => (child.kill(), reject(new Error("MCP server did not answer in 60s"))), 60_000);
    let buffer = "";
    child.stderr.on("data", (data) => process.stderr.write(data));
    child.stdout.on("data", (data) => {
      buffer += data;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const message = JSON.parse(line);
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
        } else if (message.id === 2) {
          clearTimeout(timer);
          child.kill();
          resolveTools(message.result.tools.map((tool) => tool.name));
        }
      }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } })}\n`);
  });
  check(tools.includes("delegate") && tools.includes("update_chunk"), `MCP server lists ${tools.length} tools`);

  step("dashboard serves the office");
  const state = await new Promise((resolveState, reject) => {
    const child = spawn(process.execPath, [binScript, "dashboard", "--port", "0"], { cwd: project, env });
    const timer = setTimeout(() => (child.kill(), reject(new Error("dashboard did not start in 60s"))), 60_000);
    child.stdout.on("data", async (data) => {
      const url = /http:\/\/\S+/.exec(String(data))?.[0];
      if (!url) return;
      try {
        const page = await fetch(url);
        const api = await fetch(new URL("/api/state", url));
        resolveState({ page: page.status, agents: (await api.json()).agents.map((agent) => agent.name) });
      } catch (error) {
        reject(error);
      } finally {
        clearTimeout(timer);
        child.kill();
      }
    });
  });
  check(state.page === 200 && state.agents.includes("claude"), `dashboard answered (agents: ${state.agents.join(", ")})`);

  step("later and uninstall");
  check(/Nothing scheduled/.test(sh("sharelane", ["later", "list"])), "later list works");
  const removed = sh("sharelane", ["uninstall"]);
  console.log(removed);
  check(!existsSync(join(project, ".sharelane")) && !existsSync(join(project, ".mcp.json")), "uninstall removed ShareLane from the project");

  console.log("\nInstall smoke test passed.");
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
}
