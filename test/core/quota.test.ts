import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installClaudeUsageStatusLine } from "../../src/core/hooks.js";
import {
  decideQuota,
  readClaudeQuota,
  readCodexQuota,
  writeClaudeSnapshot,
} from "../../src/core/quota.js";

const now = Date.parse("2026-10-02T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const epochIn = (minutes: number) => Math.round((now + minutes * 60_000) / 1000);

test("the lowest window decides, and only a fresh reading can say fine", () => {
  const windows = [
    { name: "five-hour", remainingPercent: 60 },
    { name: "weekly", remainingPercent: 6 },
  ];
  const handoff = decideQuota({ agent: "a", source: "s", windows, observedAt: minutesAgo(1), now });
  assert.equal(handoff.state, "handoff");
  assert.equal(handoff.lowest?.name, "weekly");
  // Usage only rises until a reset, so an old "exhausted" reading still stands...
  assert.equal(decideQuota({ agent: "a", source: "s", windows, observedAt: minutesAgo(600), now }).state, "handoff");
  // ...but an old "plenty left" reading is only a guess.
  const healthy = [{ name: "five-hour", remainingPercent: 80 }];
  assert.equal(decideQuota({ agent: "a", source: "s", windows: healthy, observedAt: minutesAgo(5), now }).state, "ok");
  assert.equal(decideQuota({ agent: "a", source: "s", windows: healthy, observedAt: minutesAgo(60), now }).state, "unknown");
  assert.equal(decideQuota({ agent: "a", source: "s", windows: [], now }).state, "unknown");
  assert.equal(decideQuota({ agent: "a", source: "s", windows: [{ name: "w", remainingPercent: 7 }], now }).state, "handoff");
});

async function codexHomeWith(lines: object[]): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "sharelane-codex-home-"));
  const directory = join(home, "sessions", "2026", "10", "02");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "rollout-test.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
  return home;
}

function limitsEvent(minutes: number, rateLimits: object): object {
  return { timestamp: minutesAgo(minutes), type: "event_msg", payload: { type: "token_count", rate_limits: rateLimits } };
}

test("Codex quota comes from its local session logs", async () => {
  const exhausted = await codexHomeWith([
    { timestamp: minutesAgo(300), type: "event_msg", payload: { type: "agent_message" } },
    limitsEvent(240, {
      primary: { used_percent: 2, window_minutes: 300, resets_at: epochIn(30) },
      secondary: { used_percent: 100, window_minutes: 10080, resets_at: epochIn(1500) },
      rate_limit_reached_type: null,
    }),
  ]);
  const depletedNow = await codexHomeWith([
    limitsEvent(10, { primary: null, secondary: null, rate_limit_reached_type: "workspace_member_credits_depleted" }),
  ]);
  const depletedLongAgo = await codexHomeWith([
    limitsEvent(180, { primary: null, secondary: null, rate_limit_reached_type: "workspace_member_credits_depleted" }),
  ]);
  const windowsReset = await codexHomeWith([
    limitsEvent(5, {
      primary: { used_percent: 100, window_minutes: 300, resets_at: epochIn(-10) },
      secondary: { used_percent: 40, window_minutes: 10080, resets_at: epochIn(3000) },
    }),
  ]);
  try {
    const weekly = readCodexQuota({ codexHome: exhausted, now });
    assert.equal(weekly.state, "handoff", "an old exhausted weekly window is still exhausted");
    assert.equal(weekly.lowest?.name, "weekly");
    assert.equal(weekly.lowest?.remainingPercent, 0);
    assert.equal(readCodexQuota({ codexHome: depletedNow, now }).state, "handoff");
    assert.match(readCodexQuota({ codexHome: depletedNow, now }).reason ?? "", /credits depleted/);
    assert.equal(readCodexQuota({ codexHome: depletedLongAgo, now }).state, "unknown");
    const reset = readCodexQuota({ codexHome: windowsReset, now });
    assert.equal(reset.state, "ok", "a window whose reset time has passed counts as full");
    assert.equal(reset.lowest?.name, "weekly");
    assert.equal(readCodexQuota({ codexHome: join(exhausted, "missing"), now }).state, "unknown");
  } finally {
    for (const home of [exhausted, depletedNow, depletedLongAgo, windowsReset]) {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("Claude quota uses the status-line snapshot and never calls home when told not to", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sharelane-claude-usage-"));
  const snapshotPath = join(directory, "claude.json");
  try {
    assert.equal((await readClaudeQuota({ snapshotPath, now, allowEndpoint: false })).state, "unknown");
    writeClaudeSnapshot(
      {
        capturedAt: minutesAgo(2),
        source: "statusline",
        five_hour: { used_percentage: 40, resets_at: epochIn(100) },
        seven_day: { used_percentage: 95, resets_at: epochIn(5000) },
      },
      snapshotPath,
    );
    const report = await readClaudeQuota({ snapshotPath, now, allowEndpoint: false });
    assert.equal(report.state, "handoff");
    assert.equal(report.lowest?.name, "weekly");
    assert.equal(report.source, "Claude status line");
    const later = await readClaudeQuota({ snapshotPath, now: now + 60 * 60_000, allowEndpoint: false });
    assert.equal(later.state, "handoff", "an exhausted week stays exhausted until it resets");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the status line saves a snapshot and still shows the user's own status line", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sharelane-statusline-"));
  const home = await mkdtemp(join(tmpdir(), "sharelane-home-"));
  try {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ statusLine: { type: "command", command: "echo my-own-status-line" } }),
      "utf8",
    );
    assert.equal(installClaudeUsageStatusLine(projectRoot), true);
    assert.equal(installClaudeUsageStatusLine(projectRoot), true, "reinstalling is harmless");
    const settings = JSON.parse(await readFile(join(projectRoot, ".claude", "settings.json"), "utf8"));
    assert.equal(settings.statusLine.command, "node .claude/hooks/sharelane-statusline.mjs");

    const snapshotPath = join(home, "usage.json");
    const run = spawnSync(process.execPath, [".claude/hooks/sharelane-statusline.mjs"], {
      cwd: projectRoot,
      input: JSON.stringify({
        model: { display_name: "Opus" },
        rate_limits: {
          five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
          seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
        },
      }),
      env: { ...process.env, USERPROFILE: home, HOME: home, SHARELANE_CLAUDE_USAGE_FILE: snapshotPath },
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), "my-own-status-line");
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
    assert.equal(snapshot.source, "statusline");
    assert.equal(snapshot.seven_day.used_percentage, 41.2);

    // A project that already has its own status line keeps it.
    const other = await mkdtemp(join(tmpdir(), "sharelane-statusline-own-"));
    await mkdir(join(other, ".claude"), { recursive: true });
    await writeFile(join(other, ".claude", "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "mine" } }), "utf8");
    assert.equal(installClaudeUsageStatusLine(other), false);
    assert.equal(JSON.parse(await readFile(join(other, ".claude", "settings.json"), "utf8")).statusLine.command, "mine");
    assert.ok(existsSync(join(other, ".claude", "hooks", "sharelane-statusline.mjs")));
    await rm(other, { recursive: true, force: true });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
