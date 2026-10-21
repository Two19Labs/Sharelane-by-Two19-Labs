import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { mergeEnvironment } from "../../src/core/runner.js";
import {
  buildTerminalCommand,
  cancelLaterEntry,
  executeBackgroundMode,
  formatLaterList,
  isValidSessionId,
  latestClaudeSession,
  listLaterEntries,
  loadLaterEntry,
  parseWhen,
  runLaterEntry,
  saveLaterEntry,
  scheduleLater,
  waitLaterEntry,
  type LaterEntry,
} from "../../src/core/later.js";
import type { QuotaReport } from "../../src/core/quota.js";

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "sharelane-later-test-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("parseWhen handles --in correctly with a fixed now", () => {
  const fixedNow = new Date("2026-10-16T12:00:00.000Z");
  const nowMs = fixedNow.getTime();

  // 90m -> +90 mins
  const r90m = parseWhen({ in: "90m", now: fixedNow });
  assert.equal(r90m.when, "in");
  assert.equal(r90m.fireAt, new Date(nowMs + 90 * 60_000).toISOString());

  // 2h -> +120 mins
  const r2h = parseWhen({ in: "2h", now: fixedNow });
  assert.equal(r2h.fireAt, new Date(nowMs + 120 * 60_000).toISOString());

  // 1h30m -> +90 mins
  const r1h30m = parseWhen({ in: "1h30m", now: fixedNow });
  assert.equal(r1h30m.fireAt, new Date(nowMs + 90 * 60_000).toISOString());

  // 45 -> 45 mins
  const r45 = parseWhen({ in: "45", now: fixedNow });
  assert.equal(r45.fireAt, new Date(nowMs + 45 * 60_000).toISOString());

  // Rejections
  assert.throws(() => parseWhen({ in: "0", now: fixedNow }), /positive/i);
  assert.throws(() => parseWhen({ in: "-5", now: fixedNow }), /positive/i);
  assert.throws(() => parseWhen({ in: "3x", now: fixedNow }), /format must be/i);
  assert.throws(() => parseWhen({ in: "8d", now: fixedNow }), /format must be|cannot exceed 7 days/i);
  assert.throws(() => parseWhen({ in: "10081m", now: fixedNow }), /cannot exceed 7 days/i);
});

test("parseWhen handles --at correctly with local HH:MM and ISO strings", () => {
  // Let fixedNow be 2026-10-16 12:00 local time
  const now = new Date();
  now.setHours(12, 0, 0, 0);

  // Future HH:MM today (14:30)
  const future = parseWhen({ at: "14:30", now });
  assert.equal(future.when, "at");
  const futureDate = new Date(future.fireAt);
  assert.equal(futureDate.getHours(), 14);
  assert.equal(futureDate.getMinutes(), 30);
  assert.equal(futureDate.getDate(), now.getDate());

  // Past HH:MM today (10:15) rolls to tomorrow
  const past = parseWhen({ at: "10:15", now });
  assert.equal(past.when, "at");
  const pastDate = new Date(past.fireAt);
  assert.equal(pastDate.getHours(), 10);
  assert.equal(pastDate.getMinutes(), 15);
  const expectedTomorrow = new Date(now);
  expectedTomorrow.setDate(expectedTomorrow.getDate() + 1);
  assert.equal(pastDate.getDate(), expectedTomorrow.getDate());

  // Valid future ISO string
  const futureIso = new Date(now.getTime() + 3_600_000).toISOString();
  const isoResult = parseWhen({ at: futureIso, now });
  assert.equal(isoResult.fireAt, futureIso);

  // Past ISO string rejected
  const pastIso = new Date(now.getTime() - 3_600_000).toISOString();
  assert.throws(() => parseWhen({ at: pastIso, now }), /in the past/i);
});

