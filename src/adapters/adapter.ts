import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parse } from "yaml";

export const outputFormatSchema = z.enum(["claude-json", "codex-jsonl"]);
export type AgentOutputFormat = z.infer<typeof outputFormatSchema>;

const commandTemplateSchema = z.object({
  args: z.array(z.string()).min(1),
});

const agentAdapterSchema = z.object({
  displayName: z.string().trim().min(1),
  command: z.string().trim().min(1),
  run: commandTemplateSchema,
  resume: commandTemplateSchema,
  output: outputFormatSchema,
  instructionsFile: z.string().trim().min(1),
});

const registrySchema = z.object({
  version: z.literal(1),
  agents: z.record(z.string().regex(/^[a-z0-9-]+$/), agentAdapterSchema),
});

export type AgentAdapter = z.infer<typeof agentAdapterSchema>;
export type AgentRegistry = z.infer<typeof registrySchema>;

export interface AgentCommand {
  agent: string;
  command: string;
  args: string[];
  output: AgentOutputFormat;
  resumed: boolean;
}

export const defaultAgentsPath = fileURLToPath(
  new URL("./agents.yaml", import.meta.url),
);

function validateTemplate(
  agent: string,
  name: "run" | "resume",
  args: string[],
): void {
  const joined = args.join("\n");
  const placeholders = [...joined.matchAll(/\{([^}]+)\}/g)].map(
    (match) => match[1],
  );
  const allowed = name === "run" ? new Set(["prompt"]) : new Set(["prompt", "session"]);
  const unknown = placeholders.filter((placeholder) => !allowed.has(placeholder));
  if (unknown.length > 0) {
    throw new Error(
      `Adapter "${agent}" ${name} command has unknown placeholder {${unknown[0]}}.`,
    );
  }
  if (!placeholders.includes("prompt")) {
    throw new Error(`Adapter "${agent}" ${name} command must include {prompt}.`);
  }
  if (name === "resume" && !placeholders.includes("session")) {
    throw new Error(`Adapter "${agent}" resume command must include {session}.`);
  }
}

export function loadAgentRegistry(
  configPath = process.env.SHARELANE_AGENTS_CONFIG || defaultAgentsPath,
): AgentRegistry {
  const source = readFileSync(configPath, "utf8");
  const parsed = registrySchema.parse(parse(source));
  if (Object.keys(parsed.agents).length === 0) {
    throw new Error("Agent configuration must contain at least one agent.");
  }

  for (const [name, adapter] of Object.entries(parsed.agents)) {
    validateTemplate(name, "run", adapter.run.args);
    validateTemplate(name, "resume", adapter.resume.args);
  }
  return parsed;
}

export function getAgentAdapter(
  agent: string,
  registry = loadAgentRegistry(),
): AgentAdapter {
  const adapter = registry.agents[agent];
  if (!adapter) {
    const available = Object.keys(registry.agents).sort().join(", ");
    throw new Error(`Unknown agent "${agent}". Available agents: ${available}.`);
  }
  return adapter;
}

export function buildAgentCommand(
  agent: string,
  prompt: string,
  sessionId?: string,
  registry = loadAgentRegistry(),
): AgentCommand {
  const adapter = getAgentAdapter(agent, registry);
  const template = sessionId ? adapter.resume.args : adapter.run.args;
  const args = template.map((argument) =>
    argument
      .replaceAll("{prompt}", prompt)
      .replaceAll("{session}", sessionId ?? ""),
  );

  return {
    agent,
    command: adapter.command,
    args,
    output: adapter.output,
    resumed: Boolean(sessionId),
  };
}
