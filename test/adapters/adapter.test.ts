import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import {
  buildAgentCommand,
  defaultAgentsPath,
  loadAgentRegistry,
} from "../../src/adapters/adapter.js";

test("loads Claude and Codex adapters from YAML", () => {
  const registry = loadAgentRegistry(defaultAgentsPath);
  assert.deepEqual(Object.keys(registry.agents).sort(), ["claude", "codex"]);
  assert.equal(registry.agents.claude?.output, "claude-json");
  assert.equal(registry.agents.codex?.output, "codex-jsonl");
});

test("builds run and resume commands without shell parsing", () => {
  const registry = loadAgentRegistry(defaultAgentsPath);
  const dangerousLookingPrompt = 'Calculate "2 & 3"; Remove-Item -Recurse .';
  const run = buildAgentCommand("codex", dangerousLookingPrompt, undefined, registry);
  assert.equal(run.command, "codex");
  assert.equal(run.resumed, false);
  assert.equal(run.args.at(-1), dangerousLookingPrompt);
  assert.equal(
    run.args.filter((argument) => argument === dangerousLookingPrompt).length,
    1,
  );

  const resume = buildAgentCommand(
    "claude",
    "Please continue.",
    "session-123",
    registry,
  );
  assert.equal(resume.command, "claude");
  assert.equal(resume.resumed, true);
  assert.equal(resume.args[resume.args.indexOf("--resume") + 1], "session-123");
  assert.equal(resume.args[resume.args.indexOf("-p") + 1], "Please continue.");
});

test("a new agent is added through configuration without code changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sharelane-adapter-"));
  const configPath = join(directory, "agents.yaml");

  try {
    await writeFile(
      configPath,
      stringify({
        version: 1,
        agents: {
          example: {
            displayName: "Example Agent",
            command: "example-agent",
            run: { args: ["run", "{prompt}"] },
            resume: { args: ["resume", "{session}", "{prompt}"] },
            output: "codex-jsonl",
            instructionsFile: "AGENTS.md",
          },
        },
      }),
      "utf8",
    );
    const registry = loadAgentRegistry(configPath);
    const command = buildAgentCommand(
      "example",
      "hello",
      undefined,
      registry,
    );
    assert.equal(command.command, "example-agent");
    assert.deepEqual(command.args, ["run", "hello"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects unknown agents with the configured choices", () => {
  assert.throws(
    () => buildAgentCommand("missing", "hello"),
    /Unknown agent "missing"\. Available agents: claude, codex\./,
  );
});
