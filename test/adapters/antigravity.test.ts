import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  buildAgentCommand,
  defaultAgentsPath,
  loadAgentRegistry,
  type AgentRegistry,
} from "../../src/adapters/adapter.js";
import { parseAgentOutput } from "../../src/adapters/result.js";
import { claimPaths } from "../../src/core/claims.js";
import {
  installAntigravityIntegration,
  installClaudeClaimHook,
} from "../../src/core/hooks.js";
import { resolveAgentExecutable, runAgent } from "../../src/core/runner.js";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "fake-agent.mjs",
);

test("normalizes Antigravity JSON output and reports refused actions", () => {
  const result = parseAgentOutput(
    "antigravity-json",
    JSON.stringify({
      conversation_id: "agy-conversation",
      status: "SUCCESS",
      response: "Finished from Antigravity\n",
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        thinking_tokens: 2,
        cache_read_tokens: 3,
        total_tokens: 14,
      },
      denied_actions: [
        { action: "command", display_name: "RunCommand" },
        { action: "command", display_name: "RunCommand" },
      ],
    }),
  );
  assert.equal(result.sessionId, "agy-conversation");
  assert.equal(
    result.finalMessage,
    "Finished from Antigravity\n\n[ShareLane: Antigravity was not permitted to run: RunCommand]",
  );
  assert.deepEqual(result.usage, {
    inputTokens: 10,
    cachedInputTokens: 3,
    outputTokens: 4,
    reasoningOutputTokens: 2,
  });
  assert.throws(
    () =>
      parseAgentOutput(
        "antigravity-json",
        JSON.stringify({ conversation_id: "c", status: "ERROR", response: "quota exceeded" }),
      ),
    /Antigravity finished with status ERROR: quota exceeded/,
  );
});

test("the Antigravity adapter is configuration only and runs headless", () => {
  const registry = loadAgentRegistry(defaultAgentsPath);
  assert.deepEqual(Object.keys(registry.agents).sort(), ["antigravity", "claude", "codex"]);
  const run = buildAgentCommand("antigravity", "hello", undefined, registry);
  assert.equal(run.command, "agy");
  assert.equal(run.output, "antigravity-json");
  assert.equal(run.args[run.args.indexOf("-p") + 1], "hello");
  assert.equal(run.args[run.args.indexOf("--mode") + 1], "accept-edits");
  assert.equal(run.args[run.args.indexOf("--output-format") + 1], "json");
  const resume = buildAgentCommand("antigravity", "more", "conversation-9", registry);
  assert.equal(resume.args[resume.args.indexOf("--conversation") + 1], "conversation-9");
  // A scope adds no Antigravity flags; claims, the hook, and Git enforce it.
  const scoped = buildAgentCommand("antigravity", "hello", undefined, registry, {
    patterns: ["src/ui/**"],
    directories: ["/work/src/ui"],
  });
  assert.deepEqual(scoped.args, run.args);
});

test(
  "npm .cmd launchers are started as node plus script, without a shell",
  { skip: process.platform !== "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "sharelane-shim-"));
    try {
      const scriptPath = join(directory, "node_modules", "fake-cli", "agent.mjs");
      await mkdir(dirname(scriptPath), { recursive: true });
      await copyFile(fixturePath, scriptPath);
      // The same launcher shape npm writes for globally installed CLIs.
      await writeFile(
        join(directory, "fakecli.cmd"),
        '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake-cli\\agent.mjs" %*\r\n',
        "utf8",
      );
      const env = { PATH: directory };
      assert.deepEqual(resolveAgentExecutable("fakecli", env), {
        command: process.execPath,
        prefixArgs: [scriptPath],
      });

      const registry: AgentRegistry = {
        version: 1,
        agents: {
          fakeagy: {
            displayName: "Fake Antigravity",
            command: "fakecli",
            run: { args: ["antigravity-json", "{prompt}"] },
            resume: { args: ["antigravity-json", "{prompt}", "{session}"] },
            output: "antigravity-json",
            instructionsFile: "AGENTS.md",
          },
        },
      };
      const dangerous = 'Say "hi" & echo pwned > owned.txt';
      const result = await runAgent({
        agent: "fakeagy",
        prompt: dangerous,
        projectRoot: directory,
        registry,
        env,
      });
      assert.match(result.finalMessage, /^Antigravity heard: Say "hi" & echo pwned > owned\.txt/);
      assert.equal(result.sessionId, "fake-session-123");
      assert.deepEqual(result.usage, {
        inputTokens: 12,
        cachedInputTokens: 2,
        outputTokens: 5,
        reasoningOutputTokens: 3,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("init merges Antigravity workspace files and the shared guard blocks its edits", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sharelane-agy-"));
  try {
    const agentsDir = join(projectRoot, ".agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, "mcp_config.json"),
      JSON.stringify({ mcpServers: { mine: { command: "my-server" } } }),
      "utf8",
    );
    await writeFile(
      join(agentsDir, "hooks.json"),
      JSON.stringify({ "my-hook": { enabled: true, Stop: [{ type: "command", command: "echo bye" }] } }),
      "utf8",
    );
    installClaudeClaimHook(projectRoot);
    installAntigravityIntegration(projectRoot);
    installAntigravityIntegration(projectRoot);

    const mcp = JSON.parse(await readFile(join(agentsDir, "mcp_config.json"), "utf8"));
    assert.equal(mcp.mcpServers.mine.command, "my-server");
    assert.equal(mcp.mcpServers.sharelane.env.SHARELANE_AGENT, "antigravity");
    const hooks = JSON.parse(await readFile(join(agentsDir, "hooks.json"), "utf8"));
    assert.deepEqual(Object.keys(hooks).sort(), ["my-hook", "sharelane-claim-guard"]);
    const guard = hooks["sharelane-claim-guard"].PreToolUse[0];
    assert.equal(guard.matcher, "write_to_file|replace_file_content|multi_replace_file_content");
    assert.equal(guard.hooks[0].command, "node ../.claude/hooks/sharelane-claim-guard.mjs");

    // Run the guard exactly as Antigravity does: from .agents/, with its event shape.
    claimPaths({ agent: "setup", paths: ["README.md"], intent: "create database", projectRoot });
    const hook = (file: string) =>
      spawnSync("node", ["../.claude/hooks/sharelane-claim-guard.mjs"], {
        cwd: agentsDir,
        input: JSON.stringify({
          toolCall: {
            name: "write_to_file",
            args: { TargetFile: join(projectRoot, file), CodeContent: "x" },
          },
          workspacePaths: [projectRoot.replaceAll("\\", "/")],
          conversationId: "c-1",
        }),
        env: { ...process.env, SHARELANE_PROJECT_ROOT: projectRoot, SHARELANE_AGENT: "antigravity" },
        encoding: "utf8",
      });
    const blocked = hook("src/app.ts");
    assert.equal(blocked.status, 2);
    assert.match(JSON.parse(blocked.stdout).reason, /blocked an unclaimed edit to src\/app\.ts/);
    assert.equal(JSON.parse(blocked.stdout).decision, "deny");
    claimPaths({ agent: "antigravity", paths: ["src/app.ts"], intent: "edit app", projectRoot });
    const allowed = hook("src/app.ts");
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(allowed.stdout, "");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
