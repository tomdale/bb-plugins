// Turns the worker's finished streamed message into what the write tools
// commit, so the worker says a part once, in the message the reader already
// watches, instead of saying it again as tool arguments. The markup is the one
// stream-markup.ts parses for the live preview; here the same blocks become
// schema-checked block inputs.
import { blockInputSchema, type BlockInput } from "./schemas.ts";
import { parseStreamMarkup, type StreamBlock } from "./stream-markup.ts";

export interface CommittedMessage {
  /** Prose before the `part:` fence, joined as Markdown; empty when the message has no introduction. */
  introduction: string;
  /** The part's blocks: the content after the `part:` fence, or the whole message when there is none. */
  blocks: BlockInput[];
  suggestions: string[];
  /** Why each block that could not be kept was dropped, for the worker. */
  dropped: string[];
}

function toInput(block: StreamBlock, dropped: string[]): BlockInput | null {
  if (block.kind === "prose") {
    const parsed = blockInputSchema.safeParse({ kind: "prose", text: block.text });
    if (!parsed.success) dropped.push("a prose block was empty or too long");
    return parsed.success ? parsed.data : null;
  }
  if (block.kind !== "figure") return null;
  if (block.path === null || block.startLine === null || block.endLine === null) {
    dropped.push(`a code block${block.path ? ` for ${block.path}` : ""} had no path or lines`);
    return null;
  }
  const parsed = blockInputSchema.safeParse({
    kind: "code",
    caption: block.caption.trim() || block.path,
    path: block.path,
    startLine: block.startLine,
    endLine: block.endLine,
    notes: block.notes.map((note) => ({ line: note.line, text: note.text })),
    ...(block.view === null ? {} : { view: block.view }),
  });
  if (!parsed.success) dropped.push(`the code block for ${block.path} was invalid`);
  return parsed.success ? parsed.data : null;
}

/** Whether a message carries streamed markup worth committing: at least one block outside the `part:` marker and suggestions. */
export function committedMessage(text: string): CommittedMessage {
  // A message that ends mid-line has still said everything it is going to say.
  const parsed = parseStreamMarkup(`${text.replace(/\s+$/u, "")}\n`);
  const dropped: string[] = [];
  const marker = parsed.blocks.findIndex((block) => block.kind === "part");
  const before = marker < 0 ? [] : parsed.blocks.slice(0, marker);
  const after = marker < 0 ? parsed.blocks : parsed.blocks.slice(marker + 1);
  const introduction = before
    .filter((block): block is Extract<StreamBlock, { kind: "prose" }> => block.kind === "prose")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
  const blocks = after.map((block) => toInput(block, dropped)).filter((block): block is BlockInput => block !== null);
  const suggestions = after.flatMap((block) => (block.kind === "suggestions" ? block.items : [])).slice(0, 4);
  return { introduction, blocks, suggestions, dropped };
}