test("parseWhen handles --when-reset with quota reports", () => {
  const fixedNow = new Date("2026-10-16T12:00:00.000Z");
  const resetIso = "2026-10-16T14:00:00.000Z";

  const quotaReport: QuotaReport = {
    agent: "claude",
    state: "handoff",
    threshold: 7,
    source: "statusline",
    windows: [
      { name: "weekly", remainingPercent: 40, resetsAt: "2026-10-20T00:00:00.000Z" },
      { name: "five-hour", remainingPercent: 5, resetsAt: resetIso },
    ],
  };

  const result = parseWhen({ whenReset: true, quotaReport, now: fixedNow });
  assert.equal(result.when, "reset");
  assert.equal(result.resetsAt, resetIso);
  // Resets at + 2 minutes
  const expectedFire = new Date(Date.parse(resetIso) + 2 * 60_000).toISOString();
  assert.equal(result.fireAt, expectedFire);

  // Refusal when no usable reset time is available
  const expiredReport: QuotaReport = {
    agent: "claude",
    state: "unknown",
    threshold: 7,
    source: "none",
    windows: [
      { name: "five-hour", remainingPercent: 0, resetsAt: "2026-10-16T11:00:00.000Z" },
    ],
  };
  assert.throws(
    () => parseWhen({ whenReset: true, quotaReport: expiredReport, now: fixedNow }),
    /ShareLane can't read when your Claude limit resets\. Use --in or --at instead\./,
  );

  assert.throws(
    () => parseWhen({ whenReset: true, quotaReport: undefined, now: fixedNow }),
    /ShareLane can't read when your Claude limit resets\. Use --in or --at instead\./,
  );
});

test("parseWhen rejects missing or multiple time options", () => {
  assert.throws(() => parseWhen({}), /Exactly one of --in, --at or --when-reset is required\./);
  assert.throws(
    () => parseWhen({ in: "1h", at: "12:00" }),
    /Exactly one of --in, --at or --when-reset is required\./,
  );
  assert.throws(
    () => parseWhen({ in: "1h", whenReset: true }),
    /Exactly one of --in, --at or --when-reset is required\./,
  );
});

test("latestClaudeSession finds newest session and matches folder case-insensitively", async () => {
  await withTempDir(async (homeDir) => {
    const projectRoot = "C:\\My Projects\\Demo App";
    // Encoded project root: c--My-Projects-Demo-App
    const projectsDir = join(homeDir, ".claude", "projects");
    const projectDir = join(projectsDir, "c--my-projects-demo-app");
    await mkdir(projectDir, { recursive: true });

    // Missing folder returns undefined
    assert.equal(latestClaudeSession("D:\\Other\\Path", homeDir), undefined);

    const s1 = join(projectDir, "session-11111111.jsonl");
    const s2 = join(projectDir, "session-22222222.jsonl");

    await writeFile(s1, '{"test":1}\n', "utf8");
    await writeFile(s2, '{"test":2}\n', "utf8");

    // Set s2 to be newer than s1
    await utimes(s1, 1000, 1000);
    await utimes(s2, 2000, 2000);

    const found = latestClaudeSession(projectRoot, homeDir);
    assert.equal(found, "session-22222222");

    // Change utimes so s1 is newer
    await utimes(s1, 3000, 3000);
    const foundNewer = latestClaudeSession(projectRoot, homeDir);
    assert.equal(foundNewer, "session-11111111");
  });
});

test("isValidSessionId checks session ID format", () => {
  assert.equal(isValidSessionId("12345678"), true);
  assert.equal(isValidSessionId("930def49-8e42-4521-8898-1f19d08e56ec"), true);
  assert.equal(isValidSessionId("930def49"), true);
  assert.equal(isValidSessionId("abc"), false);
  assert.equal(isValidSessionId("session!invalid"), false);
});

test("entry store saves and lists entries newest first", async () => {
  await withTempDir(async (projectRoot) => {
    assert.deepEqual(listLaterEntries(projectRoot), []);

    const e1: LaterEntry = {
      id: "11111111",
      prompt: "first prompt",
      projectRoot,
      createdAt: "2026-10-16T10:00:00.000Z",
      fireAt: "2026-10-16T12:00:00.000Z",
      when: "in",
      mode: "window",
      status: "scheduled",
    };
    const e2: LaterEntry = {
      id: "22222222",
      prompt: "second prompt",
      projectRoot,
      createdAt: "2026-10-16T11:00:00.000Z",
      fireAt: "2026-10-16T13:00:00.000Z",
      when: "in",
      mode: "background",
      status: "scheduled",
    };

    saveLaterEntry(e1);
    saveLaterEntry(e2);

    const loaded1 = loadLaterEntry(projectRoot, "11111111");
    assert.deepEqual(loaded1, e1);

    const all = listLaterEntries(projectRoot);
    assert.equal(all.length, 2);
    // Newest first by createdAt
    assert.equal(all[0].id, "22222222");
    assert.equal(all[1].id, "11111111");
  });
});

