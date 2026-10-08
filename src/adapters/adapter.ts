import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parse } from "yaml";

export const outputFormatSchema = z.enum(["claude-json", "codex-jsonl", "antigravity-json"]);
export type AgentOutputFormat = z.infer<typeof outputFormatSchema>;

const commandTemplateSchema = z.object({
  args: z.array(z.string()).min(1),
});

const scopeArgsSchema = z.object({
  // Replaces a "{scopeArgs}" template element when the task has a scope.
  scoped: z.array(z.string()),
  // Replaces "{scopeArgs}" when the task has no explicit scope.
  unscoped: z.array(z.string()).default([]),
});

const tierSettingSchema = z.object({
  model: z.string().trim().min(1).optional(),
  effort: z.string().trim().min(1).optional(),
});

const agentAdapterSchema = z.object({
  displayName: z.string().trim().min(1),
  command: z.string().trim().min(1),
  run: commandTemplateSchema,
  resume: commandTemplateSchema,
  scope: scopeArgsSchema.optional(),
  // Built-in reader for remaining subscription allowance (see src/core/quota.ts).
  quota: z.enum(["claude", "codex", "none"]).optional(),
  // How each model tier maps to this agent's models (see src/core/tiers.ts).
  tiers: z
    .object({ fast: tierSettingSchema, balanced: tierSettingSchema, strong: tierSettingSchema })
    .partial()
    .optional(),
  // Replace a "{modelArgs}" template element: each list is used when the tier
  // sets that value, with "{value}" filled in.
  modelFlags: z
    .object({ model: z.array(z.string()).optional(), effort: z.array(z.string()).optional() })
    .optional(),
  // Agent-specific lines added to a new delegated task's instructions.
  workerNotes: z.array(z.string().trim().min(1)).optional(),
  output: outputFormatSchema,
  instructionsFile: z.string().trim().min(1),
});

const registrySchema = z.object({
  version: z.literal(1),
  agents: z.record(z.string().regex(/^[a-z0-9-]+$/), agentAdapterSchema),
});

export type AgentAdapter = z.infer<typeof agentAdapterSchema>;
export type AgentRegistry = z.infer<typeof registrySchema>;

/** A delegated write scope, resolved against the worker's checkout. */
export interface CommandScope {
  patterns: string[];
  /** Absolute scope directories; the first is the primary sandbox root. */
  directories: string[];
}

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
  const allowed =
    name === "run"
      ? new Set(["prompt", "scopeArgs", "modelArgs"])
      : new Set(["prompt", "session", "scopeArgs", "modelArgs"]);
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
  for (const slot of ["{scopeArgs}", "{modelArgs}"]) {
    if (args.some((arg) => arg.includes(slot) && arg !== slot)) {
      throw new Error(`Adapter "${agent}" ${name} command must use ${slot} as a whole argument.`);
    }
  }
}

const scopePlaceholders = new Set(["scopePattern", "scopeRoot", "scopeExtraDir"]);

function validateScopeArgs(agent: string, args: string[]): void {
  for (const arg of args) {
    const names = [...arg.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    const unknown = names.find((placeholder) => !scopePlaceholders.has(placeholder ?? ""));
    if (unknown) {
      throw new Error(`Adapter "${agent}" scope args have unknown placeholder {${unknown}}.`);
    }
    if (new Set(names).size > 1) {
      throw new Error(`Adapter "${agent}" scope args may use one placeholder per argument.`);
    }
  }
}

/**
 * Expand scope arguments. {scopeRoot} is the first scope directory;
 * an argument containing {scopePattern} or {scopeExtraDir} is repeated once per
 * pattern or per additional directory (and dropped when there are none).
 */
function expandScopeArgs(args: string[], scope: CommandScope): string[] {
  const [root = "", ...extraDirectories] = scope.directories;
  return args.flatMap((arg) => {
    if (arg.includes("{scopePattern}")) {
      return scope.patterns.map((pattern) => arg.replaceAll("{scopePattern}", pattern));
    }
    if (arg.includes("{scopeExtraDir}")) {
      return extraDirectories.map((directory) =>
        arg.replaceAll("{scopeExtraDir}", directory),
      );
    }
    return [arg.replaceAll("{scopeRoot}", root)];
  });
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
    if (adapter.scope) {
      validateScopeArgs(name, adapter.scope.scoped);
      validateScopeArgs(name, adapter.scope.unscoped);
    }
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
  scope?: CommandScope,
  model?: { model?: string; effort?: string },
): AgentCommand {
  const adapter = getAgentAdapter(agent, registry);
  const template = sessionId ? adapter.resume.args : adapter.run.args;
  const scopeArgs = scope
    ? expandScopeArgs(adapter.scope?.scoped ?? [], scope)
    : (adapter.scope?.unscoped ?? []);
  const fill = (flag: string[] | undefined, value: string | undefined) =>
    flag && value ? flag.map((part) => part.replaceAll("{value}", value)) : [];
  const modelArgs = [
    ...fill(adapter.modelFlags?.model, model?.model),
    ...fill(adapter.modelFlags?.effort, model?.effort),
  ];
  const args = template.flatMap((argument) =>
    argument === "{scopeArgs}"
      ? scopeArgs
      : argument === "{modelArgs}"
        ? modelArgs
        : [
          argument
            .replaceAll("{prompt}", prompt)
            .replaceAll("{session}", sessionId ?? ""),
        ],
  );

  return {
    agent,
    command: adapter.command,
    args,
    output: adapter.output,
    resumed: Boolean(sessionId),
  };
}
