import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  initializeContext,
  regenerateMap,
  syncChunks,
} from "./context.js";
import { getShareLanePaths, openDatabase } from "./database.js";

export interface SearchResult {
  kind: "chunk" | "journal";
  reference: string;
  title: string;
  snippet: string;
  rank: number;
}

export interface ProgressEntry {
  id: number;
  task: string;
  note: string;
  agent: string;
  createdAt: string;
}

function ftsQuery(query: string): string {
  const terms = query.normalize("NFKC").match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (terms.length === 0) {
    throw new Error("Search query must contain at least one word or number.");
  }

  return terms
    .map((term) => `"${term.replaceAll('"', '""')}"*`)
    .join(" AND ");
}

export function contextMap(projectRoot = process.cwd()): string {
  initializeContext(projectRoot);
  return regenerateMap(projectRoot);
}

export function searchMemory(
  query: string,
  limit = 10,
  projectRoot = process.cwd(),
): SearchResult[] {
  initializeContext(projectRoot);
  // Pick up valid changes made directly to a Markdown chunk before searching.
  syncChunks(projectRoot);
  const database = openDatabase(projectRoot);

  try {
    return database
      .prepare(
        `SELECT
          kind,
          reference,
          title,
          snippet(search_index, 3, '[', ']', ' … ', 18) AS snippet,
          bm25(search_index) AS rank
         FROM search_index
         WHERE search_index MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(
        ftsQuery(query),
        Math.max(1, Math.min(20, limit)),
      ) as unknown as SearchResult[];
  } finally {
    database.close();
  }
}

export function logProgress(
  task: string,
  note: string,
  agent = process.env.SHARELANE_AGENT?.trim() || "unknown",
  projectRoot = process.cwd(),
): ProgressEntry {
  const cleanTask = task.trim();
  const cleanNote = note.trim();
  if (!cleanTask || !cleanNote) {
    throw new Error("Task and progress note must not be empty.");
  }

  initializeContext(projectRoot);
  const createdAt = new Date().toISOString();
  const database = openDatabase(projectRoot);
  let id: number;

  database.exec("BEGIN IMMEDIATE;");
  try {
    const result = database
      .prepare(
        "INSERT INTO journal (task, note, agent, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(cleanTask, cleanNote, agent, createdAt);
    id = Number(result.lastInsertRowid);
    database
      .prepare(
        "INSERT INTO search_index (kind, reference, title, body) VALUES ('journal', ?, ?, ?)",
      )
      .run(`journal/${id}`, `Progress: ${cleanTask}`, cleanNote);
    database.exec("COMMIT;");
  } catch (error: unknown) {
    database.exec("ROLLBACK;");
    throw error;
  } finally {
    database.close();
  }

  const paths = getShareLanePaths(projectRoot);
  mkdirSync(paths.journalDir, { recursive: true });
  const day = createdAt.slice(0, 10);
  appendFileSync(
    join(paths.journalDir, `${day}.md`),
    `- ${createdAt} — **${agent}** — **${cleanTask}**: ${cleanNote.replaceAll("\n", " ")}\n`,
    "utf8",
  );

  return { id, task: cleanTask, note: cleanNote, agent, createdAt };
}