test("formatLaterList formats entries and identifies lost entries", () => {
  const emptyOutput = formatLaterList([]);
  assert.match(emptyOutput[0], /Nothing scheduled/);

  const nowMs = new Date("2026-10-16T12:00:00.000Z").getTime();
  const entries: LaterEntry[] = [
    {
      id: "deadbeef",
      prompt: "say hello",
      projectRoot: "c:\\project",
      createdAt: "2026-10-16T11:00:00.000Z",
      fireAt: "2026-10-16T13:00:00.000Z",
      when: "in",
      mode: "window",
      status: "scheduled",
      pid: 999999,
    },
    {
      id: "alive123",
      prompt: "keep working",
      projectRoot: "c:\\project",
      createdAt: "2026-10-16T11:30:00.000Z",
      fireAt: "2026-10-16T14:00:00.000Z",
      when: "in",
      mode: "background",
      status: "scheduled",
      pid: 12345,
    },
  ];

  // Mock pidChecker: 12345 is alive, 999999 is dead
  const pidChecker = (pid: number) => pid === 12345;
  const lines = formatLaterList(entries, nowMs, pidChecker);
  assert.equal(lines.length, 2);

  // deadbeef should show lost (computer restarted?)
  assert.match(lines[0], /deadbeef/);
  assert.match(lines[0], /lost \(computer restarted\?\)/);

  // alive123 should show scheduled
  assert.match(lines[1], /alive123/);
  assert.match(lines[1], /scheduled/);
});

test("cancelLaterEntry cancels scheduled entry and kills process", async () => {
  await withTempDir(async (projectRoot) => {
    let killedPid: number | undefined;
    const killProcess = (pid: number) => {
      killedPid = pid;
    };

    const entry: LaterEntry = {
      id: "3fa9c2d1",
      prompt: "continue coding",
      projectRoot,
      createdAt: "2026-10-16T10:00:00.000Z",
      fireAt: "2026-10-16T12:00:00.000Z",
      when: "in",
      mode: "window",
      status: "scheduled",
      pid: 54321,
    };
    saveLaterEntry(entry);

    // Cancel with prefix (at least 4 chars)
    const result = cancelLaterEntry(projectRoot, "3fa9", { killProcess });
    assert.equal(result.cancelled.status, "cancelled");
    assert.equal(killedPid, 54321);

    // Persisted file should be updated
    const updated = loadLaterEntry(projectRoot, "3fa9c2d1");
    assert.equal(updated?.status, "cancelled");

    // Re-cancelling a cancelled entry fails
    assert.throws(
      () => cancelLaterEntry(projectRoot, "3fa9", { killProcess }),
      /already cancelled/i,
    );

    // Short prefix (<4 chars) rejected
    assert.throws(() => cancelLaterEntry(projectRoot, "3fa"), /at least 4 characters/i);

    // Non-existent prefix rejected
    assert.throws(() => cancelLaterEntry(projectRoot, "9999"), /No scheduled entry found/i);
  });
});

test("buildTerminalCommand formats terminal commands for win32, darwin, and linux", () => {
  const projectRoot = "C:\\Shared Context";
  const binPath = "C:\\Shared Context\\bin\\sharelane.mjs";
  const id = "12345678";
  const node = "C:\\Program Files\\nodejs\\node.exe";

  // win32
  const winCmd = buildTerminalCommand({
    platform: "win32",
    projectRoot,
    binPath,
    id,
    nodePath: node,
  });
  assert.equal(winCmd.command, "cmd.exe");
  assert.deepEqual(winCmd.args, [
    "/d",
    "/c",
    "start",
    "ShareLane later",
    "/D",
    projectRoot,
    node,
    binPath,
    "later",
    "run",
    id,
  ]);
  assert.equal(winCmd.options.shell, false);
  assert.equal(winCmd.options.detached, true);

  // darwin
  const macCmd = buildTerminalCommand({
    platform: "darwin",
    projectRoot: "/Users/dev/project",
    binPath: "/Users/dev/project/bin/sharelane.mjs",
    id: "abcd1234",
    nodePath: "/usr/local/bin/node",
  });
  assert.equal(macCmd.command, "open");
  assert.equal(macCmd.args[0], "-a");
  assert.equal(macCmd.args[1], "Terminal");
  assert.match(macCmd.args[2], /abcd1234\.command$/);

  // linux with x-terminal-emulator
  const linuxXterm = buildTerminalCommand({
    platform: "linux",
    projectRoot: "/home/dev/project",
    binPath: "/home/dev/project/bin/sharelane.mjs",
    id: "feedbeef",
    nodePath: "/usr/bin/node",
    env: { PATH: "/custom/bin" },
  });
  // Without x-terminal-emulator or gnome-terminal on mock PATH, falls back to background
  assert.equal(linuxXterm.fallbackToBackground, true);
});

