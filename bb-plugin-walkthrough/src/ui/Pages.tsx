// The pages of the reader: the introduction, one part, the wrap-up, and the
// skeleton shown before anything is written.
import { useContext, useState, type ReactNode } from "react";
import { experimental_FileLink as FileLink } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { SavedNotes } from "../save-notes.ts";
import type { Coverage, Place, DeliveredCodeBlock, DeliveredNote as Note, DeliveredPart as Part, DeliveredWalkthrough as Walkthrough, Exchange } from "../schemas.ts";
import { Figure, type FlagTarget } from "./Figure.tsx";
import { countedOpen, openConcerns, PostReviewControl, type ReviewDraftView } from "./Concerns.tsx";
import { partState } from "./fields.ts";
import { handOffMessage, unsentItems } from "./hand-off.ts";
import { type WalkthroughRpc } from "./hooks.ts";
import { useFail, useNotify } from "./notices.tsx";
import { stripReplyWrapper } from "./reply.ts";
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

function Heading({ label, title, placeholder = false }: { label?: string | undefined; title: string; placeholder?: boolean }) {
  return (
    <header className="wt-head">
      {label ? <p className="wt-lbl">{label}</p> : null}
      <h2 data-placeholder={placeholder || undefined}>{title}</h2>
    </header>
  );
}

/** The title the helper has not chosen yet: the request stands in, softly, until the plan names the walkthrough. */
export function pageTitle(walkthrough: Pick<Walkthrough, "title" | "request">): { text: string; placeholder: boolean } {
  if (walkthrough.title !== "Walkthrough") return { text: walkthrough.title, placeholder: false };
  return { text: walkthrough.request.trim() || "Reading your changes…", placeholder: true };
}

export function Introduction({ walkthrough, onOpen, streaming = false, coverage, label = "Introduction", subject }: { walkthrough: Walkthrough; onOpen: (index: number) => void; streaming?: boolean; coverage?: Coverage | null | undefined; label?: string; subject?: ReactNode }) {
  const title = pageTitle(walkthrough);
  return (
    <article>
      <Heading label={label} title={title.text} placeholder={title.placeholder} />
      {subject ? <p className="wt-subject">{subject}</p> : null}
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
      <CoverageStrip coverage={coverage} />
    </article>
  );
}

const EXCLUDED_WORD = { lockfile: "lockfile", generated: "generated", binary: "binary" } as const;

