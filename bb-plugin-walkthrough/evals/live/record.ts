// The walkthrough record, read the way the pane reads it: straight from the
// plugin's SQLite file. A live run reports the plugin's own timing and parts
// instead of inferring them, and reads only — the one write is removing the
// record the run itself created, so repeated runs do not fill the pane's list
// of recent walkthroughs with scratch threads.
import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";

export const DATA_DB = join(homedir(), ".bb", "plugins", "walkthrough", "data.db");

export interface WalkthroughRecord {
  id: string;
  threadId: string;
  status: string;
  workerThreadId: string | null;
  /** Milliseconds after the walkthrough was created at which each first-paint stage was reached. */
  timing: Record<string, number>;
  parts: Array<{ title: string; status: string }>;
  inFlight: unknown | null;
  queue: unknown[];
  message: string | null;
}

let database: Database.Database | null = null;

function db(): Database.Database {
  database ??= new Database(DATA_DB, { readonly: true, fileMustExist: true });
  return database;
}

export function closeDatabase(): void {
  database?.close();
  database = null;
}

/**
 * Removes a record a run created, and its notes, so the eval leaves nothing in
 * the pane's recent list. Scoped to the thread and id the run observed, so it
 * cannot touch a walkthrough the run did not make.
 */
export function removeWalkthrough(walkthroughId: string, threadId: string): boolean {
  const write = new Database(DATA_DB, { fileMustExist: true });
  try {
    write.prepare("delete from notes where walkthrough_id = ?").run(walkthroughId);
    return write.prepare("delete from walkthroughs_v2 where id = ? and thread_id = ?").run(walkthroughId, threadId).changes > 0;
  } finally {
    write.close();
  }
}

/** The newest walkthrough the given thread opened, or null while the thread has not opened one. */
export function walkthroughForThread(threadId: string): WalkthroughRecord | null {
  const row = db().prepare("select data from walkthroughs_v2 where thread_id = ? order by created_at desc limit 1").get(threadId) as { data: string } | undefined;
  if (row === undefined) return null;
  const saved = JSON.parse(row.data) as Partial<WalkthroughRecord>;
  return {
    id: saved.id ?? "",
    threadId: saved.threadId ?? threadId,
    status: saved.status ?? "unknown",
    workerThreadId: saved.workerThreadId ?? null,
    timing: saved.timing ?? {},
    parts: saved.parts ?? [],
    inFlight: saved.inFlight ?? null,
    queue: saved.queue ?? [],
    message: saved.message ?? null,
  };
}