test("background mode executes fake claude and records log and done status", async () => {
  await withTempDir(async (scratch) => {
    const projectRoot = join(scratch, "proj");
    const binDir = join(scratch, "bin");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(binDir, { recursive: true });

    const argsFile = join(scratch, "claude-args.json");
    const scriptPath = join(binDir, "fake-claude.mjs");
    const scriptContent = `import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_ARGS_FILE) {
  writeFileSync(process.env.FAKE_CLAUDE_ARGS_FILE, JSON.stringify(args), "utf8");
}
console.log("Fake Claude completed with args: " + args.join(" "));
`;
    await writeFile(scriptPath, scriptContent, "utf8");

    if (process.platform === "win32") {
      await writeFile(join(binDir, "claude.cmd"), `@echo off\r\n"%dp0%\\fake-claude.mjs" %*\r\n`, "utf8");
    } else {
      const claudeSh = join(binDir, "claude");
      await writeFile(claudeSh, `#!/bin/sh\nexec node "${scriptPath}" "$@"\n`, "utf8");
      const { chmod } = await import("node:fs/promises");
      await chmod(claudeSh, 0o755);
    }

    // mergeEnvironment replaces Windows' "Path" too, so the fake is found first.
    const testEnv = mergeEnvironment(process.env, {
      PATH: `${binDir}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}`,
      FAKE_CLAUDE_ARGS_FILE: argsFile,
    });

    const promptWithSpecialChars = '"quotes" & 100% ; done';
    const entry: LaterEntry = {
      id: "a1b2c3d4",
      prompt: promptWithSpecialChars,
      projectRoot,
      createdAt: new Date().toISOString(),
      fireAt: new Date(Date.now() - 1000).toISOString(), // in the past so it fires immediately
      when: "in",
      mode: "background",
      session: "session-98765432",
      status: "scheduled",
    };
    saveLaterEntry(entry);

    // Wait logic runs in-process with fast poll
    await waitLaterEntry("a1b2c3d4", {
      projectRoot,
      pollMs: 20,
      env: testEnv,
    });

    const finished = loadLaterEntry(projectRoot, "a1b2c3d4");
    assert(finished);
    assert.equal(finished.status, "done");
    assert.equal(finished.exitCode, 0);
    assert(finished.log);

    const { readFile } = await import("node:fs/promises");
    const logContent = await readFile(finished.log, "utf8");
    assert.match(logContent, /Fake Claude completed/);

    const recordedArgs = JSON.parse(await readFile(argsFile, "utf8")) as string[];
    assert.deepEqual(recordedArgs, [
      "-p",
      promptWithSpecialChars,
      "--resume",
      "session-98765432",
      "--permission-mode",
      "acceptEdits",
      "--output-format",
      "json",
    ]);
  });
});

test("cancelled entry never fires and exits waiting loop without invoking claude", async () => {
  await withTempDir(async (scratch) => {
    const projectRoot = join(scratch, "proj");
    await mkdir(projectRoot, { recursive: true });

    let fakeCalled = false;
    const runMode = async () => {
      fakeCalled = true;
    };

    const entry: LaterEntry = {
      id: "canc1234",
      prompt: "should not run",
      projectRoot,
      createdAt: new Date().toISOString(),
      fireAt: new Date(Date.now() + 500).toISOString(),
      when: "in",
      mode: "background",
      status: "scheduled",
    };
    saveLaterEntry(entry);

    // Cancel before or during wait
    cancelLaterEntry(projectRoot, "canc1234");

    await waitLaterEntry("canc1234", {
      projectRoot,
      pollMs: 20,
      runMode,
    });

    assert.equal(fakeCalled, false);
    const updated = loadLaterEntry(projectRoot, "canc1234");
    assert.equal(updated?.status, "cancelled");
  });
});
