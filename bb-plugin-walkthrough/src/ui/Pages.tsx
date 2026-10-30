// The pages of the reader: the introduction, one part, the wrap-up, and the
// skeleton shown before anything is written.
import { useContext, useState } from "react";
import { experimental_FileLink as FileLink } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { SavedNotes } from "../save-notes.ts";
import type { Place, DeliveredCodeBlock, DeliveredNote as Note, DeliveredPart as Part, DeliveredWalkthrough as Walkthrough, Exchange } from "../schemas.ts";
import { Figure, type FlagTarget } from "./Figure.tsx";
import { openConcerns, PostReviewControl, type ReviewDraftView } from "./Concerns.tsx";
import { partState } from "./fields.ts";
import { errorMessage, type WalkthroughRpc } from "./hooks.ts";
import { Prose, type ProseContext } from "./prose.tsx";
import { previewFor, partPreview, StreamContext, useStreamedView, type StreamedBlock } from "./stream.ts";

export function Skeleton({ label }: { label?: string }) {
  return (
    <div className="wt-skeleton" role="status" aria-label={label ?? "Writing this part"}>
      <span className="wt-skel wt-skel-title" />
      <span className="wt-skel" style={{ width: "92%" }} />
      <span className="wt-skel" style={{ width: "86%" }} />
      <span className="wt-skel" style={{ width: "58%" }} />
      <div className="wt-skel-figure">
        <span className="wt-skel" style={{ width: "40%" }} />
        <span className="wt-skel" style={{ width: "72%" }} />
        <span className="wt-skel" style={{ width: "64%" }} />
      </div>
      <span className="wt-skel" style={{ width: "88%" }} />
      <span className="wt-skel" style={{ width: "46%" }} />
      {label ? <p className="wt-muted wt-skel-note">{label}</p> : null}
    </div>
  );
}

/** Open notes the reader anchored inside one code block of the part on screen. */
function notesInBlock(notes: Note[], partIndex: number | null, block: DeliveredCodeBlock): Note[] {
  return notes.filter((note) => {
    const location = note.location;
    if (note.status !== "open" || note.groupIndex !== partIndex || !location || location.path !== block.path || location.startLine === undefined) return false;
    return location.startLine >= block.startLine && location.startLine <= block.endLine;
  });
}

export function Blocks({
  walkthrough,
  blocks,
  notes,
  partIndex,
  wide,
  onFlag,
}: {
  walkthrough: Walkthrough;
  blocks: StreamedBlock[];
  notes: Note[];
  partIndex: number | null;
  wide: boolean;
  onFlag: (target: FlagTarget, anchor: DOMRect) => void;
}) {
  return (
    <>
      {blocks.map((block, index) => {
        if (block.kind === "code") return <Figure key={index} walkthrough={walkthrough} block={block} notes={notesInBlock(notes, partIndex, block)} wide={wide} onFlag={onFlag} streaming={block.streaming === true} />;
        const nearest = blocks.slice(index + 1).find((candidate) => candidate.kind === "code") ?? blocks.slice(0, index).reverse().find((candidate) => candidate.kind === "code");
        const context: ProseContext = { files: walkthrough, codePath: nearest?.kind === "code" ? nearest.path : null };
        return <Prose key={index} text={block.text} context={context} className={block.streaming ? "wt-streaming" : undefined} />;
      })}
    </>
  );
}

function Heading({ label, title }: { label?: string | undefined; title: string }) {
  return (
    <header className="wt-head">
      {label ? <p className="wt-lbl">{label}</p> : null}
      <h2>{title}</h2>
    </header>
  );
}

