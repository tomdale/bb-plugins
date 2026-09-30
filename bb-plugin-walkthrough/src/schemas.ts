// Wire shapes shared by the server, the worker tools, and the pane.
//
// Everything that crosses a boundary (SQLite rows, RPC, tool arguments) is
// parsed with these schemas, because each can come back from persistence,
// the browser, or a model as untrusted JSON.
import { z } from "zod";

export const PANEL_ACTION_ID = "walkthrough";
export const CHANGED_CHANNEL = "walkthrough-changed";
/** pluginMetadata marker on the hidden thread that writes a walkthrough. */
export const WORKER_ROLE = "walkthrough-worker";

export const modeSchema = z.enum(["local", "pr"]);
export type Mode = z.infer<typeof modeSchema>;

const lineNumber = z.number().int().positive().max(10_000_000);

/** A path in the reviewed change, relative to the workspace root. */
export const locationSchema = z
  .object({
    path: z.string().trim().min(1).max(1024),
    startLine: lineNumber.optional(),
    endLine: lineNumber.optional(),
  })
  .strict();
export type Location = z.infer<typeof locationSchema>;

// ---------------------------------------------------------------------------
// Reading content
// ---------------------------------------------------------------------------

/**
 * Prose is Markdown. Links of the form `[phrase](line:40)` or
 * `[phrase](line:40-52)` point at lines of the code excerpt that follows,
 * and `[phrase](path/to/file.ts#L40-52)` points at any file in the change.
 */
export const proseBlockSchema = z.object({ kind: z.literal("prose"), text: z.string().trim().min(1).max(20_000) }).strict();

export const marginNoteSchema = z
  .object({ line: lineNumber.optional(), text: z.string().trim().min(1).max(1000) })
  .strict();

/** A short excerpt of the change, rendered as change / after / before. */
export const codeBlockSchema = z
  .object({
    kind: z.literal("code"),
    caption: z.string().trim().min(1).max(200),
    path: z.string().trim().min(1).max(1024),
    startLine: lineNumber,
    endLine: lineNumber,
    notes: z.array(marginNoteSchema).max(8).default([]),
  })
  .strict();

export const blockSchema = z.discriminatedUnion("kind", [proseBlockSchema, codeBlockSchema]);
export type Block = z.infer<typeof blockSchema>;
export type CodeBlock = z.infer<typeof codeBlockSchema>;

export const exchangeSchema = z
  .object({
    id: z.string(),
    question: z.string(),
    answer: z.string(),
    status: z.enum(["queued", "answering", "done", "failed"]),
    askedAt: z.number(),
  })
  .strict();
export type Exchange = z.infer<typeof exchangeSchema>;

export const partStatusSchema = z.enum(["pending", "writing", "ready", "failed"]);

export const partSchema = z
  .object({
    title: z.string(),
    summary: z.string(),
    locations: z.array(locationSchema),
    status: partStatusSchema,
    blocks: z.array(blockSchema),
    /** Prompts in the user's voice shown above the question box. */
    suggestions: z.array(z.string()),
    /** Worker text when writing failed or it needs the user's input. */
    message: z.string().nullable(),
    discussion: z.array(exchangeSchema),
  })
  .strict();
export type Part = z.infer<typeof partSchema>;

// ---------------------------------------------------------------------------
// Review draft
// ---------------------------------------------------------------------------

export const reviewEventSchema = z.enum(["COMMENT", "REQUEST_CHANGES", "APPROVE"]);
export type ReviewEvent = z.infer<typeof reviewEventSchema>;

export const reviewCommentSchema = z
  .object({
    path: z.string().trim().min(1).max(1024),
    line: lineNumber,
    startLine: lineNumber.optional(),
    side: z.enum(["RIGHT", "LEFT"]).default("RIGHT"),
    body: z.string().trim().min(1).max(20_000),
  })
  .strict();
export type ReviewComment = z.infer<typeof reviewCommentSchema>;

export const reviewDraftSchema = z
  .object({
    body: z.string().max(60_000),
    event: reviewEventSchema,
    comments: z.array(reviewCommentSchema).max(200),
    status: z.enum(["draft", "posted"]),
    url: z.string().max(2048).nullable(),
    updatedAt: z.number(),
  })
  .strict();
