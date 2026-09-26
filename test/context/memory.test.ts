import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ChunkTooLargeError,
  MAX_CHUNK_CHARACTERS,
  initializeContext,
  readChunk,
  updateChunk,
} from "../../src/core/context.js";
import {
  contextMap,
  logProgress,
  searchMemory,
} from "../../src/core/memory.js";

test("updating a chunk refreshes MAP.md and full-text search", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sharelane-memory-"));

  try {
    initializeContext(projectRoot);
    const chunk = updateChunk(
      {
        id: "architecture",
        title: "System architecture",
        readWhen: "Changing the message pipeline.",
        coversFiles: ["src/mcp/**"],
        content: "# System architecture\n\nThe relay uses a lighthouse protocol.",
      },
      projectRoot,
    );

    const map = await readFile(
      join(projectRoot, ".sharelane", "context", "MAP.md"),
      "utf8",
    );
    assert.match(map, /\[System architecture\]\(\.\/architecture\.md\)/);
    assert.match(map, /Changing the message pipeline\./);
    assert.match(map, new RegExp(chunk.updatedAt.replaceAll(".", "\\.")));

    const results = searchMemory("lighthouse protocol", 10, projectRoot);
    assert.equal(results[0]?.kind, "chunk");
    assert.equal(results[0]?.reference, "architecture");
    assert.match(results[0]?.snippet ?? "", /\[lighthouse\]/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("progress notes are journaled and searchable", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sharelane-journal-"));

  try {
    const entry = logProgress(
      "phase-one",
      "Finished the searchable nebula index.",
      "codex",
      projectRoot,
    );
    assert.equal(entry.agent, "codex");
    const results = searchMemory("searchable nebula", 10, projectRoot);
    assert.equal(results[0]?.kind, "journal");
    assert.equal(results[0]?.reference, `journal/${entry.id}`);

    const journal = await readFile(
      join(projectRoot, ".sharelane", "journal", `${entry.createdAt.slice(0, 10)}.md`),
      "utf8",
    );
    assert.match(journal, /phase-one/);
    assert.match(journal, /searchable nebula index/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("update_chunk refuses content over the size cap without changing the chunk", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sharelane-size-"));

  try {
    initializeContext(projectRoot);
    const before = readChunk("architecture", projectRoot);
    assert.throws(
      () =>
        updateChunk(
          {
            id: "architecture",
            content: "x".repeat(MAX_CHUNK_CHARACTERS + 1),
          },
          projectRoot,
        ),
      (error: unknown) =>
        error instanceof ChunkTooLargeError && /compact this first/i.test(error.message),
    );
    assert.equal(readChunk("architecture", projectRoot), before);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("context map marks a chunk stale after a covered source file changes", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sharelane-stale-"));

  try {
    await mkdir(join(projectRoot, "src"), { recursive: true });
    await writeFile(join(projectRoot, "src", "example.ts"), "export const value = 1;\n", "utf8");
    for (const args of [
      ["init"],
      ["config", "user.email", "sharelane-test@example.invalid"],
      ["config", "user.name", "ShareLane Test"],
      ["add", "src/example.ts"],
      ["commit", "-m", "initial"],
    ]) {
      const result = spawnSync("git", args, {
        cwd: projectRoot,
        encoding: "utf8",
        windowsHide: true,
      });
      assert.equal(result.status, 0, result.stderr);
    }

    await writeFile(join(projectRoot, "src", "example.ts"), "export const value = 2;\n", "utf8");
    updateChunk(
      {
        id: "architecture",
        content: "# Architecture\n\nTracks the example source.",
        coversFiles: ["src/example.ts"],
      },
      projectRoot,
    );
    assert.doesNotMatch(contextMap(projectRoot), /Architecture[^\n]*⚠ stale/);

    for (const args of [
      ["add", "src/example.ts"],
      ["commit", "-m", "change source and its context together"],
    ]) {
      const result = spawnSync("git", args, {
        cwd: projectRoot,
        encoding: "utf8",
        windowsHide: true,
      });
      assert.equal(result.status, 0, result.stderr);
    }
    assert.doesNotMatch(contextMap(projectRoot), /Architecture[^\n]*⚠ stale/);

    await writeFile(join(projectRoot, "src", "example.ts"), "export const value = 3;\n", "utf8");
    assert.match(contextMap(projectRoot), /Architecture[^\n]*⚠ stale/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
