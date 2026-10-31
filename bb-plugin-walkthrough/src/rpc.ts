// The pane's RPC contract. app.tsx imports this module type-only, so the SDK
// runtime helper never reaches the browser bundle.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { savedNotesSchema } from "./save-notes.ts";
import { detectedTargetSchema } from "./detect-target.ts";
import {
  locationSchema,
  noteKindSchema,
  noteSchema,
  noteStatusSchema,
  noteTextSchema,
  placeSchema,
  reviewEventSchema,
  streamPayloadSchema,
  walkthroughStatusSchema,
  walkthroughViewSchema,
} from "./schemas.ts";

const lineNumber = z.number().int().positive().max(10_000_000);
const threadIdSchema = z.string().min(1).max(256);
const walkthroughIdSchema = z.string().min(1).max(64);
const noteIdSchema = z.string().min(1).max(64);
const target = { walkthroughId: walkthroughIdSchema };
const ok = z.object({ ok: z.literal(true) }).strict();

export const diffResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("available"),
      path: z.string(),
      patch: z.string(),
      truncated: z.boolean(),
      /** True when hunks or lines outside the requested range were dropped. */
      filtered: z.boolean(),
      fullFileContents: z
        .object({
          old: z.object({ path: z.string(), content: z.string() }).strict(),
          new: z.object({ path: z.string(), content: z.string() }).strict(),
        })
        .strict()
        .nullable(),
    })
    .strict(),
  z.object({ outcome: z.literal("unavailable"), message: z.string() }).strict(),
]);
export type DiffResult = z.infer<typeof diffResultSchema>;

/** A code excerpt as three single-file patches; null when a view is unavailable. */
export const excerptResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("available"),
      path: z.string(),
      change: z.string().nullable(),
      after: z.string().nullable(),
      before: z.string().nullable(),
    })
    .strict(),
  z.object({ outcome: z.literal("unavailable"), message: z.string() }).strict(),
]);
export type ExcerptResult = z.infer<typeof excerptResultSchema>;

export const walkthroughSummarySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    request: z.string(),
    status: walkthroughStatusSchema,
    partCount: z.number().int().nonnegative(),
    currentPart: z.number().int().nonnegative().nullable(),
    openNotes: z.number().int().nonnegative(),
    createdAt: z.number(),
    /** When the walkthrough last changed: a client arriving later opens only walkthroughs that are still live. */
    updatedAt: z.number().optional(),
  })
  .strict();
export type WalkthroughSummary = z.infer<typeof walkthroughSummarySchema>;

