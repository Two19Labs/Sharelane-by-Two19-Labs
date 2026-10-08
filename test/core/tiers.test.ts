import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAgentCommand, getAgentAdapter, loadAgentRegistry, defaultAgentsPath } from "../../src/adapters/adapter.js";
import { chooseTier, describeModel, guessTier, modelForTier } from "../../src/core/tiers.js";

test("the free guess reads the request's wording and size", () => {
  assert.deepEqual(guessTier("Refactor the auth module to use sessions"), { tier: "strong", reason: 'auto: mentions "refactor"' });
  assert.equal(guessTier("Investigate why the sync job deadlocks").tier, "strong");
  assert.equal(guessTier("x".repeat(1600)).tier, "strong", "a long, detailed request is treated as hard");
  assert.deepEqual(guessTier("Fix the typo in the README"), { tier: "fast", reason: 'auto: small change ("typo")' });
  assert.equal(guessTier("Rename getUser to fetchUser").tier, "fast");
  assert.deepEqual(guessTier("Build a simple tic-tac-toe game"), { tier: "balanced", reason: "auto: ordinary task" });
});

test("an explicit choice wins over the guess, and default means the agent's own model", () => {
  assert.deepEqual(chooseTier("strong", "fix a typo", "claude"), { tier: "strong", reason: "chosen by claude" });
  assert.deepEqual(chooseTier("auto", "fix a typo", "you"), { tier: "fast", reason: 'auto: small change ("typo")' });
  assert.deepEqual(chooseTier(undefined, "add a login page", "you"), { tier: "balanced", reason: "auto: ordinary task" });
  assert.deepEqual(chooseTier("default", "anything", "you"), { reason: "the agent's own model, chosen by you" });
});

test("each shipped agent maps tiers to real model flags in new and resumed runs", () => {
  const registry = loadAgentRegistry(defaultAgentsPath);
  const args = (agent: string, tier: "fast" | "balanced" | "strong", session?: string) =>
    buildAgentCommand(agent, "do it", session, registry, undefined, modelForTier(getAgentAdapter(agent, registry), tier)).args;

  const claude = args("claude", "fast");
  assert.deepEqual(claude.slice(claude.indexOf("--model"), claude.indexOf("--model") + 2), ["--model", "haiku"]);
  assert.ok(args("claude", "strong", "s1").includes("opus"), "resumed runs keep the tier");

  const codex = args("codex", "strong");
  assert.deepEqual(codex.slice(codex.indexOf("-m"), codex.indexOf("-m") + 2), ["-m", "gpt-6-astra"]);
  assert.ok(codex.includes('model_reasoning_effort="high"'));
  const codexResume = args("codex", "fast", "s1");
  assert.ok(codexResume.includes("gpt-6-luna"));
  assert.ok(codexResume.indexOf("-m") < codexResume.indexOf("resume"), "options come before the resume subcommand");

  assert.ok(args("antigravity", "balanced").includes("gemini-3.8-flash-high"));

  const plain = buildAgentCommand("claude", "do it", undefined, registry).args;
  assert.ok(!plain.includes("--model"), "no tier means no model flag: the agent's own default");
  assert.equal(describeModel(modelForTier(getAgentAdapter("codex", registry), "balanced")), "gpt-6.1-sol · medium effort");
  assert.equal(describeModel(undefined), "agent default");
});
