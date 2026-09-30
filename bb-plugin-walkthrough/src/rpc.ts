// The frontend RPC contract. app.tsx imports this module type-only, so the
// SDK runtime helper never reaches the browser bundle.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  locationSchema,
  noteKindSchema,
  noteSchema,
  noteStatusSchema,
  noteTextSchema,
  reviewEventSchema,
  walkthroughViewSchema,
} from "./schemas.ts";

const lineNumber = z.number().int().positive().max(10_000_000);
// ---------------------------------------------------------------------------

const threadIdSchema = z.string().min(1).max(256);
const noteIdSchema = z.string().min(1).max(64);

export const diffResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("available"),
      path: z.string(),
      patch: z.string(),
      truncated: z.boolean(),
      /** True when hunks outside the requested line range were dropped. */
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
  z
    .object({ outcome: z.literal("unavailable"), message: z.string() })
    .strict(),
]);
export type DiffResult = z.infer<typeof diffResultSchema>;

export const rpcContract = defineRpcContract({
  get: {
    input: z.object({ threadId: threadIdSchema }).strict(),
    output: z.object({ view: walkthroughViewSchema.nullable() }).strict(),
  },
  addNote: {
    input: z
      .object({
        threadId: threadIdSchema,
        kind: noteKindSchema,
        text: noteTextSchema,
        groupIndex: z.number().int().nonnegative().nullable().optional(),
        location: locationSchema.nullable().optional(),
        quote: z.string().max(8000).nullable().optional(),
      })
      .strict(),
    output: noteSchema,
  },
  updateNote: {
    input: z
      .object({
        threadId: threadIdSchema,
        noteId: noteIdSchema,
        kind: noteKindSchema.optional(),
        text: noteTextSchema.optional(),
        status: noteStatusSchema.optional(),
        resolution: z.string().max(8000).nullable().optional(),
      })
      .strict(),
    output: noteSchema,
  },
  deleteNote: {
    input: z.object({ threadId: threadIdSchema, noteId: noteIdSchema }).strict(),
    output: z.object({ deleted: z.boolean() }).strict(),
  },
  setNotesFileEnabled: {
    input: z.object({ threadId: threadIdSchema, enabled: z.boolean() }).strict(),
    output: z.object({ view: walkthroughViewSchema.nullable() }).strict(),
  },
  diff: {
    input: z
      .object({
        threadId: threadIdSchema,
        path: z.string().min(1).max(1024),
        startLine: lineNumber.optional(),
        endLine: lineNumber.optional(),
        withFullFile: z.boolean().optional(),
      })
      .strict(),
    output: diffResultSchema,
  },
  /** Reopens the pause controls the user dismissed or that timed out. */
  showPause: {
    input: z.object({ threadId: threadIdSchema }).strict(),
    output: z.object({ opened: z.boolean() }).strict(),
  },
  /** Sends the user's explicit request to post the draft review. */
  requestReviewPost: {
    input: z.object({ threadId: threadIdSchema, event: reviewEventSchema }).strict(),
    output: z.object({ sent: z.boolean() }).strict(),
  },
});
