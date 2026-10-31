// Which notes a hand-off to the thread would carry. The message itself is
// prepared by the plugin (`prepareHandOff`), so what the reader edits is exactly
// what would have been sent.
import type { DeliveredNote as Note } from "../schemas.ts";

/** Open todos and questions not yet handed to the thread. */
export function unsentItems(notes: Note[]): Note[] {
  return notes.filter((note) => note.status === "open" && !note.sentAt && (note.kind === "todo" || note.kind === "question"));
}
