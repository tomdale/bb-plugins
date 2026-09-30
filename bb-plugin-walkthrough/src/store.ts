// SQLite persistence for walkthroughs and their notes.
//
// Rows keep the full JSON document plus the few columns queries need. Reads
// re-parse with the shared schemas so a malformed row surfaces as an error
// instead of flowing into the UI or the agent. better-sqlite3 is synchronous,
// which lets the instruction contributor read state without awaiting.
import type Database from "better-sqlite3";
import { noteSchema, walkthroughSchema, type Note, type Walkthrough } from "./schemas.ts";

export const MIGRATIONS = [
  `CREATE TABLE walkthroughs (
     id TEXT PRIMARY KEY,
     thread_id TEXT NOT NULL,
     status TEXT NOT NULL,
     data TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX walkthroughs_by_thread ON walkthroughs (thread_id, created_at)`,
  `CREATE TABLE notes (
     id TEXT NOT NULL,
     walkthrough_id TEXT NOT NULL,
     data TEXT NOT NULL,
     reported INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (walkthrough_id, id)
   )`,
];

export class WalkthroughStore {
  constructor(private readonly db: Database.Database) {}

  /** The thread's newest walkthrough, finished or not. */
  latestForThread(threadId: string): Walkthrough | null {
    const row = this.db
      .prepare(`SELECT data FROM walkthroughs WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(threadId) as { data: string } | undefined;
    return row ? walkthroughSchema.parse(JSON.parse(row.data)) : null;
  }

  /** The thread's walkthrough that has not finished, if any. */
  activeForThread(threadId: string): Walkthrough | null {
    const latest = this.latestForThread(threadId);
    return latest && latest.status !== "finished" ? latest : null;
  }

  get(id: string): Walkthrough | null {
    const row = this.db.prepare(`SELECT data FROM walkthroughs WHERE id = ?`).get(id) as
      | { data: string }
      | undefined;
    return row ? walkthroughSchema.parse(JSON.parse(row.data)) : null;
  }

  save(walkthrough: Walkthrough): void {
    const data = JSON.stringify(walkthroughSchema.parse(walkthrough));
    this.db
      .prepare(
        `INSERT INTO walkthroughs (id, thread_id, status, data, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data`,
      )
      .run(walkthrough.id, walkthrough.threadId, walkthrough.status, data, walkthrough.createdAt);
  }

  notes(walkthroughId: string): Note[] {
    const rows = this.db
      .prepare(`SELECT data FROM notes WHERE walkthrough_id = ? ORDER BY created_at, rowid`)
      .all(walkthroughId) as Array<{ data: string }>;
    return rows.map((row) => noteSchema.parse(JSON.parse(row.data)));
  }

  note(walkthroughId: string, id: string): Note | null {
    const row = this.db.prepare(`SELECT data FROM notes WHERE walkthrough_id = ? AND id = ?`).get(walkthroughId, id) as
      | { data: string }
      | undefined;
    return row ? noteSchema.parse(JSON.parse(row.data)) : null;
  }

  /**
   * Inserts or replaces a note. `reported` records whether the agent has
   * seen the note's current form; user edits reset it so the change reaches
   * the agent with its next walkthrough tool result.
   */
  saveNote(note: Note, reported: boolean): void {
    const data = JSON.stringify(noteSchema.parse(note));
    this.db
      .prepare(
        `INSERT INTO notes (id, walkthrough_id, data, reported, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(walkthrough_id, id) DO UPDATE SET data = excluded.data, reported = excluded.reported`,
      )
      .run(note.id, note.walkthroughId, data, reported ? 1 : 0, note.createdAt);
  }

  deleteNote(walkthroughId: string, id: string): boolean {
    return this.db.prepare(`DELETE FROM notes WHERE walkthrough_id = ? AND id = ?`).run(walkthroughId, id).changes > 0;
  }

  /** Returns notes the agent has not seen yet and marks them seen. */
  takeUnreported(walkthroughId: string): Note[] {
    const take = this.db.transaction((id: string) => {
      const rows = this.db
        .prepare(`SELECT data FROM notes WHERE walkthrough_id = ? AND reported = 0 ORDER BY created_at, rowid`)
        .all(id) as Array<{ data: string }>;
      this.db.prepare(`UPDATE notes SET reported = 1 WHERE walkthrough_id = ? AND reported = 0`).run(id);
      return rows.map((row) => noteSchema.parse(JSON.parse(row.data)));
    });
    return take(walkthroughId);
  }

  markAllReported(walkthroughId: string): void {
    this.db.prepare(`UPDATE notes SET reported = 1 WHERE walkthrough_id = ?`).run(walkthroughId);
  }
}
