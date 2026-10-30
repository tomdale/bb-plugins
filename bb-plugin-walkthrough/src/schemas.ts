// Wire shapes shared by the server, the worker tools, and the pane.
//
// Everything that crosses a boundary (SQLite rows, RPC, tool arguments) is
// parsed with these schemas, because each can come back from persistence,
// the browser, or a model as untrusted JSON.
import { z } from "zod";

export const PANEL_ACTION_ID = "walkthrough";
/**
 * Path of the nav panel that shows a walkthrough as a full page:
 * `/plugins/<pluginId>/walkthroughs/<walkthroughId>`, and an index of recent
 * walkthroughs at the root.
 */
export const PAGE_PATH = "walkthroughs";
export const CHANGED_CHANNEL = "walkthrough-changed";
/**
 * Realtime channel carrying the worker's message text while a plan, part
 * write, or answer is in flight (see StreamPayload and src/stream-tail.ts).
 */
export const STREAM_CHANNEL = "walkthrough-stream";
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

/** How a code block reads: `code` explains how the code works, `diff` shows the change. */
export const codeViewSchema = z.enum(["diff", "code"]);
export type CodeView = z.infer<typeof codeViewSchema>;

/**
 * The excerpt text saved with a code block when its part is written, so the
 * pane never depends on live git. Each side is a context-only or single-file
 * patch; a side that does not exist (an added file has no "before") is null.
 */
export const codeSnapshotSchema = z
  .object({
    change: z.string().nullable(),
    after: z.string().nullable(),
    before: z.string().nullable(),
    baseSha: z.string().max(80).nullable(),
    headSha: z.string().max(80).nullable(),
    capturedAt: z.number(),
  })
  .strict();
export type CodeSnapshot = z.infer<typeof codeSnapshotSchema>;

const codeBlockFields = {
  kind: z.literal("code"),
  caption: z.string().trim().min(1).max(200),
  path: z.string().trim().min(1).max(1024),
  startLine: lineNumber,
  endLine: lineNumber,
  notes: z.array(marginNoteSchema).max(8).default([]),
};

/** A code block as the worker writes it: no snapshot, which the plugin captures. */
export const codeBlockInputSchema = z
  .object({ ...codeBlockFields, view: codeViewSchema.optional().describe("code to explain how this code works; diff (the default) when what changed is the point.") })
  .strict();

/**
 * A short excerpt of the change. Stored blocks tolerate older and damaged
 * rows: a bad `view` or `snapshot` falls back instead of failing the record,
 * and the store backfills the optional fields so readers always see them.
 */
export const codeBlockSchema = z
  .object({
    ...codeBlockFields,
    /** Absent in walkthroughs written before views existed; read as "diff". */
    view: codeViewSchema.optional().catch(undefined),
    /** Excerpt text captured when the part was written; null when capture failed, absent before snapshots existed. */
    snapshot: codeSnapshotSchema.nullable().optional().catch(null),
    /** A short, reader-safe reason the snapshot is null; never raw git output. */
    snapshotError: z.string().max(300).nullable().optional().catch(null),
  })
  .strict();

export const blockSchema = z.discriminatedUnion("kind", [proseBlockSchema, codeBlockSchema]);
export const blockInputSchema = z.discriminatedUnion("kind", [proseBlockSchema, codeBlockInputSchema]);
export type Block = z.infer<typeof blockSchema>;
export type BlockInput = z.infer<typeof blockInputSchema>;
export type CodeBlock = z.infer<typeof codeBlockSchema>;

