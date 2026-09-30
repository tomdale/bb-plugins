// The pane's RPC contract. app.tsx imports this module type-only, so the SDK
// runtime helper never reaches the browser bundle.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  locationSchema,
  noteKindSchema,
  noteSchema,
  noteStatusSchema,
  noteTextSchema,
  placeSchema,
  reviewEventSchema,
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
  })
  .strict();
export type WalkthroughSummary = z.infer<typeof walkthroughSummarySchema>;

export const rpcContract = defineRpcContract({
  list: {
    input: z.object({ threadId: threadIdSchema }).strict(),
    output: z.object({ walkthroughs: z.array(walkthroughSummarySchema) }).strict(),
  },
  get: {
    input: z.object(target).strict(),
    output: z.object({ view: walkthroughViewSchema.nullable() }).strict(),
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
  handOff: { input: z.object(target).strict(), output: z.object({ sent: z.boolean() }).strict() },
  addNote: {
    input: z
      .object({
        ...target,
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
        ...target,
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
    input: z.object({ ...target, noteId: noteIdSchema }).strict(),
    output: z.object({ deleted: z.boolean() }).strict(),
  },
  setNotesFileEnabled: {
    input: z.object({ ...target, enabled: z.boolean() }).strict(),
    output: ok,
  },
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
  requestReviewPost: {
    input: z.object({ ...target, event: reviewEventSchema }).strict(),
    output: ok,
  },
});
