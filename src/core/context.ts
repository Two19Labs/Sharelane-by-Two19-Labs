import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getShareLanePaths, openDatabase } from "./database.js";

export const MAX_CHUNK_CHARACTERS = 12_000;

export interface ChunkMetadata {
  id: string;
  title: string;
  readWhen: string;
  coversFiles: string[];
  updatedAt: string;
  filePath: string;
  sourceHash?: string;
}

export interface Chunk extends ChunkMetadata {
  content: string;
}

export interface UpdateChunkInput {
  id: string;
  content: string;
  title?: string;
  readWhen?: string;
  coversFiles?: string[];
}

export interface InitializeResult {
  createdChunks: string[];
  mapPath: string;
  databasePath: string;
}

interface StarterChunk {
  id: string;
  title: string;
  readWhen: string;
}

const STARTER_CHUNKS: StarterChunk[] = [
  {
    id: "architecture",
    title: "Architecture",
    readWhen: "You need to understand the system structure or major components.",
  },
  {
    id: "ui",
    title: "User interface",
    readWhen: "You are changing screens, interactions, or visual behavior.",
  },
  {
    id: "api",
    title: "API and tools",
    readWhen: "You are changing commands, tools, integrations, or public interfaces.",
  },
  {
    id: "data",
    title: "Data and storage",
    readWhen: "You are changing stored data, schemas, migrations, or persistence.",
  },
  {
    id: "conventions",
    title: "Project conventions",
    readWhen: "You need the project's coding, testing, or collaboration rules.",
  },
  {
    id: "decisions",
    title: "Project decisions",
    readWhen: "You need to know why an important choice was made.",
  },
];

export class ChunkTooLargeError extends Error {
  constructor(actual: number) {
    super(
      `Chunk is ${actual.toLocaleString("en-US")} characters; the limit is ${MAX_CHUNK_CHARACTERS.toLocaleString("en-US")}. Compact this first.`,
    );
    this.name = "ChunkTooLargeError";
  }
}

function validateChunkId(id: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    throw new Error(
      "Chunk id must contain only lowercase letters, numbers, and single hyphens.",
    );
  }
  return id;
}

function chunkPath(id: string, projectRoot: string): string {
  return join(getShareLanePaths(projectRoot).contextDir, `${validateChunkId(id)}.md`);
}

function writeAtomic(path: string, content: string): void {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, content, "utf8");
  renameSync(temporaryPath, path);
}

export function formatChunk(chunk: Chunk): string {
  return [
    "---",
    `title: ${chunk.title}`,
    `read-when: ${chunk.readWhen}`,
    `covers-files: ${JSON.stringify(chunk.coversFiles)}`,
    `updated-at: ${chunk.updatedAt}`,
    ...(chunk.sourceHash ? [`source-hash: ${chunk.sourceHash}`] : []),
    "---",
    "",
    chunk.content.trimEnd(),
    "",
  ].join("\n");
}

export function parseChunk(source: string, id: string, filePath: string): Chunk {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "---") {
    throw new Error(`${basename(filePath)} is missing its opening --- header.`);
  }

  const headerEnd = lines.indexOf("---", 1);
  if (headerEnd === -1) {
    throw new Error(`${basename(filePath)} is missing its closing --- header.`);
  }

  const fields = new Map<string, string>();
  for (const line of lines.slice(1, headerEnd)) {
    const separator = line.indexOf(":");
    if (separator === -1) {
      throw new Error(`Invalid header line in ${basename(filePath)}: ${line}`);
    }
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }

  const title = fields.get("title");
  const readWhen = fields.get("read-when");
  const updatedAt = fields.get("updated-at");
  const rawCoversFiles = fields.get("covers-files");
  const sourceHash = fields.get("source-hash") || undefined;
  if (!title || !readWhen || !updatedAt || rawCoversFiles === undefined) {
    throw new Error(
      `${basename(filePath)} must define title, read-when, covers-files, and updated-at.`,
    );
  }
  if (Number.isNaN(Date.parse(updatedAt))) {
    throw new Error(`${basename(filePath)} has an invalid updated-at timestamp.`);
  }

  let coversFiles: unknown;
  try {
    coversFiles = JSON.parse(rawCoversFiles);
  } catch {
    throw new Error(`${basename(filePath)} has invalid covers-files JSON.`);
  }
  if (
    !Array.isArray(coversFiles) ||
    !coversFiles.every((entry) => typeof entry === "string")
  ) {
    throw new Error(`${basename(filePath)} covers-files must be a JSON string array.`);
  }

  const content = lines
    .slice(headerEnd + 1)
    .join("\n")
    .replace(/^\n/, "")
    .trimEnd();

  return {
    id: validateChunkId(id),
    title,
    readWhen,
    coversFiles,
    updatedAt,
    filePath,
    sourceHash,
    content,
  };
}