export function Introduction({ walkthrough, onOpen, streaming = false }: { walkthrough: Walkthrough; onOpen: (index: number) => void; streaming?: boolean }) {
  return (
    <article>
      <Heading label="Introduction" title={walkthrough.title} />
      <Prose text={walkthrough.introduction} context={{ files: walkthrough, codePath: null }} className={streaming ? "wt-streaming" : undefined} />
      {walkthrough.parts.length > 0 ? (
        <ol className="wt-toc" aria-label="Parts">
          {walkthrough.parts.map((part, index) => (
            <li key={`${index}:${part.title}`}>
              <button type="button" onClick={() => onOpen(index)}>
                <span className="wt-toc-n">{index + 1}</span>
                <span>
                  <span className="wt-toc-t">{part.title}</span>
                  {part.summary ? <span className="wt-toc-s">{part.summary}</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ol>
      ) : null}
    </article>
  );
}

export function PartPage({
  walkthrough,
  index,
  notes,
  rpc,
  wide,
  onFlag,
}: {
  walkthrough: Walkthrough;
  index: number;
  notes: Note[];
  rpc: WalkthroughRpc;
  wide: boolean;
  onFlag: (target: FlagTarget, anchor: DOMRect) => void;
}) {
  const part = walkthrough.parts[index]!;
  const closed = walkthrough.status === "done";
  const retry = () => void rpc.call("retry", { walkthroughId: walkthrough.id, place: index }).catch((cause: unknown) => toast.error(errorMessage(cause)));
  const state = partState(walkthrough, part);
  // What the worker has written so far stands in until the part is saved; the saved blocks take over in the same elements.
  const streams = useContext(StreamContext);
  const streamed = useStreamedView(partPreview(streams, walkthrough, index));
  const blocks: StreamedBlock[] = part.blocks.length > 0 ? part.blocks : (streamed?.blocks ?? []);
  return (
    <article aria-busy={part.status === "writing" || undefined}>
      <Heading title={part.title} />
      {state === "stale" ? (
        <div role="status" className="wt-stale">
          <span>The code changed after this part was written, so details here may be out of date.</span>
          <button type="button" className="wt-btn wt-btn-quiet" onClick={retry}>
            Rewrite this part
          </button>
        </div>
      ) : null}
      {part.status === "ready" || (part.status !== "failed" && blocks.length > 0) ? (
        <>
          <Blocks walkthrough={walkthrough} blocks={blocks} notes={notes} partIndex={index} wide={wide} onFlag={onFlag} />
          {part.status !== "ready" ? <Skeleton label="Writing this part…" /> : null}
        </>
      ) : part.status === "failed" ? (
        <div className="wt-failed">
          {part.message ? <Prose text={part.message} context={{ files: walkthrough, codePath: null }} /> : <p className="wt-muted">This part could not be written.</p>}
          {closed ? null : (
            <button type="button" className="wt-btn wt-btn-quiet" onClick={retry}>
              Try again
            </button>
          )}
        </div>
      ) : closed ? (
        <p className="wt-muted">This part was not written before the walkthrough finished.</p>
      ) : (
        <>
          {part.summary ? <p className="wt-summary">{part.summary}</p> : null}
          <Skeleton label={part.status === "writing" ? "Writing this part…" : "Not started yet"} />
        </>
      )}
    </article>
  );
}

/** The answers to questions asked on a page, as a thread hanging under it. */
export function Thread({ walkthrough, part, place }: { walkthrough: Walkthrough; part: Part; place: Place }) {
  if (part.discussion.length === 0) return null;
  return (
    <section className="wt-thread" aria-label="Questions about this part">
      {part.discussion.map((exchange) => (
        <ExchangeView key={exchange.id} walkthrough={walkthrough} exchange={exchange} place={place} />
      ))}
    </section>
  );
}

function ExchangeView({ walkthrough, exchange, place }: { walkthrough: Walkthrough; exchange: Exchange; place: Place }) {
  // The answer streams in through the same channel as parts; the saved answer takes over when the exchange settles.
  const streams = useContext(StreamContext);
  const live = exchange.status === "answering" ? previewFor(streams, walkthrough, "ask", place, exchange.id) : null;
  const answer = live && live.text.length > exchange.answer.length ? live.text : exchange.answer;
  const streaming = exchange.status === "answering" && answer !== "";
  return (
    <div className="wt-ex" data-status={exchange.status}>
      <p className="wt-q">{exchange.question}</p>
      {answer ? <Prose text={answer} context={{ files: walkthrough, codePath: null }} className={cn("wt-a", streaming && "wt-streaming")} /> : null}
      {exchange.status === "queued" ? <p className="wt-muted">Waiting for the current step to finish…</p> : null}
      {exchange.status === "answering" && !answer ? <p className="wt-muted wt-pulse">Thinking…</p> : null}
      {exchange.status === "failed" ? <p className="wt-muted">No answer came back. Ask again?</p> : null}
    </div>
  );
}

/** The ledger of what the reading left open, and the one thing to do about it. */
export function WrapUpPage({
  walkthrough,
  notes,
  draft,
  rpc,
  wide,
  onFlag,
  onOpenPart,
  onOpenConcerns,
}: {
  walkthrough: Walkthrough;
  notes: Note[];
  draft: ReviewDraftView | null;
  rpc: WalkthroughRpc;
  wide: boolean;
  onFlag: (target: FlagTarget, anchor: DOMRect) => void;
  onOpenPart: (index: number) => void;
  onOpenConcerns: () => void;
}) {
  const wrap = walkthrough.wrapUp;
  const closed = walkthrough.status === "done";
  const intent = walkthrough.intent;
  const [sending, setSending] = useState(false);
  const open = openConcerns(notes);
  const count = (kind: Note["kind"]) => open.filter((note) => note.kind === kind).length;
  const answered = walkthrough.parts.reduce((total, part) => total + part.discussion.filter((exchange) => exchange.status === "done").length, 0) + (wrap?.discussion.filter((exchange) => exchange.status === "done").length ?? 0);
  const skipped = walkthrough.parts.map((part, index) => ({ part, index })).filter(({ part }) => part.status !== "ready");
  const sendable = count("todo") + count("question");
  const handOff = async () => {
    setSending(true);
    try {
      const { sent } = await rpc.call("handOff", { walkthroughId: walkthrough.id });
      toast[sent ? "success" : "info"](sent ? "Sent the open items to your thread." : "There are no new todos or questions to send.");
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setSending(false);
    }
  };
  const [saved, setSaved] = useState<SavedNotes | null>(null);
  const saveNotes = async () => {
    try {
      const result = await rpc.call("saveNotes", { walkthroughId: walkthrough.id });
      setSaved(result);
      toast.success("Saved your notes");
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  };
  const openSummary = [
    count("todo") ? `${count("todo")} to do` : null,
    count("question") ? `${count("question")} ${count("question") === 1 ? "question" : "questions"}` : null,
    count("comment") ? `${count("comment")} ${count("comment") === 1 ? "comment" : "comments"}` : null,
    count("note") ? `${count("note")} ${count("note") === 1 ? "note" : "notes"}` : null,
  ].filter(Boolean);
  return (
    <article aria-busy={wrap?.status === "writing" || undefined}>
      <Heading label={closed ? "Finished" : "Wrap-up"} title={walkthrough.title} />
      {wrap?.status === "ready" ? (
        <Blocks walkthrough={walkthrough} blocks={wrap.blocks} notes={notes} partIndex={null} wide={wide} onFlag={onFlag} />
      ) : wrap?.status === "failed" ? (
        <div className="wt-failed">
          {wrap.message ? <Prose text={wrap.message} context={{ files: walkthrough, codePath: null }} /> : null}
          {closed ? null : (
            <button type="button" className="wt-btn wt-btn-quiet" onClick={() => void rpc.call("retry", { walkthroughId: walkthrough.id, place: "wrap-up" }).catch((cause: unknown) => toast.error(errorMessage(cause)))}>
              Try again
            </button>
          )}
        </div>
      ) : closed ? null : (
        <p className="wt-muted wt-pulse" role="status">
          Going over your notes and answering what it can…
        </p>
      )}
      <dl className="wt-ledger" aria-label="What is left">
        <div>
          <dt>Open items</dt>
          <dd>
            <strong>{open.length}</strong>
            {openSummary.length > 0 ? <span>{openSummary.join(", ")}</span> : null}
            {open.length > 0 ? (
              <button type="button" className="wt-link-btn" onClick={onOpenConcerns}>
                Review them
              </button>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Questions answered</dt>
          <dd>
            <strong>{answered}</strong>
          </dd>
        </div>
        <div>
          <dt>Parts skipped</dt>
          <dd>
            <strong>{skipped.length}</strong>
            {skipped.map(({ part, index }) => (
              <button key={index} type="button" className="wt-link-btn" onClick={() => onOpenPart(index)}>
                {part.title}
              </button>
            ))}
          </dd>
        </div>
      </dl>
      <div className="wt-actions">
        {intent === "review" ? (
          <PostReviewControl walkthrough={walkthrough} draft={draft} rpc={rpc} />
        ) : intent === "own-change" ? (
          <button type="button" className="wt-btn wt-btn-primary" disabled={sending} onClick={() => void handOff()}>
            Send open items to thread
          </button>
        ) : (
          <>
            <button type="button" className="wt-btn wt-btn-primary" onClick={() => void saveNotes()}>
              Save notes
            </button>
            <button type="button" className="wt-btn wt-btn-quiet" disabled={sending || sendable === 0} onClick={() => void handOff()}>
              Ask the thread to apply it
            </button>
          </>
        )}
      </div>
      {saved ? (
        <p className="wt-muted" role="status">
          Saved to{" "}
          <FileLink target={{ kind: "thread-storage", threadId: saved.threadId, path: saved.path }} className="wt-loc">
            {saved.path}
          </FileLink>
        </p>
      ) : null}
    </article>
  );
}