export type ReviewDraft = z.infer<typeof reviewDraftSchema>;

// ---------------------------------------------------------------------------
// Worker requests
// ---------------------------------------------------------------------------

/** Where a question belongs: a part index, or the wrap-up. */
export const placeSchema = z.union([z.number().int().nonnegative(), z.literal("wrap-up")]);
export type Place = z.infer<typeof placeSchema>;

/** One unit of work the plugin hands the worker; sent one at a time. */
export const requestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plan") }).strict(),
  z.object({ kind: z.literal("write"), part: z.number().int().nonnegative() }).strict(),
  z
    .object({
      kind: z.literal("ask"),
      place: placeSchema,
      exchangeId: z.string(),
      /** Replaces the question as the text the worker receives. */
      instruction: z.string().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("reply"), text: z.string() }).strict(),
  z.object({ kind: z.literal("wrap-up") }).strict(),
]);
export type WorkerRequest = z.infer<typeof requestSchema>;

export const walkthroughStatusSchema = z.enum(["planning", "reading", "wrapping-up", "done", "failed"]);
export type WalkthroughStatus = z.infer<typeof walkthroughStatusSchema>;

export const walkthroughSchema = z
  .object({
    id: z.string(),
    /** The user's thread; the pane opens in its side panel. */
    threadId: z.string(),
    workerThreadId: z.string().nullable(),
    /** What the user asked to be walked through. */
    request: z.string(),
    status: walkthroughStatusSchema,
    /** A worker message the user needs to see (a question, or why planning stopped). */
    message: z.string().nullable(),
    title: z.string(),
    mode: modeSchema,
    baseRef: z.string(),
    includeUncommitted: z.boolean(),
    pr: z
      .object({ number: z.number().int().positive(), url: z.string().nullable(), title: z.string().nullable() })
      .strict()
      .nullable(),
    /** Prose (Markdown) shown before the first part. */
    introduction: z.string(),
    parts: z.array(partSchema),
    /** The part on screen; null shows the introduction. */
    currentPart: z.number().int().nonnegative().nullable(),
    wrapUp: partSchema.nullable(),
    environmentId: z.string().nullable(),
    hostId: z.string().nullable(),
    workspacePath: z.string().nullable(),
    notesFile: z
      .object({ enabled: z.boolean(), path: z.string().nullable(), written: z.boolean(), error: z.string().nullable() })
      .strict(),
    review: reviewDraftSchema.nullable(),
    queue: z.array(requestSchema),
    inFlight: z
      .object({ request: requestSchema, sentAt: z.number(), afterSeq: z.number().int().nonnegative() })
      .strict()
      .nullable(),
    nextNoteNumber: z.number().int().positive(),
    nextExchangeNumber: z.number().int().positive(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();
export type Walkthrough = z.infer<typeof walkthroughSchema>;

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export const noteKindSchema = z.enum(["question", "todo", "comment", "note"]);
export type NoteKind = z.infer<typeof noteKindSchema>;
export const noteStatusSchema = z.enum(["open", "resolved"]);
export type NoteStatus = z.infer<typeof noteStatusSchema>;

export const noteSchema = z
  .object({
    id: z.string(),
    walkthroughId: z.string(),
    kind: noteKindSchema,
    text: z.string(),
    /** Part index the note belongs to; null for the whole walkthrough. */
    groupIndex: z.number().int().nonnegative().nullable(),
    location: locationSchema.nullable(),
    quote: z.string().nullable(),
    status: noteStatusSchema,
    resolution: z.string().nullable(),
    author: z.enum(["user", "agent"]),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();
export type Note = z.infer<typeof noteSchema>;

export const noteTextSchema = z.string().trim().min(1).max(8000);

/** Everything the pane renders for one walkthrough. */
export const walkthroughViewSchema = z
  .object({
    walkthrough: walkthroughSchema,
    notes: z.array(noteSchema),
  })
  .strict();
export type WalkthroughView = z.infer<typeof walkthroughViewSchema>;
