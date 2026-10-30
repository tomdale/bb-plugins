// "Save notes": the open notes as a Markdown file in the walkthrough thread's
// own storage. That directory belongs to the thread, outside the repository,
// so a saved file never shows up as untracked work and needs no .gitignore;
// the thread's agent can read it and the pane links to it. Saving again
// replaces the same file.
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { formatLocation, NOTE_KIND_LABEL, NOTE_SECTIONS } from "./model.ts";
import type { Note, Walkthrough } from "./schemas.ts";

export const savedNotesSchema = z.object({ threadId: z.string(), path: z.string(), absolutePath: z.string(), notes: z.number().int().nonnegative() }).strict();
export type SavedNotes = z.infer<typeof savedNotesSchema>;

/** The directory in thread storage that holds saved notes. */
export const NOTES_DIRECTORY = "walkthrough-notes";

export function notesMarkdown(walkthrough: Pick<Walkthrough, "title" | "parts">, notes: Note[]): string {
  const lines = [`# ${walkthrough.title}`, ""];
  const open = NOTE_SECTIONS.flatMap((section) => notes.filter((note) => note.kind === section.kind && note.status === "open"));
  for (const note of open) {
    const part = note.groupIndex === null ? null : (walkthrough.parts[note.groupIndex]?.title ?? null);
    const where = [part, formatLocation(note.location)].filter(Boolean).join(" · ");
    lines.push(`- **${NOTE_KIND_LABEL[note.kind]}**${where ? ` (${where})` : ""}: ${note.text.replace(/\n+/gu, " ")}`);
    if (note.quote) lines.push(`  > ${note.quote.replace(/\n+/gu, " ").slice(0, 300)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** A file name from the title; the id keeps two walkthroughs with one title apart. */
export function notesFileName(walkthrough: Pick<Walkthrough, "id" | "title">): string {
  const slug = walkthrough.title.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40);
  return `${slug || "walkthrough"}-${walkthrough.id.replace(/^wt_/u, "")}.md`;
}

export async function saveNotes(sdk: Pick<BbPluginApi["sdk"], "threads" | "files">, walkthrough: Walkthrough, notes: Note[]): Promise<SavedNotes> {
  const open = notes.filter((note) => note.status === "open");
  const location = await sdk.threads.storageLocation({ threadId: walkthrough.threadId });
  const path = `${NOTES_DIRECTORY}/${notesFileName(walkthrough)}`;
  const absolutePath = `${location.storageRootPath.replace(/\/+$/u, "")}/${path}`;
  await sdk.files.write({ hostId: location.hostId, path: absolutePath, content: notesMarkdown(walkthrough, notes), createParents: true });
  return { threadId: walkthrough.threadId, path, absolutePath, notes: open.length };
}
