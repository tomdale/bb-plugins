// Turns the worker's finished streamed message into what the write tools
// commit, so the worker says a part once, in the message the reader already
// watches, instead of saying it again as tool arguments. The markup is the one
// stream-markup.ts parses for the live preview; here the same blocks become
// schema-checked block inputs. The text given here is the message's content
// (extractContent): what the helper said outside it is already gone.
import { blockInputSchema, type BlockInput } from "./schemas.ts";
import { stripNarration, stripNarrationFromBlocks } from "./narration.ts";
import { parseStreamMarkup, type StreamBlock } from "./stream-markup.ts";

export interface CommittedMessage {
  /** Prose before the `part:` fence (less narration at its edges), joined as Markdown; empty when the message has no introduction. */
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

/**
 * What a streamed message commits. In the plan turn, a message with no `part:`
 * fence still has two halves: the prose before its first code block is the
 * introduction and the rest is part 1, because a helper that forgets the
 * separator has still said both. (A write turn has no introduction, so there
 * the whole message is the part.)
 */
export function committedMessage(text: string, turn: "plan" | "write" = "write"): CommittedMessage {
  // A message that ends mid-line has still said everything it is going to say.
  const parsed = parseStreamMarkup(`${text.replace(/\s+$/u, "")}\n`);
  const dropped: string[] = [];
  const explicit = parsed.blocks.findIndex((block) => block.kind === "part");
  const firstFigure = parsed.blocks.findIndex((block) => block.kind === "figure");
  // The first figure is part 1's first block; the prose that precedes it is the introduction, and its own index is where part 1 begins.
  const impliedSplit = turn === "plan" && explicit < 0 && firstFigure > 0 ? firstFigure : -1;
  const marker = explicit >= 0 ? explicit : impliedSplit;
  const before = marker < 0 ? [] : parsed.blocks.slice(0, marker);
  const after = marker < 0 ? parsed.blocks : parsed.blocks.slice(explicit >= 0 ? marker + 1 : marker);
  const introduction = before
    .filter((block): block is Extract<StreamBlock, { kind: "prose" }> => block.kind === "prose")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
  const blocks = stripNarrationFromBlocks(after.map((block) => toInput(block, dropped)).filter((block): block is BlockInput => block !== null));
  const suggestions = after.flatMap((block) => (block.kind === "suggestions" ? block.items : [])).slice(0, 4);
  return { introduction: stripNarration(introduction), blocks, suggestions, dropped };
}
