import { openDatabase } from "./database.js";

export interface ShareLaneNotice {
  id: number;
  kind: string;
  message: string;
  createdAt: string;
  recipientAgent?: string;
  taskId?: string;
}

interface NoticeRow {
  id: number;
  kind: string;
  message: string;
  created_at: string;
  recipient_agent: string | null;
  task_id: string | null;
}

function fromRow(row: NoticeRow): ShareLaneNotice {
  return {
    id: row.id,
    kind: row.kind,
    message: row.message,
    createdAt: row.created_at,
    recipientAgent: row.recipient_agent ?? undefined,
    taskId: row.task_id ?? undefined,
  };
}

export function createNotice(input: {
  kind: string;
  message: string;
  projectRoot?: string;
  recipientAgent?: string;
  taskId?: string;
}): ShareLaneNotice {
  const projectRoot = input.projectRoot ?? process.cwd();
  const createdAt = new Date().toISOString();
  const database = openDatabase(projectRoot);
  try {
    const result = database
      .prepare(
        `INSERT INTO notices (
          recipient_agent, task_id, kind, message, created_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.recipientAgent ?? null,
        input.taskId ?? null,
        input.kind,
        input.message,
        createdAt,
      );
    return {
      id: Number(result.lastInsertRowid),
      kind: input.kind,
      message: input.message,
      createdAt,
      recipientAgent: input.recipientAgent,
      taskId: input.taskId,
    };
  } finally {
    database.close();
  }
}

export function takePendingNotices(input: {
  projectRoot?: string;
  agent?: string;
  taskId?: string;
  relatedTaskId?: string;
}): ShareLaneNotice[] {
  const projectRoot = input.projectRoot ?? process.cwd();
  const agent = input.agent?.trim() || "unknown";
  const taskIds = [
    ...new Set(
      [input.taskId, input.relatedTaskId].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  ];
  const taskClause = taskIds.length
    ? ` OR task_id IN (${taskIds.map(() => "?").join(", ")})`
    : "";
  const database = openDatabase(projectRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    const rows = database
      .prepare(
        `SELECT id, kind, message, created_at, recipient_agent, task_id
         FROM notices
         WHERE delivered_at IS NULL
           AND ((recipient_agent = ? AND task_id IS NULL)
             OR task_id = ?${taskClause})
         ORDER BY id
         LIMIT 20`,
      )
      .all(agent, input.taskId ?? "", ...taskIds) as unknown as NoticeRow[];
    if (rows.length > 0) {
      const placeholders = rows.map(() => "?").join(", ");
      database
        .prepare(
          `UPDATE notices SET delivered_at = ? WHERE id IN (${placeholders})`,
        )
        .run(new Date().toISOString(), ...rows.map((row) => row.id));
    }
    database.exec("COMMIT");
    return rows.map(fromRow);
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original error.
    }
    throw error;
  } finally {
    database.close();
  }
}

export function listTaskNotices(
  taskId: string,
  projectRoot = process.cwd(),
): ShareLaneNotice[] {
  const database = openDatabase(projectRoot);
  try {
    const rows = database
      .prepare(
        `SELECT id, kind, message, created_at, recipient_agent, task_id
         FROM notices WHERE task_id = ? ORDER BY id`,
      )
      .all(taskId) as unknown as NoticeRow[];
    return rows.map(fromRow);
  } finally {
    database.close();
  }
}