function upsertChunk(database: DatabaseSync, chunk: Chunk): void {
  database.exec("BEGIN IMMEDIATE;");
  try {
    database
      .prepare(
        `INSERT INTO chunks
          (id, title, read_when, covers_files, updated_at, content, file_path)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          read_when = excluded.read_when,
          covers_files = excluded.covers_files,
          updated_at = excluded.updated_at,
          content = excluded.content,
          file_path = excluded.file_path`,
      )
      .run(
        chunk.id,
        chunk.title,
        chunk.readWhen,
        JSON.stringify(chunk.coversFiles),
        chunk.updatedAt,
        chunk.content,
        chunk.filePath,
      );
    database
      .prepare("DELETE FROM search_index WHERE kind = 'chunk' AND reference = ?")
      .run(chunk.id);
    database
      .prepare(
        "INSERT INTO search_index (kind, reference, title, body) VALUES ('chunk', ?, ?, ?)",
      )
      .run(chunk.id, chunk.title, chunk.content);
    database.exec("COMMIT;");
  } catch (error: unknown) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

export function syncChunks(projectRoot = process.cwd()): Chunk[] {
  const paths = getShareLanePaths(projectRoot);
  mkdirSync(paths.contextDir, { recursive: true });
  const chunks = readdirSync(paths.contextDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && entry.name.endsWith(".md") && entry.name !== "MAP.md",
    )
    .map((entry) => {
      const id = entry.name.slice(0, -3);
      const filePath = join(paths.contextDir, entry.name);
      return parseChunk(readFileSync(filePath, "utf8"), id, filePath);
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  const database = openDatabase(projectRoot);
  try {
    const diskIds = new Set(chunks.map((chunk) => chunk.id));
    const stored = database.prepare("SELECT id FROM chunks").all() as Array<{
      id: string;
    }>;
    for (const { id } of stored) {
      if (!diskIds.has(id)) {
        database.prepare("DELETE FROM chunks WHERE id = ?").run(id);
        database
          .prepare("DELETE FROM search_index WHERE kind = 'chunk' AND reference = ?")
          .run(id);
      }
    }
    for (const chunk of chunks) {
      upsertChunk(database, chunk);
    }
  } finally {
    database.close();
  }

  return chunks;
}

function pathspec(pattern: string): string {
  const normalized = pattern.replaceAll("\\", "/");
  return /[*?\[]/.test(normalized) ? `:(glob)${normalized}` : normalized;
}

function computeSourceHash(
  patterns: string[],
  projectRoot: string,
): string | undefined {
  if (patterns.length === 0) {
    return undefined;
  }

  const listed = spawnSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ...patterns.map(pathspec),
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (listed.status !== 0) {
    return undefined;
  }

  const files = listed.stdout
    .split("\0")
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    try {
      hash.update(readFileSync(resolve(projectRoot, file)));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        hash.update("<missing>");
      } else {
        throw error;
      }
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function isChunkStale(
  chunk: ChunkMetadata,
  projectRoot = process.cwd(),
): boolean {
  if (chunk.coversFiles.length === 0) {
    return false;
  }

  const patterns = chunk.coversFiles.map(pathspec);
  if (chunk.sourceHash) {
    return computeSourceHash(chunk.coversFiles, projectRoot) !== chunk.sourceHash;
  }

  // Older chunks without a source fingerprint use the timestamp fallback.
  const status = spawnSync("git", ["status", "--porcelain", "--", ...patterns], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (status.status === 0 && status.stdout.trim().length > 0) {
    return true;
  }

  const log = spawnSync(
    "git",
    ["log", "-1", "--format=%cI", "--", ...patterns],
    {
      cwd: projectRoot,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (log.status !== 0 || log.stdout.trim().length === 0) {
    return false;
  }

  return Date.parse(log.stdout.trim()) > Date.parse(chunk.updatedAt);
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function projectDescription(projectRoot: string): string {
  const packagePath = join(projectRoot, "package.json");
  if (existsSync(packagePath)) {
    try {
      const packageData = JSON.parse(readFileSync(packagePath, "utf8")) as {
        name?: unknown;
        description?: unknown;
      };
      const name =
        typeof packageData.name === "string" ? packageData.name : basename(projectRoot);
      const description =
        typeof packageData.description === "string"
          ? packageData.description
          : "Shared project context.";
      return `**${name}** — ${description}`;
    } catch {
      // A malformed package file should not prevent context initialization.
    }
  }
  return `**${basename(projectRoot)}** — Shared project context.`;
}

export function regenerateMap(projectRoot = process.cwd()): string {
  const paths = getShareLanePaths(projectRoot);
  const chunks = syncChunks(projectRoot);
  const rows = chunks.map((chunk) => {
    const covers =
      chunk.coversFiles.length > 0
        ? chunk.coversFiles.map((entry) => `\`${entry}\``).join(", ")
        : "Not set yet";
    const status = isChunkStale(chunk, projectRoot) ? "⚠ stale" : "current";
    return `| [${escapeTableCell(chunk.title)}](./${chunk.id}.md) | ${escapeTableCell(chunk.readWhen)} | ${escapeTableCell(covers)} | ${chunk.updatedAt} | ${status} |`;
  });
  const graph = chunks.map((chunk) => `  MAP --> ${chunk.id}`).join("\n");
  const output = [
    "# ShareLane context map",
    "",
    "> Generated from chunk headers. Edit a chunk through ShareLane instead of editing this index by hand.",
    "",
    "## Project",
    "",
    projectDescription(projectRoot),
    "",
    "## How to use this map",
    "",
    "Read only the chunks relevant to your task. After meaningful work, update the affected chunks so the next agent receives fresh context.",
    "",
    "## Context chunks",
    "",
    "| Chunk | Read this when… | Covers files | Updated at | Status |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    "## Context map",
    "",
    "```mermaid",
    "graph LR",
    "  MAP[MAP.md]",
    graph,
    "```",
    "",
  ].join("\n");

  writeAtomic(paths.map, output);
  return output;
}

export function initializeContext(
  projectRoot = process.cwd(),
): InitializeResult {
  const paths = getShareLanePaths(projectRoot);
  mkdirSync(paths.contextDir, { recursive: true });
  mkdirSync(paths.journalDir, { recursive: true });
  const createdChunks: string[] = [];

  for (const starter of STARTER_CHUNKS) {
    const filePath = chunkPath(starter.id, projectRoot);
    if (!existsSync(filePath)) {
      const chunk: Chunk = {
        ...starter,
        coversFiles: [],
        updatedAt: new Date().toISOString(),
        filePath,
        content: `# ${starter.title}\n\nNo shared context has been written here yet.`,
      };
      writeAtomic(filePath, formatChunk(chunk));
      createdChunks.push(starter.id);
    }
  }

  openDatabase(projectRoot).close();
  regenerateMap(projectRoot);
  return {
    createdChunks,
    mapPath: paths.map,
    databasePath: paths.database,
  };
}

export function readChunk(id: string, projectRoot = process.cwd()): string {
  initializeContext(projectRoot);
  const filePath = chunkPath(id, projectRoot);
  if (!existsSync(filePath)) {
    throw new Error(`Unknown context chunk: ${id}`);
  }
  return readFileSync(filePath, "utf8");
}

export function updateChunk(
  input: UpdateChunkInput,
  projectRoot = process.cwd(),
): Chunk {
  if (input.content.length > MAX_CHUNK_CHARACTERS) {
    throw new ChunkTooLargeError(input.content.length);
  }

  initializeContext(projectRoot);
  const id = validateChunkId(input.id);
  const filePath = chunkPath(id, projectRoot);
  const existing = existsSync(filePath)
    ? parseChunk(readFileSync(filePath, "utf8"), id, filePath)
    : undefined;
  const chunk: Chunk = {
    id,
    title: input.title?.trim() || existing?.title || id.replaceAll("-", " "),
    readWhen:
      input.readWhen?.trim() ||
      existing?.readWhen ||
      `You are working on ${id.replaceAll("-", " ")}.`,
    coversFiles: input.coversFiles ?? existing?.coversFiles ?? [],
    updatedAt: new Date().toISOString(),
    filePath,
    sourceHash: computeSourceHash(
      input.coversFiles ?? existing?.coversFiles ?? [],
      projectRoot,
    ),
    content: input.content,
  };

  writeAtomic(filePath, formatChunk(chunk));
  const database = openDatabase(projectRoot);
  try {
    upsertChunk(database, chunk);
  } finally {
    database.close();
  }
  regenerateMap(projectRoot);
  return chunk;
}

export function relativeContextPath(path: string, projectRoot: string): string {
  return relative(projectRoot, path).replaceAll("\\", "/");
}