/** Which of the changed files the figures cover, so the reader knows what the walkthrough left out. Hidden until the server knows the changed files. */
export function CoverageStrip({ coverage }: { coverage: Coverage | null | undefined }) {
  if (!coverage || coverage.changed === 0) return null;
  const countable = coverage.files.filter((file) => file.excluded === null);
  const shown = countable.filter((file) => file.covered).length;
  const left = coverage.files.filter((file) => !file.covered && file.excluded === null);
  const quiet = coverage.files.filter((file) => !file.covered && file.excluded !== null);
  const plural = countable.length === 1 ? "file" : "files";
  return (
    <section className="wt-coverage" aria-label="Coverage">
      <p className="wt-coverage-line">
        <strong>
          {shown} of {countable.length}
        </strong>{" "}
        changed {plural} shown in figures
        {left.length === 0 ? <span className="wt-muted"> · every file covered</span> : null}
      </p>
      <ul className="wt-coverage-files" aria-label="Changed files">
        {coverage.files.map((file) => (
          <li key={file.path} data-covered={file.covered || undefined} data-excluded={file.excluded ?? undefined}>
            <span className="wt-sr">{file.covered ? "Covered: " : file.excluded ? `Not shown, ${EXCLUDED_WORD[file.excluded]}: ` : "Not covered: "}</span>
            {file.path}
            {!file.covered && file.excluded ? <span className="wt-muted"> ({EXCLUDED_WORD[file.excluded]})</span> : null}
          </li>
        ))}
        {coverage.truncated ? <li className="wt-muted">and more not listed</li> : null}
      </ul>
      {left.length > 0 ? (
        <p className="wt-muted wt-coverage-left">
          Not covered: {left.map((file) => file.path).join(", ")}
          {quiet.length > 0 ? `. Left out on purpose: ${quiet.map((file) => file.path).join(", ")}` : ""}
        </p>
      ) : null}
    </section>
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
  const fail = useFail();
  const retry = () => void rpc.call("retry", { walkthroughId: walkthrough.id, place: index }).catch(fail);
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
          <span>
            {(() => {
              const files = (part as { staleFiles?: string[] }).staleFiles ?? [];
              const named = files.slice(0, 2).map((file) => file.split("/").pop()).join(", ");
              return files.length > 0 ? `${named}${files.length > 2 ? ` and ${files.length - 2} more` : ""} changed after this part was written, so details here may be out of date.` : "The code changed after this part was written, so details here may be out of date.";
            })()}
          </span>
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
  const answer = stripReplyWrapper(live && live.text.length > exchange.answer.length ? live.text : exchange.answer);
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

/** The ledger of what the reading left open. Its primary action is pinned in the pager (see WrapUpActions). */
export function WrapUpPage({
  walkthrough,
  notes,
  draft,
  coverage,
  rpc,
  wide,
  onFlag,
  onOpenPart,
  onOpenConcerns,
}: {
  walkthrough: Walkthrough;
  notes: Note[];
  draft: ReviewDraftView | null;
  coverage?: Coverage | null | undefined;
  rpc: WalkthroughRpc;
  wide: boolean;
  onFlag: (target: FlagTarget, anchor: DOMRect) => void;
  onOpenPart: (index: number) => void;
  onOpenConcerns: () => void;
}) {
  const wrap = walkthrough.wrapUp;
  const closed = walkthrough.status === "done";
  const fail = useFail();
  const open = countedOpen(notes);
  const count = (kind: Note["kind"]) => open.filter((note) => note.kind === kind).length;
  const answered = walkthrough.parts.reduce((total, part) => total + part.discussion.filter((exchange) => exchange.status === "done").length, 0) + (wrap?.discussion.filter((exchange) => exchange.status === "done").length ?? 0);
  const skipped = walkthrough.parts.map((part, index) => ({ part, index })).filter(({ part }) => part.status !== "ready");
  const inReview = walkthrough.intent === "review" ? (draft?.comments.length ?? 0) : null;
  const waiting = openConcerns(notes).length - open.length;
  const title = pageTitle(walkthrough);
  const openSummary = [
    count("todo") ? `${count("todo")} to do` : null,
    count("question") ? `${count("question")} ${count("question") === 1 ? "question" : "questions"}` : null,
    count("comment") ? `${count("comment")} ${count("comment") === 1 ? "comment" : "comments"}` : null,
    count("note") ? `${count("note")} ${count("note") === 1 ? "note" : "notes"}` : null,
  ].filter(Boolean);
  return (
    <article aria-busy={wrap?.status === "writing" || undefined}>
      <Heading label={closed ? "Finished" : "Wrap-up"} title={title.text} />
      {wrap?.status === "ready" ? (
        <Blocks walkthrough={walkthrough} blocks={wrap.blocks} notes={notes} partIndex={null} wide={wide} onFlag={onFlag} />
      ) : wrap?.status === "failed" ? (
        <div className="wt-failed">
          {wrap.message ? <Prose text={wrap.message} context={{ files: walkthrough, codePath: null }} /> : null}
          {closed ? null : (
            <button type="button" className="wt-btn wt-btn-quiet" onClick={() => void rpc.call("retry", { walkthroughId: walkthrough.id, place: "wrap-up" }).catch(fail)}>
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
            <span>
              open{inReview !== null ? ` · ${inReview} in review` : ""}
              {waiting > 0 ? ` · ${waiting} waiting on the thread` : ""}
            </span>
            {openSummary.length > 0 ? <span className="wt-muted">{openSummary.join(", ")}</span> : null}
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
      <CoverageStrip coverage={coverage} />
    </article>
  );
}

/**
 * The wrap-up's primary action, by what the reader came to do. It lives in the
 * pager so it is reachable without scrolling. Handing items to the thread is
 * only enabled while there is something new to hand over, and then reads "Sent".
 */
export function WrapUpActions({ walkthrough, notes, draft, rpc }: { walkthrough: Walkthrough; notes: Note[]; draft: ReviewDraftView | null; rpc: WalkthroughRpc }) {
  const intent = walkthrough.intent;
  const notify = useNotify();
  const fail = useFail();
  const [sending, setSending] = useState(false);
  const [applying, setApplying] = useState(false);
  const [saved, setSaved] = useState<SavedNotes | null>(null);
  const unsent = unsentItems(notes).length;
  const sentBefore = notes.some((note) => note.sentAt);
  const sentLabel = sentBefore ? "Sent to thread" : null;
  const handOff = async (message?: string) => {
    setSending(true);
    try {
      const { sent } = await rpc.call("handOff", { walkthroughId: walkthrough.id, ...(message === undefined ? {} : { message }) } as never);
      notify(sent ? "Sent to your thread" : "Nothing new to send", sent ? "success" : "info");
      setApplying(false);
    } catch (cause) {
      fail(cause);
    } finally {
      setSending(false);
    }
  };
  const saveNotes = async () => {
    try {
      setSaved(await rpc.call("saveNotes", { walkthroughId: walkthrough.id }));
      notify("Notes saved");
    } catch (cause) {
      fail(cause);
    }
  };
  if (intent === "review") return <PostReviewControl walkthrough={walkthrough} draft={draft} rpc={rpc} />;
  const send = (
    <button type="button" className="wt-btn wt-btn-primary" disabled={sending || unsent === 0} onClick={() => void handOff()} data-sent={unsent === 0 && sentBefore ? "" : undefined}>
      {unsent === 0 && sentLabel ? sentLabel : "Send open items to thread"}
    </button>
  );
  if (intent === "own-change") return send;
  return (
    <>
      <button type="button" className="wt-btn wt-btn-primary" onClick={() => void saveNotes()}>
        Save notes
      </button>
      <button type="button" className="wt-btn wt-btn-quiet" disabled={sending || unsent === 0} onClick={() => setApplying(true)} data-sent={unsent === 0 && sentBefore ? "" : undefined}>
        {unsent === 0 && sentLabel ? sentLabel : "Ask the thread to apply it"}
      </button>
      {saved ? (
        <span className="wt-muted wt-saved" role="status">
          Saved to{" "}
          <FileLink target={{ kind: "thread-storage", threadId: saved.threadId, path: saved.path }} className="wt-loc">
            {saved.path}
          </FileLink>
        </span>
      ) : null}
      <ApplyDialog open={applying} onOpenChange={setApplying} walkthrough={walkthrough} notes={notes} sending={sending} onSend={(message, edited) => void handOff(edited ? message : undefined)} />
    </>
  );
}

/** The message "Ask the thread to apply it" will send, prefilled and editable; nothing is sent until the reader presses Send. */
function ApplyDialog({ open, onOpenChange, walkthrough, notes, sending, onSend }: { open: boolean; onOpenChange: (open: boolean) => void; walkthrough: Walkthrough; notes: Note[]; sending: boolean; onSend: (message: string, edited: boolean) => void }) {
  const generated = handOffMessage(walkthrough, notes);
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? generated;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setDraft(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="wt-portal wt-dialog">
        <DialogHeader>
          <DialogTitle>Ask the thread to apply it</DialogTitle>
          <DialogDescription>This is the message your thread will receive. Edit it, then send it. Nothing is sent until you press Send.</DialogDescription>
        </DialogHeader>
        <textarea className="wt-apply-text" aria-label="Message to your thread" rows={10} value={text} onChange={(event) => setDraft(event.target.value)} />
        <DialogFooter className="wt-dialog-actions">
          <Button type="button" variant="ghost" className="wt-btn wt-btn-quiet" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" className="wt-btn wt-btn-primary" disabled={sending || text.trim() === ""} onClick={() => onSend(text, text !== generated)}>
            Send to thread
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