export const exchangeSchema = z
  .object({
    id: z.string(),
    question: z.string(),
    answer: z.string(),
    status: z.enum(["queued", "answering", "done", "failed"]),
    askedAt: z.number(),
    /** Follow-up questions the worker offered with this answer; they replace the part's suggestions while this is the latest answer. */
    suggestions: z.array(z.string()).optional().catch(undefined),
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
    /** The workspace's code fingerprint when this part was written; see staleness.ts. */
    writtenAgainst: z.string().nullable().optional(),
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

/** An inline comment in a derived draft; `noteId` names the note it came from. */
export const derivedReviewCommentSchema = reviewCommentSchema.extend({ noteId: z.string().optional() }).strict();
export type DerivedReviewComment = z.infer<typeof derivedReviewCommentSchema>;

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

/** Why the reader is here; drives the wrap-up. */
export const intentSchema = z.enum(["review", "own-change", "understand"]);
export type Intent = z.infer<typeof intentSchema>;

/** The intent a walkthrough has when its planner did not choose one. */
export function defaultIntent(mode: Mode): Intent {
  return mode === "pr" ? "review" : "own-change";
}

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
    /** Absent in walkthroughs written before intents existed; the store backfills it from `mode`. */
    intent: intentSchema.optional().catch(undefined),
    baseRef: z.string(),
    includeUncommitted: z.boolean(),
    pr: z
      .object({ number: z.number().int().positive(), url: z.string().nullable(), title: z.string().nullable(), headRef: z.string().nullable().optional(), state: z.enum(["open", "merged", "closed"]).nullable().optional() })
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
    /** Retired: the `.agent/review-notes` mirror no longer exists. Old rows still carry it; new ones omit it. */
    notesFile: z
      .object({ enabled: z.boolean(), path: z.string().nullable(), written: z.boolean(), error: z.string().nullable() })
      .strict()
      .optional()
      .catch(undefined),
    review: reviewDraftSchema.nullable(),
    queue: z.array(requestSchema),
    inFlight: z
      .object({ request: requestSchema, sentAt: z.number(), afterSeq: z.number().int().nonnegative() })
      .strict()
      .nullable(),
    nextNoteNumber: z.number().int().positive(),
    nextExchangeNumber: z.number().int().positive(),
    /** Fingerprint of the workspace's diff the last time we looked; null in PR mode or when unknown. */
    codeFingerprint: z.string().nullable().optional(),
    /** Last event of the user's thread already considered; null for walkthroughs that predate tracking. */
    threadSeq: z.number().int().nonnegative().nullable().optional(),
    /** What the user told their thread since the helper last heard, to be passed on with its next request. */
    threadUpdates: z.array(z.string()).optional(),
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
    /** When the note was handed to the user's own thread; cleared when the note changes. */
    sentAt: z.number().nullable().optional(),
    /** Whether a comment note becomes an inline comment in the review draft; the store backfills comments as true, other kinds as false. */
    includeInReview: z.boolean().optional().catch(undefined),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();
export type Note = z.infer<typeof noteSchema>;

export const noteTextSchema = z.string().trim().min(1).max(8000);

/**
 * What the pane receives. The store backfills every field the stored schemas
 * leave optional for old rows, so a delivered block, part, walkthrough and note
 * always carries them; these shapes say so and the pane reads the fields
 * directly.
 */
const deliveredCodeBlockSchema = codeBlockSchema.extend({
  view: codeViewSchema,
  snapshot: codeSnapshotSchema.nullable(),
  snapshotError: z.string().nullable(),
});
const deliveredPartSchema = partSchema.extend({ blocks: z.array(z.discriminatedUnion("kind", [proseBlockSchema, deliveredCodeBlockSchema])) });
const deliveredWalkthroughSchema = walkthroughSchema.extend({
  intent: intentSchema,
  parts: z.array(deliveredPartSchema),
  wrapUp: deliveredPartSchema.nullable(),
});
const deliveredNoteSchema = noteSchema.extend({ includeInReview: z.boolean() });
export type DeliveredCodeBlock = z.infer<typeof deliveredCodeBlockSchema>;
export type DeliveredPart = z.infer<typeof deliveredPartSchema>;
export type DeliveredWalkthrough = z.infer<typeof deliveredWalkthroughSchema>;
export type DeliveredNote = z.infer<typeof deliveredNoteSchema>;

/** Everything the pane renders for one walkthrough. */
export const walkthroughViewSchema = z
  .object({
    walkthrough: deliveredWalkthroughSchema,
    notes: z.array(deliveredNoteSchema),
    /**
     * The review as the pane shows it in PR mode: the worker's draft merged with
     * the included comment notes. Null outside PR mode or when nothing is drafted.
     */
    reviewDraft: reviewDraftSchema
      .extend({ comments: z.array(derivedReviewCommentSchema).max(400) })
      .strict()
      .nullable(),
  })
  .strict();
export type WalkthroughView = z.infer<typeof walkthroughViewSchema>;

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/** What a stream payload belongs to. `place` is the part index (0 for the plan turn, which streams the introduction and part 1) or the wrap-up. */
export const streamRequestKindSchema = z.enum(["plan", "write", "ask"]);
export type StreamRequestKind = z.infer<typeof streamRequestKindSchema>;

/** streaming: more text may follow; done: the request settled normally; failed: it failed; cancelled: it was stopped or the helper went away. */
export const streamStateSchema = z.enum(["streaming", "done", "failed", "cancelled"]);
export type StreamState = z.infer<typeof streamStateSchema>;

/**
 * The full text of the worker's current message so far, on STREAM_CHANNEL and
 * from the `streamSnapshot` RPC. Stateless on purpose: a client replaces what
 * it holds for (walkthroughId, requestKind, place) whenever `seq` is higher,
 * or the state is terminal.
 */
export const streamPayloadSchema = z
  .object({
    walkthroughId: z.string(),
    requestKind: streamRequestKindSchema,
    place: placeSchema,
    /** Highest worker event consumed; non-decreasing per walkthrough. */
    seq: z.number().int().nonnegative(),
    text: z.string(),
    state: streamStateSchema,
  })
  .strict();
export type StreamPayload = z.infer<typeof streamPayloadSchema>;
