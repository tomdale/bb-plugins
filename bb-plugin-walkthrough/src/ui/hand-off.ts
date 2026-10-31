// The message "Ask the thread to apply it" prefills. It is the text the
// plugin sends when handOff is called without one, so a reader who sends it
// unedited changes nothing about what the thread receives.
import { describeNoteForAgent } from "../model.ts";
import type { DeliveredNote as Note, DeliveredWalkthrough as Walkthrough } from "../schemas.ts";

/** Open todos and questions not yet handed to the thread. */
export function unsentItems(notes: Note[]): Note[] {
  return notes.filter((note) => note.status === "open" && !note.sentAt && (note.kind === "todo" || note.kind === "question"));
}

export function handOffMessage(walkthrough: Walkthrough, notes: Note[]): string {
  const subject = walkthrough.pr ? `PR #${walkthrough.pr.number}${walkthrough.pr.url ? ` (${walkthrough.pr.url})` : ""}` : walkthrough.title;
  const lines = unsentItems(notes).map((note) => describeNoteForAgent(walkthrough, note));
  return `From my walkthrough of ${subject}. These are notes I recorded while reading; act on the todos and answer the questions here, in this thread:\n\n${lines.join("\n")}`;
}