export const rpcContract = defineRpcContract({
  list: {
    input: z.object({ threadId: threadIdSchema }).strict(),
    output: z.object({ walkthroughs: z.array(walkthroughSummarySchema) }).strict(),
  },
  recent: {
    input: z.object({}).strict(),
    output: z.object({ walkthroughs: z.array(walkthroughSummarySchema) }).strict(),
  },
  get: {
    input: z.object(target).strict(),
    output: z.object({ view: walkthroughViewSchema.nullable() }).strict(),
  },
  /** What a manual start would cover in the thread's workspace; null when there is nothing to walk through. */
  detectTarget: {
    input: z.object({ threadId: threadIdSchema }).strict(),
    output: z.object({ target: detectedTargetSchema }).strict(),
  },
  start: {
    input: z.object({ threadId: threadIdSchema, request: z.string().trim().max(4000) }).strict(),
    output: z.object({ walkthroughId: z.string() }).strict(),
  },
  openPart: {
    input: z.object({ ...target, index: z.number().int().nonnegative().nullable() }).strict(),
    output: ok,
  },
  ask: {
    input: z.object({ ...target, place: placeSchema, question: noteTextSchema }).strict(),
    output: ok,
  },
  reply: {
    input: z.object({ ...target, text: noteTextSchema }).strict(),
    output: ok,
  },
  retry: {
    input: z.object({ ...target, place: placeSchema }).strict(),
    output: ok,
  },
  wrapUp: { input: z.object(target).strict(), output: ok },
  close: { input: z.object(target).strict(), output: ok },
  /**
   * Removes the walkthrough with its notes and exchanges, cancels any request
   * the helper is writing, and archives the helper thread. Notes saved to the
   * thread's storage stay. `deleted` is false when it was already gone.
   */
  delete: { input: z.object(target).strict(), output: z.object({ deleted: z.boolean() }).strict() },
  /**
   * The message "send open items to the thread" (and "ask the thread to apply
   * it") would send, and the notes it covers. Sends nothing; null when no todo
   * or question is waiting. The pane shows it in an editable field.
   */
  prepareHandOff: {
    input: z.object(target).strict(),
    output: z.object({ draft: z.object({ message: z.string(), noteIds: z.array(noteIdSchema) }).strict().nullable() }).strict(),
  },
  /**
   * Sends a message to the user's own thread: the one action that does. Call it
   * only from an explicit Send in the pane, with the text the reader saw
   * (`prepareHandOff`'s, possibly edited) and the `noteIds` it came with. Without
   * `message` it sends the prepared text, which only the pane's explicit Send may
   * trigger. `sent` is false when there was nothing to send.
   */
  handOff: {
    input: z.object({ ...target, message: z.string().trim().min(1).max(20_000).optional(), noteIds: z.array(noteIdSchema).max(200).optional() }).strict(),
    output: z.object({ sent: z.boolean() }).strict(),
  },
  addNote: {
    input: z
      .object({
        ...target,
        kind: noteKindSchema,
        text: noteTextSchema,
        groupIndex: z.number().int().nonnegative().nullable().optional(),
        location: locationSchema.nullable().optional(),
        quote: z.string().max(8000).nullable().optional(),
        includeInReview: z.boolean().optional(),
      })
      .strict(),
    output: noteSchema,
  },
  updateNote: {
    input: z
      .object({
        ...target,
        noteId: noteIdSchema,
        kind: noteKindSchema.optional(),
        text: noteTextSchema.optional(),
        status: noteStatusSchema.optional(),
        resolution: z.string().max(8000).nullable().optional(),
        includeInReview: z.boolean().optional(),
      })
      .strict(),
    output: noteSchema,
  },
  /** Accepts the helper's proposed outcome for a note: the note resolves with it. Errors when there is no proposal. */
  acceptResolution: {
    input: z.object({ ...target, noteId: noteIdSchema }).strict(),
    output: noteSchema,
  },
  /** Dismisses the helper's proposed outcome; the note stays open and unchanged. */
  dismissResolution: {
    input: z.object({ ...target, noteId: noteIdSchema }).strict(),
    output: noteSchema,
  },
  deleteNote: {
    input: z.object({ ...target, noteId: noteIdSchema }).strict(),
    output: z.object({ deleted: z.boolean() }).strict(),
  },
  /** Writes the open notes as Markdown into the walkthrough thread's storage. */
  saveNotes: { input: z.object(target).strict(), output: savedNotesSchema },
  diff: {
    input: z
      .object({
        ...target,
        path: z.string().min(1).max(1024),
        startLine: lineNumber.optional(),
        endLine: lineNumber.optional(),
        withFullFile: z.boolean().optional(),
      })
      .strict(),
    output: diffResultSchema,
  },
  excerpt: {
    input: z.object({ ...target, path: z.string().min(1).max(1024), startLine: lineNumber, endLine: lineNumber }).strict(),
    output: excerptResultSchema,
  },
  /** The in-flight request's message text so far, for a client that joined mid-stream; null when nothing is streaming. */
  streamSnapshot: {
    input: z.object(target).strict(),
    output: z.object({ snapshot: streamPayloadSchema.nullable() }).strict(),
  },
  requestReviewPost: {
    input: z.object({ ...target, event: reviewEventSchema }).strict(),
    output: ok,
  },
});
