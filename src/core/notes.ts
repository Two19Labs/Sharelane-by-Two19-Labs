import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const NO_NOTES_MESSAGE = "No shared notes yet.";

export function getNotesPath(projectRoot = process.cwd()): string {
  return join(projectRoot, ".sharelane", "notes.txt");
}

export async function appendNote(
  text: string,
  projectRoot = process.cwd(),
): Promise<void> {
  const notesPath = getNotesPath(projectRoot);
  await mkdir(dirname(notesPath), { recursive: true });
  await appendFile(notesPath, `${text}\n`, "utf8");
}

export async function readNotes(projectRoot = process.cwd()): Promise<string> {
  try {
    const contents = await readFile(getNotesPath(projectRoot), "utf8");
    return contents.trimEnd() || NO_NOTES_MESSAGE;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return NO_NOTES_MESSAGE;
    }

    throw error;
  }
}
